import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeTrack, analyzeFiles, bassSwap, bassSwapPoints, camelotDistance, djBuild, djBuildCapability, findDrops, planSet, type TrackAnalysis } from "../src/dj.js";
import { decodeWav } from "../src/audio.js";
import { LiveBridge } from "../src/live.js";
import { Workspace } from "../src/workspace.js";
// @ts-ignore Plain JavaScript fixture shared with the native check.
import { synthTrack } from "../../scripts/dj-fixture.mjs";

const track = (file: string, bpm: number, camelot: string, extra: Partial<TrackAnalysis> = {}): TrackAnalysis => ({
  file, durationSeconds: 240, bpm, tempoConfidence: 1, beatOffsetSeconds: 0.1, downbeatOffsetSeconds: 0.1, downbeatConfident: true,
  bars: 96, key: "x", camelot, keyConfidence: 0.8, integratedLufs: -12, truePeakDbfs: -1, barEnergyDb: [], drops: [16], firstDropBar: 16, ...extra,
});

test("analysis finds tempo to 0.01 BPM, the first beat, the bar line, the drop and loudness", () => {
  for (const spec of [
    { bpm: 120, tonicMidi: 57, mode: "minor", bars: 16, dropBar: 8, leadSeconds: 0, key: "8A" },
    { bpm: 126.37, tonicMidi: 62, mode: "minor", bars: 20, dropBar: 12, leadSeconds: 0.137, key: "7A" },
    { bpm: 174, tonicMidi: 60, mode: "major", bars: 24, dropBar: 8, leadSeconds: 0.05, key: "8B" },
  ]) {
    const a = analyzeTrack(decodeWav(synthTrack(spec)) as any);
    assert.ok(Math.abs(a.bpm! - spec.bpm) <= 0.011, `tempo ${a.bpm} for ${spec.bpm}`);
    assert.ok(Math.abs(a.downbeatOffsetSeconds - spec.leadSeconds) <= 0.006, `bar line ${a.downbeatOffsetSeconds} for ${spec.leadSeconds}`);
    assert.equal(a.downbeatConfident, true);
    assert.equal(a.bars, spec.bars - (spec.leadSeconds > 0 ? 0 : 0));
    assert.deepEqual(a.drops, [spec.dropBar]);
    assert.equal(a.camelot, spec.key);
    assert.ok(a.tempoConfidence > 0.8 && a.integratedLufs! < -10 && a.integratedLufs! > -30);
  }
  const silent = analyzeTrack({ sampleRate: 44100, frames: 44100 * 8, channels: [new Float32Array(44100 * 8)] });
  assert.deepEqual([silent.bpm, silent.bars, silent.camelot], [null, 0, null]);
});
test("drops need a 6 dB jump near the loudest level and stay 8 bars apart", () => {
  const quiet = Array(8).fill(-30), loud = Array(8).fill(-12);
  assert.deepEqual(findDrops([...quiet, ...loud, ...quiet, ...loud]), [8, 24]);
  // A slow build of 2 dB a bar never jumps 6 dB over the four bars before it.
  assert.deepEqual(findDrops([...quiet, -28, -26, -24, -22, -20, -18, -16, -14, -12, -12]), []);
  assert.deepEqual(findDrops(Array(32).fill(-12)), []);
  assert.deepEqual(findDrops([...quiet, ...Array(8).fill(-20), ...loud]), [16]);
});
test("Camelot distance: same key 0, neighbours and relative keys 1, the rest clash", () => {
  assert.equal(camelotDistance("8A", "8A"), 0);
  assert.equal(camelotDistance("8A", "9A"), 1);
  assert.equal(camelotDistance("8A", "8B"), 1);
  assert.equal(camelotDistance("12A", "1A"), 1);
  assert.equal(camelotDistance("8A", "9B"), 2);
  assert.equal(camelotDistance("1B", "7B"), 6);
  assert.equal(camelotDistance("8A", null), null);
});
test("a set shares one tempo, alternates decks, lines bars up and lands the incoming drop on the transition end", () => {
  const plan = planSet([track("a.wav", 120, "8A"), track("b.wav", 128, "9A", { firstDropBar: 24, downbeatOffsetSeconds: 0.25 }), track("c.wav", 124, "8B", { firstDropBar: null, integratedLufs: -9 })], { order: "given" });
  assert.equal(plan.bpm, 124);
  assert.deepEqual(plan.tracks.map((t) => t.deck), ["A", "B", "A"]);
  assert.deepEqual(plan.tracks.map((t) => t.playRate), [1.033333, 0.96875, 1]);
  // Track a plays all 96 bars. Track b enters 16 bars before a ends, 8 bars into itself, so its bar-24 drop lands at bar 96.
  assert.deepEqual(plan.tracks.map((t) => [t.startBar, t.playBars, t.enterAtSourceBar, t.dropLandsAtBar]), [[0, 96, 0, 16], [80, 88, 8, 96], [152, 96, 0, null]]);
  assert.equal(plan.tracks[1]!.offsetSeconds, 0.25 + (8 * 4 * 60) / 128);
  const bar = 240 / 124;
  assert.ok(plan.tracks.every((t) => Math.abs(t.lengthSeconds - t.playBars * bar) < 1e-3 && t.startBeat === t.startBar * 4));
  // Source consumed never runs past the file: length times rate is bars of the source at its own tempo.
  assert.ok(Math.abs(plan.tracks[0]!.lengthSeconds * plan.tracks[0]!.playRate - 96 * 2) < 1e-3);
  assert.deepEqual(plan.tracks.map((t) => [Math.round(t.fadeInSeconds / bar), Math.round(t.fadeOutSeconds / bar)]), [[0, 16], [16, 16], [16, 4]]);
  assert.deepEqual(plan.tracks.map((t) => t.gainDb), [-4, -4, -7]);
  assert.deepEqual(plan.transitions.map((x) => [x.startBar, x.bars, x.keyMove, x.compatible]), [[80, 16, 1, true], [152, 16, 2, false]]);
  assert.equal(plan.lengthBars, 248);
  assert.ok(plan.warnings.some((w) => /b\.wav into c\.wav: keys clash \(9A to 8B\)/.test(w)));
});
test("ordering, half-time tracks, short tracks and bad input", () => {
  const pool = [track("start.wav", 124, "8A"), track("far.wav", 124, "2B"), track("near.wav", 125, "9A"), track("same.wav", 126, "8A")];
  assert.deepEqual(planSet(pool).tracks.map((t) => t.file), ["start.wav", "same.wav", "near.wav", "far.wav"]);
  assert.deepEqual(planSet(pool, { order: "bpm" }).tracks.map((t) => t.sourceBpm), [124, 124, 125, 126]);
  // A 87 BPM track in a 174 BPM set is matched at double time, not stretched to twice its speed.
  const half = planSet([track("dnb.wav", 174, "5A"), track("hiphop.wav", 87, "5A", { bars: 48, firstDropBar: null })], { tempo: "first", order: "given" });
  assert.deepEqual([half.bpm, half.tracks[1]!.playRate, half.tracks[1]!.playBars], [174, 1, 96]);
  const fixed = planSet([track("a.wav", 120, "8A"), track("b.wav", 140, "8A")], { tempo: 128, order: "given" });
  assert.ok(fixed.warnings.some((w) => /b\.wav: tempo changes by -8\.6%/.test(w)));
  // Short tracks shrink the transition instead of overlapping more than half of either track.
  const short = planSet([track("a.wav", 124, "8A", { bars: 24, firstDropBar: null }), track("b.wav", 124, "8A", { bars: 20, firstDropBar: null })], { transitionBars: 32, order: "given" });
  assert.equal(short.transitions[0]!.bars, 8);
  assert.ok(short.warnings.some((w) => /transition shortened to 8 bars/.test(w)));
  assert.equal(planSet(pool, { maxBarsPerTrack: 32, order: "given" }).lengthBars, 32 * 4 - 16 * 3);
  assert.ok(planSet([track("a.wav", 124, "8A", { keyConfidence: 0.3, downbeatConfident: false })]).warnings.length === 2);
  assert.throws(() => planSet([track("a.wav", 124, "8A"), track("b.wav", 124, "8A", { bpm: null })]), /No steady tempo found in b\.wav/);
  assert.throws(() => planSet([track("a.wav", 124, "8A", { bars: 4 })]), /shorter than 8 bars/);
  assert.throws(() => planSet([]), /1 to 20 tracks/);
  assert.throws(() => djBuildCapability.schema.parse({ files: ["a.wav"], transitionBars: 10 }));
});
test("building a set analyses, caches, and sends one batch of tempo, decks, stretched items, regions and markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dj-"));
  await writeFile(path.join(root, "one.wav"), synthTrack({ bpm: 120, tonicMidi: 57, bars: 16, dropBar: 8 }));
  await writeFile(path.join(root, "two.wav"), synthTrack({ bpm: 126, tonicMidi: 57, bars: 16, dropBar: 8, leadSeconds: 0.1 }));
  await writeFile(path.join(root, "notes.txt"), "x");
  const workspace = await Workspace.open(root);
  const first = await analyzeFiles(workspace, ["one.wav", "two.wav"]);
  assert.deepEqual(first.map((a) => a.bpm), [120, 126]);
  assert.equal((await readdir(path.join(root, ".reaper-mcp-dj"))).length, 2);
  assert.deepEqual(await analyzeFiles(workspace, ["one.wav", "two.wav"]), first);
  await assert.rejects(analyzeFiles(workspace, ["notes.txt"]), /reads WAV files/);
  await assert.rejects(analyzeFiles(workspace, ["missing.wav"]), /not found/);
  const batches: any[] = [];
  const reads: Record<string, unknown> = { "/tracks": [{}, {}, {}], "/project/tempo_map": { markers: [{ beat: 0 }] }, "/plugins": [{ name: "VST: ReaComp (Cockos)" }, { name: "VST: ReaEQ (Cockos)" }] };
  const bridge = {
    get: async (p: string) => reads[p],
    batch: async (...args: any[]) => { batches.push(args); return { undoLabel: "REAPER MCP: batch #1" }; },
  } as unknown as LiveBridge;
  const args = djBuildCapability.schema.parse({ files: ["one.wav", "two.wav"], transitionBars: 4, tempo: 123, order: "given", transition: "crossfade" });
  const preview: any = await djBuild(bridge, workspace, args, true);
  assert.equal(batches.length, 0);
  assert.deepEqual(preview.decks, [{ name: "Deck A", index: 3 }, { name: "Deck B", index: 4 }]);
  const built: any = await djBuild(bridge, workspace, args, false);
  assert.equal(built.undoLabel, "REAPER MCP: batch #1");
  const steps = batches[0][0];
  assert.deepEqual(steps.map((s: any) => s.action), ["live_set_tempo", "live_add_track", "live_add_track", "live_insert_audio", "live_add_marker", "live_insert_audio", "live_add_marker", "live_add_marker"]);
  assert.deepEqual(steps[0].args, { beat: 0, bpm: 123 });
  const [a, b] = [steps[3].args, steps[5].args];
  assert.deepEqual([a.track, b.track, a.preservePitch, a.startBeat, b.startBeat], [3, 4, true, 0, 48]);
  assert.ok(Math.abs(a.playRate - 123 / 120) < 1e-6 && Math.abs(b.playRate - 123 / 126) < 1e-6);
  // The incoming track enters 4 bars before its bar-8 drop, measured from its own first bar line.
  assert.ok(Math.abs(b.offsetSeconds - (0.1 + (4 * 240) / 126)) < 0.006);
  assert.ok(path.isAbsolute(a.file) && a.name === "one");
  assert.equal(steps.at(-1).args.beat, 48);
  reads["/project/tempo_map"] = { markers: [{ beat: 0 }, { beat: 64 }] };
  await assert.rejects(djBuild(bridge, workspace, args, false), /one steady tempo/);
  await assert.rejects(djBuild(bridge, workspace, { ...args, files: ["one.wav", "one.wav"] }, true), /may appear once/);
  assert.equal(batches.length, 1);
});

