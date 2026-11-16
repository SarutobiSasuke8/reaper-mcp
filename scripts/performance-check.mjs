import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {decodeWav,analyze} from '../dist/src/audio.js';
if(process.env.REAPER_MCP_RUN_PERFORMANCE_CHECK!=='true')throw Error('Opt in on a disposable workspace');
const client=new Client({name:'performance-acceptance',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[process.env.REAPER_MCP_TEST_SERVER||fileURLToPath(new URL('../dist/src/stdio.js',import.meta.url))],env:{...getDefaultEnvironment(),...Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('REAPER_MCP_'))),REAPER_MCP_ALLOW_WRITES:'true',REAPER_MCP_AUTOSTART:'true'},stderr:'pipe'}));
const call=async(name,args={})=>{const r=await client.callTool({name,arguments:{mode:'live',...args}},undefined,{timeout:240000});if(r.isError)throw Error(r.content[0].text);return r.structuredContent.result;};
const run=(args,dryRun=false)=>call('reaper_run',{capability:'live_insert_performance',args,dryRun});
try{
 const deadline=Date.now()+180000;while(!(await call('reaper_health')).live){if(Date.now()>deadline)throw Error('Startup timeout');await new Promise(r=>setTimeout(r,1000));}
 await call('reaper_get',{path:'/project'});await call('reaper_enable_toolset',{name:'editing'});await call('reaper_project',{operation:'new',song:{tempo:120}});
 await call('reaper_run',{capability:'live_add_track',args:{name:'Performance proof'}});
 await call('reaper_run',{capability:'live_insert_instrument',args:{track:0,instrument:'vpo-1st-violin-solo'}});
 const args={track:0,startBeat:0,lengthBeats:8,instrument:'vpo-1st-violin-solo',notes:[{beat:.125,duration:1.5,pitch:67},{beat:2.125,duration:.25,pitch:69},{beat:4.125,duration:2.5,pitch:71}],controllers:[{beat:0,controller:1,value:0}],articulations:[{beat:0,name:'normal'},{beat:2,name:'staccato'},{beat:4,name:'sustain'}],ramps:[{startBeat:0,endBeat:7,controller:11,startValue:45,endValue:115,steps:28}]};
 await run(args,true);assert.equal((await call('reaper_get',{path:'/tracks/0'})).itemCount,0);
 await run(args);const notes=await call('reaper_get',{path:'/tracks/0/items/0/notes'});assert.equal(notes.length,6);for(const pitch of [38,40,36])assert(notes.some(n=>n.pitch===pitch&&n.velocity===1));
 const cc=await call('reaper_get',{path:'/tracks/0/items/0/controllers'});const expression=cc.filter(e=>e.controller===11);assert.equal(expression.length,29);assert.equal(expression[0].value,45);assert.equal(expression.at(-1).value,115);assert(Math.abs(expression.at(-1).beat-7)<1e-6);
 await assert.rejects(run({...args,articulations:[{beat:0,name:'absent'}]}),/Unknown instrument/);assert.equal((await call('reaper_get',{path:'/tracks/0'})).itemCount,1);
 await run({track:0,startBeat:8,lengthBeats:1,controllers:[{beat:0,controller:11,value:100}]});
 const file=`performance-proof-${Date.now()}.rpp`;await call('reaper_project',{operation:'save',file});await call('reaper_project',{operation:'open',file});assert.equal((await call('reaper_get',{path:'/tracks/0/items/0/controllers'})).filter(e=>e.controller===11).length,29);
 const render=await call('reaper_render',{target:'mix',timeoutMs:240000});const analysis=analyze(decodeWav(await readFile(path.join(process.env.REAPER_MCP_WORKSPACE,render.files[0]))));
 assert(analysis.peakDbfs>-80);assert.equal(analysis.clippedSamples,0);
 const result={file,render,analysis,notes:notes.length,expressionEvents:expression.length,dryRun:true,reopen:true,controllerOnly:true};await writeFile(path.join(process.env.REAPER_MCP_WORKSPACE,'performance-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await client.close();}
