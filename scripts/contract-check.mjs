import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-contract-"));
const directory = path.join(root, "bridge");
await mkdir(directory);
const client = new Client({ name: "release-contract", version: "1" });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../" + pkg.bin["reaper-mcp"], import.meta.url))],
    env: {...getDefaultEnvironment(), REAPER_MCP_WORKSPACE:root, REAPER_MCP_BRIDGE_DIR:directory},
  }));
  async function call(name, args = {}) {
    const reply = await client.callTool({ name, arguments:{mode:"offline", ...args} });
    assert.ok(!reply.isError, JSON.stringify(reply.content));
    return reply.structuredContent.result;
  }
  const health = await call("reaper_health");
  assert.equal(health.version, pkg.version);
  assert.equal(health.bridge.state, "absent");
  assert.equal(health.writesEnabled, false);
  const denied = await client.callTool({ name:"reaper_project", arguments:{operation:"new", mode:"offline"} });
  assert.ok(denied.isError);
  const capabilities = await call("reaper_find_capability", {query:""});
  const [editing] = await call("reaper_list_toolsets");
  assert.deepEqual(capabilities.map(c => c.name).sort(), [...editing.capabilities].sort());
  for (const capability of capabilities) {
    assert.ok(["stable", "experimental"].includes(capability.maturity));
    const { definition } = await call("reaper_describe", {subject:capability.name});
    assert.equal(definition.maturity, capability.maturity);
    assert.deepEqual(definition.modes, capability.modes);
    assert.ok(definition.schema && definition.acceptance);
  }
  await writeFile(path.join(directory,"heartbeat.json"), JSON.stringify({protocol:health.bridge.requiredProtocol-1}));
  assert.equal((await call("reaper_health")).bridge.state, "outdated");
  console.log("Packed contract passed", pkg.version, capabilities.length, "capabilities");
} finally {
  await client.close();
}
