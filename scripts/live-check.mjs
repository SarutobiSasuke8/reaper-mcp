import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
if (process.env.REAPER_MCP_RUN_LIVE_CHECK !== "true")
  throw Error(
    "Use only a disposable test project; set REAPER_MCP_RUN_LIVE_CHECK=true",
  );
const client = new Client({ name: "alpha-live-check", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/src/stdio.js", import.meta.url))],
    env: {
      ...getDefaultEnvironment(),
      REAPER_MCP_WORKSPACE: process.env.REAPER_MCP_WORKSPACE,
      REAPER_MCP_BRIDGE_DIR: process.env.REAPER_MCP_BRIDGE_DIR,
      REAPER_MCP_ALLOW_WRITES: "true",
    },
    stderr: "pipe",
  }),
);
const invoke = async (name, args) => {
  const r = await client.callTool({
    name,
    arguments: { ...args, mode: "live" },
  });
  if (r.isError) throw Error(r.content[0].text);
  assert.equal(r.structuredContent.mode, "live");
  return r.structuredContent.result;
};
let original;
try {
  original = await invoke("reaper_get", { path: "/tracks/0/volume_db" });
  const changed = original === -9 ? -8 : -9;
  await invoke("reaper_set", {
    path: "/tracks/0/volume_db",
    value: changed,
    dryRun: true,
  });
  assert.equal(
    await invoke("reaper_get", { path: "/tracks/0/volume_db" }),
    original,
  );
  await invoke("reaper_set", { path: "/tracks/0/volume_db", value: changed });
  assert.ok(
    Math.abs(
      (await invoke("reaper_get", { path: "/tracks/0/volume_db" })) - changed,
    ) < 1e-6,
  );
  assert.ok(
    Array.isArray(
      await invoke("reaper_list", { path: "/tracks/0/fx" }).then(
        (r) => r.items,
      ),
    ),
  );
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        checks: [
          "real MCP stdio live connection",
          "dryRun unchanged",
          "edit and readback",
          "FX listing",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (original !== undefined) {
    await invoke("reaper_get", { path: "/tracks/0" });
    await invoke("reaper_set", {
      path: "/tracks/0/volume_db",
      value: original,
    });
  }
  await client.close();
}
