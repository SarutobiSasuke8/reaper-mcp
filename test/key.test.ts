// @ts-nocheck Synthetic fixtures ported unchanged from the attributed LMMS source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelot, estimateKey } from '../../vendor/lmms-mcp/audio.mjs';

function hz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function prog(chords, sr) {
  const len = Math.round(sr * 2);
  const out = new Float32Array(len * chords.length);
  for (let k = 0; k < chords.length; k++) {
    const notes = chords[k];
    const base = k * len;
    for (let n = 0; n < notes.length; n++) {
      const f = hz(notes[n]);
      for (let i = 0; i < len; i++) {
        out[base + i] += 0.15 * Math.sin((2 * Math.PI * f * i) / sr);
      }
    }
  }
  return out;
}

function tr(chords, d) {
  return chords.map((chord) => chord.map((m) => m + d));
}

const C_MAJ = [
  [48, 60, 64, 67],
  [53, 60, 65, 69],
  [55, 59, 62, 67],
  [48, 60, 64, 67],
];

const A_MIN = [
  [45, 57, 60, 64],
  [50, 57, 62, 65],
  [52, 56, 59, 64],
  [45, 57, 60, 64],
];

test('C major at 48 kHz is 8B with confidence >= 0.6', () => {
  const audio = prog(C_MAJ, 48000);
  const r = estimateKey({ sampleRate: 48000, channels: [audio] });
  assert.equal(r.key, 'C major');
  assert.equal(r.camelot, '8B');
  assert.ok(r.confidence >= 0.6, 'confidence ' + r.confidence);
});

test('A minor at 48 kHz is 8A', () => {
  const audio = prog(A_MIN, 48000);
  const r = estimateKey({ sampleRate: 48000, channels: [audio] });
  assert.equal(r.key, 'A minor');
  assert.equal(r.camelot, '8A');
});

test('G major at 44.1 kHz is 9B', () => {
  const audio = prog(tr(C_MAJ, 7), 44100);
  const r = estimateKey({ sampleRate: 44100, channels: [audio] });
  assert.equal(r.key, 'G major');
  assert.equal(r.camelot, '9B');
});

test('F# minor at 48 kHz is 11A', () => {
  const audio = prog(tr(A_MIN, -3), 48000);
  const r = estimateKey({ sampleRate: 48000, channels: [audio] });
  assert.equal(r.key, 'F# minor');
  assert.equal(r.camelot, '11A');
});

test('stereo D major at 48 kHz is 10B', () => {
  const audio = prog(tr(C_MAJ, 2), 48000);
  const r = estimateKey({ sampleRate: 48000, channels: [audio, audio] });
  assert.equal(r.key, 'D major');
  assert.equal(r.camelot, '10B');
});

test('all-zero mono is silent with 12 zero chroma', () => {
  const audio = new Float32Array(48000 * 5);
  const r = estimateKey({ sampleRate: 48000, channels: [audio] });
  assert.equal(r.key, null);
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.chroma, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('100-sample buffer yields no frames', () => {
  const audio = new Float32Array(100);
  const r = estimateKey({ sampleRate: 48000, channels: [audio] });
  assert.equal(r.key, null);
  assert.equal(r.frames, 0);
});

test('camelot table', () => {
  assert.equal(camelot(0, 'major'), '8B');
  assert.equal(camelot(9, 'minor'), '8A');
  assert.equal(camelot(7, 'major'), '9B');
  assert.equal(camelot(4, 'minor'), '9A');
  assert.equal(camelot(11, 'major'), '1B');
  assert.equal(camelot(8, 'minor'), '1A');
  assert.equal(camelot(5, 'major'), '7B');
  assert.equal(camelot(6, 'minor'), '11A');
});

import { analyze, advise } from '../../vendor/lmms-mcp/audio.mjs';
const samples = prog(C_MAJ, 48000);
const audio = { sampleRate: 48000, frames: samples.length, channels: [samples] };
test('analyze includes the six key fields by default', () => {
  assert.deepEqual(Object.keys(analyze(audio).key).sort(), ['camelot', 'confidence', 'key', 'margin', 'mode', 'tonic']);
});
test('analyze compares requested keys and advises only on incompatible keys', () => {
  const matching = analyze(audio, { expectedKey: 'C major' });
  assert.equal(matching.key.match, true);
  const relative = analyze(audio, { expectedKey: 'A minor' });
  assert.equal(relative.key.match, false);
  assert.equal(relative.key.compatible, true);
  assert.ok(!advise(relative).some(note => note.startsWith('Detected key')));
  const wrong = analyze(audio, { expectedKey: 'F# major' });
  assert.equal(wrong.key.compatible, false);
  assert.ok(advise(wrong).includes('Detected key (C major, Camelot 8B) does not match the requested 2B: check the project key, the bass line and the chord pattern.'));
});
test('analyze parses Camelot codes like named keys', () => {
  assert.deepEqual(analyze(audio, { expectedKey: '8A' }).key, analyze(audio, { expectedKey: 'A minor' }).key);
});
test('expected keys handle flats, case, wheel neighbours, invalid values and silence', () => {
  assert.equal(analyze(audio, { expectedKey: 'bb MAJOR' }).key.expectedCamelot, '6B');
  for (const key of ['7B', '9B']) assert.equal(analyze(audio, { expectedKey: key }).key.compatible, true);
  for (const key of ['0A', '13B', 'C dorian', '', null, 8]) assert.throws(() => analyze(audio, { expectedKey: key }), RangeError);
  const silent = analyze({ sampleRate: 48000, frames: 48000, channels: [new Float32Array(48000)] }, { expectedKey: '8A' });
  assert.equal(silent.key.match, null);
  assert.equal(silent.key.compatible, null);
  assert.ok(!advise(silent).some(note => note.startsWith('Detected key')));
  // Actual wheel wrapping is also exercised with a B-major progression below.
  const b = prog(tr(C_MAJ, -1), 48000);
  assert.equal(analyze({ sampleRate: 48000, frames: b.length, channels: [b] }, { expectedKey: '12B' }).key.compatible, true);
});
