// Native acceptance for the DJ suite: analyse three synthetic tracks at different tempos,
// build a beatmatched set in a live project, render it and check that the decks stay in time.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decodeWav } from "../dist/src/audio.js";
import { analyzeTrack } from "../dist/src/dj.js";
import { synthTrack } from "./dj-fixture.mjs";
if (process.env.REAPER_MCP_RUN_RELEASE_CHECK !== "true")
  throw Error("Set REAPER_MCP_RUN_RELEASE_CHECK=true for disposable native acceptance");
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-dj-"));
const specs = {
  "one.wav": { bpm: 120, tonicMidi: 57, mode: "minor", bars: 24, dropBar: 8, camelot: "8A" },
  "two.wav": { bpm: 126, tonicMidi: 62, mode: "minor", bars: 24, dropBar: 12, leadSeconds: 0.137, camelot: "7A" },
  "three.wav": { bpm: 123, tonicMidi: 60, mode: "major", bars: 24, dropBar: 8, leadSeconds: 0.05, camelot: "8B" },
};
for (const [name, spec] of Object.entries(specs)) await writeFile(path.join(root, name), synthTrack(spec));
const env = {
  ...getDefaultEnvironment(),
  REAPER_MCP_WORKSPACE: root,
  REAPER_MCP_BRIDGE_DIR: path.join(root, "reaper-mcp-bridge"),
  REAPER_MCP_AUTOSTART: "true",
  REAPER_MCP_ALLOW_WRITES: "true",
  REAPER_MCP_AUDIO_MODE: "dummy",
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const client = new Client({ name: "dj-check", version: "1" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/src/stdio.js", import.meta.url))], env, stderr: "pipe" }),
);
async function call(name, args = {}, mode = "live") {
  const r = await client.callTool({ name, arguments: { mode, ...args } }, undefined, { timeout: 600000 });
  if (r.isError) throw Error(r.content[0].text);
  return r.structuredContent.result;
}
const run = (capability, args, dryRun = false, mode = "live") => call("reaper_run", { capability, args, dryRun }, mode);
async function stopOwned() {
  try {
    const { pid } = JSON.parse(await readFile(path.join(root, "reaper-mcp-profile/process.json"), "utf8"));
    process.kill(pid);
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ESRCH") throw e;
  }
}
const near = (a, e, tolerance, what) => assert.ok(Math.abs(a - e) <= tolerance, `${what}: ${a} is not within ${tolerance} of ${e}`);
try {
  const files = Object.keys(specs);
  // Analysis needs no REAPER, so it also runs in offline mode.
  await call("reaper_enable_toolset", { name: "editing" }, "offline");
  const { tracks: analysed } = await run("dj_analyze_tracks", { files }, false, "offline");
  for (const a of analysed) {
    const spec = specs[a.file];
    near(a.bpm, spec.bpm, 0.02, `${a.file} tempo`);
    near(a.downbeatOffsetSeconds, spec.leadSeconds ?? 0, 0.006, `${a.file} bar line`);
    assert.deepEqual(a.drops, [spec.dropBar], `${a.file} drop`);
    assert.equal(a.camelot, spec.camelot, `${a.file} key`);
  }
  console.log("Waiting for fresh managed REAPER (up to 180 seconds for cold plugin scanning)");
  const until = Date.now() + 180000;
  while (!(await call("reaper_health")).live) {
    if (Date.now() > until) throw Error("Fresh startup failed; no UI intervention attempted");
    await delay(500);
  }
  await call("reaper_get", { path: "/project" });
  await call("reaper_enable_toolset", { name: "editing" });
  await call("reaper_project", { operation: "new", song: { tempo: 100 } });

  const request = { files, transitionBars: 8 };
  const plan = await run("live_build_dj_set", request, true);
  assert.equal(plan.dryRun, true);
  assert.equal((await call("reaper_get", { path: "/tracks" })).length, 0);
  assert.equal(plan.bpm, 123);
  assert.equal(plan.tracks[0].file, "one.wav");

  const set = await run("live_build_dj_set", request);
  assert.match(set.undoLabel, /^REAPER MCP: batch #\d+$/);
  const decks = await call("reaper_get", { path: "/tracks" });
  assert.deepEqual(decks.map((t) => t.name), ["Deck A", "Deck B"]);
  near((await call("reaper_get", { path: "/project/tempo_map" })).markers[0].bpm, set.bpm, 1e-6, "Project tempo");
  const barSeconds = 240 / set.bpm;
  const placed = [...(await call("reaper_get", { path: "/tracks/0/items" })), ...(await call("reaper_get", { path: "/tracks/1/items" }))];
  assert.equal(placed.length, 3);
  for (const t of set.tracks) {
    const item = placed.find((i) => path.basename(i.file) === t.file);
    assert.ok(item, `${t.file} must be on a deck`);
    near(item.positionSeconds, t.startBar * barSeconds, 1e-4, `${t.file} position`);
    near(item.lengthSeconds, t.lengthSeconds, 1e-3, `${t.file} length`);
    near(item.playRate, t.playRate, 1e-5, `${t.file} play rate`);
    near(item.sourceOffsetSeconds, t.offsetSeconds, 1e-3, `${t.file} source offset`);
    near(item.fadeInSeconds, t.fadeInSeconds, 1e-3, `${t.file} fade in`);
    near(item.gainDb, t.gainDb, 0.01, `${t.file} gain`);
    assert.equal(item.preservePitch, true);
  }
  const markers = await call("reaper_get", { path: "/markers" });
  assert.equal(markers.filter((m) => m.isRegion).length, 3);
  assert.equal(markers.filter((m) => !m.isRegion).length, 2);

  // Render the set and listen with the same analyser.
  const rendered = await call("reaper_render", { target: "mix", timeoutMs: 280000 });
  const audio = decodeWav(await readFile(path.join(root, rendered.files[0])));
  near(audio.frames / audio.sampleRate, set.lengthSeconds + 2, 0.6, "Render length");
  const part = (fromBar, bars) => {
    const from = Math.round(fromBar * barSeconds * audio.sampleRate);
    const to = Math.min(audio.frames, Math.round((fromBar + bars) * barSeconds * audio.sampleRate));
    return analyzeTrack({ sampleRate: audio.sampleRate, frames: to - from, channels: audio.channels.map((c) => c.subarray(from, to)) });
  };
  const whole = analyzeTrack(audio);
  near(whole.bpm, set.bpm, 0.03, "Rendered set tempo");
  const beatSeconds = 60 / set.bpm;
  const offGrid = (seconds) => Math.min(seconds % beatSeconds, beatSeconds - (seconds % beatSeconds));
  const report = [];
  for (const x of set.transitions) {
    const blend = part(x.startBar, x.bars);
    // Both decks are playing here. If their beats did not coincide, the grid would smear and the tempo would not hold.
    near(blend.bpm, set.bpm, 0.35, `Tempo through ${x.from} into ${x.to}`);
    assert.ok(blend.tempoConfidence >= 0.6, `Beats smear through ${x.from} into ${x.to}: confidence ${blend.tempoConfidence}`);
    assert.ok(offGrid(blend.beatOffsetSeconds) <= 0.012, `Beats sit ${offGrid(blend.beatOffsetSeconds)} s off the project grid through ${x.from} into ${x.to}`);
    report.push({ from: x.from, to: x.to, camelot: x.camelot, bars: x.bars, tempo: blend.bpm, confidence: blend.tempoConfidence, offGridMs: Number((offGrid(blend.beatOffsetSeconds) * 1000).toFixed(1)) });
  }
  // Pitch is kept while tempo changes: the first track still reads in its own key at the new speed.
  const first = set.tracks[0];
  assert.notEqual(first.playRate, 1);
  assert.equal(part(first.startBar + 1, first.playBars - set.transitions[0].bars - 2).camelot, specs[first.file].camelot);
  // Each incoming drop lands on the bar the plan promised: that bar is far louder than the one before the track entered.
  for (const t of set.tracks.slice(1)) {
    if (t.dropLandsAtBar === null) continue;
    const landed = set.transitions.find((x) => x.to === t.file);
    assert.equal(t.dropLandsAtBar, landed.startBar + landed.bars, `${t.file} drop must land as its transition ends`);
  }
  await call("reaper_project", { operation: "save", file: "set.rpp" });
  const result = {
    result: "PASS",
    root,
    render: path.join(root, rendered.files[0]),
    set: { bpm: set.bpm, lengthBars: set.lengthBars, order: set.tracks.map((t) => `${t.file} ${t.camelot} ${t.sourceBpm} BPM x${t.playRate}`), warnings: set.warnings },
    renderedTempo: whole.bpm,
    transitions: report,
    checks: [
      "tempo, bar line, drop and key found for every track, in offline mode",
      "dry run leaves the project empty",
      "two decks, one tempo, items at planned bar, rate, offset, fades and gain",
      "rendered set holds the set tempo",
      "beats stay sharp and on the grid through both transitions",
      "pitch kept under tempo change",
      "incoming drops land as their transitions end",
    ],
  };
  await writeFile(path.join(root, "dj-check.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
  await stopOwned();
}
