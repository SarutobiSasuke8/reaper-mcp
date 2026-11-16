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
local function get_value(p, object_path)
  if object_path=="/plugins" then
    local plugins={__array=true}
    for i=0,2047 do local ok,name,id=reaper.EnumInstalledFX(i);if not ok then break end;plugins[#plugins+1]={name=name,id=id} end
    return plugins
  end
  local ti,ii=object_path:match("^/tracks/(%d+)/items/(%d+)/notes$")
  if ti then
    local tr=assert(reaper.GetTrack(p,tonumber(ti)),"Track not found")
    local it=assert(reaper.GetTrackMediaItem(tr,tonumber(ii)),"Item not found")
    local take=assert(reaper.GetActiveTake(it),"Take not found")
    assert(reaper.TakeIsMIDI(take),"Not MIDI")
    local _,count=reaper.MIDI_CountEvts(take);assert(count<=10000,"Note read limit")
    local notes={__array=true}
    for i=0,count-1 do local ok,selected,muted,start,ending,channel,pitch,velocity=reaper.MIDI_GetNote(take,i);notes[#notes+1]={startBeat=reaper.MIDI_GetProjQNFromPPQPos(take,start),endBeat=reaper.MIDI_GetProjQNFromPPQPos(take,ending),channel=channel,pitch=pitch,velocity=velocity} end
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
  if field=="fx" then
    local fx={__array=true}; assert(reaper.TrackFX_GetCount(t)<=128,"FX limit exceeded")
    for i=0,reaper.TrackFX_GetCount(t)-1 do
      local _,name=reaper.TrackFX_GetFXName(t,i)
      fx[#fx+1]={index=i,name=name,enabled=reaper.TrackFX_GetEnabled(t,i),parameterCount=reaper.TrackFX_GetNumParams(t,i)}
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
local function music(p,a)
  local action,dry=a[7],a[8]; assert(dry=="0" or dry=="1","Invalid dryRun")
  local result={dryRun=dry=="1",action=action}
  local perform
  if action=="project_new" then
    local tempo=number(a[9],20,300)
    perform=function() reaper.Main_OnCommand(40859,0); reaper.SetCurrentBPM(0,tempo,true) end
  elseif action=="project_open" or action=="project_save" or action=="snapshot" then
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
      perform=function()
        local nums={};local strs={}
        for _,key in ipairs({'RENDER_BOUNDSFLAG','RENDER_STARTPOS','RENDER_ENDPOS','RENDER_SETTINGS','RENDER_SRATE','RENDER_CHANNELS','RENDER_TAILFLAG'}) do nums[key]=reaper.GetSetProjectInfo(p,key,0,false) end
        for _,key in ipairs({'RENDER_FILE','RENDER_PATTERN','RENDER_FORMAT'}) do local _,v=reaper.GetSetProjectInfo_String(p,key,'',false);strs[key]=v end
        local ok,err=pcall(function()
          reaper.GetSetProjectInfo_String(p,'RENDER_FILE',folder,true)
          reaper.GetSetProjectInfo_String(p,'RENDER_PATTERN','mix',true)
          reaper.GetSetProjectInfo_String(p,'RENDER_FORMAT','ZXZhdxgAAQ==',true)
          for key,v in pairs({RENDER_BOUNDSFLAG=0,RENDER_STARTPOS=0,RENDER_ENDPOS=reaper.GetProjectLength(p)+2,RENDER_SETTINGS=0,RENDER_SRATE=44100,RENDER_CHANNELS=2,RENDER_TAILFLAG=0}) do reaper.GetSetProjectInfo(p,key,v,true) end
          reaper.Main_SaveProjectEx(p,filename,0)
        end)
        for key,v in pairs(nums) do reaper.GetSetProjectInfo(p,key,v,true) end
        for key,v in pairs(strs) do reaper.GetSetProjectInfo_String(p,key,v,true) end
        assert(ok,err)
      end
    end
    result.file=filename
  elseif action=="live_add_track" then
    local name=a[9];assert(name and #name<=800 and not name:find('[%z\r\n]'),"Invalid name")
    local index=reaper.CountTracks(p);assert(index<256,"Track limit")
    result.index=index
    perform=function()
      reaper.InsertTrackAtIndex(index,false)
      local t=assert(reaper.GetTrack(p,index));reaper.GetSetMediaTrackInfo_String(t,'P_NAME',name,true)
      result.track=track_view(t)
    end
  elseif action=="live_insert_instrument" or action=="live_insert_midi" then
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
        local b,d,pitch,velocity,channel=row:match('^([^,]+),([^,]+),([^,]+),([^,]+),([^,]+)$')
        local n={number(b,0,length),number(d,0.000001,length),number(pitch,0,127,true),number(velocity,1,127,true),number(channel,0,15,true)}
        assert(n[1]+n[2]<=length+0.00000001,"Note outside item");notes[#notes+1]=n
      end
      assert(#notes>=1 and #notes<=128,"Note limit")
      result.noteCount=#notes
      perform=function()
        local item=assert(reaper.CreateNewMIDIItemInProj(t,reaper.TimeMap2_QNToTime(p,start),reaper.TimeMap2_QNToTime(p,start+length),false))
        local ok,err=pcall(function()
          local take=assert(reaper.GetActiveTake(item))
          reaper.GetSetMediaItemTakeInfo_String(take,'P_NAME',name,true)
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
    local useundo=action:match('^live_')~=nil
    if useundo then reaper.Undo_BeginBlock2(p) end
    local ok,err=pcall(perform)
    if useundo then reaper.Undo_EndBlock2(p,'REAPER MCP: '..action,-1) end
    reaper.UpdateArrange();assert(ok,err)
  end
  local _,identity,revision=current();result.project=identity;result.revision=revision
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
