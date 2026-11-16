// Read only the explicitly exported reaper entry, never the full Codex config.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
const config=JSON.parse((await readFile(process.argv[2],'utf8')).replace(/^\uFEFF/,''));
assert.equal(config.name,'reaper');assert.equal(config.enabled,true);
const c=new Client({name:'registered-codex-check',version:'1.0.0'});
await c.connect(new StdioClientTransport({command:config.transport.command,args:config.transport.args,env:{...getDefaultEnvironment(),...config.transport.env},stderr:'pipe'}));
try{
 assert.equal((await c.listTools()).tools.length,14);
 const until=Date.now()+90000;let project;
 while(Date.now()<until){
  const r=await c.callTool({name:'reaper_get',arguments:{mode:'live',path:'/project'}});
  if(!r.isError){project=r.structuredContent.result;break;}
  await new Promise(r=>setTimeout(r,500));
 }
 assert.ok(project,'Managed startup did not become available; inspect REAPER dialogs');
 assert.ok(Number.isInteger(project.trackCount));
 const described=await c.callTool({name:'reaper_describe',arguments:{mode:'live',subject:'live_insert_midi'}});assert.notEqual(described.isError,true);
 const library=await c.callTool({name:'reaper_get',arguments:{mode:'live',path:'/instruments'}});assert.notEqual(library.isError,true);assert.ok(library.structuredContent.result.some(e=>e.id==='piano'));
 console.log(JSON.stringify({result:'PASS',checks:['exact enabled Codex registration','installed package MCP handshake','14 tools discovered','managed startup reaches live project'],project},null,2));
}finally{await c.close();}
