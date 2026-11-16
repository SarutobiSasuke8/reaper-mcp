import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_CONTRACTS } from "../src/server.js";

async function connect(writes: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-protocol-"));
  const client = new Client({ name: "reaper-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/stdio.js", import.meta.url))],
    env: {
      ...getDefaultEnvironment(),
      REAPER_MCP_WORKSPACE: root,
      REAPER_MCP_ALLOW_WRITES: String(writes),
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}
test("real stdio exposes 14 tools below schema budget with honest annotations", async () => {
  const client = await connect(true);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
    assert.ok(
      Buffer.byteLength(JSON.stringify(tools)) < 24000,
      "Conservative schema budget: <= 8k tokens at 3 bytes/token",
    );
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      Object.keys(TOOL_CONTRACTS).sort(),
    );
    for (const tool of tools) {
      assert.ok(tool.name.startsWith("reaper_"));
      assert.ok(tool.description);
      assert.equal(
        tool.annotations?.readOnlyHint,
        !TOOL_CONTRACTS[tool.name]!.writes,
      );
    }
  } finally {
    await client.close();
  }
});
test("real stdio read-only mode hides all write tools", async () => {
  const client = await connect(false);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length < 14);
    for (const tool of tools)
      assert.equal(TOOL_CONTRACTS[tool.name]!.writes, false);
  } finally {
    await client.close();
  }
});
test("scripted agent session creates notes, edits tempo and saves/reopens RPP", async () => {
  const client = await connect(true);
  try {
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent as { mode: string; result: unknown };
    };
    await invoke("reaper_project", {
      operation: "new",
      song: { name: "Agent eval" },
    });
    await invoke("reaper_enable_toolset", { name: "editing" });
    await invoke("reaper_run", {
      capability: "add_track",
      args: { track: { name: "Lead" } },
    });
    await invoke("reaper_run", {
      capability: "add_item",
      args: {
        track: 0,
        item: {
          kind: "midi",
          position: 0,
          length: 2,
          notes: [{ tick: 0, duration: 960, pitch: 60 }],
        },
      },
    });
    await invoke("reaper_set", { path: "/project/tempo", value: 128 });
    await invoke("reaper_project", { operation: "save", file: "agent.rpp" });
    await invoke("reaper_project", { operation: "new" });
    await invoke("reaper_project", { operation: "open", file: "agent.rpp" });
    const tempo = await invoke("reaper_get", { path: "/project/tempo" });
    assert.equal(tempo.result, 128);
    assert.equal(tempo.mode, "offline");
    const tracks = await invoke("reaper_get", { path: "/tracks" });
    assert.equal((tracks.result as unknown[]).length, 1);
  } finally {
    await client.close();
  }
});
