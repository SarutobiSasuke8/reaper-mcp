import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { encodeWav, decodeWav } from '../vendor/lmms-mcp/audio.mjs';
import { writeRpp } from '../dist/src/rpp/index.js';
import { songSchema } from '../dist/src/song/model.js';

// Four bars with the kick confined to bar 2. Compare independent windows on the bass stem.
export async function checkRouting({root, catalogue, call}) {
  const rate=44100, duration=8;
  function tone(frequency, amplitude, active) {
    return encodeWav({sampleRate:rate,channels:[Float32Array.from({length:rate*duration},
      (_,i)=>active(i/rate) ? amplitude*Math.sin(2*Math.PI*frequency*i/rate) : 0)]});
  }
  await writeFile(path.join(root,'kick.wav'),tone(60,0.8,t=>t>=2 && t<4));
  await writeFile(path.join(root,'bass.wav'),tone(110,0.15,()=>true));
  const tracks=['kick','bass'].map(name=>({name,items:[{kind:'audio',file:name+'.wav',position:0,length:duration}]}));
  const rpp=writeRpp(songSchema.parse({tempo:120,tracks,render:{end:duration}}));
  await writeFile(path.join(root,'routing.rpp'),rpp);
  await call('reaper_enable_toolset',{name:'editing'});
  await call('reaper_project',{operation:'open',file:'routing.rpp'});
  const get=path=>call('reaper_get',{path});
  const run=(capability,args,dryRun=false)=>call('reaper_run',{capability,args,dryRun});
  const [kick,bass]=await get('/tracks');
  const route={source:0,sourceGuid:kick.guid,destination:1,destinationGuid:bass.guid,pair:'3/4'};
  await run('live_add_send',route,true);
  assert.deepEqual(await get('/tracks/0/sends'),[]);
  await assert.rejects(run('live_add_send',{...route,destinationGuid:'wrong'}),/identity/);
  await run('live_add_send',route);
  const [send]=await get('/tracks/0/sends');
  assert.equal(send.destinationGuid,bass.guid);
  assert.equal(send.destinationChannel,2);
  assert.equal(send.midiFlags & 31,31);
  await assert.rejects(run('live_add_send',route),/already exists/);
  await assert.rejects(run('live_add_send',{source:1,sourceGuid:bass.guid,destination:0,destinationGuid:kick.guid}),/feedback/);
  const stemTrack={index:1,guid:bass.guid};
  const section={startBeat:0,endBeat:16,tailSeconds:0};
  const stem=async()=> (await call('reaper_render',{target:'stems',stemTrack,section,timeoutMs:240000})).files[0];
  await assert.rejects(call('reaper_render',{target:'stems',stemTrack:{...stemTrack,guid:'wrong'},section}),/identity/);
  const baseline=await stem();
  const plugin=(await get('/plugins')).find(p=>p.name.includes('ReaComp (Cockos)'));
  assert.ok(plugin,'Bundled ReaComp must be installed');
  await writeFile(catalogue,JSON.stringify([{id:'reacomp',name:'ReaComp',plugin:plugin.name}]));
  await run('live_insert_instrument',{track:1,instrument:'reacomp'});
  const [fx]=await get('/tracks/1/fx');
  const params=await get('/tracks/1/fx/0/parameters');
  async function set(name,normalized) {
    const param=params.find(p=>p.name.toLowerCase()===name);
    assert.ok(param,'Missing '+name+' in '+params.map(p=>p.name).join(', '));
    return (await run('live_set_fx_parameter',{track:1,fx:0,fxGuid:fx.guid,parameter:param.index,normalized})).after;
  }
  // ReaComp 7.86 exposes detector pair 3/4 as step 2 of 1084.
  const detector=await set('signin',2/1084);
  assert.equal(detector.formatted,'2');
  const threshold=await set('threshold',0.1);
  const ratio=await set('ratio',1);
  const ducked=await stem();
  const load=async file=>decodeWav(await readFile(path.join(root,file)));
  const before=await load(baseline), after=await load(ducked);
  assert.equal(before.frames,rate*duration);
  assert.equal(after.frames,before.frames);
  const windows=[[0.5,1.5],[2.5,3.5],[6,7]];
  function level(audio,from,to) {
    const samples=audio.channels[0].subarray(from*rate,to*rate);
    const energy=samples.reduce((sum,sample)=>sum+sample*sample,0)/samples.length;
    return 10*Math.log10(energy);
  }
  assert.ok(Math.abs(level(before,2.5,3.5)-level(before,0.5,1.5))<0.05,
    'Bass stem must exclude kick audio on the master mix');
  const deltas=windows.map(([lo,hi])=>level(after,lo,hi)-level(before,lo,hi));
  console.log('Bass stem deltas',deltas,threshold,ratio);
  assert.ok(Math.abs(deltas[0])<0.2 && deltas[1]<-3 && Math.abs(deltas[2])<0.2);
  // Construct a known, editable native envelope in a separate fixture project.
  await call('reaper_project',{operation:'save',file:'with-compressor.rpp'});
  const saved=await readFile(path.join(root,'with-compressor.rpp'),'utf8');
  const anchor=saved.match(/^([ \t]*)WAK [^\r\n]+/m);
  assert.ok(anchor,'Expected native FX chain');
  const envelope=['<PARMENV '+ratio.index+' 0 1 0.5','ACT 1 -1','VIS 1 1 1','ARM 0',
    ...[0,2,3,4,8].map(t=>'PT '+t+' 1 1'),'>'].join('\n'+anchor[1]);
  await writeFile(path.join(root,'automation.rpp'),saved.replace(anchor[0],anchor[1]+envelope+'\n'+anchor[0]));
  await call('reaper_project',{operation:'open',file:'automation.rpp'});
  const envelopePath='/tracks/1/fx/0/parameters/'+ratio.index+'/envelope';
  const beforePoints=(await get(envelopePath)).points;
  assert.equal(beforePoints.length,5);
  const change={track:1,fx:0,fxGuid:fx.guid,parameter:ratio.index,point:2,timeSeconds:3,normalized:0};
  const edit=(args,dry=false)=>run('live_edit_fx_envelope_point',args,dry);
  await edit(change,true);
  assert.deepEqual((await get(envelopePath)).points,beforePoints);
  await assert.rejects(edit({...change,timeSeconds:2.8}),/time changed/);
  await assert.rejects(edit({...change,point:0}),/Invalid number/);
  const automationBaseline=await load(await stem());
  const edited=await edit(change);
  assert.equal(edited.startSeconds,2);assert.equal(edited.endSeconds,4);
  const afterPoints=(await get(envelopePath)).points;
  assert.deepEqual(afterPoints,beforePoints.map((p,i)=>i===2?{...p,value:0}:p));
  const automated=await stem(), automatedAudio=await load(automated);
  const automationDeltas=[[1,1.5],[2.4,2.8],[3.4,3.8],[6,7]].map(([lo,hi])=>level(automatedAudio,lo,hi)-level(automationBaseline,lo,hi));
  console.log('Automation deltas',automationDeltas);
  assert.ok(automationDeltas[2]>3 && [0,1,3].every(i=>Math.abs(automationDeltas[i])<0.2));
  return {baseline,ducked,section,windows,deltas,detector,threshold,ratio,automated,automationDeltas};
}
