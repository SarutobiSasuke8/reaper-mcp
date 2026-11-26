// Run FROM the installed package. No third-party instruments, personal settings or UI automation.
import assert from 'node:assert/strict';
import { checkRouting } from './routing-fixture.mjs';
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
const started=Date.now(), toolCalls={};
async function call(name,args={}){toolCalls[name]=(toolCalls[name]??0)+1;const r=await client.callTool({name,arguments:{mode:'live',...args}},undefined,{timeout:240000});if(r.isError)throw Error(r.content[0].text);return r.structuredContent.result;}
async function ready(){const end=Date.now()+180000;while(!(await call('reaper_health')).live){if(Date.now()>end)throw Error('Fresh startup failed; no UI intervention attempted');await delay(500);}await call('reaper_get',{path:'/project'});}
async function ownedPid(){return JSON.parse(await readFile(path.join(root,'reaper-mcp-profile/process.json'),'utf8')).pid;}
async function stopOwned(){try{const pid=await ownedPid();process.kill(pid);const end=Date.now()+10000;while(Date.now()<end){try{process.kill(pid,0);}catch{return;}await delay(100);}throw Error('Owned test process did not exit');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}}
try{
 await connect();console.log("Waiting for fresh managed REAPER (up to 180 seconds for cold plugin scanning)");await ready();
 if (process.argv.includes('--routing')) {
   const routing=await checkRouting({root,catalogue,call});
   routing.elapsedMs=Date.now()-started; routing.toolCalls=toolCalls;
   await writeFile(path.join(root,'routing-check.json'),JSON.stringify(routing,null,2));
   console.log('Native routing PASS',root,JSON.stringify(routing));
 } else {
 const plugins=await call('reaper_get',{path:'/plugins'});const synth=plugins.find(p=>p.name.includes('ReaSynth'));assert(synth,'Bundled ReaSynth not found');
 await writeFile(catalogue,JSON.stringify([{id:'test-synth',name:'Bundled ReaSynth',plugin:synth.name,articulations:{test_switch:24}}]));
 await call('reaper_enable_toolset',{name:'editing'});await call('reaper_project',{operation:'new',song:{tempo:120}});
 const run=(capability,args,dryRun=false)=>call('reaper_run',{capability,args,dryRun});
 await run('live_add_track',{name:'Release acceptance'});await run('live_insert_instrument',{track:0,instrument:'test-synth'});
 await call('reaper_set',{path:'/tracks/0/volume_db',value:-18});
 const [fx] = await call('reaper_get', {path:'/tracks/0/fx'});
 const base = '/tracks/0/fx/0/parameters';
 const controls = await call('reaper_list', {path:base});
 const page = await call('reaper_list',{path:base,offset:1,limit:2});
 assert.deepEqual(page,{offset:1,total:fx.parameterCount,items:controls.items.slice(1,3)});
 const control = controls.items.find(p => p.name.toLowerCase().includes('attack'));
 assert.ok(control, 'Bundled ReaSynth attack must be discoverable');
 const readControl = () => call('reaper_get', {path:base+'/'+control.index});
 const change = {track:0, fx:0, fxGuid:fx.guid, parameter:control.index, normalized:0.5};
 await assert.rejects(run('live_set_fx_parameter',{...change,fxGuid:'stale'}),/identity/);
 await assert.rejects(run('live_set_fx_parameter',{...change,normalized:2}));
 await assert.rejects(run('live_set_fx_parameter',{...change,parameter:fx.parameterCount}),/Parameter not found/);
 const preview = await run('live_set_fx_parameter',change,true);
 assert.deepEqual(preview.before,control);
 assert.deepEqual(await readControl(),control);
 const applied = await run('live_set_fx_parameter',change);
 assert.deepEqual(await readControl(),applied.after);
 assert.ok(Math.abs(applied.after.normalized-change.normalized)<1e-5);
 assert.notEqual(applied.after.normalized,control.normalized);
 assert.ok(applied.undoToken);
 await assert.rejects(run('live_revert_fx_edit',{undoToken:'wrong'}),/undo step/);
 await run('live_revert_fx_edit',{undoToken:applied.undoToken},true);
 assert.deepEqual(await readControl(),applied.after);
 await run('live_revert_fx_edit',{undoToken:applied.undoToken});
 await assert.rejects(run('live_revert_fx_edit',{undoToken:applied.undoToken}),/undo step/);
 assert.deepEqual(await readControl(),control);
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
 const variantEdit = await run('live_set_fx_parameter', change);
 const fxVariant = await call('reaper_render',{target:'mix',section,timeoutMs:240000});
 const analyzeFile = file => call('reaper_analyze',{file});
 const baselineAudio = await analyzeFile(before.files[0]);
 const variantAudio = await analyzeFile(fxVariant.files[0]);
 assert.ok(variantAudio.rmsDbfs < baselineAudio.rmsDbfs-1, 'Slower attack should reduce rendered RMS by at least 1 dB');
 console.log('FX comparison RMS dBFS',baselineAudio.rmsDbfs,variantAudio.rmsDbfs);
 await run('live_set_fx_parameter',{...change,normalized:control.normalized});
 await assert.rejects(run('live_revert_fx_edit',{undoToken:variantEdit.undoToken}),/undo step/);
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
 const originalVariant = await readFile(path.join(root,fxVariant.files[0]));
 const auditionArgs = {a:before.files[0], b:fxVariant.files[0], targetLufs:-18};
 const previewAB = await run('audition_ab',auditionArgs,true);
 assert.equal(previewAB.files,undefined);
 const audition = await run('audition_ab',auditionArgs);
 assert.ok(audition.deltaLu<=0.5);
 for (const file of audition.files) {
   const levels = await analyzeFile(file);
   assert.ok(Math.abs(levels.integratedLufs-audition.targetLufs)<0.25);
   assert.ok(levels.truePeakDbfs<=-1);
 }
 assert.ok(first.equals(await readFile(path.join(root,before.files[0]))));
 assert.ok(originalVariant.equals(await readFile(path.join(root,fxVariant.files[0]))));
 await call('reaper_project',{operation:'open',file:audition.project});
 assert.equal((await call('reaper_get',{path:'/tracks/0'})).mute,false);
 assert.equal((await call('reaper_get',{path:'/tracks/1'})).mute,true);
 const auditionRenders=[];
 for(const i of [0,1]) {
   if(i===1) {
     await call('reaper_set',{path:'/tracks/0/mute',value:true});
     await call('reaper_set',{path:'/tracks/1/mute',value:false});
   }
   const variant=await call('reaper_render',{target:'mix',section:{startBeat:0,endBeat:2.5,tailSeconds:0}});
   const level=await analyzeFile(variant.files[0]);
   assert.ok(Number.isFinite(level.integratedLufs));
   auditionRenders.push(level.integratedLufs);
 }
 assert.ok(Math.abs(auditionRenders[0]-auditionRenders[1])<=0.5);
 console.log('Native audition',JSON.stringify({project:audition.project,auditionRenders,deltaLu:audition.deltaLu}));
 const report={elapsedMs:Date.now()-started,toolCalls,audition,auditionRenders,result:'PASS',root,packageVersion:JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version,before,section,fxComparison:{baselineRmsDbfs:baselineAudio.rmsDbfs,variantRmsDbfs:variantAudio.rmsDbfs},checks:['paged FX discovery, preview, GUID guard, readback and measured A/B','looped and pooled MIDI rejected','offline section rejected','exact section duration','existing note pitch/velocity/duration edits','named articulation replacement','scoped CC ramp replacement','dry-run unchanged','invalid take and out-of-bounds rejection','equal-length different section renders','save/reopen edits','fresh hidden dummy startup','bundled instrument insertion','dry-run immutability','MIDI and articulation readback','CC ramp readback','native save','audible unclipped isolated render','MCP client reconnect','managed REAPER restart and reopen'],rendered,measurement};
 await writeFile(path.join(root,'release-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }
}finally{if(client)await client.close();await stopOwned();}
