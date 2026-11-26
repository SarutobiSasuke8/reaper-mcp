-- REAPER MCP protocol 2. Native APIs only; no sockets, eval or extensions.
-- Set REAPER_MCP_BRIDGE_DIR before launching REAPER, or use the resource subfolder.
local root = os.getenv("REAPER_MCP_BRIDGE_DIR") or (reaper.GetResourcePath() .. "/reaper-mcp-bridge")
reaper.RecursiveCreateDirectory(root, 0)
local session = tostring(reaper.time_precise()) .. ":" .. tostring({})
local function quote(s)
  return '"' .. tostring(s):gsub('[%z\1-\31\\"]', function(c)
    return string.format('\\u%04x', string.byte(c))
  end) .. '"'
end
local function json(v)
  if type(v)=="string" then return quote(v) end
  if type(v)=="number" or type(v)=="boolean" then return tostring(v) end
  if type(v)~="table" then return "null" end
  local parts={}
  if v.__array then
    for i=1,#v do parts[#parts+1]=json(v[i]) end
    return "["..table.concat(parts,",").."]"
  end
  for k,val in pairs(v) do parts[#parts+1]=quote(k)..":"..json(val) end
  return "{"..table.concat(parts,",").."}"
end
local function atomic(name, content)
  local f=assert(io.open(root.."/"..name..".tmp","wb")); f:write(content); f:close()
  assert(os.rename(root.."/"..name..".tmp",root.."/"..name))
end
local last_project, last_revision, epoch = nil, nil, 0
local function current()
  local p,filename = reaper.EnumProjects(-1, "")
  local key=tostring(p)..":"..filename..":"..reaper.GetTrackGUID(reaper.GetMasterTrack(p))
  local revision=reaper.GetProjectStateChangeCount(p)
  if key~=last_project or (last_revision and revision<last_revision) then epoch=epoch+1 end
  last_project,last_revision=key,revision
  return p, session..":"..epoch..":"..key, revision
end
local function track_view(t)
  local _,name=reaper.GetTrackName(t)
  local vol=reaper.GetMediaTrackInfo_Value(t,"D_VOL")
  return {name=name,guid=reaper.GetTrackGUID(t),volume_db=vol>0 and math.max(-150,20*math.log(vol,10)) or -150,
    pan=reaper.GetMediaTrackInfo_Value(t,"D_PAN"),mute=reaper.GetMediaTrackInfo_Value(t,"B_MUTE")~=0,
    itemCount=reaper.CountTrackMediaItems(t),fxCount=reaper.TrackFX_GetCount(t)}
end
local function item_view(p,it)
  local take=reaper.GetActiveTake(it)
  local _,guid=reaper.GetSetMediaItemInfo_String(it,'GUID','',false)
  local takeguid='';if take then _,takeguid=reaper.GetSetMediaItemTakeInfo_String(take,'GUID','',false) end
  local pos=reaper.GetMediaItemInfo_Value(it,'D_POSITION')
  local start=reaper.TimeMap2_timeToQN(p,pos)
  return {guid=guid,takeGuid=takeguid,isMidi=take and reaper.TakeIsMIDI(take) or false,
    startBeat=start,lengthBeats=reaper.TimeMap2_timeToQN(p,pos+reaper.GetMediaItemInfo_Value(it,'D_LENGTH'))-start,
    looped=reaper.GetMediaItemInfo_Value(it,'B_LOOPSRC')~=0}
end
local function track_fx(p, track_index, fx)
  local t=assert(reaper.GetTrack(p,track_index),"Track not found")
  assert(fx>=0 and fx<reaper.TrackFX_GetCount(t),"Track FX not found")
  assert(not reaper.TrackFX_GetOffline(t,fx),"Track FX is offline")
  return t
end
local function fx_parameter(t, fx, index)
  assert(index>=0 and index<reaper.TrackFX_GetNumParams(t,fx),"Parameter not found")
  local ok,name=reaper.TrackFX_GetParamName(t,fx,index,"")
  assert(ok,"Cannot read parameter name")
  local formatted,label=reaper.TrackFX_GetFormattedParamValue(t,fx,index,"")
  return {index=index,name=name,normalized=reaper.TrackFX_GetParamNormalized(t,fx,index),
    formatted=formatted and label or nil}
end
local function envelope_point(env,index)
  local ok,time,value,shape,tension,selected=reaper.GetEnvelopePoint(env,index)
  assert(ok,"Envelope point not found")
  return {index=index,timeSeconds=time,value=value,shape=shape,tension=tension,selected=selected}
end
local function get_value(p, object_path)
  local tr,slot,control=object_path:match("^/tracks/(%d+)/fx/(%d+)/parameters/(%d+)/envelope$")
  if tr then
    local fx,index=tonumber(slot),tonumber(control)
    local t=track_fx(p,tonumber(tr),fx)
    fx_parameter(t,fx,index)
    local env=reaper.GetFXEnvelope(t,fx,index,false)
    local points={__array=true}
    if not env then return {exists=false,points=points} end
    local count=reaper.CountEnvelopePoints(env)
    assert(count<=2048,"Envelope read limit exceeded")
    for i=0,count-1 do points[#points+1]=envelope_point(env,i) end
    return {exists=true,points=points,automationItems=reaper.CountAutomationItems(env)}
  end
  local ti,fi,pi=object_path:match("^/tracks/(%d+)/fx/(%d+)/parameters/(%d+)$")
  local offset,limit
  if not ti then
    ti,fi,offset,limit=object_path:match("^/tracks/(%d+)/fx/(%d+)/parameters/page/(%d+)/(%d+)$")
  end
  if not ti then ti,fi=object_path:match("^/tracks/(%d+)/fx/(%d+)/parameters$") end
  if ti then
    local fx=tonumber(fi)
    local t=track_fx(p,tonumber(ti),fx)
    if pi then return fx_parameter(t,fx,tonumber(pi)) end
    local count=reaper.TrackFX_GetNumParams(t,fx)
    local first,last=0,count-1
    if offset then
      first=tonumber(offset)
      limit=tonumber(limit)
      assert(first<=100000 and limit>=1 and limit<=200,"Invalid parameter page")
      last=math.min(last,first+limit-1)
    else
      assert(count<=256,"Use reaper_list for more than 256 parameters")
    end
    local parameters={__array=true}
    for i=first,last do parameters[#parameters+1]=fx_parameter(t,fx,i) end
    if offset then return {total=count,offset=first,items=parameters} end
    return parameters
  end
  local vt,vi=object_path:match('^/tracks/(%d+)/items/(%d+)$')
  if vt then return item_view(p,assert(reaper.GetTrackMediaItem(assert(reaper.GetTrack(p,tonumber(vt))),tonumber(vi)),"Item not found")) end

  if object_path=="/plugins" then
    local plugins={__array=true}
    for i=0,2047 do local ok,name,id=reaper.EnumInstalledFX(i);if not ok then break end;plugins[#plugins+1]={name=name,id=id} end
    return plugins
  end
  local ci,cj=object_path:match("^/tracks/(%d+)/items/(%d+)/controllers$")
  if ci then
    local tr=assert(reaper.GetTrack(p,tonumber(ci)),"Track not found")
    local it=assert(reaper.GetTrackMediaItem(tr,tonumber(cj)),"Item not found")
    local take=assert(reaper.GetActiveTake(it),"Take not found")
    assert(reaper.TakeIsMIDI(take),"Not MIDI")
    local _,_,count=reaper.MIDI_CountEvts(take);assert(count<=10000,"Controller read limit")
    local events={__array=true}
    for i=0,count-1 do
      local ok,selected,muted,pos,msg,channel,cc,value=reaper.MIDI_GetCC(take,i)
      if ok and msg==176 then events[#events+1]={index=i,selected=selected,muted=muted,beat=reaper.MIDI_GetProjQNFromPPQPos(take,pos),controller=cc,value=value,channel=channel} end
    end
    return events
  end
  local ti,ii=object_path:match("^/tracks/(%d+)/items/(%d+)/notes$")
  if ti then
    local tr=assert(reaper.GetTrack(p,tonumber(ti)),"Track not found")
    local it=assert(reaper.GetTrackMediaItem(tr,tonumber(ii)),"Item not found")
    local take=assert(reaper.GetActiveTake(it),"Take not found")
    assert(reaper.TakeIsMIDI(take),"Not MIDI")
    local _,count=reaper.MIDI_CountEvts(take);assert(count<=10000,"Note read limit")
    local notes={__array=true}
    for i=0,count-1 do local ok,selected,muted,start,ending,channel,pitch,velocity=reaper.MIDI_GetNote(take,i);notes[#notes+1]={index=i,selected=selected,muted=muted,startBeat=reaper.MIDI_GetProjQNFromPPQPos(take,start),endBeat=reaper.MIDI_GetProjQNFromPPQPos(take,ending),channel=channel,pitch=pitch,velocity=velocity} end
    return notes
  end
  if object_path=="/project" then return {name=reaper.GetProjectName(p),tempo=reaper.Master_GetTempo(),trackCount=reaper.CountTracks(p)} end
  if object_path=="/project/tempo" then return reaper.Master_GetTempo() end
  if object_path=="/tracks" then
    assert(reaper.CountTracks(p)<=256,"Track limit exceeded; use individual track paths")
    local tracks={__array=true}
    for i=0,reaper.CountTracks(p)-1 do tracks[#tracks+1]=track_view(reaper.GetTrack(p,i)) end
    return tracks
  end
  local index,field=object_path:match("^/tracks/(%d+)/([%w_]+)$")
  if not index then index=object_path:match("^/tracks/(%d+)$") end
  assert(index,"Unsupported live path")
  local t=reaper.GetTrack(p,tonumber(index)); assert(t,"Track not found")
  if field=="sends" then
    local sends={__array=true}
    local count=reaper.GetTrackNumSends(t,0)
    assert(count<=256,"Too many sends")
    for i=0,count-1 do
      local function get(key) return reaper.GetTrackSendInfo_Value(t,0,i,key) end
      local dest=get("P_DESTTRACK")
      sends[#sends+1]={index=i,destinationGuid=reaper.GetTrackGUID(dest),sourceChannel=get("I_SRCCHAN"),
        destinationChannel=get("I_DSTCHAN"),gain=get("D_VOL"),mode=get("I_SENDMODE"),midiFlags=get("I_MIDIFLAGS")}
    end
    return sends
  end
  if field=="fx" then
    local fx={__array=true}; assert(reaper.TrackFX_GetCount(t)<=128,"FX limit exceeded")
    for i=0,reaper.TrackFX_GetCount(t)-1 do
      local _,name=reaper.TrackFX_GetFXName(t,i)
      fx[#fx+1]={index=i,name=name,guid=reaper.TrackFX_GetFXGUID(t,i),enabled=reaper.TrackFX_GetEnabled(t,i),parameterCount=reaper.TrackFX_GetNumParams(t,i)}
    end
    return fx
  end
  local view=track_view(t)
  if field then assert(view[field]~=nil,"Unsupported live track field"); return view[field] end
  return view
end
local function number(s,lo,hi,integer)
  local n=tonumber(s); assert(n and n==n and n>=lo and n<=hi and (not integer or n%1==0),"Invalid number")
  return n
end
local fx_undo, fx_edit_count = nil, 0
local function music(p,a)
  local action,dry=a[7],a[8]; assert(dry=="0" or dry=="1","Invalid dryRun")
  local result={dryRun=dry=="1",action=action}
  local perform
  local undo_label='REAPER MCP: '..action
  if action=="live_edit_fx_envelope_point" then
    assert(reaper.GetPlayStateEx(p)==0,"Stop transport before editing automation")
    local fx=number(a[10],0,9999,true)
    local t=track_fx(p,number(a[9],0,255,true),fx)
    assert(reaper.TrackFX_GetFXGUID(t,fx)==a[11],"FX identity changed")
    local param=number(a[12],0,reaper.TrackFX_GetNumParams(t,fx)-1,true)
    local _,minimum,maximum=reaper.TrackFX_GetParam(t,fx,param)
    local env=assert(reaper.GetFXEnvelope(t,fx,param,false),"Existing FX envelope required")
    assert(minimum==0 and maximum==1 and reaper.GetEnvelopeScalingMode(env)==0,"Requires an unscaled 0-1 parameter")
    assert(reaper.CountAutomationItems(env)==0,"Envelope with automation items unsupported")
    local index=number(a[13],1,reaper.CountEnvelopePoints(env)-2,true)
    local left,point,right=envelope_point(env,index-1),envelope_point(env,index),envelope_point(env,index+1)
    assert(math.abs(point.timeSeconds-number(a[14],0,86400))<0.0000001,"Point time changed")
    assert(left.timeSeconds<point.timeSeconds and point.timeSeconds<right.timeSeconds,"Distinct anchors required")
    assert(left.shape<=1 and point.shape<=1,"Only linear and square segments supported")
    if index>=2 then assert(envelope_point(env,index-2).shape<=1,"Curved outer anchor unsupported") end
    assert(right.shape<=1,"Curved outer anchor unsupported")
    result.before=point;result.startSeconds=left.timeSeconds;result.endSeconds=right.timeSeconds
    result.requested=number(a[15],0,1)
    perform=function()
      assert(reaper.SetEnvelopePoint(env,index,point.timeSeconds,result.requested,point.shape,point.tension,point.selected,false),"Envelope write failed")
      result.after=envelope_point(env,index)
    end
  elseif action=="live_add_send" then
    local src=assert(reaper.GetTrack(p,number(a[9],0,255,true)),"Source not found")
    local dest=assert(reaper.GetTrack(p,number(a[11],0,255,true)),"Destination not found")
    assert(reaper.GetTrackGUID(src)==a[10] and reaper.GetTrackGUID(dest)==a[12],"Track identity changed")
    assert(a[13]=="1/2" or a[13]=="3/4","Unknown destination pair")
    local dstchan=a[13]=="3/4" and 2 or 0
    local gain=10^(number(a[14],-150,12)/20)
    for i=0,reaper.GetTrackNumSends(src,0)-1 do
      assert(reaper.GetTrackSendInfo_Value(src,0,i,"P_DESTTRACK")~=dest or
        reaper.GetTrackSendInfo_Value(src,0,i,"I_DSTCHAN")~=dstchan,"Send to that pair already exists")
    end
    local seen,queue={}, {dest}
    while #queue>0 do
      local node=table.remove(queue)
      assert(node~=src,"Send would create feedback")
      if not seen[node] then
        seen[node]=true
        if reaper.GetMediaTrackInfo_Value(node,"B_MAINSEND")~=0 then
          local parent=reaper.GetParentTrack(node)
          if parent then queue[#queue+1]=parent end
        end
        for i=0,reaper.GetTrackNumSends(node,0)-1 do
          queue[#queue+1]=reaper.GetTrackSendInfo_Value(node,0,i,"P_DESTTRACK")
        end
      end
    end
    perform=function()
      local width=reaper.GetMediaTrackInfo_Value(dest,"I_NCHAN")
      local widened=width<dstchan+2
      local send=-1
      local ok,err=pcall(function()
        if widened then assert(reaper.SetMediaTrackInfo_Value(dest,"I_NCHAN",dstchan+2),"Channel expansion failed") end
        send=reaper.CreateTrackSend(src,dest)
        assert(send>=0,"Send creation failed")
        local function set(key,value) assert(reaper.SetTrackSendInfo_Value(src,0,send,key,value),"Send setup failed: "..key) end
        set("I_SRCCHAN",0);set("I_DSTCHAN",dstchan);set("I_MIDIFLAGS",31);set("I_SENDMODE",0);set("D_VOL",gain)
        set("D_PAN",0);set("B_MUTE",0);set("B_PHASE",0);set("B_MONO",0)
      end)
      if not ok then
        if send>=0 then reaper.RemoveTrackSend(src,0,send) end
        if widened then reaper.SetMediaTrackInfo_Value(dest,"I_NCHAN",width) end
        error(err)
      end
      result.index=send
    end
  elseif action=="live_revert_fx_edit" then
    local _,identity,revision=current()
    assert(fx_undo and fx_undo.token==a[9] and fx_undo.project==identity and fx_undo.revision==revision
      and reaper.Undo_CanUndo2(p)==fx_undo.label,"FX edit is no longer the current undo step")
    perform=function()
      assert(reaper.Undo_DoUndo2(p)~=0,"REAPER could not undo the edit")
      fx_undo=nil
    end
  elseif action=="live_set_fx_parameter" then
    local fx=number(a[10],0,2147483647,true)
    local t=track_fx(p,number(a[9],0,255,true),fx)
    assert(reaper.TrackFX_GetFXGUID(t,fx)==a[11],"FX identity changed; inspect the chain again")
    local index=number(a[12],0,2147483647,true)
    if dry=="0" then
      fx_edit_count=fx_edit_count+1
      undo_label=undo_label..' #'..fx_edit_count
    end
    result.before=fx_parameter(t,fx,index)
    result.requested=number(a[13],0,1,false)
    perform=function()
      assert(reaper.TrackFX_SetParamNormalized(t,fx,index,result.requested),"Plugin rejected parameter")
      reaper.TrackFX_EndParamEdit(t,fx,index)
      result.after=fx_parameter(t,fx,index)
    end
  elseif action=="project_new" then
    local tempo=number(a[9],20,300)
    perform=function() reaper.Main_OnCommand(40859,0); reaper.SetCurrentBPM(0,tempo,true) end
  elseif action=="project_open" or action=="project_save" or action=="snapshot" or action=="snapshot_stem" then
    local filename=a[9]; assert(filename and filename:lower():match('%.rpp$') and not filename:find('[%z\r\n]'),"Invalid project filename")
    if action=="project_open" then
      local f=assert(io.open(filename,"rb"),"Project missing");f:close()
      perform=function() reaper.Main_OnCommand(40859,0); reaper.Main_openProject(filename) end
    elseif action=="project_save" then
      local f=assert(io.open(filename,"rb"),"Output reservation missing");local size=f:seek('end');f:close();assert(size==0,"Output exists")
      perform=function() reaper.Main_SaveProjectEx(p,filename,8) end
    else
      local folder=a[10];assert(folder and not folder:find('[%z\r\n]'),"Invalid folder")
      assert(reaper.GetProjectLength(p)>0,"Project contains no renderable timeline")
      local startpos,endpos=0,reaper.GetProjectLength(p)+2
      local stem
      local pos=11
      if action=="snapshot_stem" then
        stem=assert(reaper.GetTrack(p,number(a[11],0,255,true)),"Stem track not found")
        assert(reaper.GetTrackGUID(stem)==a[12],"Stem track identity changed")
        result.stemGuid=a[12]
        pos=13
      end
      if a[pos] then
        local first,last=number(a[pos],0,100000),number(a[pos+1],0,100000)
        assert(last>first,"Invalid section")
        startpos=reaper.TimeMap2_QNToTime(p,first)
        endpos=reaper.TimeMap2_QNToTime(p,last)+number(a[pos+2],0,30)
        assert(startpos<reaper.GetProjectLength(p),"Section starts beyond project")
      end
      result.startSeconds=startpos;result.endSeconds=endpos
      perform=function()
        local nums={};local strs={}
        for _,key in ipairs({'RENDER_BOUNDSFLAG','RENDER_STARTPOS','RENDER_ENDPOS','RENDER_SETTINGS','RENDER_SRATE','RENDER_CHANNELS','RENDER_TAILFLAG'}) do nums[key]=reaper.GetSetProjectInfo(p,key,0,false) end
        for _,key in ipairs({'RENDER_FILE','RENDER_PATTERN','RENDER_FORMAT'}) do local _,v=reaper.GetSetProjectInfo_String(p,key,'',false);strs[key]=v end
        local ok,err=pcall(function()
          reaper.GetSetProjectInfo_String(p,'RENDER_FILE',folder,true)
          reaper.GetSetProjectInfo_String(p,'RENDER_PATTERN',stem and 'stem' or 'mix',true)
          reaper.GetSetProjectInfo_String(p,'RENDER_FORMAT','ZXZhdxgAAQ==',true)
          for key,v in pairs({RENDER_BOUNDSFLAG=0,RENDER_STARTPOS=startpos,RENDER_ENDPOS=endpos,RENDER_SETTINGS=stem and 3 or 0,RENDER_SRATE=44100,RENDER_CHANNELS=2,RENDER_TAILFLAG=0}) do reaper.GetSetProjectInfo(p,key,v,true) end
          reaper.Main_SaveProjectEx(p,filename,0)
        end)
        for key,v in pairs(nums) do reaper.GetSetProjectInfo(p,key,v,true) end
        for key,v in pairs(strs) do reaper.GetSetProjectInfo_String(p,key,v,true) end
        assert(ok,err)
      end
    end
    result.file=filename
  elseif action=="live_edit_performance" then
    local t=assert(reaper.GetTrack(p,number(a[9],0,255,true)),"Track not found")
    local it=assert(reaper.GetTrackMediaItem(t,number(a[10],0,9999,true)),"Item not found")
    local take=assert(reaper.GetActiveTake(it),"Take not found")
    local view=item_view(p,it)
    assert(reaper.CountTakes(it)==1,"Multiple-take items unsupported")
    assert(view.isMidi and view.takeGuid==a[11],"MIDI take identity mismatch")
    -- REAPER creates new clips with loop-source enabled, even when not extended.
    -- Reject actual looping rather than that default checkbox alone.
    local source=reaper.GetMediaItemTake_Source(take)
    local length,isqn=reaper.GetMediaSourceLength(source)
    assert(isqn and reaper.GetMediaSourceFileName(source,'')=='',"Only embedded MIDI is editable")
    local offset=reaper.GetMediaItemTakeInfo_Value(take,'D_STARTOFFS')
    assert(offset==0 and reaper.GetMediaItemTakeInfo_Value(take,'D_PLAYRATE')==1,"Offset or rate-adjusted take unsupported")
    assert(not view.looped or view.lengthBeats<=length+0.000001,"Looped MIDI unsupported")
    local ok,chunk=reaper.GetItemStateChunk(it,'',false);assert(ok,"Cannot inspect MIDI pooling")
    assert(#chunk<=4000000,"MIDI item chunk limit")
    local pool=chunk:match('POOLEDEVTS%s+(%b{})')
    if pool then
      assert(reaper.CountMediaItems(p)<=10000,"Pooling scan limit")
      local occurrences=0
      for j=0,reaper.CountMediaItems(p)-1 do
        local yes,c=reaper.GetItemStateChunk(reaper.GetMediaItem(p,j),'',false);assert(yes,"Cannot inspect MIDI pooling")
        assert(#c<=4000000,"Pooling scan chunk limit")
        for id in c:gmatch('POOLEDEVTS%s+(%b{})') do if id==pool then occurrences=occurrences+1 end end
      end
      assert(occurrences==1,"Pooled MIDI unsupported; unpool before editing")
    end
    local _,nc,cc=reaper.MIDI_CountEvts(take);assert(nc<=10000 and cc<=10000,"Event limit")
    local edits,seen,ramps={},{},{}
    local function readnote(index)
      local i=number(index,0,nc-1,true);assert(not seen[i],"Duplicate note index");seen[i]=true
      local yes,sel,mute,b,e,ch,pitch,vel=reaper.MIDI_GetNote(take,i);assert(yes,"Note missing")
      return {i=i,sel=sel,mute=mute,b=b,e=e,ch=ch,pitch=pitch,vel=vel}
    end
    for row in (assert(a[12])..';'):gmatch('(.-);') do if row~='' then
      local i,b,d,pitch,vel,ch=row:match('^([^,]+),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*)$')
      local n=readnote(i)
      local oldb=reaper.MIDI_GetProjQNFromPPQPos(take,n.b)
      local duration=reaper.MIDI_GetProjQNFromPPQPos(take,n.e)-oldb
      local start=b~='' and number(b,0,view.lengthBeats) or oldb-view.startBeat
      duration=d~='' and number(d,0.000001,view.lengthBeats) or duration
      assert(start>=0 and start+duration<=view.lengthBeats+0.0000001,"Edited note outside item")
      n.b=reaper.MIDI_GetPPQPosFromProjQN(take,view.startBeat+start)
      n.e=reaper.MIDI_GetPPQPosFromProjQN(take,view.startBeat+start+duration)
      assert(n.e-n.b>=1,"Edited note shorter than one MIDI tick")
      if pitch~='' then n.pitch=number(pitch,0,127,true) end
      if vel~='' then n.vel=number(vel,1,127,true) end
      if ch~='' then n.ch=number(ch,0,15,true) end
      edits[#edits+1]=n
    end end
    for row in (assert(a[13])..';'):gmatch('(.-);') do if row~='' then
      local i,from,to=row:match('^([^,]+),([^,]+),([^,]+)$');local n=readnote(i)
      assert(n.pitch==number(from,0,127,true) and n.vel==1,"Existing note is not the expected catalogue keyswitch")
      n.pitch=number(to,0,127,true);edits[#edits+1]=n
    end end
    local total=#edits
    for row in (assert(a[14])..';'):gmatch('(.-);') do if row~='' then
      local b,e,c,v,w,steps,ch=row:match('^([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+)$')
      local r={b=number(b,0,view.lengthBeats),e=number(e,0,view.lengthBeats),cc=number(c,0,127,true),v=number(v,0,127,true),w=number(w,0,127,true),steps=number(steps,1,64,true),ch=number(ch,0,15,true)}
      assert(r.e>r.b and r.e<view.lengthBeats,"Ramp outside item")
      r.b=reaper.MIDI_GetPPQPosFromProjQN(take,view.startBeat+r.b)
      r.e=reaper.MIDI_GetPPQPosFromProjQN(take,view.startBeat+r.e)
      assert((r.e-r.b)/r.steps>=1,"Ramp samples collide at MIDI tick resolution")
      for _,q in ipairs(ramps) do assert(q.ch~=r.ch or q.cc~=r.cc or q.e<r.b or r.e<q.b,"Overlapping ramps") end
      total=total+r.steps+1;ramps[#ramps+1]=r
    end end
    assert(total>0 and total<=128,"Edit limit")
    result.editedNotes=#edits;result.replacedControllerRanges=#ramps
    perform=function()
      local saved,raw=reaper.MIDI_GetAllEvts(take,'');assert(saved,"Cannot snapshot MIDI")
      local success,err=pcall(function()
        for _,n in ipairs(edits) do assert(reaper.MIDI_SetNote(take,n.i,n.sel,n.mute,n.b,n.e,n.ch,n.pitch,n.vel,true),"Note edit failed") end
        for i=cc-1,0,-1 do
          local yes,sel,mute,pos,msg,ch,c=reaper.MIDI_GetCC(take,i)
          for _,r in ipairs(ramps) do if yes and msg==176 and ch==r.ch and c==r.cc and pos>=r.b-0.5 and pos<=r.e+0.5 then assert(reaper.MIDI_DeleteCC(take,i));break end end
        end
        for _,r in ipairs(ramps) do for j=0,r.steps do
          assert(reaper.MIDI_InsertCC(take,false,false,r.b+(r.e-r.b)*j/r.steps,176,r.ch,r.cc,math.floor(r.v+(r.w-r.v)*j/r.steps+0.5)))
        end end
        reaper.MIDI_Sort(take)
      end)
      if not success then assert(reaper.MIDI_SetAllEvts(take,raw),"MIDI rollback failed");error(err) end
      reaper.UpdateItemInProject(it)
    end
  elseif action=="live_add_track" then
    local name=a[9];assert(name and #name<=800 and not name:find('[%z\r\n]'),"Invalid name")
    local index=reaper.CountTracks(p);assert(index<256,"Track limit")
    result.index=index
    perform=function()
      reaper.InsertTrackAtIndex(index,false)
      local t=assert(reaper.GetTrack(p,index));reaper.GetSetMediaTrackInfo_String(t,'P_NAME',name,true)
      result.track=track_view(t)
    end
  elseif action=="live_insert_instrument" or action=="live_insert_midi" or action=="live_insert_performance" then
    local index=number(a[9],0,255,true);local t=assert(reaper.GetTrack(p,index),"Track not found")
    if action=="live_insert_instrument" then
      assert(reaper.TrackFX_GetCount(t)<128,"FX limit")
      assert(reaper.TrackFX_GetInstrument(t)<0,"Track already has an instrument; use a fresh track")
      local plugin,preset=a[10],a[11];local found
      for i=0,10000 do local ok,name,ident=reaper.EnumInstalledFX(i);if not ok then break end;if name==plugin or ident==plugin then found=ident;break end end
      assert(found,"Plugin not installed/scanned; read /plugins")
      if preset~='' then local f=assert(io.open(preset,'rb'),"Preset missing");f:close() end
      perform=function()
        local fx=reaper.TrackFX_AddByName(t,found,false,-1);assert(fx>=0,"Plugin failed to load")
        if reaper.TrackFX_GetOffline(t,fx) or (preset~='' and not reaper.TrackFX_SetPreset(t,fx,preset)) then
          reaper.TrackFX_Delete(t,fx);error("Plugin/preset failed; inserted FX removed")
        end
        result.fx=fx;local _,name=reaper.TrackFX_GetFXName(t,fx);result.name=name
      end
    else
      local name,start,length=a[10],number(a[11],0,100000),number(a[12],0.000001,10000)
      assert(name and #name<=800 and not name:find('[%z\r\n]'),"Invalid item name")
      assert(reaper.CountTrackMediaItems(t)<10000,"Item limit")
      local notes={}
      for row in (a[13]..';'):gmatch('(.-);') do
        if row~='' then
        local b,d,pitch,velocity,channel=row:match('^([^,]+),([^,]+),([^,]+),([^,]+),([^,]+)$')
        local n={number(b,0,length),number(d,0.000001,length),number(pitch,0,127,true),number(velocity,1,127,true),number(channel,0,15,true)}
        assert(n[1]+n[2]<=length+0.00000001,"Note outside item");notes[#notes+1]=n
        end
      end
      local controllers={}
      if action=="live_insert_performance" then
        assert(a[14],"Missing controller field")
        local positions={}
        for row in (a[14]..';'):gmatch('(.-);') do
          if row~='' then
            local b,cc,value,channel=row:match('^([^,]+),([^,]+),([^,]+),([^,]+)$')
            local e={number(b,0,length),number(cc,0,127,true),number(value,0,127,true),number(channel,0,15,true)}
            assert(e[1]<length,"Controller outside item")
            local key=tostring(e[1])..':'..e[2]..':'..e[4];assert(not positions[key],"Conflicting controller events");positions[key]=true
            controllers[#controllers+1]=e
          end
        end
      else assert(#notes>=1,"Note limit") end
      assert(#notes+#controllers>=1 and #notes+#controllers<=128,"Event limit")
      result.noteCount=#notes
      result.controllerCount=#controllers
      perform=function()
        local item=assert(reaper.CreateNewMIDIItemInProj(t,reaper.TimeMap2_QNToTime(p,start),reaper.TimeMap2_QNToTime(p,start+length),false))
        local ok,err=pcall(function()
          local take=assert(reaper.GetActiveTake(item))
          reaper.GetSetMediaItemTakeInfo_String(take,'P_NAME',name,true)
          for _,e in ipairs(controllers) do
            assert(reaper.MIDI_InsertCC(take,false,false,reaper.MIDI_GetPPQPosFromProjQN(take,start+e[1]),176,e[4],e[2],e[3]))
          end
          for _,n in ipairs(notes) do
            assert(reaper.MIDI_InsertNote(take,false,false,reaper.MIDI_GetPPQPosFromProjQN(take,start+n[1]),reaper.MIDI_GetPPQPosFromProjQN(take,start+n[1]+n[2]),n[5],n[3],n[4],true))
          end
          reaper.MIDI_Sort(take)
          result.itemCount=reaper.CountTrackMediaItems(t)
        end)
        if not ok then reaper.DeleteTrackMediaItem(t,item);error(err) end
      end
    end
  else error("Unknown music operation") end
  if dry=="0" then
    local useundo=action:match('^live_')~=nil and action~='live_revert_fx_edit'
    if useundo then reaper.Undo_BeginBlock2(p) end
    local ok,err=pcall(perform)
    if useundo then reaper.Undo_EndBlock2(p,undo_label,-1) end
    reaper.UpdateArrange();assert(ok,err)
  end
  local _,identity,revision=current();result.project=identity;result.revision=revision
  if action=="live_set_fx_parameter" and result.after and result.before.normalized~=result.after.normalized
    and reaper.Undo_CanUndo2(p)==undo_label then
    result.undoToken=session..':'..fx_edit_count
    fx_undo={token=result.undoToken,label=undo_label,project=identity,revision=revision}
  end
  return result
end

local function execute(a)
  assert(a[1]=="2","Unsupported protocol")
  assert(tonumber(a[3]) and os.time()*1000 < tonumber(a[3])-1000,"Request expired")
  local p,identity,revision=current()
  if a[4]=="ping" then return {protocol=2,project=identity,revision=revision,writes=os.getenv("REAPER_MCP_ALLOW_WRITES")=="true"} end
  if a[4]=="get" then return {project=identity,revision=revision,value=get_value(p,a[5])} end
  assert(a[4]=="set" or a[4]=="music","Unsupported operation")
  assert(os.getenv("REAPER_MCP_ALLOW_WRITES")=="true","Bridge writes disabled")
  assert(a[5]==identity,"Project changed or bridge restarted; read again")
  assert(tonumber(a[6])==revision,"Project changed since read; inspect before editing")
  if a[4]=="music" then return music(p,a) end
  local index=tonumber(a[7]); assert(index and index%1==0 and index>=0 and index<=255,"Invalid track")
  local t=reaper.GetTrack(p,index); assert(t,"Track not found")
  local field,value,dry=a[8],a[9],a[10]
  assert(dry=="0" or dry=="1","Invalid dryRun")
  local param
  if field=="name" then assert(#value<=800 and not value:find('[%z\r\n]'),"Invalid name")
  elseif field=="mute" then assert(value=="true" or value=="false","Invalid mute"); param="B_MUTE"; value=value=="true" and 1 or 0
  else
    value=tonumber(value); assert(value and value==value,"Invalid value")
    if field=="volume_db" then assert(value>=-150 and value<=24,"Invalid gain"); param="D_VOL"; value=10^(value/20)
    elseif field=="pan" then assert(value>=-1 and value<=1,"Invalid pan"); param="D_PAN"
    else error("Unsupported live field") end
  end
  if dry=="0" then
    reaper.Undo_BeginBlock2(p)
    local ok,err=pcall(function()
      if field=="name" then assert(reaper.GetSetMediaTrackInfo_String(t,"P_NAME",value,true))
      else assert(reaper.SetMediaTrackInfo_Value(t,param,value)) end
    end)
    reaper.Undo_EndBlock2(p,"REAPER MCP: set "..field,-1)
    reaper.UpdateArrange()
    assert(ok,"Mutation failed; inspect state and undo before retrying")
  end
  return {project=identity,revision=reaper.GetProjectStateChangeCount(p),dryRun=dry=="1",track=track_view(t)}
end
-- A second script in the same REAPER process must not race the first reader.
local lease_key = root
local existing = tonumber(reaper.GetExtState("REAPER_MCP_LEASE", lease_key))
if existing and reaper.time_precise() - existing < 3 then
  reaper.ShowConsoleMsg("REAPER MCP already running for this directory\n")
  return
end
reaper.atexit(function() reaper.DeleteExtState("REAPER_MCP_LEASE", lease_key, false) end)
local last_heartbeat = 0
local function loop()
  current()
  reaper.SetExtState("REAPER_MCP_LEASE", lease_key, tostring(reaper.time_precise()), false)
  if reaper.time_precise() - last_heartbeat > 1 then
    -- Windows Lua rename cannot replace an existing file. Readers tolerate the short gap.
    os.remove(root.."/heartbeat.json")
    atomic("heartbeat.json", json({protocol=2,session=session,time=os.time(),writes=os.getenv("REAPER_MCP_ALLOW_WRITES")=="true"}))
    last_heartbeat=reaper.time_precise()
  end
  -- At most one bounded operation per defer tick. Unique files avoid a poisoned shared slot.
  reaper.EnumerateFiles(root,-1)
  local index=0
  while index<512 do
    local name=reaper.EnumerateFiles(root,index)
    if not name then break end
    if name:match("^[0-9a-f%-]+%.request$") then
      local claimed=root.."/"..name..".working"
      if os.rename(root.."/"..name,claimed) then
        local f=io.open(claimed,"rb")
        local raw=f and f:read(16385) or ""
        if f then f:close() end
        os.remove(claimed)
        local a={};local valid=#raw>0 and #raw<=16384
        for line in raw:gmatch("([^\n]*)\n") do
          if #line%2~=0 or line:find("[^0-9a-f]") then valid=false end
          a[#a+1]=line:gsub("..",function(h) return string.char(tonumber(h,16) or 0) end)
        end
        if valid and a[2] and #a[2]==36 and name==a[2]..".request" then
          local ok,result=pcall(execute,a)
          -- Native plugin/project loads can block the UI thread. Refresh liveness
          -- before replying so the next serialized request does not see a stale heartbeat.
          os.remove(root.."/heartbeat.json")
          atomic("heartbeat.json",json({protocol=2,session=session,time=os.time(),writes=os.getenv("REAPER_MCP_ALLOW_WRITES")=="true"}))
          last_heartbeat=reaper.time_precise()
          if os.time()*1000 < tonumber(a[3]) then atomic(a[2]..".json",json({id=a[2],ok=ok,result=ok and result or nil,error=not ok and tostring(result):sub(1,300) or nil})) end
        end
      end
      break
    end
    index=index+1
  end
end
local last_error
local function guarded_loop()
  local ok,err=pcall(loop)
  if not ok and tostring(err)~=last_error then
    last_error=tostring(err)
    reaper.ShowConsoleMsg("REAPER MCP retryable I/O error: "..last_error.."\n")
  end
  reaper.defer(guarded_loop)
end
reaper.defer(guarded_loop)
