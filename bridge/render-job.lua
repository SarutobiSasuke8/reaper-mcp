-- Runs in the private worker only. Signal completion before optional plugin shutdown dialogs.
local p,filename=reaper.EnumProjects(-1,"")
local folder=reaper.get_ini_file():match("^(.*)[/\\]worker%.ini$")
if not folder then return end
local function canonical(s)return s:gsub("\\","/"):lower() end
local function render()
  assert(canonical(filename)==canonical(folder..".rpp"),"unexpected_snapshot")
  reaper.GetSetProjectInfo_String(p,"RENDER_FILE",folder,true)
  reaper.GetSetProjectInfo_String(p,"RENDER_PATTERN","mix",true)
  local _,target=reaper.GetSetProjectInfo_String(p,"RENDER_TARGETS","",false)
  assert(canonical(target)==canonical(folder.."/mix.wav"),"unexpected_render_target")
  reaper.Main_OnCommand(42230,0)
end
local ok,err=pcall(render)
local f=assert(io.open(folder.."/observation.tmp","wb"))
f:write(ok and "ok" or tostring(err))
f:close()
os.rename(folder.."/observation.tmp",folder.."/observation.txt")
