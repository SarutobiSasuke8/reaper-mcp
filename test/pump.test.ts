// @ts-nocheck Synthetic measurement fixtures ported from the attributed LMMS source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pumpDepth } from '../../vendor/lmms-mcp/audio.mjs';
function noise(seed, n, amp = 0.25) { const x = new Float32Array(n); let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; x[i] = amp * (2 * (s / 4294967296) - 1); } return x; }
const SR = 48000, BEAT = SR / 2; // one beat at 120 BPM
function pumped(seed, beats, lead = 0) { const x = noise(seed, lead + BEAT * beats, 0.5);
  for (let i = lead; i < x.length; i++) x[i] *= 0.1 + 0.9 * (((i - lead) % BEAT) / BEAT); return x; }
test('bad bpm, slices or offset throws RangeError', () => {
  const a = { sampleRate: SR, channels: [noise(1, BEAT)] };
  assert.throws(() => pumpDepth(a, { bpm: 0 }), RangeError);
  assert.throws(() => pumpDepth(a, { bpm: 120, slices: 3 }), RangeError);
  assert.throws(() => pumpDepth(a, { bpm: 120, offset: -1 }), RangeError);
});
test('short input: no beats, null depth and dip', () => {
  const p = pumpDepth({ sampleRate: SR, channels: [noise(2, BEAT - 1)] }, { bpm: 120 });
  assert.deepEqual(p, { beats: 0, profileDb: [], depthDb: null, dipSlice: null, pumping: false });
});
test('steady noise: flat profile, not pumping', () => {
  const p = pumpDepth({ sampleRate: SR, channels: [noise(3, BEAT * 8)] }, { bpm: 120 });
  assert.equal(p.beats, 8); assert.equal(p.profileDb.length, 16);
  assert.ok(p.depthDb <= 1, String(p.depthDb)); assert.equal(p.pumping, false);
});
test('sidechain ramp: dip at slice 0, about 17.6 dB deep, pumping', () => {
  const p = pumpDepth({ sampleRate: SR, channels: [pumped(10, 8)] }, { bpm: 120 });
  assert.equal(p.beats, 8); assert.equal(p.dipSlice, 0); assert.equal(p.pumping, true);
  assert.ok(Math.abs(p.depthDb - 17.6) <= 0.6, String(p.depthDb));
});
test('offset aligns the grid; without it the dip lands mid-beat', () => {
  const x = pumped(20, 8, BEAT / 2);
  assert.equal(pumpDepth({ sampleRate: SR, channels: [x] }, { bpm: 120, offset: 0.25 }).dipSlice, 0);
  assert.equal(pumpDepth({ sampleRate: SR, channels: [x] }, { bpm: 120 }).dipSlice, 8);
});
test('stereo is mixed to mono: cancelling channels floor at -90 dB', () => {
  const l = noise(30, BEAT * 4), r = l.map(v => -v);
  const p = pumpDepth({ sampleRate: SR, channels: [l, r] }, { bpm: 120, slices: 8 });
  assert.equal(p.profileDb.length, 8); assert.ok(p.profileDb.every(v => v === -90));
  assert.equal(p.depthDb, 0); assert.equal(p.pumping, false);
});
test('fewer than 4 beats never counts as pumping', () => {
  const p = pumpDepth({ sampleRate: SR, channels: [pumped(40, 3)] }, { bpm: 120 });
  assert.equal(p.beats, 3); assert.ok(p.depthDb >= 3, String(p.depthDb)); assert.equal(p.pumping, false);
});

import { analyze, advise } from '../../vendor/lmms-mcp/audio.mjs';
const audioOf = x => ({ sampleRate: SR, frames: x.length, channels: [x] });
const warning = 'The sidechain dip lands mid-beat: check the sidechain trigger is on the kick.';
const pumpNotes = report => advise(report).filter(s => s === warning);
test('analyze: expected BPM detects ramp-ducked noise with dip at zero', () => {
  const report = analyze(audioOf(pumped(50, 8)), { expectedBpm: 120 });
  assert.equal(report.pump.pumping, true); assert.equal(report.pump.dipSlice, 0);
  assert.deepEqual(pumpNotes(report), []);
});
test('analyze: silence floors profile at -90; unknown tempo leaves pump null', () => {
  const audio = audioOf(new Float32Array(BEAT * 8));
  const report = analyze(audio, { expectedBpm: 120 });
  assert.deepEqual(report.pump.profileDb, Array(16).fill(-90));
  assert.equal(report.pump.pumping, false); assert.equal(analyze(audio).pump, null);
});
test('analyze: shorter than a beat gives zero beats and no pump advice', () => {
  const report = analyze(audioOf(noise(51, BEAT - 1)), { expectedBpm: 120 });
  assert.equal(report.pump.beats, 0); assert.deepEqual(pumpNotes(report), []);
});
test('pump advice requires eight pumping beats and excludes boundary slices', () => {
  const report = analyze(audioOf(pumped(20, 8, BEAT / 2)), { expectedBpm: 120 });
  assert.deepEqual(pumpNotes(report), [warning]);
  for (const dipSlice of [0, 1, 15]) assert.deepEqual(pumpNotes({ ...report, pump: { ...report.pump, dipSlice } }), []);
  assert.deepEqual(pumpNotes({ ...report, pump: { ...report.pump, beats: 7 } }), []);
  assert.deepEqual(pumpNotes({ ...report, pump: { ...report.pump, pumping: false } }), []);
  assert.deepEqual(pumpNotes({ ...report, pump: null }), []);
});
test('pump loop rejects sub-sample slices rather than stalling or dividing by zero', () => {
  for (const bpm of [Number.MAX_VALUE, SR * 60]) assert.throws(() => pumpDepth(audioOf(noise(1, BEAT)), { bpm }), RangeError);
});
