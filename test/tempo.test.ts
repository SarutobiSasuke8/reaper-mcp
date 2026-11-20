import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore Source-attributed vendored JavaScript stays byte-identical.
import { analyze, advise, estimateTempo } from "../../vendor/lmms-mcp/audio.mjs";

test("vendored tempo analysis preserves mismatch advice and octave tolerance", () => {
  const sampleRate = 48000, frames = sampleRate * 20;
  const samples = new Float32Array(frames);
  for (let beat = 0; ; beat++) {
    const start = Math.round(beat * 60 / 128 * sampleRate);
    if (start >= frames) break;
    samples.fill(0.5, start, Math.min(start + 240, frames));
  }
  const audio = { sampleRate, frames, channels: [samples] };
  const estimate = estimateTempo(audio);
  assert.ok(Math.abs(estimate.bpm - 128) <= 0.5);
  const wrong = analyze(audio, { expectedBpm: 100 });
  assert.equal(wrong.tempo.bpm, estimate.bpm);
  assert.equal(wrong.tempo.match, false);
  assert.ok(advise(wrong).includes(`Detected tempo (${estimate.bpm} BPM) does not match the requested 100 BPM: check the project tempo and the drum pattern grid.`));
  assert.equal(analyze(audio, { expectedBpm: 64 }).tempo.match, true);
  assert.ok("dynamicRange" in wrong && "lraLu" in wrong && "stereo" in wrong);
});
