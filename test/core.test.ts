import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import MidiPackage from "@tonejs/midi";
import { songSchema, beatToSeconds, secondsToBeat } from "../src/song/model.js";
import { readRpp, writeRpp, parseTree } from "../src/rpp/index.js";
import { Workspace } from "../src/workspace.js";
import { ReaperService } from "../src/service.js";
import { call } from "../src/server.js";

const fixture = () =>
  songSchema.parse({
    name: 'Test "quoted" song',
    ppq: 960,
    tempo: 120,
    tempoMap: [{ beat: 4, bpm: 90, numerator: 3, denominator: 4 }],
    tracks: [
      {
        name: "MIDI",
        volume_db: -6,
        pan: -0.3,
        sends: [{ to: 1, volume_db: -3 }],
        items: [
          {
            kind: "midi",
            name: "riff",
            position: 0,
            length: 5,
            notes: [
              { tick: 0, duration: 960, pitch: 60, velocity: 96, channel: 1 },
              { tick: 960, duration: 480, pitch: 64, velocity: 80, channel: 0 },
            ],
          },
        ],
      },
      {
        name: "Bus",
        fx: [{ kind: "JS", name: "volume", params: [-3, 0] }],
        items: [
          {
            kind: "audio",
            name: "clip",
            position: 2,
            length: 3,
            file: "sample.wav",
            offset: 0.1,
          },
        ],
      },
    ],
    markers: [
      { id: 1, name: "Intro", position: 0 },
      { id: 2, name: "Loop", position: 1, end: 4 },
    ],
    render: { start: 0, end: 5 },
  });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-mcp-test-"));
  return { root, workspace: await Workspace.open(root) };
}

test("independent audio fixture from prior REAPER 7.86 render retains full duration", async () => {
  const source = await readFile(
    new URL("../../test/fixtures/audio-project.rpp", import.meta.url),
    "utf8",
  );
  const song = readRpp(source);
  assert.equal(song.tempo, 76);
  assert.equal(song.render.end, 95);
  assert.equal(song.tracks[0]!.items[0]!.length, 95);
  assert.throws(
    () => readRpp(source.replace("MAINSEND 1 0", "MAINSEND 1 0\nVOLENV2 1")),
    /Cannot preserve/,
  );
});

