// @ts-nocheck Synthetic measurement fixtures ported from the attributed LMMS source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { barEnergy, findDrops } from '../../vendor/lmms-mcp/audio.mjs';
function noise(seed, n, amp = 0.25) { const x = new Float32Array(n); let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; x[i] = amp * (2 * (s / 4294967296) - 1); } return x; }
const SR = 48000, BAR = SR * 2; // one 4/4 bar at 120 BPM
function sections(seed, amps) { const x = new Float32Array(BAR * amps.length);
  amps.forEach((a, j) => x.set(noise(seed + j, BAR, a), j * BAR)); return x; }
test('bad bpm or beatsPerBar throws RangeError', () => {
  assert.throws(() => barEnergy({ sampleRate: SR, channels: [noise(1, BAR)] }, { bpm: 0 }), RangeError);
  assert.throws(() => barEnergy({ sampleRate: SR, channels: [noise(1, BAR)] }, { bpm: 120, beatsPerBar: 2.5 }), RangeError);
});
test('short input: no bars, null peak and range', () => {
  const e = barEnergy({ sampleRate: SR, channels: [noise(2, BAR - 1)] }, { bpm: 120 });
  assert.equal(e.barSeconds, 2); assert.deepEqual(e.bars, []); assert.equal(e.peakBar, null); assert.equal(e.rangeDb, null);
  assert.deepEqual(findDrops(e.bars), []);
});
test('steady noise: 8 flat bars, no drops', () => {
  const e = barEnergy({ sampleRate: SR, channels: [noise(3, BAR * 8)] }, { bpm: 120 });
  assert.equal(e.bars.length, 8); assert.ok(e.rangeDb <= 0.5, String(e.rangeDb)); assert.deepEqual(findDrops(e.bars), []);
});
test('quiet 8 bars then loud 8 bars: one drop at bar 8, about +20 dB', () => {
  const e = barEnergy({ sampleRate: SR, channels: [sections(10, [...Array(8).fill(0.05), ...Array(8).fill(0.5)])] }, { bpm: 120 });
  const d = findDrops(e.bars); assert.equal(d.length, 1); assert.equal(d[0].bar, 8);
  assert.ok(Math.abs(d[0].jumpDb - 20) <= 1, String(d[0].jumpDb)); assert.ok(e.peakBar >= 8);
});
test('silent intro floors at -90 dB and the entry is a drop', () => {
  const e = barEnergy({ sampleRate: SR, channels: [sections(20, [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5])] }, { bpm: 120 });
  assert.equal(e.bars[0], -90); assert.deepEqual(findDrops(e.bars).map(d => d.bar), [4]);
});
test('minGap suppresses a second drop', () => {
  const e = barEnergy({ sampleRate: SR, channels: [sections(30, [0.05, 0.05, 0.05, 0.05, 0.5, 0.5, 0.5, 0.5, 0.05, 0.05, 0.05, 0.05, 0.5, 0.5, 0.5, 0.5])] }, { bpm: 120 });
  assert.deepEqual(findDrops(e.bars).map(d => d.bar), [4, 12]);
  assert.deepEqual(findDrops(e.bars, { minGap: 16 }).map(d => d.bar), [4]);
});
test('stereo is mixed to mono and offset shifts the grid', () => {
  const l = noise(40, BAR * 4), r = l.map(v => -v);
  const e = barEnergy({ sampleRate: SR, channels: [l, r] }, { bpm: 120 });
  assert.deepEqual(e.bars, [-90, -90, -90, -90]); assert.deepEqual(findDrops(e.bars), []);
  const o = barEnergy({ sampleRate: SR, channels: [noise(41, BAR * 4)] }, { bpm: 120, offset: 1 }); assert.equal(o.bars.length, 3);
});

import { analyze, advise } from '../../vendor/lmms-mcp/audio.mjs';
const audioOf = x => ({ sampleRate: SR, frames: x.length, channels: [x] });
const energyNotes = report => advise(report).filter(s => s.startsWith('No drop found:') || s.startsWith('Bar-to-bar energy'));
test('analyze: expected BPM places the quiet-to-loud drop on bar 8', () => {
  const report = analyze(audioOf(sections(50, [...Array(8).fill(0.05), ...Array(8).fill(0.5)])), { expectedBpm: 120 });
  assert.equal(report.arrangement.barSeconds, 2);
  assert.equal(report.arrangement.bars.length, 16);
  assert.deepEqual(report.arrangement.drops.map(d => d.bar), [8]);
  assert.deepEqual(energyNotes(report), []);
});
test('analyze: silence floors bars at -90 and no tempo leaves arrangement null', () => {
  const audio = audioOf(new Float32Array(BAR * 16));
  const report = analyze(audio, { expectedBpm: 120 });
  assert.deepEqual(report.arrangement.bars, Array(16).fill(-90));
  assert.deepEqual(report.arrangement.drops, []);
  assert.equal(energyNotes(report).length, 2);
  assert.equal(analyze(audio).arrangement, null);
});
test('analyze: short audio returns empty bars without new advice', () => {
  const report = analyze(audioOf(noise(51, BAR - 1)), { expectedBpm: 120 });
  assert.deepEqual(report.arrangement, { barSeconds: 2, bars: [], peakBar: null, rangeDb: null, drops: [] });
  assert.deepEqual(energyNotes(report), []);
});
test('arrangement advice obeys exact bar and range thresholds', () => {
  const report = analyze(audioOf(noise(52, BAR)), { expectedBpm: 120 });
  const notes = (count, rangeDb, drops = []) => energyNotes({ ...report, arrangement: { bars: Array(count).fill(-20), rangeDb, drops } });
  assert.deepEqual(notes(7, 0), []);
  assert.equal(notes(8, 2.9).length, 1);
  assert.deepEqual(notes(8, 3), []);
  assert.deepEqual(notes(15, null), []);
  assert.equal(notes(16, null).length, 1);
  assert.deepEqual(notes(16, 3, [{ bar: 8, jumpDb: 6 }]), []);
});
test('sub-sample bar lengths cannot stall the bar-energy loop', () => {
  assert.throws(() => barEnergy(audioOf(new Float32Array(1)), { bpm: Number.MAX_VALUE }), RangeError);
});
