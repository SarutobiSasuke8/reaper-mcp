import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../dist/src/workspace.js";
import { ReaperService } from "../dist/src/service.js";
import { call } from "../dist/src/server.js";
import { encodeWav, decodeWav, analyze } from "../vendor/lmms-mcp/audio.mjs";
if (process.env.REAPER_MCP_RUN_RENDER !== "true")
  throw Error(
    "Set REAPER_MCP_RUN_RENDER=true to run installed-REAPER acceptance",
  );
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-alpha-"));
const workspace = await Workspace.open(root),
  svc = new ReaperService(workspace, true);
const invoke = async (name, args) => {
  const result = await call(svc, name, { ...args, mode: "offline" });
  if (result.isError) throw Error(result.content[0].text);
  return result.structuredContent.result;
};
const sampleRate = 44100;
await writeFile(
  path.join(root, "phrase.wav"),
  encodeWav({
    sampleRate,
    channels: [
      Float32Array.from(
        { length: sampleRate * 2 },
        (_, i) =>
          0.1 *
          Math.sin(
            (2 * Math.PI * (i < sampleRate ? 440 : 660) * i) / sampleRate,
          ) *
          Math.min(1, i / 100, (sampleRate * 2 - i) / 100),
      ),
    ],
  }),
);
await invoke("reaper_project", {
  operation: "new",
  song: {
    name: "Alpha acceptance",
    tracks: [
      {
        name: "Phrase",
        mainSend: false,
        sends: [{ to: 1, volume_db: -3 }],
        items: [{ kind: "audio", file: "phrase.wav", position: 0, length: 2 }],
      },
      { name: "Bus" },
      {
        name: "MIDI score",
        items: [
          {
            kind: "midi",
            position: 0,
            length: 2,
            notes: [
              { tick: 0, duration: 480, pitch: 60 },
              { tick: 960, duration: 480, pitch: 64 },
            ],
          },
        ],
      },
    ],
    markers: [{ id: 1, name: "First phrase", position: 0, end: 1 }],
    render: { end: 2 },
  },
});
await invoke("reaper_enable_toolset", { name: "editing" });
await invoke("reaper_run", {
  capability: "transpose_notes",
  args: { track: 2, item: 0, semitones: 7 },
});
await invoke("reaper_set", { path: "/tracks/0/volume_db", value: -3 });
await invoke("reaper_project", { operation: "save", file: "alpha.rpp" });
await invoke("reaper_project", { operation: "new" });
await invoke("reaper_project", { operation: "open", file: "alpha.rpp" });
assert.equal(svc.song.tracks[2].items[0].notes[0].pitch, 67);
const evidence = [];
for (const target of ["mix", "stems", "regions"]) {
  const rendered = await invoke("reaper_render", { target, timeoutMs: 180000 });
  for (const file of rendered.files) {
    const a = decodeWav(await workspace.read(file));
    const m = analyze(a);
    assert.ok(
      Math.abs(a.frames / a.sampleRate - (target === "regions" ? 1 : 2)) < 0.05,
    );
    if (target !== "stems" || file.endsWith("stem-0.wav"))
      assert.ok(m.peakDbfs > -35 && m.peakDbfs < -20);
    evidence.push({
      target,
      file,
      duration: a.frames / a.sampleRate,
      peakDbfs: m.peakDbfs,
    });
  }
}
console.log(
  JSON.stringify(
    {
      result: "PASS",
      root,
      evidence,
      note: "Audio renders through the bus; MIDI score is round-tripped but has no instrument in this fixture.",
    },
    null,
    2,
  ),
);
