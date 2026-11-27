// Native acceptance for auto-mix: compose a piece, measure it, auto-mix it and confirm
// the loudness on a fresh render. Uses bundled REAPER instruments unless
// REAPER_MCP_COMPOSE_CATALOGUE (absolute JSON path) and REAPER_MCP_COMPOSE_INSTRUMENTS
// (JSON object of role to catalogue ID) name installed ones.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
if (process.env.REAPER_MCP_RUN_RELEASE_CHECK !== "true")
  throw Error("Set REAPER_MCP_RUN_RELEASE_CHECK=true for disposable native acceptance");
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-automix-"));
const catalogue = path.join(root, "instruments.json");
const own = process.env.REAPER_MCP_COMPOSE_CATALOGUE;
if (own) await copyFile(own, catalogue);
else await writeFile(catalogue, "[]");
const env = {
  ...getDefaultEnvironment(),
  REAPER_MCP_WORKSPACE: root,
  REAPER_MCP_BRIDGE_DIR: path.join(root, "reaper-mcp-bridge"),
  REAPER_MCP_AUTOSTART: "true",
  REAPER_MCP_ALLOW_WRITES: "true",
  REAPER_MCP_AUDIO_MODE: "dummy",
  REAPER_MCP_INSTRUMENTS: catalogue,
  ...(process.env.REAPER_MCP_VST_PATHS ? { REAPER_MCP_VST_PATHS: process.env.REAPER_MCP_VST_PATHS } : {}),
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const client = new Client({ name: "automix-check", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/src/stdio.js", import.meta.url))],
    env,
    stderr: "pipe",
  }),
);
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: { mode: "live", ...args } }, undefined, { timeout: 900000 });
  if (r.isError) throw Error(r.content[0].text);
  return r.structuredContent.result;
}
const run = (capability, args, dryRun = false) => call("reaper_run", { capability, args, dryRun });
async function stopOwned() {
  try {
    const { pid } = JSON.parse(await readFile(path.join(root, "reaper-mcp-profile/process.json"), "utf8"));
    process.kill(pid);
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ESRCH") throw e;
  }
}
const levels = async () => (await call("reaper_get", { path: "/tracks" })).map((t) => t.volume_db);
const near = (a, e, tolerance, what) => assert.ok(Math.abs(a - e) <= tolerance, `${what}: ${a} is not within ${tolerance} of ${e}`);
try {
  console.log("Waiting for fresh managed REAPER (up to 180 seconds for cold plugin scanning)");
  const until = Date.now() + 180000;
  while (!(await call("reaper_health")).live) {
    if (Date.now() > until) throw Error("Fresh startup failed; no UI intervention attempted");
    await delay(500);
  }
  await call("reaper_get", { path: "/project" });
  let instruments = process.env.REAPER_MCP_COMPOSE_INSTRUMENTS && JSON.parse(process.env.REAPER_MCP_COMPOSE_INSTRUMENTS);
  if (!own) {
    const plugins = await call("reaper_get", { path: "/plugins" });
    const synth = plugins.find((p) => p.name.includes("ReaSynth"));
    const kit = plugins.find((p) => p.name.includes("ReaSynDr"));
    assert.ok(synth && kit, "Bundled ReaSynth and ReaSynDr must be installed");
    await writeFile(catalogue, JSON.stringify([
      { id: "synth", name: "Bundled ReaSynth", plugin: synth.name },
      { id: "kit", name: "Bundled ReaSynDr", plugin: kit.name },
    ]));
    instruments = { lead: "synth", harmony: "synth", pad: "synth", bass: "synth", drums: "kit" };
  }
  assert.ok(instruments, "Set REAPER_MCP_COMPOSE_INSTRUMENTS with your own catalogue");
  await call("reaper_enable_toolset", { name: "editing" });
  await call("reaper_project", { operation: "new", song: { tempo: 100 } });
  const piece = await run("live_compose_piece", { style: process.env.REAPER_MCP_COMPOSE_STYLE ?? "adventure", bars: 16, seed: 3, instruments });
  const before = await call("reaper_analyze", { file: (await call("reaper_render", { target: "mix", timeoutMs: 280000 })).files[0] });
  const startLevels = await levels();

  // Solo would make the stems a different mix, so it is refused before any render.
  await call("reaper_set", { path: "/tracks/0/solo", value: true });
  await assert.rejects(run("live_auto_mix", {}), /Solo is on/);
  await call("reaper_set", { path: "/tracks/0/solo", value: false });
  await assert.rejects(run("live_auto_mix", { tracks: [99] }), /Track 99 not found/);

  // A dry run measures and plans but leaves every fader alone.
  const target = Number(process.env.REAPER_MCP_AUTOMIX_TARGET ?? -16);
  const plan = await run("live_auto_mix", { targetLufs: target }, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.verified, undefined);
  assert.deepEqual(await levels(), startLevels);
  assert.equal(plan.stemRenders, piece.tracks.length);
  assert.deepEqual(plan.tracks.map((t) => t.role), piece.tracks.map((t) => t.role === "texture" ? "pad" : t.role));

  const mixed = await run("live_auto_mix", { targetLufs: target });
  const after = await levels();
  for (const t of mixed.tracks) near(after[t.index], t.afterDb, 0.01, `${t.name} fader`);
  assert.match(mixed.undoLabel, /^REAPER MCP: batch #\d+$/);
  assert.equal(mixed.verified.clippedSamples, 0);
  assert.ok(mixed.verified.truePeakDbfs <= mixed.ceilingDb + 0.3, `True peak ${mixed.verified.truePeakDbfs} passes the ceiling`);
  // The stems must predict the real mix, or the whole method is unsound.
  near(mixed.verified.integratedLufs, mixed.predicted.integratedLufs, 1, "Verified against predicted loudness");
  if (mixed.limitedBy === null) near(mixed.verified.integratedLufs, target, 1, "Verified against target loudness");
  else assert.ok(mixed.verified.integratedLufs < target, "A peak-limited mix stops below the target");

  // Loudness only: every fader moves by the same amount.
  const quieter = await run("live_auto_mix", { targetLufs: target - 6, balance: false });
  const changes = quieter.tracks.map((t) => t.changeDb);
  assert.ok(changes.every((c) => Math.abs(c - changes[0]) <= 0.02), `Uniform move expected, got ${changes}`);
  near(quieter.verified.integratedLufs, target - 6, 1, "Loudness-only run against its target");
  await call("reaper_project", { operation: "save", file: "mixed.rpp" });
  const report = {
    result: "PASS",
    root,
    piece: { style: piece.style, key: piece.key, bpm: piece.bpm },
    before: { integratedLufs: before.integratedLufs, truePeakDbfs: before.truePeakDbfs, clippedSamples: before.clippedSamples },
    target,
    autoMix: {
      tracks: mixed.tracks.map((t) => ({ name: t.name, role: t.role, measuredDb: t.measuredDb, targetDb: t.targetDb, beforeDb: t.beforeDb, afterDb: t.afterDb, warning: t.warning })),
      targetShiftDb: mixed.targetShiftDb, masterOffsetDb: mixed.masterOffsetDb, limitedBy: mixed.limitedBy,
      predicted: mixed.predicted, verified: mixed.verified, elapsedMs: mixed.elapsedMs, note: mixed.note ?? null,
    },
    loudnessOnly: { target: target - 6, verifiedLufs: quieter.verified.integratedLufs, elapsedMs: quieter.elapsedMs },
    render: path.join(root, mixed.verified.file),
    checks: [
      "solo and unknown tracks refused before rendering",
      "dry run plans without moving faders",
      "faders read back at the planned levels, one undo step",
      "verifying render is unclipped and under the true-peak ceiling",
      "stem prediction within 1 LU of the real mix",
      "loudness-only run moves all faders equally and lands on its target",
    ],
  };
  await writeFile(path.join(root, "automix-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
  await stopOwned();
}
