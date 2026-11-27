// Native acceptance for arrangement lint and groove on a live session.
// Opens a disposable isolated REAPER.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { LiveBridge } from "../dist/src/live.js";
import { isolatedIni, locateReaper } from "../dist/src/render.js";
import { writeRpp } from "../dist/src/rpp/index.js";
import { songSchema } from "../dist/src/song/model.js";
import { lintArrangement, lintCapability } from "../dist/src/lint.js";
import { applyGroove, grooveCapability } from "../dist/src/groove.js";
if (process.env.REAPER_MCP_RUN_LIVE_CHECK !== "true")
  throw Error("Set REAPER_MCP_RUN_LIVE_CHECK=true; opens a disposable isolated REAPER instance");
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-feel-"));
const bridge = path.join(root, "bridge");
await mkdir(bridge);
const ini = path.join(root, "reaper.ini");
await writeFile(ini, isolatedIni());
await writeFile(
  path.join(root, "a.rpp"),
  writeRpp(songSchema.parse({ name: "a", tempo: 120, tracks: [{ name: "Lead" }, { name: "Track 2" }, { name: "Bass" }, { name: "Hats" }] })),
);
const b = new LiveBridge(bridge);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(
  await locateReaper(),
  ["-newinst", "-nosplash", "-cfgfile", ini, path.join(root, "a.rpp"), fileURLToPath(new URL("../bridge/reaper-mcp.lua", import.meta.url))],
  { env: { ...process.env, REAPER_MCP_BRIDGE_DIR: bridge, REAPER_MCP_ALLOW_WRITES: "true" }, stdio: "ignore", windowsHide: true },
);
async function stop() {
  if (child.exitCode === null) {
    const done = new Promise((r) => child.once("exit", r));
    child.kill();
    await done;
  }
}
const lint = (args = {}) => lintArrangement(b, lintCapability.schema.parse(args));
const groove = (args, dryRun = false) => applyGroove(b, grooveCapability.schema.parse(args), dryRun);
const clip = (track, notes, lengthBeats = 16) => b.mutate("live_insert_midi", { track, name: "Part", startBeat: 0, lengthBeats, notes }, false);
const note = (beat, pitch, duration = 0.9, velocity = 90) => ({ beat, duration, pitch, velocity, channel: 0 });
try {
  const until = Date.now() + 90000;
  while (!(await b.available())) {
    if (Date.now() > until) throw Error("Startup timeout: inspect isolated evaluation/dialog prompt");
    await delay(500);
  }
  await b.get("/tracks");
  await assert.rejects(lint(), /No unmuted MIDI notes/);

  // A melody in C major, a second line a semitone above it on every beat, and a bass.
  const tune = [60, 62, 64, 65, 67, 65, 64, 62, 60, 64, 67, 72, 71, 67, 64, 60];
  await clip(0, tune.map((pitch, i) => note(i, pitch + 12)));
  await clip(1, tune.map((pitch, i) => note(i, pitch + 13)));
  await clip(2, [0, 4, 8, 12].flatMap((bar, i) => [note(bar, [36, 41, 43, 36][i], 1.9), note(bar + 2, [36, 41, 43, 36][i], 1.9)]));
  const all = await b.get("/tracks/0/notes");
  assert.equal(all.length, 16);
  assert.deepEqual([all[3].startBeat, all[3].pitch, all[3].item], [3, 77, 0]);

  const before = await lint({ key: "C major" });
  assert.equal(before.pass, false);
  assert.deepEqual(before.roles.map((r) => [r.index, r.role, r.source]), [[0, "lead", "track name"], [1, "counter", "inferred from notes"], [2, "bass", "track name"]]);
  const clash = before.findings.find((f) => f.rule === "clash.harsh-interval");
  assert.ok(clash, "The semitone clash must be reported");
  assert.deepEqual(clash.tracks.map((t) => t.index).sort(), [0, 1]);
  assert.ok(before.findings.some((f) => f.rule.startsWith("key.")), "Notes outside C major must be reported");
  assert.equal((await b.get("/tracks/1/notes")).length, 16, "The lint changes nothing");

  // Follow the advice: move the second line onto chord tones a sixth below the melody.
  const item = await b.get("/tracks/1/items/0");
  const scale = [0, 2, 4, 5, 7, 9, 11];
  const sixthBelow = (pitch) => {
    const degree = scale.indexOf((pitch % 12 + 12) % 12);
    const lower = degree - 5;
    return pitch - (pitch % 12) + scale[(lower + 7) % 7] - (lower < 0 ? 12 : 0);
  };
  await b.mutate("live_edit_performance", { track: 1, item: 0, takeGuid: item.takeGuid, notes: tune.map((pitch, index) => ({ index, pitch: sixthBelow(pitch + 12) })), articulations: [], ramps: [] }, false);
  const after = await lint({ key: "C major", roles: { 1: "counter" } });
  assert.equal(after.findings.filter((f) => f.rule === "clash.harsh-interval").length, 0, JSON.stringify(after.findings));
  assert.equal(after.counts.error, 0);
  assert.ok(after.score > before.score);
  assert.equal(after.roles[1].source, "given");
  await b.set("/tracks/1/mute", true, false);
  assert.deepEqual((await lint()).roles.map((r) => r.index), [0, 2]);
  await b.set("/tracks/1/mute", false, false);

  // Groove: sixteen straight 16th hats with kicks on the beats.
  const hats = Array.from({ length: 16 }, (_, i) => note(i * 0.25, 42, 0.1, 80));
  const kicks = [0, 1, 2, 3].map((i) => note(i, 36, 0.2, 110));
  await clip(3, [...hats, ...kicks], 4);
  const hatItem = await b.get("/tracks/3/items/0");
  const ref = { track: 3, item: 0, takeGuid: hatItem.takeGuid };
  const read = async () => (await b.get("/tracks/3/items/0/notes")).map((n) => ({ beat: n.startBeat, length: n.endBeat - n.startBeat, pitch: n.pitch, velocity: n.velocity }));
  const straight = await read();
  const preview = await groove({ ...ref, template: "mpc-swing-60", pitches: [42] }, true);
  assert.deepEqual([preview.dryRun, preview.swung, preview.changed], [true, 8, 8]);
  assert.deepEqual(await read(), straight);
  await assert.rejects(groove({ ...ref, takeGuid: "{wrong}", swing: 0.2 }), /identity/);
  const swung = await groove({ ...ref, template: "mpc-swing-60", pitches: [42] });
  assert.equal(swung.largestShiftMs, 18.8);
  const now = await read();
  const hatBeats = now.filter((n) => n.pitch === 42).map((n) => n.beat).sort((x, y) => x - y);
  hatBeats.forEach((beat, i) => assert.ok(Math.abs(beat - (i * 0.25 + (i % 2 ? 0.0375 : 0))) < 0.002, `hat ${i} at ${beat}`));
  assert.deepEqual(now.filter((n) => n.pitch === 36).map((n) => n.beat), [0, 1, 2, 3]);
  assert.ok(now.every((n, i) => Math.abs(n.length - (n.pitch === 42 ? 0.1 : 0.2)) < 0.002), "Lengths are kept");
  // A second pass finds nothing on the off-beats to move.
  const again = await groove({ ...ref, template: "mpc-swing-60", pitches: [42] });
  assert.equal(again.changed, 0);
  // Humanise: repeatable, small, and every note still inside the clip.
  const feel = { ...ref, humanize: { timingMs: 10, velocity: 12, seed: 5 } };
  const planned = await groove(feel, true);
  const applied = await groove(feel);
  assert.deepEqual([applied.changed, applied.largestShiftMs], [planned.changed, planned.largestShiftMs]);
  assert.ok(applied.changed >= 16 && applied.largestShiftMs <= 10.5);
  const loose = await read();
  assert.ok(loose.every((n) => n.beat >= 0 && n.beat + n.length <= 4 + 1e-6));
  assert.ok(new Set(loose.filter((n) => n.pitch === 42).map((n) => n.velocity)).size > 4, "Velocities should vary");
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        lint: { before: { score: before.score, counts: before.counts }, after: { score: after.score, counts: after.counts }, firstFinding: clash.message },
        groove: { swungNotes: swung.swung, swingShiftMs: swung.largestShiftMs, humanisedNotes: applied.changed, humaniseMaxShiftMs: applied.largestShiftMs },
        checks: [
          "whole-track note read across items",
          "lint reports the semitone clash and out-of-key notes with track indexes, and changes nothing",
          "after following the fix the clash is gone and the score rises",
          "muted tracks are left out; given roles are honoured",
          "swing delays only the chosen off-beat notes by the template amount, keeps lengths",
          "a second swing pass moves nothing",
          "humanise matches its dry run and keeps notes inside the clip",
        ],
        root,
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
}
