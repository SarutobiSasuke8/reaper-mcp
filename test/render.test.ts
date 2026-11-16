import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { locateReaper, runProcess, renderSong } from "../src/render.js";
import { Workspace } from "../src/workspace.js";
import { songSchema } from "../src/song/model.js";
import { decodeWav } from "../src/audio.js";
// @ts-ignore Source-attributed vendored JS, tested through the built entry point.
import { encodeWav } from "../../vendor/lmms-mcp/audio.mjs";

test("render process reports launch, exit and timeout failures", async () => {
  await assert.rejects(
    runProcess("no-such-reaper-executable", [], 1000),
    /Could not start/,
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.exit(2)"], 1000),
    /unsuccessfully/,
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], 50),
    /timed out/,
  );
});
test("missing REAPER has a clear result and is never downloaded", async () => {
  const previous = process.env.REAPER_PATH;
  process.env.REAPER_PATH = path.join(
    os.tmpdir(),
    "reaper-not-installed-test.exe",
  );
  try {
    assert.equal(await locateReaper(), undefined);
    const workspace = await Workspace.open(
      await mkdtemp(path.join(os.tmpdir(), "reaper-missing-")),
    );
    await assert.rejects(
      renderSong(songSchema.parse({}), workspace, { target: "mix" }),
      /REAPER not found/,
    );
  } finally {
    if (previous === undefined) delete process.env.REAPER_PATH;
    else process.env.REAPER_PATH = previous;
  }
});
test("optional installed REAPER renders one second of audible WAV", async (t) => {
  if (process.env.REAPER_MCP_RUN_RENDER !== "true") {
    t.skip("Opt-in integration: REAPER_MCP_RUN_RENDER=true");
    return;
  }
  if (!(await locateReaper())) {
    t.skip("REAPER absent");
    return;
  }
  const workspace = await Workspace.open(
    await mkdtemp(path.join(os.tmpdir(), "reaper-render-test-")),
  );
  const sampleRate = 44100;
  const channels = [
    Float32Array.from(
      { length: sampleRate },
      (_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / sampleRate),
    ),
  ];
  await writeFile(
    path.join(workspace.root, "tone.wav"),
    encodeWav({ sampleRate, channels }),
  );
  const song = songSchema.parse({
    tracks: [
      { items: [{ kind: "audio", file: "tone.wav", position: 0, length: 1 }] },
    ],
    render: { end: 1 },
  });
  const result = await renderSong(song, workspace, {
    target: "mix",
    timeoutMs: 30000,
  });
  const wav = decodeWav(await workspace.read(result.files[0]!));
  assert.ok(Math.abs(wav.frames / wav.sampleRate - 1) < 0.05);
  assert.ok(
    wav.channels.some((c: Float32Array) => c.some((s) => Math.abs(s) > 0.01)),
  );
});
