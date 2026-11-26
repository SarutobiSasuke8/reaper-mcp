-- Run only in the disposable render worker, with its snapshot and private INI.
local p,filename=reaper.EnumProjects(-1,"")
local function canonical(s) return s:gsub("\\","/"):lower() end
local folder=filename:match("^(.*)[/\\][^/\\]+$")
if not folder or canonical(filename)~=canonical(folder.."/mix.rpp") or
   canonical(reaper.get_ini_file())~=canonical(folder.."/reaper.ini") then return end
local f=io.open(folder.."/stem-track.txt","rb")
if not f then return end
local guid=f:read("*a");f:close()
for i=0,reaper.CountTracks(p)-1 do
  local t=reaper.GetTrack(p,i)
  if reaper.GetTrackGUID(t)==guid then
    reaper.SetOnlyTrackSelected(t)
    -- Bit 1 enables selected stems and bit 2 omits the master on REAPER 7.86.
    reaper.GetSetProjectInfo(p,"RENDER_SETTINGS",3,true)
    reaper.GetSetProjectInfo(p,"RENDER_NORMALIZE",0,true)
    -- Render using project settings; close the render dialog on completion.
    local _,target=reaper.GetSetProjectInfo_String(p,"RENDER_TARGETS","",false)
    if canonical(target)==canonical(folder.."/stem.wav") then reaper.Main_OnCommand(42230,0) end
    break
  end
end
reaper.Main_SaveProject(p,false)
reaper.Main_OnCommand(40004,0)
