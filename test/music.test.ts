import test from "node:test";
import assert from "node:assert/strict";
import { arrangeSchemas } from "../src/music.js";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  musicSchemas,
  sectionSchema,
  runMusic,
  instruments,
  liveProject,
} from "../src/music.js";
import { LiveBridge } from "../src/live.js";
import { Workspace } from "../src/workspace.js";
import { ReaperService } from "../src/service.js";
import { call } from "../src/server.js";

test("MIDI boundaries reject overflow, invalid channels and unbounded clips before dispatch", async () => {
  const base = {
    track: 0,
    startBeat: 12,
    lengthBeats: 4,
    notes: [{ beat: 0, duration: 1, pitch: 60 }],
  };
  assert.equal(musicSchemas.live_insert_midi.parse(base).notes[0]!.channel, 0);
  for (const notes of [
    [{ beat: 3, duration: 2, pitch: 60 }],
    [{ beat: 0, duration: 1, pitch: 60, channel: 16 }],
    Array(2049).fill({ beat: 0, duration: 1, pitch: 60 }),
  ])
    assert.throws(() =>
      musicSchemas.live_insert_midi.parse({ ...base, notes }),
    );
  const bridge = new LiveBridge(
    await mkdtemp(path.join(os.tmpdir(), "music-test-")),
  );
  await assert.rejects(
    runMusic(bridge, "live_add_track", { name: "test" }, false),
    /Read the live/,
  );
});
test("catalogue rejects duplicate IDs and arbitrary caller paths; save cannot overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "music-catalogue-"));
  const config = path.join(root, "instruments.json");
  const previous = process.env.REAPER_MCP_INSTRUMENTS;
  process.env.REAPER_MCP_INSTRUMENTS = config;
  try {
    await writeFile(
      config,
      JSON.stringify([
        { id: "piano", name: "Piano", plugin: "sfizz" },
        { id: "piano", name: "Piano2", plugin: "sfizz" },
      ]),
    );
    await assert.rejects(instruments(), /Duplicate/);
    await writeFile(config, "[]");
    const b = new LiveBridge(root);
    await assert.rejects(
      runMusic(
        b,
        "live_insert_instrument",
        { track: 0, instrument: "missing" },
        true,
      ),
      /not found/,
    );
    assert.throws(() =>
      musicSchemas.live_insert_instrument.parse({
        track: 0,
        instrument: "piano",
        preset: "C:/secret.vstpreset",
      }),
    );
    await writeFile(path.join(root, "keep.rpp"), "preserve");
    await assert.rejects(
      liveProject(b, new Workspace(root), "save", "keep.rpp"),
      /exists/,
    );
    assert.equal(
      await readFile(path.join(root, "keep.rpp"), "utf8"),
      "preserve",
    );
  } finally {
    if (previous === undefined) delete process.env.REAPER_MCP_INSTRUMENTS;
    else process.env.REAPER_MCP_INSTRUMENTS = previous;
  }
});
test("live music respects read-only mode and explicit offline selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "music-permission-"));
  await writeFile(
    path.join(root, "heartbeat.json"),
    JSON.stringify({ protocol: 3 }),
  );
  const svc = new ReaperService(
    new Workspace(root),
    false,
    new LiveBridge(root),
  );
  const result = await call(svc, "reaper_run", {
    mode: "live",
    capability: "live_add_track",
    args: { name: "test" },
  });
  assert.match(JSON.stringify(result), /writes_disabled/);
  const writable = new ReaperService(
    new Workspace(root),
    true,
    new LiveBridge(root),
  );
  writable.enabled.add("editing");
  const offline = await call(writable, "reaper_run", {
    mode: "offline",
    capability: "live_add_track",
    args: { name: "test" },
  });
  assert.equal(offline.isError, true);
});

