import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { auditionCapability, createAudition } from "../src/audition.js";
import { Workspace } from "../src/workspace.js";
// @ts-ignore Vendored JavaScript audio fixture writer.
import { encodeWav } from "../../vendor/lmms-mcp/audio.mjs";

test("audition protects peaks, measures encoded copies and rejects unusable pairs without outputs", async () => {
  const ws = await Workspace.open(await mkdtemp(path.join(os.tmpdir(), "ab-test-")));
  const sampleRate = 44100;
  const tone = Float32Array.from({length:sampleRate}, (_,i)=>0.01*Math.sin(2*Math.PI*440*i/sampleRate));
  tone[8000] = 0.98;
  async function write(name: string, samples: Float32Array) {
    await ws.writeNew(name, encodeWav({ sampleRate, channels:[samples] }));
  }
  await write("peak.wav",tone);
  await write("quiet.wav",tone.map(v=>v/4));
  await write("silent.wav",new Float32Array(sampleRate));
  await write("short.wav",tone.subarray(0,12000));
  const before = await readdir(ws.root);
  const request = (b: string) => auditionCapability.schema.parse({a:"peak.wav", b, targetLufs:-8});
  await assert.rejects(createAudition(ws,request("silent.wav"),false),/non-silent/);
  await assert.rejects(createAudition(ws,request("short.wav"),false),/same section/);
  const plan = await createAudition(ws,request("quiet.wav"),true);
  assert.deepEqual(await readdir(ws.root),before);
  assert.ok(plan.targetLufs < -8);
  assert.ok(plan.deltaLu <= 0.5);
  assert.ok(plan.versions.every(item=>item.output.peakDb <= -1));
});