test("bass swap keeps the low end on one deck and swaps over one bar at the middle of each transition", async () => {
  const plan = planSet([track("a.wav", 124, "8A"), track("b.wav", 124, "8A"), track("c.wav", 124, "8A")], { order: "given" });
  assert.equal(plan.transition, "bass_swap");
  const points = bassSwapPoints(plan);
  const { full, cut } = bassSwap;
  // Transitions run bars 80-96 and 160-176, so the swaps centre on bars 88 and 168 (beats 352 and 672).
  assert.deepEqual(points.A, [
    { beat: 0, normalized: full }, { beat: 350, normalized: full }, { beat: 354, normalized: cut },
    { beat: 670, normalized: cut }, { beat: 674, normalized: full },
  ]);
  assert.deepEqual(points.B, [
    { beat: 0, normalized: cut }, { beat: 350, normalized: cut }, { beat: 354, normalized: full },
    { beat: 670, normalized: full }, { beat: 674, normalized: cut },
  ]);
  // At every point in time exactly one deck is full, outside the one-bar swaps.
  for (const beat of [0, 100, 349, 355, 500, 669, 675, 900]) {
    const at = (list: { beat: number; normalized: number }[]) => [...list].reverse().find((p) => p.beat <= beat)!.normalized;
    assert.deepEqual([at(points.A), at(points.B)].sort(), [cut, full]);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "dj-swap-"));
  await writeFile(path.join(root, "one.wav"), synthTrack({ bpm: 120, tonicMidi: 57, bars: 16, dropBar: 8 }));
  await writeFile(path.join(root, "two.wav"), synthTrack({ bpm: 126, tonicMidi: 57, bars: 16, dropBar: 8 }));
  const workspace = await Workspace.open(root);
  const batches: any[] = [];
  const reads: Record<string, unknown> = { "/tracks": [], "/project/tempo_map": { markers: [] }, "/plugins": [{ name: "VST: ReaEQ (Cockos)" }] };
  const bridge = {
    get: async (p: string) => reads[p],
    batch: async (...args: any[]) => { batches.push(args); return { undoLabel: "x" }; },
  } as unknown as LiveBridge;
  const built: any = await djBuild(bridge, workspace, djBuildCapability.schema.parse({ files: ["one.wav", "two.wav"], transitionBars: 4, order: "given", regions: false }), false);
  assert.equal(built.transition, "bass_swap");
  const steps = batches[0][0];
  assert.deepEqual(steps.map((s: any) => s.action), [
    "live_set_tempo", "live_add_track", "live_add_track",
    "live_add_fx", "live_set_fx_parameter", "live_write_fx_automation",
    "live_add_fx", "live_set_fx_parameter", "live_write_fx_automation",
    "live_insert_audio", "live_insert_audio", "live_add_marker",
  ]);
  assert.deepEqual(steps[3].args, { track: 0, plugin: "VST: ReaEQ (Cockos)" });
  assert.deepEqual(steps[4].args, { track: 0, fx: 0, fxName: "ReaEQ", parameterName: "Freq-Low Shelf", normalized: bassSwap.frequency });
  assert.deepEqual(steps[8].args.points[0], { beat: 0, normalized: cut });
  assert.equal(steps[8].args.parameterName, "Gain-Low Shelf");
  // Without ReaEQ the set still builds, as a crossfade, and says so.
  reads["/plugins"] = [];
  const plain: any = await djBuild(bridge, workspace, djBuildCapability.schema.parse({ files: ["one.wav", "two.wav"], transitionBars: 4, order: "given" }), true);
  assert.equal(plain.transition, "crossfade");
  assert.ok(plain.warnings.some((w: string) => /ReaEQ is not installed/.test(w)));
  // A single track has no transition, so no EQ is added.
  const solo: any = await djBuild(bridge, workspace, djBuildCapability.schema.parse({ files: ["one.wav"] }), true);
  assert.equal(solo.transition, "crossfade");
});
