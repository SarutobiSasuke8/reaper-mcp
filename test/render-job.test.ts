import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { nativeObservation } from "../src/native-observation.js";
import { alive } from "../src/startup.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../src/workspace.js";
import {
  jobDirectory,
  jobStatus,
  controlRenderJob,
  saveState,
} from "../src/render-job.js";
import { verifyMix } from "../src/render-worker.js";

test(
  "interrupting a Windows worker stops its private scanner child",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "render-cancel-tree-"));
    const pidFile = path.join(dir, "scanner.pid");
    const script =
      "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);";
    const controller = new AbortController();
    const running = nativeObservation(
      process.execPath,
      ["-e", script, pidFile],
      path.join(dir, "observation"),
      Date.now() + 20000,
      controller.signal,
    );
    const stopped = assert.rejects(running);
    let pid = 0;
    try {
      for (let i = 0; i < 100 && !pid; i++) {
        pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
        if (!pid) await delay(50);
      }
      assert.ok(pid && alive(pid));
      controller.abort();
      await stopped;
      assert.equal(alive(pid), false);
    } finally {
      controller.abort();
      await stopped;
      if (pid && alive(pid)) process.kill(pid);
    }
  },
);

test("accept only a full-length complete PCM mix", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mix-verification-"));
  const file = path.join(root, "test.wav"),
    wav = Buffer.alloc(44 + 60);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(44100, 24);
  wav.writeUInt16LE(6, 32);
  wav.writeUInt16LE(24, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(60, 40);
  await writeFile(file, wav);
  assert.equal((await verifyMix(file, 10 / 44100)).frames, 10);
  const quantized = Buffer.alloc(44 + 44100 * 6);
  wav.copy(quantized, 0, 0, 44);
  quantized.writeUInt32LE(quantized.length - 8, 4);
  quantized.writeUInt32LE(44100 * 6, 40);
  await writeFile(file, quantized);
  assert.equal((await verifyMix(file, 1.00049)).frames, 44100);
  await writeFile(file, wav);
  await assert.rejects(verifyMix(file, 1), /requested duration/);
  await writeFile(file, wav.subarray(0, 60));
  await assert.rejects(verifyMix(file, 10 / 44100), /complete/);
});

test("a dead worker exposes a retryable interrupted attempt", async () => {
  const ws = await Workspace.open(
    await mkdtemp(path.join(tmpdir(), "mix-retry-")),
  );
  const jobId = randomUUID(),
    folder = path.join(ws.root, jobDirectory(jobId)),
    attempt = path.join(folder, "attempt-1");
  await mkdir(attempt, { recursive: true });
  await saveState(folder, "input", {
    sha256: "0".repeat(64),
    project: "fixture",
    revision: 1,
    startSeconds: 0,
    endSeconds: 1,
  });
  await saveState(attempt, "worker", { pid: 0, deadline: Date.now() + 30000 });
  assert.equal((await jobStatus(ws, jobId)).state, "interrupted");
  assert.equal(
    (
      await controlRenderJob(
        ws,
        { jobId, attempt: 1, action: "retry", timeoutMs: 1000 },
        true,
      )
    ).attempt,
    1,
  );
  await assert.rejects(
    controlRenderJob(
      ws,
      { jobId, attempt: 2, action: "cancel", timeoutMs: 1000 },
      false,
    ),
    /current job status/,
  );
});
