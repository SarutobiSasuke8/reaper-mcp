import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { locateReaper, renderSong } from "../dist/src/render.js";
import { songSchema } from "../dist/src/song/model.js";
import { Workspace } from "../dist/src/workspace.js";
import { encodeWav, decodeWav, analyze } from "../vendor/lmms-mcp/audio.mjs";

if (!(await locateReaper())) {
  console.log("SKIP: REAPER not installed; no download attempted.");
  process.exit(0);
}
if (process.env.REAPER_MCP_RUN_RENDER !== "true") {
  console.log(
    "SKIP: Set REAPER_MCP_RUN_RENDER=true to launch an isolated evaluation render.",
  );
  process.exit(0);
}
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-headless-"));
const sampleRate = 44100,
  channels = [
    Float32Array.from(
      { length: sampleRate },
      (_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / sampleRate),
    ),
  ];
await writeFile(
  path.join(root, "tone.wav"),
  encodeWav({ sampleRate, channels }),
);
const song = songSchema.parse({
  tracks: [
    {
      name: "Tone",
      items: [{ kind: "audio", position: 0, length: 1, file: "tone.wav" }],
    },
  ],
  render: { end: 1 },
});
try {
  const workspace = await Workspace.open(root);
  const rendered = await renderSong(song, workspace, {
    target: "mix",
    timeoutMs: 30000,
  });
  const audio = decodeWav(await workspace.read(rendered.files[0]));
  const measured = analyze(audio);
  if (Math.abs(audio.frames / audio.sampleRate - 1) > 0.05)
    throw new Error("Wrong render duration");
  if (!audio.channels.some((c) => c.some((s) => Math.abs(s) > 0.01)))
    throw new Error("Silent output");
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        platform: process.platform,
        elapsedMs: rendered.elapsedMs,
        sampleRate: audio.sampleRate,
        duration: audio.frames / audio.sampleRate,
        measurement: measured,
        workspace: root,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      result: "FAIL",
      code: error.code ?? "verification",
      message: error.message,
      workspace: root,
    }),
  );
  process.exitCode = 1;
}