test("performance bounds validate expanded ramps, clip fit and named-articulation requirements", () => {
  const base = { track: 0, startBeat: 0, lengthBeats: 4, controllers: [{ beat: 0, controller: 11, value: 70 }] };
  assert.equal(musicSchemas.live_insert_performance.parse(base).controllers[0]!.channel, 0);
  for (const patch of [
    { controllers: [] },
    { controllers: [{ beat: 4, controller: 11, value: 70 }] },
    { controllers: [{ beat: 0, controller: 128, value: 70 }] },
    { controllers: [{ beat: 0, controller: 11, value: -1 }] },
    { controllers: [{ beat: 0, controller: 11, value: 70, channel: 16 }] },
    { ramps: [{ startBeat: 2, endBeat: 1, controller: 1, startValue: 0, endValue: 127 }] },
    { notes: Array(2048).fill({ beat: 0, duration: 1, pitch: 60 }) },
    { ramps: Array(17).fill({ startBeat: 0, endBeat: 3, controller: 1, startValue: 0, endValue: 127, steps: 64 }) },
    { articulations: [{ beat: 0, name: "staccato" }] },
    { notes: [{ beat: 3.9, duration: 1, pitch: 60 }] },
  ]) assert.throws(() => musicSchemas.live_insert_performance.parse({ ...base, ...patch }));
});

test("performance dispatch expands catalogue keyswitches and ramps and rejects conflicts before mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "performance-"));
  const config = path.join(root, "catalogue.json");
  const previous = process.env.REAPER_MCP_INSTRUMENTS;
  process.env.REAPER_MCP_INSTRUMENTS = config;
  await writeFile(config, JSON.stringify([{ id: "solo", name: "Solo", plugin: "sfizz", articulations: { staccato: 40 } }]));
  const calls: any[] = [];
  const bridge = { mutate: async (...args: any[]) => { calls.push(args); return {}; } } as unknown as LiveBridge;
  const base = { track: 2, startBeat: 8, lengthBeats: 4, instrument: "solo", articulations: [{ beat: 0, name: "staccato" }], notes: [{ beat: 0.1, duration: 0.5, pitch: 64 }], ramps: [{ startBeat: 0, endBeat: 3, controller: 11, startValue: 40, endValue: 100, steps: 2 }] };
  try {
    await runMusic(bridge, "live_insert_performance", base, true);
    assert.equal(calls[0][0], "live_insert_performance");
    assert.equal(calls[0][2], true);
    assert.deepEqual(calls[0][1].notes.at(-1), { beat: 0, duration: 0.025, pitch: 40, velocity: 1, channel: 0 });
    assert.deepEqual(
      calls[0][1].controllers.map((e: any) => [e.beat, e.controller, e.value, e.channel]),
      [[0, 11, 40, 0], [1.5, 11, 70, 0], [3, 11, 100, 0]],
    );
    await assert.rejects(runMusic(bridge, "live_insert_performance", { ...base, articulations: [{ beat: 0, name: "toString" }] }, false), /Unknown instrument/);
    await assert.rejects(runMusic(bridge, "live_insert_performance", { ...base, controllers: [{ beat: 0, controller: 11, value: 1 }] }, false), /Conflicting/);
    assert.equal(calls.length, 1);
  } finally {
    if (previous === undefined) delete process.env.REAPER_MCP_INSTRUMENTS;
    else process.env.REAPER_MCP_INSTRUMENTS = previous;
  }
});


