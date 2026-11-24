// @ts-nocheck Synthetic fixtures ported unchanged from the attributed LMMS source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectOnsets, swingRatio } from '../../vendor/lmms-mcp/audio.mjs';
function clicks(times, sr, dur) {
  const x = new Float32Array(Math.round(sr * dur)), len = Math.round(0.05 * sr);
  for (const t of times) { const p = Math.round(t * sr);
    for (let i = 0; i < len && p + i < x.length; i++) x[p + i] += 0.5 * Math.sin(2 * Math.PI * 1500 * i / sr) * Math.exp(-i / (0.01 * sr)); }
  return x;
}
const grid = (start, step, count) => Array.from({ length: count }, (_, k) => start + k * step);
test('120 BPM quarter clicks, 48 kHz', () => {
  const t = grid(0.25, 0.5, 8), r = detectOnsets({ sampleRate: 48000, channels: [clicks(t, 48000, 4.5)] });
  assert.equal(r.count, 8);
  r.onsets.forEach((o, i) => assert.ok(Math.abs(o - t[i]) <= 0.03, `onset ${i} ${o} vs ${t[i]}`));
  assert.ok(Math.abs(r.meanIoi - 0.5) <= 0.01);
  assert.ok(Math.abs(r.density - 8 / 4.5) <= 0.01);
});
test('128 BPM eighths at 44.1 kHz, stereo', () => {
  const step = 60 / 128 / 2, t = grid(0.2, step, 16), x = clicks(t, 44100, 4.5);
  const r = detectOnsets({ sampleRate: 44100, channels: [x, x] });
  assert.equal(r.count, 16);
  assert.ok(Math.abs(r.meanIoi - step) <= 0.01);
});
test('straight eighths give swing ratio about 1', () => {
  const t = grid(0.2, 0.25, 16), r = detectOnsets({ sampleRate: 48000, channels: [clicks(t, 48000, 4.5)] });
  const s = swingRatio(r.onsets, 120);
  assert.ok(Math.abs(s.ratio - 1) <= 0.15, String(s.ratio)); assert.equal(s.offbeats, 8);
});
test('triplet swing gives swing ratio about 2', () => {
  const t = []; for (let b = 0; b < 8; b++) { t.push(0.2 + b * 0.5); t.push(0.2 + b * 0.5 + 0.5 * 2 / 3); }
  const r = detectOnsets({ sampleRate: 48000, channels: [clicks(t, 48000, 4.5)] });
  const s = swingRatio(r.onsets, 120);
  assert.ok(Math.abs(s.ratio - 2) <= 0.15, String(s.ratio)); assert.equal(s.offbeats, 8);
});
test('silence returns empty without throwing', () => {
  const r = detectOnsets({ sampleRate: 48000, channels: [new Float32Array(48000 * 2)] });
  assert.equal(r.count, 0); assert.deepEqual(r.onsets, []); assert.equal(r.meanIoi, null); assert.ok(r.frames > 0);
});
test('short buffer gives zero frames', () => {
  const r = detectOnsets({ sampleRate: 48000, channels: [new Float32Array(100)] });
  assert.equal(r.frames, 0); assert.equal(r.count, 0);
});
test('swingRatio edge cases', () => {
  assert.deepEqual(swingRatio([], 120), { ratio: null, offbeats: 0 });
  assert.deepEqual(swingRatio([0, 0.5, 1.0], 120), { ratio: null, offbeats: 0 });
  assert.deepEqual(swingRatio([0, 0.25], 0), { ratio: null, offbeats: 0 });
});

import { analyze, advise } from '../../vendor/lmms-mcp/audio.mjs';
const audioOf = samples => ({ sampleRate: 48000, frames: samples.length, channels: [samples] });
test('analyze reports rhythm on clicks without raw onsets or opt-in expectation fields', () => {
  const r = analyze(audioOf(clicks(grid(0.25, 0.5, 8), 48000, 4.5)));
  assert.equal(r.rhythm.onsetCount, 8);
  assert.deepEqual(Object.keys(r.rhythm).sort(), ['density', 'meanIoi', 'offbeats', 'onsetCount', 'swing']);
});
test('analyze compares straight eighths to expected swing and advises only mismatches', () => {
  const audio = audioOf(clicks(grid(0.2, 0.25, 16), 48000, 4.5));
  const straight = analyze(audio, { expectedBpm: 120, expectedSwing: 'straight' });
  assert.equal(straight.rhythm.expectedSwing, 1);
  assert.equal(straight.rhythm.swingMatch, true);
  assert.ok(!advise(straight).some(note => note.startsWith('Detected swing ratio')));
  const swung = analyze(audio, { expectedBpm: 120, expectedSwing: 2 });
  assert.equal(swung.rhythm.swingMatch, false);
  assert.deepEqual(advise(swung).filter(note => note.startsWith('Detected swing ratio')),
    [`Detected swing ratio (${swung.rhythm.swing}) does not match the requested 2: check the groove swing setting and the humanise amount.`]);
});
test('analyze silence has no onsets or swing, with nullable expected-swing match', () => {
  const audio = audioOf(new Float32Array(48000));
  for (const options of [{}, { expectedSwing: 'triplet' }, { expectedBpm: 120, expectedSwing: 1 }]) {
    const r = analyze(audio, options);
    assert.equal(r.rhythm.onsetCount, 0);
    assert.equal(r.rhythm.swing, null);
    if (options.expectedSwing !== undefined) assert.equal(r.rhythm.swingMatch, null);
    assert.ok(!advise(r).some(note => note.startsWith('Detected swing ratio')));
  }
});
test('expectedSwing rejects invalid values before analysing audio', () => {
  for (const value of [null, true, false, '', '1', 'shuffle', 0, -1, NaN, Infinity, -Infinity, {}, []]) {
    assert.throws(() => analyze(null, { expectedSwing: value }), { name: 'RangeError', message: /expectedSwing/ });
  }
});
test('triplet alias and numeric expectations accept the detected triplet ratio', () => {
  const times = []; for (let b = 0; b < 8; b++) times.push(0.2 + b * 0.5, 0.2 + b * 0.5 + 1 / 3);
  const audio = audioOf(clicks(times, 48000, 4.5));
  for (const expectedSwing of ['triplet', 2]) {
    const r = analyze(audio, { expectedBpm: 120, expectedSwing });
    assert.equal(r.rhythm.expectedSwing, 2);
    assert.equal(r.rhythm.swingMatch, true);
  }
});
