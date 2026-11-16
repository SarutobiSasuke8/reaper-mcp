import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { songSchema } from "../src/song/model.js";
import { editSong } from "../src/editing.js";
import { ReaperService } from "../src/service.js";
import { Workspace } from "../src/workspace.js";
import { call } from "../src/server.js";

const fixture = () =>
  songSchema.parse({
    tracks: [
      {
        name: "Source",
        sends: [{ to: 2 }],
        items: [
          {
            kind: "midi",
            position: 0,
            length: 2,
            notes: [
              { tick: 100, duration: 240, pitch: 60 },
              { tick: 270, duration: 120, pitch: 125 },
            ],
          },
        ],
      },
      { name: "Other", sends: [{ to: 2 }] },
      { name: "Bus" },
    ],
  });

test("deleting a track removes incoming sends and remaps surviving destinations", () => {
  const original = fixture();
  const result = editSong(original, "delete_track", { track: 1 });
  assert.equal(result.tracks[0]!.sends[0]!.to, 1);
  assert.equal(result.tracks[1]!.name, "Bus");
  assert.equal(original.tracks.length, 3);
  assert.deepEqual(
    editSong(original, "delete_track", { track: 2 }).tracks.map((t) => t.sends),
    [[], []],
  );
});
test("batch is atomic if a late edit introduces a feedback route or invalid MIDI pitch", () => {
  const original = fixture();
  const before = structuredClone(original);
  assert.throws(() =>
    editSong(original, "batch_edit", {
      operations: [
        { capability: "move_item", args: { track: 0, item: 0, position: 5 } },
        { capability: "add_send", args: { track: 2, to: 0 } },
      ],
    }),
  );
  assert.throws(() =>
    editSong(original, "transpose_notes", { track: 0, item: 0, semitones: 3 }),
  );
  assert.deepEqual(original, before);
});
test("quantize strength, transpose and duplication preserve durations and independent notes", () => {
  const result = editSong(fixture(), "batch_edit", {
    operations: [
      {
        capability: "quantize_notes",
        args: { track: 0, item: 0, gridTicks: 240, strength: 0.5 },
      },
      {
        capability: "transpose_notes",
        args: { track: 0, item: 0, semitones: -12 },
      },
      {
        capability: "duplicate_item",
        args: { track: 0, item: 0, position: 3 },
      },
    ],
  });
  const [a, b] = result.tracks[0]!.items;
  assert.equal(b!.position, 3);
  if (!a || !b || a.kind !== "midi" || b.kind !== "midi") throw Error("fixture");
  assert.deepEqual(
    a.notes.map((n) => [n.tick, n.duration, n.pitch]),
    [
      [50, 240, 48],
      [255, 120, 113],
    ],
  );
  b.notes[0]!.pitch = 1;
  assert.equal(a.notes[0]!.pitch, 48);
});
test("MCP batch dryRun and failure leave service state intact; successful batch commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-edit-"));
  const svc = new ReaperService(await Workspace.open(root), true);
  svc.song = fixture();
  svc.enabled.add("editing");
  const request = {
    capability: "batch_edit",
    args: { operations: [{ capability: "delete_track", args: { track: 1 } }] },
    dryRun: true,
  };
  assert.equal((await call(svc, "reaper_run", request)).isError, undefined);
  assert.equal(svc.song.tracks.length, 3);
  assert.equal(
    (await call(svc, "reaper_run", { ...request, dryRun: false })).isError,
    undefined,
  );
  assert.equal(svc.song.tracks.length, 2);
  assert.equal(
    (
      await call(svc, "reaper_run", {
        capability: "batch_edit",
        args: {
          operations: [{ capability: "delete_track", args: { track: 99 } }],
        },
      })
    ).isError,
    true,
  );
  assert.equal(svc.song.tracks.length, 2);
});

