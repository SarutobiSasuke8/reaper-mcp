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
 await call('reaper_project',{operation:'save',file:'acceptance.rpp'});
 const catalogProbe=await run('probe_instrument',{source:{instrument:'test-synth'}});
 assert.ok(catalogProbe.passed,JSON.stringify(catalogProbe));
 assert.ok(catalogProbe.reopened.audible && catalogProbe.first.audible);
 const missingProbe=await run('probe_instrument',{source:{instrument:'missing-fixture'}});
 assert.equal(missingProbe.reason,'instrument_not_listed');
 const job=await run('start_render_job',{timeoutMs:240000});
 const status=()=>call('reaper_get',{mode:'offline',path:job.statusPath});
 async function waitForJob(states){
   const until=Date.now()+250000;
   while(Date.now()<until){
     const info=await status();
     if(states.includes(info.state))return info;
     if(['failed','interrupted','cancelled','completed'].includes(info.state))throw Error(JSON.stringify(info));
     await delay(100);
   }
   throw Error('Job did not reach '+states.join('/'));
 }
 await run('control_render_job',{jobId:job.jobId,attempt:1,action:'cancel'});
 await waitForJob(['cancelled']);
 await run('control_render_job',{jobId:job.jobId,attempt:1,action:'retry',timeoutMs:240000});
 await assert.rejects(run('control_render_job',{jobId:job.jobId,attempt:1,action:'retry'}),/current job status/);
 await client.close();await connect();
 assert.ok((await call('reaper_get',{mode:'offline',path:'/render_jobs'})).includes(job.jobId));
 const rendered=await waitForJob(['completed']);
 assert.equal(rendered.attempt,2);
 assert.equal(rendered.measurement.channels,2);
 const measurement=analyze(decodeWav(await readFile(path.join(root,rendered.files[0]))));assert(measurement.peakDbfs>-65);assert.equal(measurement.clippedSamples,0);
 await client.close();await connect();await ready();assert.equal((await call('reaper_get',{path:'/tracks'})).length,1);
 await client.close();client=null;await stopOwned();await delay(5500);
 env.REAPER_MCP_START_PROJECT='acceptance.rpp';await connect();await ready();assert.equal((await call('reaper_get',{path:'/tracks/0/items/0/notes'})).length,4);
 const sourceBytes = await readFile(path.join(root, 'acceptance.rpp'));
 await call('reaper_enable_toolset', {name:'editing'});
 const fork = {source:'acceptance.rpp', candidate:'revision.rpp'};
 const preview = await run('fork_saved_project', fork, true);
 await run('fork_saved_project', {...fork, sourceSha256:preview.sourceSha256});
 await call('reaper_project', {operation:'open',file:fork.candidate});
 await call('reaper_get',{path:'/tracks'});
 const track = await call('reaper_get',{path:'/tracks/0'});
 const item = await call('reaper_get',{path:'/tracks/0/items/0'});
 await run('live_edit_performance',{track:track.guid,item:0,takeGuid:item.takeGuid,notes:[{index:2,velocity:40}]});
 const ride = {track:track.guid,rideId:'opening',unit:'seconds',points:[
   {position:0,gainDb:0},{position:.04,gainDb:6},{position:.32,gainDb:6},{position:.38,gainDb:0}
 ]};
 const effects = () => call('reaper_get',{path:'/tracks/0/fx'});
 const originalFx = await effects();
 await run('live_add_gain_ride',ride,true);
 assert.deepEqual(await effects(),originalFx);
 await run('live_add_gain_ride',ride);
 await assert.rejects(run('live_add_gain_ride',ride),/already exists/);
 await call('reaper_project',{operation:'save',file:'revision-edited.rpp'});
 const candidateRender = await call('reaper_render',{target:'mix',timeoutMs:240000});
 const reference = decodeWav(await readFile(path.join(root,rendered.files[0])));
 const edited = decodeWav(await readFile(path.join(root,candidateRender.files[0])));
 function level(audio,start,end){
   const values=audio.channels[0].subarray(Math.round(start*audio.sampleRate),Math.round(end*audio.sampleRate));
   return 10*Math.log10(values.reduce((sum,sample)=>sum+sample*sample,0)/values.length);
 }
 function gain(start,end){return level(edited,start,end)-level(reference,start,end);}
 assert.ok(Math.abs(gain(.09,.24)-6)<.2,'Opening ride gain: '+gain(.09,.24));
 assert.ok(Math.abs(gain(1.05,1.20))<.02,'Unexpected gain after ride: '+gain(1.05,1.20));
 const listen = await run('audition_ab',{a:rendered.files[0],b:candidateRender.files[0],projects:{a:'acceptance.rpp',b:'revision-edited.rpp'},section:{startSeconds:0,endSeconds:1.5}});
 assert.ok(listen.deltaLu <= 0.5);
 const selected = await run('select_audition_render',{manifest:listen.manifest,choice:'B'});
 assert.deepEqual(await readFile(path.join(root,selected.file)),await readFile(path.join(root,candidateRender.files[0])));
 await client.close();client=null;await stopOwned();await delay(5500);
 env.REAPER_MCP_START_PROJECT=selected.project.file;
 await connect();await ready();await call('reaper_enable_toolset',{name:'editing'});
 const reopenedNotes = await call('reaper_get',{path:'/tracks/0/items/0/notes'});
 assert.equal(reopenedNotes[2].velocity,40);
 const reopened = await call('reaper_render',{target:'mix',timeoutMs:240000});
 const compare = file => run('verify_audition_render',{receipt:selected.receipt,rendered:file});
 const verified = await compare(reopened.files[0]);
 assert.ok(verified.passed,JSON.stringify(verified));
 const rejected = await compare(rendered.files[0]);
 assert.equal(rejected.passed,false);
 assert.ok(rejected.relativeRmsError>0.05);
 await run('live_set_tempo',{beat:0,bpm:120,timeSignature:{numerator:3,denominator:4}});
 await run('live_set_tempo',{beat:3,bpm:90,timeSignature:{numerator:6,denominator:8}});
 for(const [unit,positions] of [['bars',[0,1,1.5,2]],['quarterNotes',[0,3,4.5,6]]]){
   const preview=await run('live_add_gain_ride',{
     ...ride,rideId:'meter-check',unit,
     points:positions.map((position,i)=>({position,gainDb:i===1?2:0}))
   },true);
   for(const [index,time] of [0,1.5,2.5,3.5].entries()){
     assert.ok(Math.abs(preview.points[index].timeSeconds-time)<1e-5,JSON.stringify(preview));
   }
 }
 assert.deepEqual(await readFile(path.join(root,'acceptance.rpp')),sourceBytes);
 const report={result:'PASS',root,packageVersion:JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version,checks:['fresh hidden dummy startup','bundled instrument insertion','dry-run immutability','MIDI and articulation readback','CC ramp readback','native save','audible unclipped isolated render','MCP client reconnect','managed REAPER restart and reopen','editable candidate fork, matched selection and verified reopened note edit'],rendered,measurement,verified,rejected};
 report.ride={requestedDb:6,measuredDb:gain(.09,.24),afterRideDb:gain(1.05,1.20)};
 report.instrumentProbe=catalogProbe;
 const revisionArgs={source:'acceptance.rpp',candidate:'phrase.rpp',ride,section:{startSeconds:0,endSeconds:1.5}};
 const plan=await run('audition_gain_ride',revisionArgs,true);
 const pending=await run('audition_gain_ride',{...revisionArgs,sourceSha256:plan.sourceSha256,waitMs:0});
 await client.close();await connect();
 await call('reaper_enable_toolset',{name:'editing',mode:'offline'});
 const revised=await run('audition_gain_ride',{resume:pending.workflow,waitMs:230000});
 assert.equal(revised.phase,'ready',JSON.stringify(revised));
 assert.ok(revised.deltaLu<=.5);
 const resumed=await run('audition_gain_ride',{resume:revised.workflow});
 assert.equal(resumed.manifest,revised.manifest);
 const approved=await run('select_audition_render',{manifest:revised.manifest,choice:'B'});
 assert.equal(approved.project.file,'phrase.rpp');
 assert.deepEqual(await readFile(path.join(root,'acceptance.rpp')),sourceBytes);
 report.checks.push('single-request gain ride, matched listening copies, resumed manifest and independent approval');
 report.checks.push('catalogue instrument rendered before and after reopening','cancelled mix retried from snapshot across a client reconnect');
 report.checks.push('approved project reopened after managed process restart','scoped gain verified inside and after ride','3/4 to 6/8 tempo map in bars and quarter notes');
 await writeFile(path.join(root,'release-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{if(client)await client.close();await stopOwned();}
