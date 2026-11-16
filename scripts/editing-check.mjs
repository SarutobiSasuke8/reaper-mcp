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
async function ready(){const end=Date.now()+180000;while(!(await call('reaper_health')).live){if(Date.now()>end)throw Error('Fresh startup failed; no UI intervention attempted');await delay(500);}await call('reaper_get',{path:'/project'});}
async function ownedPid(){return JSON.parse(await readFile(path.join(root,'reaper-mcp-profile/process.json'),'utf8')).pid;}
async function stopOwned(){try{const pid=await ownedPid();process.kill(pid);const end=Date.now()+10000;while(Date.now()<end){try{process.kill(pid,0);}catch{return;}await delay(100);}throw Error('Owned test process did not exit');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}}
try{
 await connect();console.log("Waiting for fresh managed REAPER (up to 180 seconds for cold plugin scanning)");await ready();
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
 const item=await call('reaper_get',{path:'/tracks/0/items/0'});
 const readNotes=()=>call('reaper_get',{path:'/tracks/0/items/0/notes'});
 const beforeNotes=await readNotes();
 const readCC=()=>call('reaper_get',{path:'/tracks/0/items/0/controllers'});
 const beforeCC=await readCC();
 const section={startBeat:1,endBeat:3,tailSeconds:.25};
 await assert.rejects(call('reaper_render',{mode:'offline',section}),/requires live/);
 const before=await call('reaper_render',{target:'mix',section,timeoutMs:240000});
 const edit={track:0,item:0,takeGuid:item.takeGuid,notes:[{index:2,pitch:65,velocity:40,duration:.75}],instrument:'test-synth',articulations:[{index:0,from:'test_switch',to:'other_switch'}],ramps:[{startBeat:1,endBeat:2,controller:11,startValue:20,endValue:60,steps:4}]};
 await writeFile(catalogue,JSON.stringify([{id:'test-synth',name:'Test',plugin:synth.name,articulations:{test_switch:24,other_switch:25}}]));
 await run('live_edit_performance',edit,true);
 assert.deepEqual(await readNotes(),beforeNotes);assert.deepEqual(await readCC(),beforeCC);
 await assert.rejects(run('live_edit_performance',{...edit,takeGuid:'wrong'}),/identity/);
 await assert.rejects(run('live_edit_performance',{...edit,notes:[{index:2,duration:100}]}),/outside|number/);
 assert.deepEqual(await readNotes(),beforeNotes);
 await run('live_edit_performance',edit);
 const afterNotes=await readNotes(),afterCC=await readCC();
 assert.equal(afterNotes[0].pitch,25);assert.equal(afterNotes[2].pitch,65);assert.equal(afterNotes[2].velocity,40);
 assert.equal(afterNotes[2].endBeat-afterNotes[2].startBeat,.75);
 assert.deepEqual(afterNotes[1],beforeNotes[1]);assert.deepEqual(afterNotes[3],beforeNotes[3]);
 assert.deepEqual(afterCC.filter(c=>c.beat<1||c.beat>2).map(({index,...v})=>v),beforeCC.filter(c=>c.beat<1||c.beat>2).map(({index,...v})=>v));
 assert.deepEqual(afterCC.filter(c=>c.beat>=1&&c.beat<=2).map(c=>c.value),[20,30,40,50,60]);
 await assert.rejects(run('live_edit_performance',edit),/expected catalogue/);
 const rendered=await call('reaper_render',{target:'mix',section,timeoutMs:240000});
 assert.deepEqual(before.section,section);assert.deepEqual(rendered.section,section);
 assert.equal(rendered.snapshot.startSeconds,.5);assert.equal(rendered.snapshot.endSeconds,1.75);
 const first=await readFile(path.join(root,before.files[0])),second=await readFile(path.join(root,rendered.files[0]));
 const decoded=decodeWav(second);
 assert(Math.abs(decoded.frames/decoded.sampleRate-1.25)<1/decoded.sampleRate,"Expected exact section plus tail duration");
 const measurement=analyze(decoded);
 assert.equal(first.length,second.length);assert(!first.equals(second),'Audio must change');
 assert(measurement.peakDbfs>-65);assert.equal(measurement.clippedSamples,0);
 console.log('SECTION MEASUREMENT',JSON.stringify(measurement));
 await call('reaper_project',{operation:'save',file:'acceptance.rpp'});
 await client.close();client=null;await stopOwned();await delay(5500);
 env.REAPER_MCP_START_PROJECT='acceptance.rpp';await connect();await ready();
 assert.deepEqual(await readNotes(),afterNotes);assert.deepEqual(await readCC(),afterCC);
 const saved=await readFile(path.join(root,'acceptance.rpp'),'utf8');
 const looped=saved.replace(/^(\s*)LENGTH 2$/m,'$1LENGTH 4');assert.notEqual(looped,saved);
 await writeFile(path.join(root,'looped.rpp'),looped);
 await call('reaper_enable_toolset',{name:'editing'});
 await call('reaper_project',{operation:'open',file:'looped.rpp'});
 const loopItem=await call('reaper_get',{path:'/tracks/0/items/0'});
 await assert.rejects(run('live_edit_performance',{track:0,item:0,takeGuid:loopItem.takeGuid,notes:[{index:1,velocity:50}]}),/Looped MIDI/);
 const block=saved.match(/^    <ITEM[\s\S]*?^    >$/m)?.[0];assert(block);
 await writeFile(path.join(root,'pooled.rpp'),saved.replace(block,block+'\n'+block));
 await call('reaper_project',{operation:'open',file:'pooled.rpp'});
 const pooledItem=await call('reaper_get',{path:'/tracks/0/items/0'});
 await assert.rejects(run('live_edit_performance',{track:0,item:0,takeGuid:pooledItem.takeGuid,notes:[{index:1,velocity:50}]}),/Pooled MIDI/);
 const report={result:'PASS',root,packageVersion:JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version,before,section,checks:['looped and pooled MIDI rejected','offline section rejected','exact section duration','existing note pitch/velocity/duration edits','named articulation replacement','scoped CC ramp replacement','dry-run unchanged','invalid take and out-of-bounds rejection','equal-length different section renders','save/reopen edits','fresh hidden dummy startup','bundled instrument insertion','dry-run immutability','MIDI and articulation readback','CC ramp readback','native save','audible unclipped isolated render','MCP client reconnect','managed REAPER restart and reopen'],rendered,measurement};
 await writeFile(path.join(root,'release-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{if(client)await client.close();await stopOwned();}
