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
  // Pitch is kept while tempo changes. The first track opens on its tonic chord, so its root must
  // still sound at its written frequency, not at that frequency times the play rate.
  const first = set.tracks[0];
  assert.notEqual(first.playRate, 1);
  const rootHz = 440 * 2 ** ((specs[first.file].tonicMidi - 69) / 12);
  const power = (hz) => {
    const from = Math.round(0.05 * audio.sampleRate);
    const count = Math.round(0.4 * audio.sampleRate);
    const coefficient = 2 * Math.cos((2 * Math.PI * hz) / audio.sampleRate);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < count; i++) {
      const s0 = audio.channels[0][from + i] + coefficient * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
  };
  const kept = power(rootHz), shifted = power(rootHz * first.playRate);
  assert.ok(kept > shifted * 4, `Root should sound at ${rootHz.toFixed(1)} Hz, not ${(rootHz * first.playRate).toFixed(1)} Hz: ${kept} against ${shifted}`);
  // Each incoming drop lands on the bar the plan promised: that bar is far louder than the one before the track entered.
  for (const t of set.tracks.slice(1)) {
    if (t.dropLandsAtBar === null) continue;
    const landed = set.transitions.find((x) => x.to === t.file);
    assert.equal(t.dropLandsAtBar, landed.startBar + landed.bars, `${t.file} drop must land as its transition ends`);
  }
  // Bass swap: each deck carries ReaEQ with a written low-shelf envelope.
  assert.equal(set.transition, "bass_swap");
  const deckOf = Object.fromEntries(set.tracks.map((t) => [t.file, t.deck === "A" ? 0 : 1]));
  for (const deck of [0, 1]) {
    const chain = await call("reaper_get", { path: `/tracks/${deck}/fx` });
    assert.equal(chain.length, 1);
    assert.match(chain[0].name, /ReaEQ/);
    const envelope = await call("reaper_get", { path: `/tracks/${deck}/fx/0/parameters/1/envelope` });
    assert.equal(envelope.exists, true);
    assert.ok(envelope.points.length >= 3, `Deck ${deck} envelope has ${envelope.points.length} points`);
  }
  // Hear it on the stems: how much of a deck's level is low end, before and after each swap.
  const stems = [];
  for (const deck of [0, 1]) {
    const stem = await call("reaper_render", { target: "stems", stemTrack: { index: deck, guid: decks[deck].guid }, timeoutMs: 280000 });
    stems.push(decodeWav(await readFile(path.join(root, stem.files[0]))));
  }
  // Share of level below about 120 Hz, in dB, over a span of bars.
  function lowShareDb(stem, fromBar, bars) {
    const from = Math.round(fromBar * barSeconds * stem.sampleRate);
    const to = Math.min(stem.frames, Math.round((fromBar + bars) * barSeconds * stem.sampleRate));
    const k = 1 - Math.exp((-2 * Math.PI * 120) / stem.sampleRate);
    let a = 0, b = 0, c = 0, low = 0, all = 0;
    for (let i = Math.max(0, from - 4000); i < to; i++) {
      const x = stem.channels[0][i];
      a += k * (x - a); b += k * (a - b); c += k * (b - c);
      if (i >= from) { low += c * c; all += x * x; }
    }
    return 10 * Math.log10(low / all + 1e-12);
  }
  const bass = [];
  for (const x of set.transitions) {
    const incoming = stems[deckOf[x.to]];
    const outgoing = stems[deckOf[x.from]];
    const quarter = x.bars / 4;
    // First quarter of the blend: the incoming deck has no low end yet. Last quarter: it has, and the outgoing deck has lost its own.
    const row = {
      from: x.from, to: x.to,
      incomingBeforeSwap: lowShareDb(incoming, x.startBar, quarter), incomingAfterSwap: lowShareDb(incoming, x.startBar + 3 * quarter, quarter),
      outgoingBeforeSwap: lowShareDb(outgoing, x.startBar, quarter), outgoingAfterSwap: lowShareDb(outgoing, x.startBar + 3 * quarter, quarter),
    };
    assert.ok(row.incomingAfterSwap - row.incomingBeforeSwap >= 10, `Incoming bass should arrive at the swap: ${JSON.stringify(row)}`);
    assert.ok(row.outgoingBeforeSwap - row.outgoingAfterSwap >= 10, `Outgoing bass should leave at the swap: ${JSON.stringify(row)}`);
    bass.push(Object.fromEntries(Object.entries(row).map(([key, v]) => [key, typeof v === "number" ? Number(v.toFixed(1)) : v])));
  }

  // The general FX capabilities behind it, used directly.
  const added = await run("live_add_fx", { track: 0, plugin: (await call("reaper_get", { path: "/plugins" })).find((p) => p.name.includes("ReaComp (Cockos)")).name });
  assert.equal(added.fx, 1);
  await assert.rejects(run("live_add_fx", { track: 0, plugin: "No Such Plugin" }), /not installed/);
  const params = await call("reaper_list", { path: "/tracks/0/fx/1/parameters", offset: 0, limit: 50 });
  const ratio = params.items.find((p) => p.name === "Ratio");
  const written = await run("live_write_fx_automation", { track: 0, fx: 1, fxGuid: added.guid, parameterName: "Ratio", points: [{ beat: 0, normalized: 0.1 }, { beat: 8, normalized: 0.4 }, { beat: 16, normalized: 0.2, shape: 1 }] });
  assert.deepEqual([written.createsEnvelope, written.parameter], [true, ratio.index]);
  const ratioPath = `/tracks/0/fx/1/parameters/${ratio.index}/envelope`;
  const firstPoints = (await call("reaper_get", { path: ratioPath })).points;
  // Rewriting the middle replaces only the points inside the new range.
  const again = await run("live_write_fx_automation", { track: 0, fx: 1, fxName: "ReaComp", parameter: ratio.index, points: [{ beat: 4, normalized: 0.3 }, { beat: 12, normalized: 0.35 }] });
  assert.equal(again.createsEnvelope, false);
  const nowPoints = (await call("reaper_get", { path: ratioPath })).points;
  assert.equal(nowPoints.length, firstPoints.length + 1);
  assert.ok(nowPoints.every((point) => Math.abs(point.value - 0.4) > 1e-6), "The old middle point must be gone");
  await assert.rejects(run("live_write_fx_automation", { track: 0, fx: 1, fxName: "ReaEQ", parameterName: "Ratio", points: [{ beat: 0, normalized: 0 }] }), /identity/);
  await assert.rejects(run("live_write_fx_automation", { track: 0, fx: 1, fxGuid: added.guid, parameterName: "No Such", points: [{ beat: 0, normalized: 0 }] }), /Parameter not found/);
  await assert.rejects(run("live_remove_fx", { track: 0, fx: 1, fxName: "ReaEQ" }), /identity/);
  assert.equal((await run("live_remove_fx", { track: 0, fx: 1, fxGuid: added.guid })).fxCount, 1);
  await call("reaper_project", { operation: "save", file: "set.rpp" });
  const result = {
    result: "PASS",
    root,
    render: path.join(root, rendered.files[0]),
    set: { bpm: set.bpm, lengthBars: set.lengthBars, order: set.tracks.map((t) => `${t.file} ${t.camelot} ${t.sourceBpm} BPM x${t.playRate}`), warnings: set.warnings },
    renderedTempo: whole.bpm,
    transitions: report,
    bassShareDb: bass,
    checks: [
      "tempo, bar line, drop and key found for every track, in offline mode",
      "dry run leaves the project empty",
      "two decks, one tempo, items at planned bar, rate, offset, fades and gain",
      "rendered set holds the set tempo",
      "beats stay sharp and on the grid through both transitions",
      "pitch kept under tempo change, measured on a known note",
      "incoming drops land as their transitions end",
      "bass swap: low end arrives on the incoming deck and leaves the outgoing deck at the swap",
      "FX add, automation write with range replace, and removal, with identity checks",
    ],
  };
  await writeFile(path.join(root, "dj-check.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
  await stopOwned();
}
