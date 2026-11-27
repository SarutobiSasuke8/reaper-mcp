// Native acceptance for arrangement capabilities: transport, markers and regions,
// tempo map, audio items and track removal. Opens a disposable isolated REAPER.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { LiveBridge } from "../dist/src/live.js";
import { isolatedIni, locateReaper } from "../dist/src/render.js";
import { writeRpp } from "../dist/src/rpp/index.js";
import { songSchema } from "../dist/src/song/model.js";
import { encodeWav } from "../vendor/lmms-mcp/audio.mjs";
if (process.env.REAPER_MCP_RUN_LIVE_CHECK !== "true")
  throw Error(
    "Set REAPER_MCP_RUN_LIVE_CHECK=true; opens a disposable isolated REAPER instance",
  );
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-arrange-"));
const bridge = path.join(root, "bridge");
await mkdir(bridge);
const ini = path.join(root, "reaper.ini");
await writeFile(ini, isolatedIni());
await writeFile(
  path.join(root, "a.rpp"),
  writeRpp(songSchema.parse({ name: "a", tempo: 120, tracks: [{ name: "audio" }, { name: "spare" }] })),
);
const rate = 44100;
const wav = path.join(root, "tone.wav");
await writeFile(
  wav,
  encodeWav({
    sampleRate: rate,
    channels: [Float32Array.from({ length: rate * 2 }, (_, i) => 0.25 * Math.sin((2 * Math.PI * 220 * i) / rate))],
  }),
);
const b = new LiveBridge(bridge);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, e, tolerance = 1e-6) => assert.ok(Math.abs(a - e) <= tolerance, `${a} is not within ${tolerance} of ${e}`);
const child = spawn(
  await locateReaper(),
  ["-newinst", "-nosplash", "-cfgfile", ini, path.join(root, "a.rpp"), fileURLToPath(new URL("../bridge/reaper-mcp.lua", import.meta.url))],
  {
    env: { ...process.env, REAPER_MCP_BRIDGE_DIR: bridge, REAPER_MCP_ALLOW_WRITES: "true" },
    stdio: "ignore",
    windowsHide: true,
  },
);
async function stop() {
  if (child.exitCode === null) {
    const done = new Promise((r) => child.once("exit", r));
    child.kill();
    await done;
  }
}
const run = (action, args, dryRun = false) => b.mutate(action, args, dryRun);
const transport = () => b.get("/project/transport");
async function waitFor(state) {
  for (let i = 0; i < 60; i++) {
    const t = await transport();
    if (t.state === state) return t;
    await delay(100);
  }
  throw Error(`Transport never reached ${state}`);
}
try {
  const until = Date.now() + 90000;
  while (!(await b.available())) {
    if (Date.now() > until) throw Error("Startup timeout: inspect isolated evaluation/dialog prompt");
    await delay(500);
  }
  const tracks = await b.get("/tracks");
  assert.deepEqual(tracks.map((t) => t.solo), [false, false]);

  // Transport: seek, loop range, play, pause and stop.
  assert.equal((await transport()).state, "stopped");
  const seek = await run("live_transport", { command: "seek", beat: 8 });
  near(seek.transport.cursorSeconds, 4);
  near(seek.transport.positionBeats, 8);
  const preview = await run("live_transport", { command: "seek", beat: 2 }, true);
  assert.equal(preview.transport, undefined);
  near((await transport()).cursorSeconds, 4);
  const loop = await run("live_transport", { command: "set_loop", enabled: true, startBeat: 4, endBeat: 12 });
  assert.deepEqual([loop.transport.loop.enabled, loop.transport.loop.startBeat, loop.transport.loop.endBeat], [true, 4, 12]);
  await run("live_transport", { command: "set_loop", enabled: false });
  const kept = (await transport()).loop;
  assert.deepEqual([kept.enabled, kept.startBeat, kept.endBeat], [false, 4, 12]);
  await assert.rejects(run("live_transport", { command: "set_loop", startBeat: 8, endBeat: 8 }), /move forward/);
  await assert.rejects(run("live_transport", { command: "record" }), /Unknown transport command/);
  await run("live_transport", { command: "play" });
  const playing = await waitFor("playing");
  await delay(400);
  assert.ok((await transport()).positionSeconds > playing.positionSeconds, "Play position must advance");
  await run("live_transport", { command: "pause" });
  await waitFor("paused");
  await run("live_transport", { command: "stop" });
  await waitFor("stopped");
  await assert.rejects(b.batch([{ action: "live_transport", args: { command: "play" } }], false), /cannot run in a batch/);

  // Markers and regions.
  const intro = await run("live_add_marker", { name: "Intro", beat: 4 });
  assert.deepEqual([intro.marker.isRegion, intro.marker.name, intro.marker.startBeat], [false, "Intro", 4]);
  const verse = await run("live_add_marker", { name: "Verse", beat: 8, endBeat: 16 });
  assert.deepEqual([verse.marker.isRegion, verse.marker.startBeat, verse.marker.endBeat], [true, 8, 16]);
  assert.equal((await b.get("/markers")).length, 2);
  await run("live_edit_marker", { id: verse.marker.id, isRegion: true, name: "Verse 1", endBeat: 24 }, true);
  assert.equal((await b.get("/markers")).find((m) => m.isRegion).name, "Verse");
  const edited = await run("live_edit_marker", { id: verse.marker.id, isRegion: true, name: "Verse 1", endBeat: 24 });
  assert.deepEqual([edited.marker.name, edited.marker.startBeat, edited.marker.endBeat], ["Verse 1", 8, 24]);
  // REAPER numbers markers and regions separately, so id alone does not identify one.
  await assert.rejects(run("live_edit_marker", { id: 99, isRegion: false, name: "x" }), /Marker not found/);
  await assert.rejects(run("live_delete_marker", { id: 99, isRegion: true }), /Region not found/);
  await assert.rejects(run("live_edit_marker", { id: verse.marker.id, isRegion: true, endBeat: 2 }), /move forward/);
  await run("live_delete_marker", { id: intro.marker.id, isRegion: false });
  const markers = await b.get("/markers");
  assert.deepEqual(markers.map((m) => [m.isRegion, m.name]), [[true, "Verse 1"]]);

  // Audio items: import, edit, split, delete and move between tracks.
  const inserted = await run("live_insert_audio", { track: 0, file: wav, startBeat: 4, name: "Tone" });
  near(inserted.item.positionSeconds, 2);
  near(inserted.item.lengthSeconds, 2, 1e-4);
  assert.equal(inserted.item.isMidi, false);
  assert.equal(inserted.item.name, "Tone");
  assert.equal(path.basename(inserted.item.file), "tone.wav");
  await assert.rejects(run("live_insert_audio", { track: 0, file: path.join(root, "missing.wav"), startBeat: 0 }), /Audio file missing/);
  await assert.rejects(run("live_insert_audio", { track: 0, file: ini, startBeat: 0 }), /Not a readable audio file|could not open/);
  let items = await b.get("/tracks/0/items");
  assert.equal(items.length, 1);
  assert.deepEqual(await b.get("/tracks/0/items/0"), (({ index, ...view }) => view)(items[0]));
  const ref = { track: 0, item: 0, itemGuid: items[0].guid };
  await assert.rejects(run("live_edit_item", { ...ref, itemGuid: "{wrong}", mute: true }), /identity/);
  await assert.rejects(run("live_edit_item", { ...ref, lengthBeats: 16 }), /exceeds the audio source/);
  await assert.rejects(run("live_edit_item", { ...ref, fadeInSeconds: 1.5, fadeOutSeconds: 1 }), /Fades exceed/);
  const moved = await run("live_edit_item", { ...ref, startBeat: 8, gainDb: -6, fadeInSeconds: 0.1, fadeOutSeconds: 0.2, name: "Tone late", mute: true });
  near(moved.item.positionSeconds, 4);
  near(moved.item.gainDb, -6, 1e-6);
  near(moved.item.fadeInSeconds, 0.1);
  near(moved.item.fadeOutSeconds, 0.2);
  assert.deepEqual([moved.item.name, moved.item.mute, moved.before.name], ["Tone late", true, "Tone"]);
  near(moved.item.lengthSeconds, 2, 1e-4);
  await assert.rejects(run("live_split_item", { ...ref, beat: 8 }), /inside the item/);
  const split = await run("live_split_item", { ...ref, beat: 10 });
  near(split.left.lengthSeconds, 1);
  near(split.right.positionSeconds, 5);
  near(split.right.lengthSeconds, 1, 1e-4);
  assert.equal(split.itemCount, 2);
  items = await b.get("/tracks/0/items");
  await run("live_delete_item", { track: 0, item: 1, itemGuid: items[1].guid });
  const toSpare = await run("live_edit_item", { track: 0, item: 0, itemGuid: items[0].guid, toTrack: tracks[1].guid });
  near(toSpare.item.positionSeconds, 4);
  assert.equal((await b.get("/tracks/0/items")).length, 0);
  const onSpare = await b.get("/tracks/1/items");
  assert.deepEqual(onSpare.map((i) => i.guid), [items[0].guid]);

  // A failed batch leaves markers and items exactly as they were.
  const markersBefore = await b.get("/markers");
  await assert.rejects(
    b.batch(
      [
        { action: "live_add_marker", args: { name: "Gone", beat: 32 } },
        { action: "live_insert_audio", args: { track: 0, file: wav, startBeat: 32 } },
        { action: "live_delete_item", args: { track: 0, item: 5, itemGuid: "{none}" } },
      ],
      false,
    ),
    /Batch step 3 \(live_delete_item\) failed: Item not found; earlier steps were rolled back/,
  );
  assert.deepEqual(await b.get("/markers"), markersBefore);
  assert.equal((await b.get("/tracks/0/items")).length, 0);

  // Track solo and removal.
  await b.set("/tracks/1/solo", true, false);
  assert.equal(await b.get("/tracks/1/solo"), true);
  await b.set(`/tracks/${tracks[1].guid}/solo`, false, false);
  await assert.rejects(run("live_delete_track", { track: 0, trackGuid: tracks[1].guid }), /identity/);
  const removed = await run("live_delete_track", { track: 0, trackGuid: tracks[0].guid });
  assert.equal(removed.trackCount, 1);
  assert.deepEqual((await b.get("/tracks")).map((t) => t.guid), [tracks[1].guid]);

  // Tempo map last, because it changes where every beat falls in seconds.
  const initial = await b.get("/project/tempo_map");
  near(initial.projectBpm, 120);
  const first = await run("live_set_tempo", { beat: 0, bpm: 100 });
  near(first.tempoMap.markers[0].bpm, 100);
  near(await b.get("/project/tempo"), 100);
  const second = await run("live_set_tempo", { beat: 16, bpm: 140, timeSignature: { numerator: 3, denominator: 4 } });
  assert.equal(second.replaced, false);
  assert.equal(second.tempoMap.markers.length, 2);
  near(second.tempoMap.markers[1].beat, 16);
  near(second.tempoMap.markers[1].timeSeconds, 16 * 0.6);
  assert.deepEqual(second.tempoMap.markers[1].timeSignature, { numerator: 3, denominator: 4 });
  const replaced = await run("live_set_tempo", { beat: 16, bpm: 150 });
  assert.equal(replaced.replaced, true);
  near(replaced.before.bpm, 140);
  assert.equal(replaced.tempoMap.markers.length, 2);
  near(replaced.tempoMap.markers[1].bpm, 150);
  await assert.rejects(run("live_delete_tempo_marker", { index: 1, bpm: 140 }), /Tempo marker changed/);
  await assert.rejects(run("live_set_tempo", { beat: 4, bpm: 500 }), /Invalid number/);
  const deleted = await run("live_delete_tempo_marker", { index: 1, bpm: 150 });
  assert.equal(deleted.tempoMap.markers.length, 1);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        checks: [
          "seek, loop range, play, pause and stop with readback",
          "marker and region add, edit, delete",
          "audio import, retime, gain, fades, split, delete, move between tracks",
          "item GUID, source-length and fade guards",
          "failed batch restores markers and items",
          "track solo and guarded removal",
          "tempo map add, replace and delete with time signature",
        ],
        root,
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
}
