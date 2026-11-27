-- REAPER MCP protocol 3. Native APIs only; no sockets, eval or extensions.
-- JSON requests, a handler registry, track GUID addressing and batch transactions.
-- Set REAPER_MCP_BRIDGE_DIR before launching REAPER, or use the resource subfolder.
local root = os.getenv("REAPER_MCP_BRIDGE_DIR") or (reaper.GetResourcePath() .. "/reaper-mcp-bridge")
reaper.RecursiveCreateDirectory(root, 0)
local PROTOCOL = 3
local MAX_REQUEST = 1048576
local MAX_EVENTS = 2048
local MAX_BATCH = 64
local session = tostring(reaper.time_precise()) .. ":" .. tostring({})
local function writes_enabled() return os.getenv("REAPER_MCP_ALLOW_WRITES")=="true" end

-- JSON ------------------------------------------------------------------
local function quote(s)
  return '"' .. tostring(s):gsub('[%z\1-\31\\"]', function(c)
    return string.format('\\u%04x', string.byte(c))
  end) .. '"'
end
local function json(v)
  if type(v)=="string" then return quote(v) end
  if type(v)=="number" then
    if v~=v or v==math.huge or v==-math.huge then return "null" end
    return tostring(v)
  end
  if type(v)=="boolean" then return tostring(v) end
  if type(v)~="table" then return "null" end
  local parts={}
  if v.__array then
    for i=1,#v do parts[#parts+1]=json(v[i]) end
    return "["..table.concat(parts,",").."]"
  end
  for k,val in pairs(v) do parts[#parts+1]=quote(k)..":"..json(val) end
  return "{"..table.concat(parts,",").."}"
end
local escapes={['"']='"',['\\']='\\',['/']='/',b='\b',f='\f',n='\n',r='\r',t='\t'}
-- Strict decoder for requests written by the Node client. null is rejected: omit absent fields.
local function decode(s)
  local pos,depth=1,0
  local function fail(m) error("Invalid JSON: "..m,0) end
  local function ws() pos=s:find("[^ \t\r\n]",pos) or #s+1 end
  local function str()
    pos=pos+1
    local out={}
    while true do
      local stop=s:find('["\\]',pos) or fail("unterminated string")
      if stop>pos then out[#out+1]=s:sub(pos,stop-1) end
      pos=stop
      if s:sub(pos,pos)=='"' then pos=pos+1; return table.concat(out) end
      local e=s:sub(pos+1,pos+1)
      if e=="u" then
        local cp=tonumber(s:sub(pos+2,pos+5),16) or fail("escape")
        pos=pos+6
        if cp>=0xD800 and cp<=0xDBFF then
          local lo=s:sub(pos,pos+1)=="\\u" and tonumber(s:sub(pos+2,pos+5),16)
          if not lo or lo<0xDC00 or lo>0xDFFF then fail("surrogate") end
          cp=0x10000+(cp-0xD800)*0x400+(lo-0xDC00); pos=pos+6
        elseif cp>=0xDC00 and cp<=0xDFFF then fail("surrogate") end
        out[#out+1]=utf8.char(cp)
      else
        out[#out+1]=escapes[e] or fail("escape"); pos=pos+2
      end
    end
  end
  local value
  function value()
    ws()
    local c=s:sub(pos,pos)
    if c=='"' then return str() end
    if c=="{" or c=="[" then
      depth=depth+1; if depth>16 then fail("depth") end
      local t,close={},c=="{" and "}" or "]"
      pos=pos+1; ws()
      if s:sub(pos,pos)==close then pos=pos+1; depth=depth-1; return t end
      while true do
        if c=="{" then
          ws(); if s:sub(pos,pos)~='"' then fail("key") end
          local k=str(); ws()
          if s:sub(pos,pos)~=":" then fail("colon") end
          pos=pos+1; t[k]=value()
        else t[#t+1]=value() end
        ws()
        local d=s:sub(pos,pos); pos=pos+1
        if d==close then depth=depth-1; return t end
        if d~="," then fail("separator") end
      end
    end
    if s:sub(pos,pos+3)=="true" then pos=pos+4; return true end
    if s:sub(pos,pos+4)=="false" then pos=pos+5; return false end
    local text=s:match("^-?%d+%.?%d*[eE]?[+-]?%d*",pos)
    local n=text and tonumber(text) or fail("value")
    pos=pos+#text
    return n
  end
  local v=value(); ws()
  if pos<=#s then fail("trailing data") end
  return v
end
local function clean(err) return (tostring(err):gsub("^.-:%d+: ","")):sub(1,300) end

-- Files and project identity --------------------------------------------
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

-- Argument validation ----------------------------------------------------
local function num(v,lo,hi,integer)
  assert(type(v)=="number" and v==v and v>=lo and v<=hi and (not integer or v%1==0),"Invalid number")
  return v
end
local function text(v,message,max)
  assert(type(v)=="string" and #v<=(max or 800) and not v:find('[%z\r\n]'),message or "Invalid text")
  return v
end
local function list(v,max)
  if v==nil then return {} end
  assert(type(v)=="table" and #v<=max,"List limit")
  return v
end
-- A track reference is a zero-based index or the track GUID in braces.
local function resolve_track(p,ref,missing)
  if type(ref)=="number" then
    num(ref,0,255,true)
    return assert(reaper.GetTrack(p,ref),missing or "Track not found"),ref
  end
  assert(type(ref)=="string" and ref:match("^{[%x%-]+}$"),"Invalid track reference")
  local wanted=ref:upper()
  for i=0,reaper.CountTracks(p)-1 do
    local t=reaper.GetTrack(p,i)
    if reaper.GetTrackGUID(t):upper()==wanted then return t,i end
  end
  error(missing or "Track not found",0)
end

-- Views -------------------------------------------------------------------
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
local function track_fx(p, track_ref, fx)
  local t=resolve_track(p,track_ref)
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

-- Reads -------------------------------------------------------------------
local function get_value(p, object_path)
  -- /tracks/{GUID}/... addresses the same objects as /tracks/<index>/...
  local guid,rest=object_path:match("^/tracks/({[%x%-]+})(.*)$")
  if guid then
    local _,resolved=resolve_track(p,guid)
    object_path="/tracks/"..resolved..rest
  end
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
  if vt then return item_view(p,assert(reaper.GetTrackMediaItem(assert(reaper.GetTrack(p,tonumber(vt)),"Track not found"),tonumber(vi)),"Item not found")) end

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

-- Handler registry --------------------------------------------------------
-- A handler validates its named arguments against the live project, fills the
-- preview fields of `result` and returns the function that performs the edit.
-- undo: wrap in one native undo block. batch: may run as a step of a transaction.
local handlers={}
local function define(name,options,fn) handlers[name]={fn=fn,undo=options.undo,batch=options.batch} end
local fx_undo, fx_edit_count = nil, 0

define("set_track",{undo=true,batch=true},function(p,a,result)
  local t=resolve_track(p,a.track)
  local field,value=a.field,a.value
  local param
  if field=="name" then text(value,"Invalid name")
  elseif field=="mute" then assert(type(value)=="boolean","Invalid mute"); param="B_MUTE"; value=value and 1 or 0
  elseif field=="volume_db" then assert(type(value)=="number" and value>=-150 and value<=24,"Invalid gain"); param="D_VOL"; value=10^(value/20)
  elseif field=="pan" then assert(type(value)=="number" and value>=-1 and value<=1,"Invalid pan"); param="D_PAN"
  else error("Unsupported live field",0) end
  result.track=track_view(t)
  return function()
    local ok=pcall(function()
      if field=="name" then assert(reaper.GetSetMediaTrackInfo_String(t,"P_NAME",value,true))
      else assert(reaper.SetMediaTrackInfo_Value(t,param,value)) end
    end)
    assert(ok,"Mutation failed; inspect state and undo before retrying")
    result.track=track_view(t)
  end
end)

define("live_edit_fx_envelope_point",{undo=true,batch=true},function(p,a,result)
  assert(reaper.GetPlayStateEx(p)==0,"Stop transport before editing automation")
  local fx=num(a.fx,0,9999,true)
  local t=track_fx(p,a.track,fx)
  assert(reaper.TrackFX_GetFXGUID(t,fx)==a.fxGuid,"FX identity changed")
  local param=num(a.parameter,0,reaper.TrackFX_GetNumParams(t,fx)-1,true)
  local _,minimum,maximum=reaper.TrackFX_GetParam(t,fx,param)
  local env=assert(reaper.GetFXEnvelope(t,fx,param,false),"Existing FX envelope required")
  assert(minimum==0 and maximum==1 and reaper.GetEnvelopeScalingMode(env)==0,"Requires an unscaled 0-1 parameter")
  assert(reaper.CountAutomationItems(env)==0,"Envelope with automation items unsupported")
  local index=num(a.point,1,reaper.CountEnvelopePoints(env)-2,true)
  local left,point,right=envelope_point(env,index-1),envelope_point(env,index),envelope_point(env,index+1)
  assert(math.abs(point.timeSeconds-num(a.timeSeconds,0,86400))<0.0000001,"Point time changed")
  assert(left.timeSeconds<point.timeSeconds and point.timeSeconds<right.timeSeconds,"Distinct anchors required")
  assert(left.shape<=1 and point.shape<=1,"Only linear and square segments supported")
  if index>=2 then assert(envelope_point(env,index-2).shape<=1,"Curved outer anchor unsupported") end
  assert(right.shape<=1,"Curved outer anchor unsupported")
  result.before=point;result.startSeconds=left.timeSeconds;result.endSeconds=right.timeSeconds
  result.requested=num(a.normalized,0,1)
  return function()
    assert(reaper.SetEnvelopePoint(env,index,point.timeSeconds,result.requested,point.shape,point.tension,point.selected,false),"Envelope write failed")
    result.after=envelope_point(env,index)
  end
end)

define("live_add_send",{undo=true,batch=true},function(p,a,result)
  local src=resolve_track(p,a.source,"Source not found")
  local dest=resolve_track(p,a.destination,"Destination not found")
  assert(reaper.GetTrackGUID(src)==a.sourceGuid and reaper.GetTrackGUID(dest)==a.destinationGuid,"Track identity changed")
  assert(a.pair=="1/2" or a.pair=="3/4","Unknown destination pair")
  local dstchan=a.pair=="3/4" and 2 or 0
  local gain=10^(num(a.gainDb,-150,12)/20)
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
  return function()
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
      error(err,0)
    end
    result.index=send
  end
end)

define("live_revert_fx_edit",{},function(p,a,result)
  local _,identity,revision=current()
  assert(fx_undo and fx_undo.token==a.undoToken and fx_undo.project==identity and fx_undo.revision==revision
    and reaper.Undo_CanUndo2(p)==fx_undo.label,"FX edit is no longer the current undo step")
  return function()
    assert(reaper.Undo_DoUndo2(p)~=0,"REAPER could not undo the edit")
    fx_undo=nil
  end
end)

define("live_set_fx_parameter",{undo=true,batch=true},function(p,a,result,ctx)
  local fx=num(a.fx,0,2147483647,true)
  local t=track_fx(p,a.track,fx)
  assert(reaper.TrackFX_GetFXGUID(t,fx)==a.fxGuid,"FX identity changed; inspect the chain again")
  local index=num(a.parameter,0,2147483647,true)
  result.before=fx_parameter(t,fx,index)
  result.requested=num(a.normalized,0,1,false)
  if not ctx.dry and not ctx.batch then
    -- A numbered label lets a later revert prove this exact edit is still the undo head.
    fx_edit_count=fx_edit_count+1
    ctx.label=ctx.label..' #'..fx_edit_count
    ctx.after=function(identity,revision)
      if result.after and result.before.normalized~=result.after.normalized and reaper.Undo_CanUndo2(p)==ctx.label then
        result.undoToken=session..':'..fx_edit_count
        fx_undo={token=result.undoToken,label=ctx.label,project=identity,revision=revision}
      end
    end
  end
  return function()
    assert(reaper.TrackFX_SetParamNormalized(t,fx,index,result.requested),"Plugin rejected parameter")
    reaper.TrackFX_EndParamEdit(t,fx,index)
    result.after=fx_parameter(t,fx,index)
  end
end)

define("project_new",{},function(p,a)
  local tempo=num(a.tempo,20,300)
  return function() reaper.Main_OnCommand(40859,0); reaper.SetCurrentBPM(0,tempo,true) end
end)

local function project_file(a,result)
  local filename=a.file
  assert(type(filename)=="string" and filename:lower():match('%.rpp$') and not filename:find('[%z\r\n]'),"Invalid project filename")
  result.file=filename
  return filename
end
define("project_open",{},function(p,a,result)
  local filename=project_file(a,result)
  local f=assert(io.open(filename,"rb"),"Project missing");f:close()
  return function() reaper.Main_OnCommand(40859,0); reaper.Main_openProject(filename) end
end)
define("project_save",{},function(p,a,result)
  local filename=project_file(a,result)
  local f=assert(io.open(filename,"rb"),"Output reservation missing");local size=f:seek('end');f:close();assert(size==0,"Output exists")
  return function() reaper.Main_SaveProjectEx(p,filename,8) end
end)
-- Writes a render-ready copy of the project without changing the user's render settings.
define("snapshot",{},function(p,a,result)
  local filename=project_file(a,result)
  local folder=text(a.folder,"Invalid folder",4096)
  assert(reaper.GetProjectLength(p)>0,"Project contains no renderable timeline")
  local startpos,endpos=0,reaper.GetProjectLength(p)+2
  local stem
  if a.stemTrack~=nil then
    stem=resolve_track(p,a.stemTrack,"Stem track not found")
    assert(reaper.GetTrackGUID(stem)==a.stemGuid,"Stem track identity changed")
    result.stemGuid=a.stemGuid
  end
  if a.section~=nil then
    assert(type(a.section)=="table","Invalid section")
    local first,last=num(a.section.startBeat,0,100000),num(a.section.endBeat,0,100000)
    assert(last>first,"Invalid section")
    startpos=reaper.TimeMap2_QNToTime(p,first)
    endpos=reaper.TimeMap2_QNToTime(p,last)+num(a.section.tailSeconds or 0,0,30)
    assert(startpos<reaper.GetProjectLength(p),"Section starts beyond project")
  end
  result.startSeconds=startpos;result.endSeconds=endpos
  return function()
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
end)

define("live_edit_performance",{undo=true,batch=true},function(p,a,result)
  local t=resolve_track(p,a.track)
  local it=assert(reaper.GetTrackMediaItem(t,num(a.item,0,9999,true)),"Item not found")
  local take=assert(reaper.GetActiveTake(it),"Take not found")
  local view=item_view(p,it)
  assert(reaper.CountTakes(it)==1,"Multiple-take items unsupported")
  assert(view.isMidi and view.takeGuid==a.takeGuid,"MIDI take identity mismatch")
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
    local i=num(index,0,nc-1,true);assert(not seen[i],"Duplicate note index");seen[i]=true
    local yes,sel,mute,b,e,ch,pitch,vel=reaper.MIDI_GetNote(take,i);assert(yes,"Note missing")
    return {i=i,sel=sel,mute=mute,b=b,e=e,ch=ch,pitch=pitch,vel=vel}
  end
  for _,e in ipairs(list(a.notes,MAX_EVENTS)) do
    local n=readnote(e.index)
    local oldb=reaper.MIDI_GetProjQNFromPPQPos(take,n.b)
    local duration=reaper.MIDI_GetProjQNFromPPQPos(take,n.e)-oldb
    local start=e.beat~=nil and num(e.beat,0,view.lengthBeats) or oldb-view.startBeat
    if e.duration~=nil then duration=num(e.duration,0.000001,view.lengthBeats) end
    assert(start>=0 and start+duration<=view.lengthBeats+0.0000001,"Edited note outside item")
    n.b=reaper.MIDI_GetPPQPosFromProjQN(take,view.startBeat+start)
    n.e=reaper.MIDI_GetPPQPosFromProjQN(take,view.startBeat+start+duration)
    assert(n.e-n.b>=1,"Edited note shorter than one MIDI tick")
    if e.pitch~=nil then n.pitch=num(e.pitch,0,127,true) end
    if e.velocity~=nil then n.vel=num(e.velocity,1,127,true) end
    if e.channel~=nil then n.ch=num(e.channel,0,15,true) end
    edits[#edits+1]=n
  end
  for _,e in ipairs(list(a.articulations,MAX_EVENTS)) do
    local n=readnote(e.index)
    assert(n.pitch==num(e.from,0,127,true) and n.vel==1,"Existing note is not the expected catalogue keyswitch")
    n.pitch=num(e.to,0,127,true);edits[#edits+1]=n
  end
  local total=#edits
  for _,e in ipairs(list(a.ramps,64)) do
    local r={b=num(e.startBeat,0,view.lengthBeats),e=num(e.endBeat,0,view.lengthBeats),cc=num(e.controller,0,127,true),
      v=num(e.startValue,0,127,true),w=num(e.endValue,0,127,true),steps=num(e.steps,1,64,true),ch=num(e.channel,0,15,true)}
    assert(r.e>r.b and r.e<view.lengthBeats,"Ramp outside item")
    r.b=reaper.MIDI_GetPPQPosFromProjQN(take,view.startBeat+r.b)
    r.e=reaper.MIDI_GetPPQPosFromProjQN(take,view.startBeat+r.e)
    assert((r.e-r.b)/r.steps>=1,"Ramp samples collide at MIDI tick resolution")
    for _,q in ipairs(ramps) do assert(q.ch~=r.ch or q.cc~=r.cc or q.e<r.b or r.e<q.b,"Overlapping ramps") end
    total=total+r.steps+1;ramps[#ramps+1]=r
  end
  assert(total>0 and total<=MAX_EVENTS,"Edit limit")
  result.editedNotes=#edits;result.replacedControllerRanges=#ramps
  return function()
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
    if not success then assert(reaper.MIDI_SetAllEvts(take,raw),"MIDI rollback failed");error(err,0) end
    reaper.UpdateItemInProject(it)
  end
end)

define("live_add_track",{undo=true,batch=true},function(p,a,result)
  local name=text(a.name,"Invalid name")
  local index=reaper.CountTracks(p);assert(index<256,"Track limit")
  result.index=index
  return function()
    reaper.InsertTrackAtIndex(index,false)
    local t=assert(reaper.GetTrack(p,index));reaper.GetSetMediaTrackInfo_String(t,'P_NAME',name,true)
    result.track=track_view(t)
  end
end)

define("live_insert_instrument",{undo=true,batch=true},function(p,a,result)
  local t=resolve_track(p,a.track)
  assert(reaper.TrackFX_GetCount(t)<128,"FX limit")
  assert(reaper.TrackFX_GetInstrument(t)<0,"Track already has an instrument; use a fresh track")
  local plugin,preset=text(a.plugin,"Invalid plugin"),a.preset
  local found
  for i=0,10000 do local ok,name,ident=reaper.EnumInstalledFX(i);if not ok then break end;if name==plugin or ident==plugin then found=ident;break end end
  assert(found,"Plugin not installed/scanned; read /plugins")
  if preset~=nil then
    text(preset,"Invalid preset",4096)
    local f=assert(io.open(preset,'rb'),"Preset missing");f:close()
  end
  return function()
    local fx=reaper.TrackFX_AddByName(t,found,false,-1);assert(fx>=0,"Plugin failed to load")
    if reaper.TrackFX_GetOffline(t,fx) or (preset~=nil and not reaper.TrackFX_SetPreset(t,fx,preset)) then
      reaper.TrackFX_Delete(t,fx);error("Plugin/preset failed; inserted FX removed",0)
    end
    result.fx=fx;local _,name=reaper.TrackFX_GetFXName(t,fx);result.name=name
  end
end)

local function insert_clip(with_controllers)
  return function(p,a,result)
    local t=resolve_track(p,a.track)
    local name=text(a.name,"Invalid item name")
    local start,length=num(a.startBeat,0,100000),num(a.lengthBeats,0.000001,10000)
    assert(reaper.CountTrackMediaItems(t)<10000,"Item limit")
    local notes={}
    for _,e in ipairs(list(a.notes,MAX_EVENTS)) do
      local n={num(e.beat,0,length),num(e.duration,0.000001,length),num(e.pitch,0,127,true),num(e.velocity,1,127,true),num(e.channel,0,15,true)}
      assert(n[1]+n[2]<=length+0.00000001,"Note outside item");notes[#notes+1]=n
    end
    local controllers={}
    if with_controllers then
      local positions={}
      for _,c in ipairs(list(a.controllers,MAX_EVENTS)) do
        local e={num(c.beat,0,length),num(c.controller,0,127,true),num(c.value,0,127,true),num(c.channel,0,15,true)}
        assert(e[1]<length,"Controller outside item")
        local key=tostring(e[1])..':'..e[2]..':'..e[4];assert(not positions[key],"Conflicting controller events");positions[key]=true
        controllers[#controllers+1]=e
      end
    else assert(#notes>=1,"Note limit") end
    assert(#notes+#controllers>=1 and #notes+#controllers<=MAX_EVENTS,"Event limit")
    result.noteCount=#notes
    result.controllerCount=#controllers
    return function()
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
      if not ok then reaper.DeleteTrackMediaItem(t,item);error(err,0) end
    end
  end
end
define("live_insert_midi",{undo=true,batch=true},insert_clip(false))
define("live_insert_performance",{undo=true,batch=true},insert_clip(true))

-- Execution -----------------------------------------------------------------
local function call(p,req)
  local action,dry=req.action,req.dryRun==true
  local h=handlers[action]
  assert(h,"Unknown live operation")
  local args=req.args==nil and {} or req.args
  assert(type(args)=="table","Invalid arguments")
  local result={dryRun=dry,action=action}
  local ctx={label='REAPER MCP: '..action,dry=dry}
  local perform=h.fn(p,args,result,ctx)
  if not dry then
    if h.undo then reaper.Undo_BeginBlock2(p) end
    local ok,err=pcall(perform)
    if h.undo then reaper.Undo_EndBlock2(p,ctx.label,-1) end
    reaper.UpdateArrange()
    if not ok then error(err,0) end
  end
  local _,identity,revision=current();result.project=identity;result.revision=revision
  if ctx.after then ctx.after(identity,revision) end
  return result
end

-- All steps share one undo block. A failed step undoes the earlier ones, so
-- the project is left as it was read. dryRun validates each step against the
-- current project only; a step that depends on an earlier step reports why.
local batch_count=0
local function batch(p,req)
  local steps,dry=req.steps,req.dryRun==true
  assert(type(steps)=="table" and #steps>=1 and #steps<=MAX_BATCH,"Batch requires 1-"..MAX_BATCH.." steps")
  for _,s in ipairs(steps) do
    assert(type(s)=="table" and type(s.action)=="string","Invalid batch step")
    local h=handlers[s.action]
    assert(h and h.batch,"Step cannot run in a batch: "..s.action:sub(1,60))
    assert(s.args==nil or type(s.args)=="table","Invalid arguments")
  end
  local results={__array=true}
  local result={dryRun=dry,action="batch",steps=results}
  if dry then
    result.valid=true
    for i,s in ipairs(steps) do
      local r={action=s.action}
      local ok,err=pcall(handlers[s.action].fn,p,s.args or {},r,{label='',dry=true,batch=true})
      r.valid=ok
      if not ok then r.error=clean(err);result.valid=false end
      results[i]=r
    end
  else
    batch_count=batch_count+1
    local label='REAPER MCP: batch #'..batch_count
    local failed,failure
    reaper.Undo_BeginBlock2(p)
    for i,s in ipairs(steps) do
      local r={action=s.action}
      local ok,err=pcall(function() handlers[s.action].fn(p,s.args or {},r,{label=label,dry=false,batch=true})() end)
      if not ok then failed,failure=i,clean(err);break end
      results[i]=r
    end
    reaper.Undo_EndBlock2(p,label,-1)
    if failed then
      -- REAPER records the block even when the first step failed before changing
      -- anything, so undo it whenever it is the undo head; that also clears a partial step.
      local outcome=failed==1 and "nothing was changed" or "earlier steps were rolled back"
      if reaper.Undo_CanUndo2(p)==label then
        if reaper.Undo_DoUndo2(p)==0 then outcome="ROLLBACK FAILED: undo manually before retrying" end
      elseif failed>1 then outcome="earlier steps left no undo point; inspect the project before retrying" end
      reaper.UpdateArrange()
      error(string.format("Batch step %d (%s) failed: %s; %s",failed,steps[failed].action,failure,outcome),0)
    end
    reaper.UpdateArrange()
    result.undoLabel=label
  end
  local _,identity,revision=current();result.project=identity;result.revision=revision
  return result
end

local function execute(req)
  assert(type(req)=="table" and req.protocol==PROTOCOL,"Unsupported protocol; update the MCP server and bridge together")
  assert(type(req.deadline)=="number" and os.time()*1000 < req.deadline-1000,"Request expired")
  local p,identity,revision=current()
  local op=req.op
  if op=="ping" then return {protocol=PROTOCOL,project=identity,revision=revision,writes=writes_enabled(),
    limits={requestBytes=MAX_REQUEST,events=MAX_EVENTS,batchSteps=MAX_BATCH}} end
  if op=="get" then return {project=identity,revision=revision,value=get_value(p,text(req.path,"Invalid path",512))} end
  assert(op=="call" or op=="batch","Unsupported operation")
  assert(writes_enabled(),"Bridge writes disabled")
  assert(req.project==identity,"Project changed or bridge restarted; read again")
  assert(req.revision==revision,"Project changed since read; inspect before editing")
  if op=="batch" then return batch(p,req) end
  return call(p,req)
end

-- Transport -----------------------------------------------------------------
local function write_heartbeat()
  -- Windows Lua rename cannot replace an existing file. Readers tolerate the short gap.
  os.remove(root.."/heartbeat.json")
  atomic("heartbeat.json", json({protocol=PROTOCOL,session=session,time=os.time(),writes=writes_enabled()}))
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
    write_heartbeat()
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
        local raw=f and f:read(MAX_REQUEST+1) or ""
        if f then f:close() end
        os.remove(claimed)
        local id=name:sub(1,-9)
        if #id==36 then
          local ok,result,deadline
          if #raw==0 or #raw>MAX_REQUEST then ok,result=false,"Request is empty or exceeds 1 MB"
          else
            local parsed,req=pcall(decode,raw)
            if not parsed then ok,result=false,req
            elseif type(req)~="table" or req.id~=id then ok,result=false,"Request ID does not match its file"
            else
              deadline=tonumber(req.deadline)
              ok,result=pcall(execute,req)
            end
          end
          -- Native plugin/project loads can block the UI thread. Refresh liveness
          -- before replying so the next serialized request does not see a stale heartbeat.
          write_heartbeat()
          last_heartbeat=reaper.time_precise()
          -- Nobody is waiting for an expired request, so its reply would never be removed.
          if not deadline or os.time()*1000 < deadline then
            atomic(id..".json",json({id=id,ok=ok,result=ok and result or nil,error=not ok and clean(result) or nil}))
          end
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
