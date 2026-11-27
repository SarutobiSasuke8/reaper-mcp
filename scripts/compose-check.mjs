// Native acceptance for the composition layer: compose a piece into a live project,
// read it back, render it and measure the audio. Uses bundled REAPER instruments unless
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
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-compose-"));
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
const client = new Client({ name: "compose-check", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/src/stdio.js", import.meta.url))],
    env,
    stderr: "pipe",
  }),
);
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: { mode: "live", ...args } }, undefined, { timeout: 300000 });
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

  // The library reads work in live mode too.
  const styles = await call("reaper_get", { path: "/styles" });
  assert.ok(styles.some((s) => s.name === "adventure"));
  const personas = await call("reaper_list", { path: "/personas", offset: 0, limit: 50 });
  assert.ok(personas.total >= 18);

  await call("reaper_enable_toolset", { name: "editing" });
  await call("reaper_project", { operation: "new", song: { tempo: 100 } });
  const request = { style: process.env.REAPER_MCP_COMPOSE_STYLE ?? "adventure", bars: 16, seed: 3, instruments };
  const preview = await run("live_compose_piece", request, true);
  assert.equal(preview.dryRun, true);
  assert.equal((await call("reaper_get", { path: "/tracks" })).length, 0);
  await assert.rejects(run("live_compose_piece", { ...request, instruments: { ...instruments, lead: "no-such-instrument" } }), /Instrument ID not found/);
  assert.equal((await call("reaper_get", { path: "/tracks" })).length, 0);

  const piece = await run("live_compose_piece", request);
  assert.deepEqual(piece.rolesWithoutInstrument, []);
  const tracks = await call("reaper_get", { path: "/tracks" });
  assert.deepEqual(tracks.map((t) => t.name), piece.tracks.map((t) => t.name));
  for (const t of piece.tracks) {
    assert.equal(tracks[t.index].fxCount, 1, `${t.name} must carry its instrument`);
    const notes = await call("reaper_get", { path: `/tracks/${t.index}/items/0/notes` });
    assert.equal(notes.length, t.notes, `${t.name} note count`);
  }
  const regions = (await call("reaper_get", { path: "/markers" })).filter((m) => m.isRegion);
  assert.deepEqual(regions.map((m) => [m.name, m.startBeat, m.endBeat]), piece.sections.map((s) => [s.name, s.startBar * 4, (s.startBar + s.bars) * 4]));
  const tempo = await call("reaper_get", { path: "/project/tempo_map" });
  assert.ok(Math.abs(tempo.markers[0].bpm - piece.bpm) < 1e-6);

  // A single part on its own track, written over the piece's first four chords.
  await run("live_add_track", { name: "Counter line" });
  const counter = tracks.length;
  await run("live_insert_instrument", { track: counter, instrument: instruments.lead });
  const part = await run("live_write_part", { track: counter, part: "melody", key: piece.key, chords: piece.chords.slice(0, 4), startBar: 2, seed: 9, low: 72, high: 88 });
  const partNotes = await call("reaper_get", { path: `/tracks/${counter}/items/0/notes` });
  assert.equal(partNotes.length, part.notes);
  assert.ok(partNotes.every((n) => n.pitch >= 72 && n.pitch <= 88 && n.startBeat >= 8 && n.endBeat <= 24 + 1e-9));

  // Hear it: render the whole piece and measure the audio.
  const rendered = await call("reaper_render", { target: "mix", timeoutMs: 280000 });
  const audio = await call("reaper_analyze", { file: rendered.files[0] });
  assert.ok(audio.rmsDbfs > -50, `Render is too quiet: ${audio.rmsDbfs} dBFS RMS`);
  assert.equal(audio.clippedSamples, 0);
  assert.ok(Math.abs(audio.durationSeconds - (piece.lengthSeconds + 2)) < 0.6, `Render length ${audio.durationSeconds}`);
  await call("reaper_project", { operation: "save", file: "composed.rpp" });
  const report = {
    result: "PASS",
    root,
    render: path.join(root, rendered.files[0]),
    project: path.join(root, "composed.rpp"),
    piece: { style: piece.style, key: piece.key, bpm: piece.bpm, form: piece.form, bars: piece.lengthBars, melodyScore: piece.melodyScore.score, tracks: piece.tracks, editSteps: piece.editSteps },
    audio: {
      durationSeconds: audio.durationSeconds, rmsDbfs: audio.rmsDbfs, peakDbfs: audio.peakDbfs, integratedLufs: audio.integratedLufs,
      estimatedBpm: audio.tempo?.bpm ?? audio.estimatedBpm ?? null, estimatedKey: audio.key?.name ?? audio.estimatedKey ?? null,
    },
    checks: [
      "style and persona library readable live",
      "dry run and unknown instrument leave the project empty",
      "piece placed as tracks, instruments, clips, tempo and regions in one batch",
      "note counts, regions and tempo read back from REAPER",
      "single melody part within its register and bars",
      "full render is audible, unclipped and the expected length",
    ],
  };
  await writeFile(path.join(root, "compose-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
  await stopOwned();
}
