import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore Source-attributed vendored JS.
import { analyze, advise, dynamicRange } from "../../vendor/lmms-mcp/audio.mjs";

test("vendored DR report and over-compression advice survive the REAPER port", () => {
  const sampleRate = 48000, frames = sampleRate * 6;
  const samples = Float32Array.from({ length: frames }, (_, i) => i % 480 < 240 ? 0.5 : -0.5);
  const audio = { sampleRate, frames, channels: [samples] };
  const report = analyze(audio);
  assert.deepEqual(report.dynamicRange, dynamicRange(audio));
  assert.equal(report.dynamicRange.dr, -3);
  assert.equal(report.dynamicRange.blockCount, 2);
  assert.ok(advise(report).includes("Dynamic range is under DR6: the master is likely over-compressed or over-limited; ease the limiter or bus compression."));
  assert.ok("lraLu" in report && "stereo" in report);
});
