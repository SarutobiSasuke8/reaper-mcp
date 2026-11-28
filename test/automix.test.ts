import test from "node:test";
import assert from "node:assert/strict";
import { autoMixCapability, verifyMix, masterOffset, planLevels, type StemFacts } from "../src/automix.js";

// The planner's fader top is twice unity, which is +6.02 dB, so compare within a hundredth of a dB.
const near = (actual: number[], expected: number[]) =>
  assert.ok(actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]!) <= 0.025), `${actual} is not near ${expected}`);
const stem = (index: number, name: string, peakDbfs: number | null, activeRmsDbfs: number | null, volumeDb = 0): StemFacts => ({
  index, name, volumeDb, peakDbfs, activeRmsDbfs, soundingShare: 0.9,
  crestDb: peakDbfs !== null && activeRmsDbfs !== null ? peakDbfs - activeRmsDbfs : undefined,
});

test("levels move each stem to its role target: drums by peak, pitched parts by sounding RMS", () => {
  const plan = planLevels(
    [stem(0, "Lead", -6, -27), stem(1, "Harmony", -10, -12.5), stem(2, "Pad", -20, -26), stem(3, "Bass", -8, -24), stem(4, "Drums", -14, -30)],
    true,
  );
  assert.deepEqual(plan.tracks.map((t) => [t.role, t.measure]), [["lead", "rms"], ["harmony", "rms"], ["pad", "rms"], ["bass", "rms"], ["drums", "peak"]]);
  // Targets: lead -17 RMS, harmony -22.5, pad -26, bass -18, drums -8 peak. The quiet lead and bass need +10 and +6.
  // The fader tops out at +6 dB in the planner, so every target comes down by the 4 dB the lead cannot reach.
  near([plan.targetShiftDb], [-4]);
  near(plan.tracks.map((t) => t.balanceDb), [6, -14, -4, 2, 2]);
  assert.ok(plan.tracks.every((t) => t.roleSource === "guess from name" && t.skipped === null));
  // The balance between tracks is the targets' balance, whatever the shift.
  const after = (i: number, measured: number) => measured + plan.tracks[i]!.balanceDb;
  near([after(0, -27) - after(3, -24), after(1, -12.5) - after(2, -26)], [-17 - -18, -22.5 - -26]);
});
test("a declared role beats the name, pad is accepted for texture, silent stems are left alone", () => {
  const facts = [stem(0, "Track 1", -9, -20), stem(1, "Bass", -9, -20), stem(2, "Lead", null, null)];
  facts[0]!.declared = "pad";
  facts[1]!.declared = "lead";
  const plan = planLevels(facts, true);
  assert.deepEqual(plan.tracks.map((t) => [t.role, t.roleSource]), [["pad", "declared"], ["lead", "declared"], ["lead", "guess from name"]]);
  assert.equal(plan.tracks[0]!.balanceDb, -6);
  assert.equal(plan.tracks[1]!.balanceDb, 3);
  assert.deepEqual([plan.tracks[2]!.skipped, plan.tracks[2]!.balanceDb, plan.tracks[2]!.factor], ["silent", 0, 1]);
});
test("balance false leaves every stem where it is", () => {
  const plan = planLevels([stem(0, "Lead", -6, -27), stem(1, "Drums", -14, -30)], false);
  assert.deepEqual(plan.tracks.map((t) => [t.balanceDb, t.targetDb, t.factor]), [[0, null, 1], [0, null, 1]]);
});
test("an existing fader position counts toward the fader limit", () => {
  // Already at +3 dB and needing +10: only 3 dB of travel is left, so the target comes down 7 dB.
  const plan = planLevels([stem(0, "Lead", -6, -27, 3)], true);
  near([plan.targetShiftDb, plan.tracks[0]!.balanceDb], [-7, 3]);
});
test("the mix moves to the loudness target unless the true-peak ceiling is closer", () => {
  assert.deepEqual(masterOffset(-24, -8, -16, -1), { offsetDb: 7, limitedBy: "peak" });
  assert.deepEqual(masterOffset(-24, -12, -16, -1), { offsetDb: 8, limitedBy: null });
  assert.deepEqual(masterOffset(-10, -0.2, -16, -1), { offsetDb: -6, limitedBy: null });
  assert.deepEqual(masterOffset(-15.5, -0.2, -16, -1), { offsetDb: -0.8, limitedBy: "peak" });
});
test("the schema bounds targets, roles and track lists", () => {
  const s = autoMixCapability.schema;
  assert.deepEqual([s.parse({}).targetLufs, s.parse({}).ceilingDb, s.parse({}).balance, s.parse({}).verify], [-16, -1, true, true]);
  s.parse({ roles: { "0": "lead", "12": "pad" }, tracks: [0, 12] });
  for (const bad of [{ targetLufs: -2 }, { ceilingDb: 1 }, { roles: { lead: "lead" } }, { roles: { "0": "vocals" } }, { tracks: [] }, { tracks: Array.from({ length: 13 }, (_, i) => i) }])
    assert.throws(() => s.parse(bad));
});

test("verification checks the actual mix against its achievable target and requested ceiling", () => {
  assert.equal(verifyMix({integratedLufs:-19, truePeakDbfs:-1, clippedSamples:0}, -19,-1).passed, true);
  assert.deepEqual(verifyMix({integratedLufs:-16,truePeakDbfs:-0.5,clippedSamples:2},-19,-1).failures,
    ["loudness_outside_tolerance","peak_ceiling_exceeded","clipping"]);
  assert.equal(verifyMix({integratedLufs:null,truePeakDbfs:null,clippedSamples:0},-19,-1).passed,false);
});