test("existing performance edits validate indices, limits and controller ranges before writing", async () => {
  const base = {track:0,item:0,takeGuid:"{test}",notes:[{index:1,velocity:50}]};
  const calls: any[]=[];
  const bridge={mutate:async (...args:any[])=>{calls.push(args);return {};}} as unknown as LiveBridge;
  await runMusic(bridge,"live_edit_performance",base,true);
  assert.deepEqual(calls[0],["live_edit_performance",{track:0,item:0,takeGuid:"{test}",notes:[{index:1,velocity:50}],articulations:[],ramps:[]},true]);
  for(const patch of [
    {notes:[]},{notes:[{index:0}]},{notes:[{index:0,velocity:0}]},
    {notes:[{index:0,pitch:60},{index:0,pitch:61}]},
    {articulations:[{index:1,from:"long",to:"short"}]},
    {ramps:[{startBeat:2,endBeat:1,controller:11,startValue:1,endValue:100}]},
    {ramps:[{startBeat:0,endBeat:2,controller:11,startValue:1,endValue:100},{startBeat:2,endBeat:3,controller:11,startValue:1,endValue:100}]},
  ]) await assert.rejects(runMusic(bridge,"live_edit_performance",{...base,...patch},false));
  assert.equal(calls.length,1);
});

test("section bounds reject reversed, unbounded and unknown inputs", () => {
  assert.deepEqual(sectionSchema.parse({startBeat:2,endBeat:4}),{startBeat:2,endBeat:4,tailSeconds:0});
  for(const s of [{startBeat:2,endBeat:2},{startBeat:4,endBeat:2},{startBeat:-1,endBeat:2},{startBeat:0,endBeat:Infinity},{startBeat:0,endBeat:2,tailSeconds:31},{startBeat:0,endBeat:2,file:"overwrite.wav"}]) assert.throws(()=>sectionSchema.parse(s));
});

test("live_batch prepares every step before one bridge transaction and names the failing step", async () => {
  const batches: any[] = [];
  const bridge = {
    mutate: async () => { throw Error("batch steps must not be sent one by one"); },
    batch: async (...args: any[]) => { batches.push(args); return { steps: [] }; },
  } as unknown as LiveBridge;
  const guid = "{6F1C2B3A-0000-4000-8000-00000000ABCD}";
  const steps = [
    { capability: "live_add_track", args: { name: "Keys" } },
    { capability: "live_insert_midi", args: { track: guid, startBeat: 0, lengthBeats: 4, notes: [{ beat: 0, duration: 1, pitch: 60 }] } },
  ];
  await runMusic(bridge, "live_batch", { steps }, false);
  assert.equal(batches[0][1], false);
  assert.deepEqual(batches[0][0], [
    { action: "live_add_track", args: { name: "Keys" } },
    { action: "live_insert_midi", args: { track: guid, name: "MIDI", startBeat: 0, lengthBeats: 4, notes: [{ beat: 0, duration: 1, pitch: 60, velocity: 90, channel: 0 }] } },
  ]);
  await assert.rejects(runMusic(bridge, "live_batch", { steps: [steps[0], { capability: "live_insert_midi", args: { track: 0 } }] }, false), /Step 2 \(live_insert_midi\)/);
  await assert.rejects(runMusic(bridge, "live_batch", { steps: [{ capability: "live_revert_fx_edit", args: { undoToken: "t" } }] }, false), /cannot run in a batch/);
  await assert.rejects(runMusic(bridge, "live_batch", { steps: [{ capability: "live_batch", args: { steps } }] }, false), /cannot run in a batch/);
  await assert.rejects(runMusic(bridge, "live_batch", { steps: [] }, false));
  await assert.rejects(runMusic(bridge, "live_insert_midi", { track: "{bad}", startBeat: 0, lengthBeats: 4, notes: [{ beat: 0, duration: 1, pitch: 60 }] }, false));
  assert.equal(batches.length, 1);
  assert.equal(musicSchemas.live_insert_midi.parse({ track: 0, startBeat: 0, lengthBeats: 4000, notes: Array.from({ length: 2048 }, (_, i) => ({ beat: i, duration: 0.5, pitch: 60 })) }).notes.length, 2048);
});

