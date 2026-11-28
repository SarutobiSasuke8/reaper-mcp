-- Only invoked in a new isolated REAPER process with a private profile.
local folder=reaper.get_ini_file():match("^(.*)[/\\]probe%.ini$")
if not folder then return end
local file=io.open(folder.."/request.txt","rb")
if not file then return end
local function field() return (assert(file:read("*l")):gsub("\r$","")) end
local mode,plugin,preset,guid=field(),field(),field(),field()
local pitch,velocity,channel,cc1,cc11=tonumber(field()),tonumber(field()),tonumber(field()),tonumber(field()),tonumber(field())
file:close()
local stage="project"
local function probe()
  local source=reaper.EnumProjects(-1,"")
  if mode=="reopen" then
    stage="reopen"
    assert(reaper.CountTracks(source)==1,"expected_one_probe_track")
    local track=reaper.GetTrack(source,0)
    local fx=reaper.TrackFX_GetInstrument(track)
    assert(fx>=0 and not reaper.TrackFX_GetOffline(track,fx),"instrument_offline_after_reopen")
    local _,fxName=reaper.TrackFX_GetFXName(track,fx)
    assert(fxName==plugin,"plugin_changed_after_reopen")
    stage="reopen_render"
    reaper.Main_OnCommand(42230,0)
    return fxName
  end
  local original,sourcefx,sourceName
  if mode=="saved" then
    for i=0,reaper.CountTracks(source)-1 do
      local t=reaper.GetTrack(source,i)
      local _,name=reaper.GetTrackName(t)
      if reaper.GetTrackGUID(t):upper()==guid:upper() or guid=="name:"..name then
        assert(not original,"ambiguous_track_name");original=t
      end
    end
    assert(original,"track_missing")
    sourcefx=reaper.TrackFX_GetInstrument(original)
    assert(sourcefx>=0,"instrument_missing")
    assert(not reaper.TrackFX_GetOffline(original,sourcefx),"instrument_offline")
    _,sourceName=reaper.GetTrackName(original)
    reaper.Main_OnCommand(40859,0)
  end
  local p=reaper.EnumProjects(-1,"")
  assert(mode~="saved" or p~=source,"probe_tab_failed")
  assert(reaper.CountTracks(p)==0,"probe_project_not_empty")
  reaper.InsertTrackAtIndex(0,true)
  local track=reaper.GetTrack(p,0)
  local fx
  stage="plugin"
  if mode=="saved" then
    reaper.TrackFX_CopyToTrack(original,sourcefx,track,0,false)
    fx=reaper.TrackFX_GetInstrument(track)
  else
    local ident
    for i=0,10000 do
      local ok,name,id=reaper.EnumInstalledFX(i)
      if not ok then break end
      if name==plugin or id==plugin then ident=id;break end
    end
    assert(ident,"plugin_not_found")
    fx=reaper.TrackFX_AddByName(track,ident,false,-1)
  end
  assert(fx>=0 and reaper.TrackFX_GetInstrument(track)==fx and not reaper.TrackFX_GetOffline(track,fx),"instrument_load_failed")
  if preset~="" then
    stage="preset"
    assert(reaper.TrackFX_SetPreset(track,fx,preset),"preset_load_failed")
  end
  local _,fxName=reaper.TrackFX_GetFXName(track,fx)
  local _,hostPreset=reaper.TrackFX_GetPreset(track,fx)
  stage="performance"
  local item=assert(reaper.CreateNewMIDIItemInProj(track,0,2,false))
  local take=reaper.GetActiveTake(item)
  local function ppq(sec)return reaper.MIDI_GetPPQPosFromProjTime(take,sec) end
  assert(reaper.MIDI_InsertCC(take,false,false,ppq(.1),176,channel,1,cc1))
  assert(reaper.MIDI_InsertCC(take,false,false,ppq(.1),176,channel,11,cc11))
  assert(reaper.MIDI_InsertNote(take,false,false,ppq(.25),ppq(1.5),channel,pitch,velocity,true))
  reaper.MIDI_Sort(take)
  stage="save"
  reaper.GetSetProjectInfo_String(p,"RENDER_FILE",folder,true)
  reaper.GetSetProjectInfo_String(p,"RENDER_PATTERN","mix",true)
  reaper.GetSetProjectInfo_String(p,"RENDER_FORMAT","ZXZhdxgAAQ==",true)
  for key,v in pairs({RENDER_BOUNDSFLAG=0,RENDER_STARTPOS=0,RENDER_ENDPOS=2,RENDER_SETTINGS=0,RENDER_NORMALIZE=0,RENDER_SRATE=44100,RENDER_CHANNELS=2,RENDER_TAILFLAG=0}) do reaper.GetSetProjectInfo(p,key,v,true) end
  reaper.Main_SaveProjectEx(p,folder.."/probe.rpp",0)
  local f=assert(io.open(folder.."/probe.rpp","rb"));assert(f:seek("end")>0);f:close()
  stage="render"
  reaper.Main_OnCommand(42230,0)
  return table.concat({fxName,hostPreset or "",sourceName or ""},"\n")
end
local ok,observation=pcall(probe)
local f=assert(io.open(folder.."/observation.tmp","wb"))
f:write(ok and "ok" or stage,"\n",tostring(observation))
f:close()
os.rename(folder.."/observation.tmp",folder.."/observation.txt")
-- Parent owns this disposable process and closes it after reading the observation.
