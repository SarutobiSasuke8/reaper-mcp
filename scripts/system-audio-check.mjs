import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {liveIni} from '../dist/src/profile.js';import {locateReaper} from '../dist/src/render.js';
if(process.env.REAPER_MCP_RUN_RELEASE_CHECK!=='true')throw Error('Opt in to disposable audio-device check');
const root=await mkdtemp(path.join(os.tmpdir(),'reaper-system-audio-'));const ini=path.join(root,'reaper.ini');const lua=path.join(root,'probe.lua');const result=path.join(root,'device.txt');
await writeFile(ini,liveIni('win32','system'));
await writeFile(lua,`reaper.Audio_Init()\nreaper.OnPlayButton()\nlocal started=reaper.time_precise()\nlocal function probe()\nif reaper.time_precise()-started<1 then reaper.defer(probe);return end\nlocal ok,mode=reaper.GetAudioDeviceInfo('MODE')\nlocal _,out=reaper.GetAudioDeviceInfo('IDENT_OUT')\nlocal f=assert(io.open([[${result.replaceAll('\\','/')}]],'w'));f:write(tostring(ok)..'\\n'..mode..'\\n'..out);f:close()\nreaper.OnStopButton()\nend\nreaper.defer(probe)\n`);
const child=spawn(await locateReaper(),['-newinst','-nosplash','-cfgfile',ini,lua],{stdio:'ignore',windowsHide:true});
try{const end=Date.now()+90000;let device;while(Date.now()<end){try{device=await readFile(result,'utf8');break;}catch{}await new Promise(r=>setTimeout(r,500));}assert(device,'Startup did not reach audio probe');assert.match(device,/^true\r?\n/);assert(!/dummy/i.test(device));console.log(JSON.stringify({result:'PASS',root,device,notes:'Device open verified; silent empty-project transport; no physical speaker capture performed'}));}finally{if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}}
