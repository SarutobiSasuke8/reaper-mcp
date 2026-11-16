// Run FROM the installed package. No third-party instruments, personal settings or UI automation.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {decodeWav,analyze} from '../dist/src/audio.js';
if(process.env.REAPER_MCP_RUN_RELEASE_CHECK!=='true')throw Error('Set REAPER_MCP_RUN_RELEASE_CHECK=true for disposable native acceptance');
const root=await mkdtemp(path.join(os.tmpdir(),'reaper-release-'));
const catalogue=path.join(root,'instruments.json');await writeFile(catalogue,'[]');
const env={...getDefaultEnvironment(),REAPER_MCP_WORKSPACE:root,REAPER_MCP_BRIDGE_DIR:path.join(root,'reaper-mcp-bridge'),REAPER_MCP_AUTOSTART:'true',REAPER_MCP_ALLOW_WRITES:'true',REAPER_MCP_AUDIO_MODE:'dummy',REAPER_MCP_INSTRUMENTS:catalogue};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let client;
async function connect(){client=new Client({name:'packed-release-check',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/src/stdio.js',import.meta.url))],env,stderr:'pipe'}));}
async function call(name,args={}){const r=await client.callTool({name,arguments:{mode:'live',...args}},undefined,{timeout:240000});if(r.isError)throw Error(r.content[0].text);return r.structuredContent.result;}
async function ready(){const end=Date.now()+90000;while(!(await call('reaper_health')).live){if(Date.now()>end)throw Error('Fresh startup failed; no UI intervention attempted');await delay(500);}await call('reaper_get',{path:'/project'});}
async function ownedPid(){return JSON.parse(await readFile(path.join(root,'reaper-mcp-profile/process.json'),'utf8')).pid;}
async function stopOwned(){try{const pid=await ownedPid();process.kill(pid);const end=Date.now()+10000;while(Date.now()<end){try{process.kill(pid,0);}catch{return;}await delay(100);}throw Error('Owned test process did not exit');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}}
try{
 await connect();await ready();
 const plugins=await call('reaper_get',{path:'/plugins'});const synth=plugins.find(p=>p.name.includes('ReaSynth'));assert(synth,'Bundled ReaSynth not found');
 await writeFile(catalogue,JSON.stringify([{id:'test-synth',name:'Bundled ReaSynth',plugin:synth.name,articulations:{test_switch:24}}]));
 await call('reaper_enable_toolset',{name:'editing'});await call('reaper_project',{operation:'new',song:{tempo:120}});
 const run=(capability,args,dryRun=false)=>call('reaper_run',{capability,args,dryRun});
 await run('live_add_track',{name:'Release acceptance'});await run('live_insert_instrument',{track:0,instrument:'test-synth'});
 await call('reaper_set',{path:'/tracks/0/volume_db',value:-18});
 const performance={track:0,startBeat:0,lengthBeats:4,instrument:'test-synth',notes:[{beat:.125,duration:.5,pitch:60},{beat:1,duration:.5,pitch:64},{beat:2,duration:.5,pitch:67}],articulations:[{beat:0,name:'test_switch'}],ramps:[{startBeat:0,endBeat:3,controller:11,startValue:40,endValue:100,steps:12}]};
 await run('live_insert_performance',performance,true);assert.equal((await call('reaper_get',{path:'/tracks/0'})).itemCount,0);
 await run('live_insert_performance',performance);assert.equal((await call('reaper_get',{path:'/tracks/0/items/0/notes'})).length,4);
 assert.equal((await call('reaper_get',{path:'/tracks/0/items/0/controllers'})).filter(c=>c.controller===11).length,13);
 await call('reaper_project',{operation:'save',file:'acceptance.rpp'});
 const rendered=await call('reaper_render',{target:'mix',timeoutMs:240000});
 const measurement=analyze(decodeWav(await readFile(path.join(root,rendered.files[0]))));assert(measurement.peakDbfs>-65);assert.equal(measurement.clippedSamples,0);
 await client.close();await connect();await ready();assert.equal((await call('reaper_get',{path:'/tracks'})).length,1);
 await client.close();client=null;await stopOwned();await delay(5500);
 env.REAPER_MCP_START_PROJECT='acceptance.rpp';await connect();await ready();assert.equal((await call('reaper_get',{path:'/tracks/0/items/0/notes'})).length,4);
 const report={result:'PASS',root,packageVersion:JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version,checks:['fresh hidden dummy startup','bundled instrument insertion','dry-run immutability','MIDI and articulation readback','CC ramp readback','native save','audible unclipped isolated render','MCP client reconnect','managed REAPER restart and reopen'],rendered,measurement};
 await writeFile(path.join(root,'release-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{if(client)await client.close();await stopOwned();}
