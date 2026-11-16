import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { decodeWav, analyze } from "../dist/src/audio.js";
if (process.env.REAPER_MCP_RUN_MUSIC_CHECK !== "true")
  throw Error("Opt in on a disposable managed workspace");
const client = new Client({ name: "music-acceptance", version: "1" });
const env = {
  ...getDefaultEnvironment(),
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith("REAPER_MCP_")),
  ),
  REAPER_MCP_ALLOW_WRITES: "true",
  REAPER_MCP_AUTOSTART: "true",
};
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [
      process.env.REAPER_MCP_TEST_SERVER ||
        fileURLToPath(new URL("../dist/src/stdio.js", import.meta.url)),
    ],
    env,
    stderr: "pipe",
  }),
);
const call = async (name, args = {}) => {
  const r = await client.callTool(
    { name, arguments: { mode: "live", ...args } },
    undefined,
    { timeout: 240000 },
  );
  if (r.isError) throw Error(r.content[0].text);
  return r.structuredContent.result;
};
const run = (capability, args, dryRun = false) =>
  call("reaper_run", { capability, args, dryRun });
try {
  const deadline = Date.now() + 180000;
  while (!(await call("reaper_health")).live) {
    if (Date.now() > deadline) throw Error("Startup timeout");
    await new Promise((r) => setTimeout(r, 1000));
  }
  await call("reaper_get", { path: "/project" });
  await call("reaper_project", { operation: "new", song: { tempo: 100 } });
  await call("reaper_enable_toolset", { name: "editing" });
  const catalogue = await call("reaper_get", { path: "/instruments" });
  assert(catalogue.some((e) => e.id === "piano"));
  const plugins = await call("reaper_get", { path: "/plugins" });
  assert(plugins.some((e) => e.name.includes("sfizz")));
  const checks = [];
  for (const [i, id] of ["piano", "bass", "drums", "surge"].entries()) {
    await run("live_add_track", { name: id }, true);
    assert.equal((await call("reaper_get", { path: "/tracks" })).length, i);
    await run("live_add_track", { name: id });
    await run("live_insert_instrument", { track: i, instrument: id }, true);
    assert.equal(
      (await call("reaper_get", { path: `/tracks/${i}/fx` })).length,
      0,
    );
    console.log(`Loading ${id}`);
    await run("live_insert_instrument", { track: i, instrument: id });
    await call("reaper_set", { path: `/tracks/${i}/volume_db`, value: -12 });
    const notes = Array.from({ length: 8 }, (_, n) => ({
      beat: n * 0.5,
      duration: 0.35,
      pitch:
        id === "drums"
          ? [36, 42, 38, 42][n % 4]
          : (id === "bass" ? 40 : 60) + [0, 3, 7, 10][n % 4],
      velocity: 85,
    }));
    const clip = {
      track: i,
      name: id,
      startBeat: i * 4,
      lengthBeats: 4,
      notes,
    };
    await run("live_insert_midi", clip, true);
    assert.equal(
      (await call("reaper_get", { path: `/tracks/${i}` })).itemCount,
      0,
    );
    await run("live_insert_midi", clip);
    const readback = await call("reaper_get", {
      path: `/tracks/${i}/items/0/notes`,
    });
    assert.equal(readback.length, 8);
    assert.equal(readback[0].pitch, notes[0].pitch);
    assert.ok(Math.abs(readback[0].startBeat - i * 4) < 1e-6);
    const duplicate = await client.callTool({
      name: "reaper_run",
      arguments: {
        mode: "live",
        capability: "live_insert_instrument",
        args: { track: i, instrument: id },
      },
    });
    assert.equal(duplicate.isError, true);
    assert.equal(
      (await call("reaper_get", { path: `/tracks/${i}/fx` })).length,
      1,
    );
    checks.push(
      `${id}: dry run, insertion, MIDI readback, duplicate instrument rejection`,
    );
  }
  const file = `mcp-composition-${Date.now()}.rpp`;
  await call("reaper_project", { operation: "save", file });
  await call("reaper_project", { operation: "open", file });
  assert.equal((await call("reaper_get", { path: "/tracks" })).length, 4);
  const rendered = await call("reaper_render", {
    target: "mix",
    timeoutMs: 180000,
  });
  const audio = decodeWav(
    await readFile(path.join(env.REAPER_MCP_WORKSPACE, rendered.files[0])),
  );
  const measurement = analyze(audio);
  // Every isolated 2.4-second instrument section must actually produce audio.
  for (let i = 0; i < 4; i++) {
    const samples = audio.channels[0].slice(
      Math.floor(i * 2.4 * audio.sampleRate),
      Math.floor((i * 2.4 + 2) * audio.sampleRate),
    );
    const peak = Math.max(...Array.from(samples.slice(0, 60000), Math.abs));
    assert(peak > 0.0001, `Silent instrument ${i}`);
  }
  const report = { result: "PASS", file, rendered, checks, measurement };
  await writeFile(
    path.join(env.REAPER_MCP_WORKSPACE, "music-proof.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
