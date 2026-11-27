import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const [phase,prefix,workspace] = process.argv.slice(2);
assert.ok(["seed","verify"].includes(phase) && path.isAbsolute(prefix) && path.isAbsolute(workspace));
await mkdir(workspace,{recursive:true});
const app = path.join(prefix,"node_modules/@sarutobi-sasuke/reaper-mcp");
const pkg = JSON.parse(await readFile(path.join(app,"package.json"),"utf8"));
const client = new Client({name:"package-upgrade",version:"1"});
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(app,pkg.bin["reaper-mcp"])],
    env:{...getDefaultEnvironment(),REAPER_MCP_ALLOW_WRITES:"true",REAPER_MCP_WORKSPACE:workspace}}));
  async function call(name,args) {
    const r=await client.callTool({name,arguments:{mode:"offline",...args}});
    assert.ok(!r.isError,JSON.stringify(r.content)); return r.structuredContent.result;
  }
  const health=await call("reaper_health",{});
  assert.equal(health.version,pkg.version);
  if(phase==="seed"){
    assert.equal(health.version,"0.1.0-alpha.6");
    await call("reaper_project",{operation:"new",song:{tempo:97,tracks:[{name:"Existing project",items:[{kind:"midi",position:0,length:2,notes:[{tick:0,duration:480,pitch:67}]}]}]}});
    await call("reaper_project",{operation:"save",file:"upgrade.rpp"});
  }else{
    const source=path.join(workspace,"upgrade.rpp");
    const bytes=await readFile(source);
    await call("reaper_project",{operation:"open",file:"upgrade.rpp"});
    assert.equal(await call("reaper_get",{path:"/project/tempo"}),97);
    const [track]=await call("reaper_get",{path:"/tracks"});
    assert.equal(track.name,"Existing project");
    assert.equal(track.items[0].notes[0].pitch,67);
    assert.deepEqual(await readFile(source),bytes);
    assert.equal(health.bridge.requiredProtocol,3);
  }
  console.log(phase,health.version,"passed");
}finally{await client.close();}
