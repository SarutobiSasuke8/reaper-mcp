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
local function execute(a)
  assert(a[1]=="2","Unsupported protocol")
  assert(tonumber(a[3]) and os.time()*1000 < tonumber(a[3])-1000,"Request expired")
  local p,identity,revision=current()
  if a[4]=="ping" then return {protocol=2,project=identity,revision=revision,writes=os.getenv("REAPER_MCP_ALLOW_WRITES")=="true"} end
  if a[4]=="get" then return {project=identity,revision=revision,value=get_value(p,a[5])} end
  assert(a[4]=="set","Unsupported operation")
  assert(os.getenv("REAPER_MCP_ALLOW_WRITES")=="true","Bridge writes disabled")
  assert(a[5]==identity,"Project changed or bridge restarted; read again")
  assert(tonumber(a[6])==revision,"Project changed since read; inspect before editing")
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