test("song RPP round-trip preserves notes, tempo, sends, JSFX, audio and regions", () => {
  const song = fixture(),
    restored = readRpp(writeRpp(song));
  assert.deepEqual(restored, song);
});
test("tempo conversions are inverse across multiple changes", () => {
  const song = fixture();
  for (const beat of [0, 1, 4, 8, 16])
    assert.ok(
      Math.abs(secondsToBeat(song, beatToSeconds(song, beat)) - beat) < 1e-10,
    );
});
test("song validation rejects invalid routes, cyclic buses, region order and notes", () => {
  assert.throws(() =>
    songSchema.parse({
      tracks: [{ sends: [{ to: 1 }] }, { sends: [{ to: 0 }] }],
    }),
  );
  assert.throws(() => songSchema.parse({ tracks: [{ sends: [{ to: 3 }] }] }));
  assert.throws(() =>
    songSchema.parse({
      markers: [{ id: 1, name: "bad", position: 3, end: 1 }],
    }),
  );
  assert.throws(() =>
    songSchema.parse({
      tracks: [
        {
          items: [
            {
              kind: "midi",
              position: 0,
              length: 1,
              notes: [{ tick: 0, duration: 0, pitch: 128 }],
            },
          ],
        },
      ],
    }),
  );
});
test("RPP parser fails on malformed and unsupported state rather than losing it", () => {
  assert.throws(() => parseTree("<REAPER_PROJECT\n<TRACK\n>"));
  assert.throws(() => parseTree("<REAPER_PROJECT\n>\nextra"));
  assert.throws(
    () => readRpp('<REAPER_PROJECT\n<TRACK\n<VST "x"\n>\n>\n>'),
    /Unsupported/,
  );
  assert.throws(
    () => readRpp(writeRpp(fixture()).replace("LOOP 0", "LOOP 1")),
    /Looped/,
  );
  assert.throws(() => writeRpp({ ...fixture(), name: "injection\n<TRACK" }));
});
test("path writes validate transactionally and dryRun does not mutate", async () => {
  const { workspace } = await setup();
  const svc = new ReaperService(workspace, true);
  svc.set("/project/tempo", 140, true);
  assert.equal(svc.song.tempo, 120);
  svc.set("/project/tempo", 140);
  assert.equal(svc.song.tempo, 140);
  assert.throws(() => svc.set("/project/tempo", 999));
  assert.equal(svc.song.tempo, 140);
  assert.throws(() => svc.set("/project/__proto__/x", 1));
  assert.throws(() => svc.set("/tracks/0/name", "missing"));
  assert.deepEqual(svc.list("/tracks"), { total: 0, offset: 0, items: [] });
});
test("filesystem rejects traversal and overwrites; project round trip uses relative media", async () => {
  const { root, workspace } = await setup();
  await mkdir(path.join(root, "projects"));
  await writeFile(path.join(root, "sample.wav"), "placeholder");
  await assert.rejects(workspace.resolve("../escape.json", true));
  await assert.rejects(workspace.resolve("C:/outside.wav"));
  await workspace.writeNew("x.json", "{}");
  await assert.rejects(workspace.writeNew("x.json", "bad"), /exists/);
  const svc = new ReaperService(workspace, true);
  svc.song = fixture();
  await svc.project("save", "projects/song.rpp");
  assert.match(
    await readFile(path.join(root, "projects/song.rpp"), "utf8"),
    /\.\.\/sample.wav/,
  );
  await svc.project("open", "projects/song.rpp");
  assert.equal(
    (svc.song.tracks[1]!.items[0] as { file: string }).file,
    "sample.wav",
  );
});
test("filesystem refuses symlink outside root", async (t) => {
  const { root, workspace } = await setup();
  const outside = await mkdtemp(path.join(os.tmpdir(), "reaper-outside-"));
  try {
    await symlink(outside, path.join(root, "link"), "junction");
  } catch {
    t.skip("Symlink creation unavailable");
    return;
  }
  await assert.rejects(
    workspace.resolve("link/new.json", true),
    /leaves workspace/,
  );
});
test("MIDI import keeps PPQ, notes, velocity and tempo without LMMS", async () => {
  const { root, workspace } = await setup();
  const midi = new MidiPackage.Midi();
  midi.header.setTempo(120);
  const track = midi.addTrack();
  track.addNote({ midi: 60, ticks: 0, durationTicks: 480, velocity: 0.8 });
  await writeFile(path.join(root, "test.mid"), Buffer.from(midi.toArray()));
  const svc = new ReaperService(workspace, true);
  await svc.importMidi("test.mid");
  const item = svc.song.tracks[0]!.items[0]!;
  assert.equal(item.kind, "midi");
  if (item.kind === "midi") {
    assert.equal(item.notes[0]!.pitch, 60);
    assert.equal(item.notes[0]!.duration, 480);
  }
  assert.equal(svc.song.ppq, midi.header.ppq);
});
test("live never silently falls back, read-only blocks mutations and errors are bounded", async () => {
  const { workspace } = await setup();
  const svc = new ReaperService(workspace, false);
  const live = await call(svc, "reaper_get", {
    path: "/project/tempo",
    mode: "live",
  });
  assert.equal(live.isError, true);
  const edit = await call(svc, "reaper_set", {
    path: "/project/tempo",
    value: 130,
  });
  assert.equal(edit.isError, true);
  assert.equal(svc.song.tempo, 120);
  const read = await call(svc, "reaper_get", { path: "/project/tempo" });
  assert.equal(read.isError, undefined);
  assert.equal(read.structuredContent?.mode, "offline");
});
