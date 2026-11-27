import test from "node:test";
import assert from "node:assert/strict";
import { grooveCapability, grooveEdits, swingTemplates, type ClipNote } from "../src/groove.js";
import { lintCapability, lintTracks, type LiveNote } from "../src/lint.js";
import { buildPiece, composeSchemas } from "../src/compose.js";

const sixteenths = (count: number, pitch = 42, velocity = 80): ClipNote[] =>
  Array.from({ length: count }, (_, index) => ({ index, beat: index * 0.25, duration: 0.2, pitch, velocity }));
const near = (a: number, e: number) => assert.ok(Math.abs(a - e) < 1e-9, `${a} is not ${e}`);

test("swing delays only the off-beat steps, by the template's share of a step", () => {
  const { edits, swung } = grooveEdits(sixteenths(16), 4, 120, { template: "mpc-swing-60", grid: "16th", strength: 1 });
  assert.equal(swung, 8);
  assert.deepEqual(edits.map((e) => e.index), [1, 3, 5, 7, 9, 11, 13, 15]);
  for (const e of edits) near(e.beat!, e.index * 0.25 + 0.15 * 0.25);
  assert.ok(edits.every((e) => e.velocity === undefined));
  // Half strength, a plain swing amount, and the 8th grid for jazz swing.
  near(grooveEdits(sixteenths(4), 4, 120, { swing: 0.2, grid: "16th", strength: 0.5 }).edits[0]!.beat!, 0.25 + 0.1 * 0.25);
  const eighths = grooveEdits(sixteenths(8), 4, 120, { template: "triplet", grid: "8th", strength: 1 });
  assert.deepEqual(eighths.edits.map((e) => e.index), [2, 6]);
  near(eighths.edits[0]!.beat!, 0.5 + 0.5 / 3);
  assert.equal(grooveEdits(sixteenths(16), 4, 120, { template: "straight", grid: "16th", strength: 1 }).edits.length, 0);
});
test("swing leaves notes that are already off the grid, so a second pass changes nothing", () => {
  const options = { template: "house-shuffle", grid: "16th", strength: 1 } as const;
  const first = grooveEdits(sixteenths(16), 4, 120, options);
  const moved = sixteenths(16).map((n) => ({ ...n, beat: first.edits.find((e) => e.index === n.index)?.beat ?? n.beat }));
  assert.equal(grooveEdits(moved, 4, 120, options).edits.length, 0);
  // A note played slightly late still counts as on the grid; one a third of a step away does not.
  const loose = [{ index: 0, beat: 0.25 + 0.01, duration: 0.1, pitch: 42, velocity: 80 }, { index: 1, beat: 0.75 + 0.08, duration: 0.1, pitch: 42, velocity: 80 }];
  assert.deepEqual(grooveEdits(loose, 4, 120, options).edits.map((e) => e.index), [0]);
});
test("humanise is repeatable from its seed, bounded, tighter when asked, and keeps notes inside the clip", () => {
  const options = { grid: "16th", strength: 1, humanize: { timingMs: 10, velocity: 12, seed: 7, tight: false } } as const;
  const a = grooveEdits(sixteenths(32), 8, 120, options);
  assert.deepEqual(grooveEdits(sixteenths(32), 8, 120, options), a);
  assert.notDeepEqual(grooveEdits(sixteenths(32), 8, 120, { ...options, humanize: { ...options.humanize, seed: 8 } }).edits, a.edits);
  const original = sixteenths(32);
  for (const e of a.edits) {
    // 10 ms at 120 BPM is 0.02 beat.
    if (e.beat !== undefined) assert.ok(Math.abs(e.beat - original[e.index]!.beat) <= 0.02 + 1e-9 && e.beat >= 0 && e.beat + 0.2 <= 8 + 1e-9);
    if (e.velocity !== undefined) assert.ok(Math.abs(e.velocity - 80) <= 12 && e.velocity >= 1 && e.velocity <= 127);
  }
  const tight = grooveEdits(sixteenths(32), 8, 120, { ...options, humanize: { ...options.humanize, tight: true } });
  assert.ok(tight.largestShiftBeats <= 0.01 + 1e-9 && tight.largestShiftBeats < a.largestShiftBeats);
  // The first note cannot move before the clip and the last cannot run past its end.
  const edge = grooveEdits([{ index: 0, beat: 0, duration: 0.25, pitch: 36, velocity: 100 }, { index: 1, beat: 3.75, duration: 0.25, pitch: 36, velocity: 100 }], 4, 120, { swing: 0.5, grid: "16th", strength: 1, humanize: { timingMs: 50, velocity: 0, seed: 3, tight: false } });
  for (const e of edge.edits) if (e.beat !== undefined) assert.ok(e.beat >= 0 && e.beat <= 3.75);
});
test("pitches limits the groove to chosen notes, and the schema needs something to do", () => {
  const mixed = [...sixteenths(8, 42), ...sixteenths(8, 36).map((n) => ({ ...n, index: n.index + 8 }))];
  const hats = grooveEdits(mixed, 4, 120, { template: "mpc-swing-70", grid: "16th", strength: 1, pitches: [42] });
  assert.ok(hats.edits.length === 4 && hats.edits.every((e) => e.index < 8));
  assert.ok(Object.keys(swingTemplates).includes("ukg-shuffle"));
  const base = { track: 0, item: 0, takeGuid: "{t}" };
  grooveCapability.schema.parse({ ...base, template: "triplet", grid: "8th" });
  grooveCapability.schema.parse({ ...base, humanize: {} });
  for (const bad of [base, { ...base, template: "triplet", swing: 0.2 }, { ...base, swing: 0.8 }, { ...base, template: "polka" }, { ...base, swing: 0.1, pitches: [] }])
    assert.throws(() => grooveCapability.schema.parse(bad));
});
test("the lint passes a composed piece and flags clashing, competing parts with fixes that name this server's tools", () => {
  const { steps } = buildPiece(composeSchemas.live_compose_piece.parse({ style: "adventure", bars: 16, seed: 3 }), 0);
  const names = steps.filter((s) => s.capability === "live_add_track").map((s) => s.args.name as string);
  const tracks = steps.filter((s) => s.capability === "live_insert_midi").map((s, i) => ({
    index: i,
    name: names[i]!,
    notes: (s.args.notes as { beat: number; duration: number; pitch: number; velocity: number }[]).map((n) => ({ startBeat: n.beat, endBeat: n.beat + n.duration, pitch: n.pitch, velocity: n.velocity })),
  }));
  const clean = lintTracks(tracks, { key: "A major" });
  assert.equal(clean.pass, true);
  assert.equal(clean.counts.error, 0);
  assert.deepEqual(clean.roles.map((r) => [r.track, r.role, r.source]), [["Lead", "lead", "track name"], ["Harmony", "harmony", "track name"], ["Pad", "pad", "track name"], ["Bass", "bass", "track name"], ["Drums", "drums", "track name"]]);
  assert.deepEqual(clean.key, { name: "A major", source: "given" });
  assert.equal(clean.bars, 16);
  // Two unnamed lines a semitone apart on every beat.
  const line = (pitch: number): LiveNote[] => Array.from({ length: 16 }, (_, i) => ({ startBeat: i, endBeat: i + 0.8, pitch: pitch + (i % 3), velocity: 90 }));
  const bad = lintTracks([{ index: 4, name: "Track 5", notes: line(72) }, { index: 7, name: "Track 8", notes: line(73) }]);
  assert.equal(bad.pass, false);
  assert.ok(bad.counts.error >= 1 && bad.score < clean.score);
  const clash = bad.findings.find((f) => f.rule === "clash.harsh-interval")!;
  assert.deepEqual(clash.tracks, [{ name: "Track 5", index: 4 }, { name: "Track 8", index: 7 }]);
  assert.deepEqual(clash.bars, [0, 1, 2, 3]);
  assert.ok(bad.roles.every((r) => r.source === "inferred from notes"));
  const missing = bad.findings.find((f) => f.rule === "role.missing")!;
  assert.match(missing.fix, /Pass roles \{"(4|7)": "<role>"\} to live_lint_arrangement/);
  assert.ok(bad.findings.every((f) => !/set_track_role/.test(f.fix)));
  // A given role is honoured, pad maps to the lint's texture role, and warnings fail only in strict mode.
  const given = lintTracks([{ index: 0, name: "Track 1", declared: "pad", notes: line(60) }, { index: 1, name: "Track 2", declared: "lead", notes: line(84) }]);
  assert.deepEqual(given.roles.map((r) => [r.role, r.source]), [["pad", "given"], ["lead", "given"]]);
  assert.throws(() => lintTracks(tracks, { key: "H minor" }));
  lintCapability.schema.parse({ roles: { "3": "counter" }, key: "D dorian", strict: true });
  assert.throws(() => lintCapability.schema.parse({ roles: { x: "lead" } }));
});
