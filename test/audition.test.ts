import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { auditionCapability, createAudition, selectAuditionRender } from "../src/audition.js";
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

test("a timed audition selects the exact full source and detects replacement", async () => {
  const ws = await Workspace.open(await mkdtemp(path.join(os.tmpdir(), "ab-selection-")));
  const sampleRate = 16000;
  const samples = Float32Array.from({length: sampleRate * 3}, (_, i) =>
    i < sampleRate ? 0 : 0.2 * Math.sin(2 * Math.PI * 220 * i / sampleRate));
  const a = encodeWav({sampleRate, channels: [samples]});
  const b = encodeWav({sampleRate, channels: [samples.map(x => x / 2)]});
  await ws.writeNew("a.wav", a);
  await ws.writeNew("b.wav", b);
  const args = auditionCapability.schema.parse({a:"a.wav", b:"b.wav", section:{startSeconds:1,endSeconds:2}});
  await assert.rejects(createAudition(ws, {...args, section:{startSeconds:2,endSeconds:4}}, false), /inside both renders/);
  const result = await createAudition(ws, args, false);
  assert.ok("manifest" in result && result.manifest && result.files);
  const manifest = JSON.parse((await ws.read(result.manifest)).toString());
  assert.equal(manifest.startFrame, sampleRate);
  assert.equal(manifest.endFrame, 2 * sampleRate);
  const clip = await ws.read(result.files[1]!);
  assert.equal(clip.length, 44 + 2 * sampleRate);
  const select = {manifest:result.manifest, choice:"B" as const};
  const before = await readdir(ws.root);
  await selectAuditionRender(ws, select, true);
  assert.deepEqual(await readdir(ws.root), before);
  const selected = await selectAuditionRender(ws, select, false);
  assert.ok("file" in selected && selected.file);
  assert.deepEqual(await ws.read(selected.file), b);
  await writeFile(path.join(ws.root,"b.wav"), a);
  await assert.rejects(selectAuditionRender(ws, select, false), /changed after auditioning/);
});