test("arrangement schemas reject incomplete transport, marker, tempo and item edits", () => {
  const s = arrangeSchemas;
  for (const ok of [{ command: "play" }, { command: "seek", beat: 8 }, { command: "set_loop", enabled: true }, { command: "set_loop", startBeat: 4, endBeat: 12 }])
    s.live_transport.parse(ok);
  for (const bad of [{ command: "seek" }, { command: "play", beat: 1 }, { command: "stop", enabled: true }, { command: "set_loop" }, { command: "set_loop", startBeat: 4 }, { command: "set_loop", startBeat: 8, endBeat: 4 }, { command: "record" }])
    assert.throws(() => s.live_transport.parse(bad));
  assert.equal(s.live_add_marker.parse({ beat: 4 }).endBeat, undefined);
  assert.throws(() => s.live_add_marker.parse({ beat: 4, endBeat: 4 }));
  assert.equal(s.live_edit_marker.parse({ id: 1, name: "Drop" }).isRegion, false);
  assert.throws(() => s.live_edit_marker.parse({ id: 1 }));
  assert.throws(() => s.live_edit_marker.parse({ id: 1, endBeat: 8 }));
  assert.equal(s.live_set_tempo.parse({ bpm: 128 }).beat, 0);
  for (const bad of [{ bpm: 10 }, { bpm: 120, timeSignature: { numerator: 4, denominator: 3 } }, { bpm: 120, timeSignature: { numerator: 0, denominator: 4 } }])
    assert.throws(() => s.live_set_tempo.parse(bad));
  const item = { track: 0, item: 0, itemGuid: "{g}" };
  assert.throws(() => s.live_edit_item.parse(item));
  s.live_edit_item.parse({ ...item, mute: true });
  assert.throws(() => s.live_edit_item.parse({ ...item, gainDb: 40 }));
  assert.throws(() => s.live_insert_audio.parse({ track: 0, file: "notes.txt", startBeat: 0 }));
  assert.throws(() => s.live_delete_track.parse({ track: 0 }));
});
test("audio import is confined to the workspace and transport is refused in a batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arrange-"));
  await writeFile(path.join(root, "kick.wav"), "RIFF");
  const workspace = await Workspace.open(root);
  const calls: any[] = [];
  const bridge = {
    mutate: async (...args: any[]) => { calls.push(args); return {}; },
    batch: async (...args: any[]) => { calls.push(args); return {}; },
  } as unknown as LiveBridge;
  await runMusic(bridge, "live_insert_audio", { track: 1, file: "kick.wav", startBeat: 4 }, false, workspace);
  assert.equal(calls[0][0], "live_insert_audio");
  assert.equal(path.basename(calls[0][1].file), "kick.wav");
  assert.ok(path.isAbsolute(calls[0][1].file));
  assert.equal(calls[0][1].startBeat, 4);
  await assert.rejects(runMusic(bridge, "live_insert_audio", { track: 1, file: "../kick.wav", startBeat: 0 }, false, workspace), /workspace/);
  await assert.rejects(runMusic(bridge, "live_insert_audio", { track: 1, file: "missing.wav", startBeat: 0 }, false, workspace), /not found/);
  await assert.rejects(runMusic(bridge, "live_insert_audio", { track: 1, file: "kick.wav", startBeat: 0 }, false), /requires a workspace/);
  await assert.rejects(runMusic(bridge, "live_batch", { steps: [{ capability: "live_transport", args: { command: "play" } }] }, false, workspace), /cannot run in a batch/);
  await runMusic(bridge, "live_batch", { steps: [
    { capability: "live_add_marker", args: { name: "Verse", beat: 16, endBeat: 48 } },
    { capability: "live_insert_audio", args: { track: 1, file: "kick.wav", startBeat: 16 } },
  ] }, true, workspace);
  assert.equal(calls[1][0][0].action, "live_add_marker");
  assert.ok(path.isAbsolute(calls[1][0][1].args.file));
  await assert.rejects(runMusic(bridge, "constructor", {}, false, workspace), /Unknown live music capability/);
  assert.equal(calls.length, 2);
});
