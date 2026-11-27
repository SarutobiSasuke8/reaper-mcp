import test from "node:test";
import assert from "node:assert/strict";
import { buildPiece, buildPart, composeSchemas, readLibrary } from "../src/compose.js";
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

test("a composed piece becomes tracks, instruments, bounded clips, tempo and regions in one batch", async () => {
  const args = composeSchemas.live_compose_piece.parse({ style: "adventure", bars: 16, seed: 3, instruments: { lead: "piano", bass: "bass", drums: "drums" } });
  const { steps, summary } = buildPiece(args, 2);
  assert.deepEqual(steps[0], { capability: "live_set_tempo", args: { beat: 0, bpm: summary.bpm } });
  const added = steps.filter((s) => s.capability === "live_add_track").map((s) => s.args.name);
  assert.deepEqual(added, ["Lead", "Harmony", "Pad", "Bass", "Drums"]);
  assert.deepEqual(summary.tracks.map((t) => t.index), [2, 3, 4, 5, 6]);
  assert.deepEqual(steps.filter((s) => s.capability === "live_insert_instrument").map((s) => s.args), [
    { track: 2, instrument: "piano" }, { track: 5, instrument: "bass" }, { track: 6, instrument: "drums" },
  ]);
  assert.deepEqual(summary.rolesWithoutInstrument, ["harmony", "pad"]);
  const clips = steps.filter((s) => s.capability === "live_insert_midi");
  assert.equal(clips.length, 5);
  for (const clip of clips) {
    const a = musicSchemas.live_insert_midi.parse(clip.args);
    assert.equal(a.lengthBeats, 64);
    assert.ok(a.notes.every((n) => n.beat + n.duration <= a.lengthBeats && n.duration > 0));
  }
  const drums = clips.at(-1)!.args.notes as { pitch: number }[];
  assert.deepEqual([...new Set(drums.map((n) => n.pitch))].sort(), [36, 38, 42, 49]);
  const gains = steps.filter((s) => s.capability === "set_track" && s.args.field === "volume_db");
  assert.deepEqual(gains.map((s) => [s.args.track, s.args.value]), [[2, -10], [3, -15], [4, -17], [5, -10], [6, -8]]);
  assert.ok(steps.filter((s) => s.capability === "set_track" && s.args.field === "pan").every((s) => Math.abs(s.args.value as number) <= 1));
  assert.ok(buildPiece({ ...args, levels: false }, 2).steps.every((s) => s.capability !== "set_track"));
  const regions = steps.filter((s) => s.capability === "live_add_marker");
  assert.deepEqual(regions.map((s) => s.args.name), summary.sections.map((s: any) => s.name));
  assert.deepEqual(regions.at(-1)!.args.endBeat, 64);
  assert.equal(summary.chords.length, 16);
  assert.ok(summary.melodyScore.score > 0);
  // The same seed gives the same piece; another seed does not.
  assert.deepEqual(buildPiece(args, 2).steps, steps);
  assert.notDeepEqual(buildPiece({ ...args, seed: 4 }, 2).steps, steps);
  // startBar shifts every clip, the tempo marker and the regions.
  const later = buildPiece({ ...args, startBar: 8, setTempo: false, regions: false }, 0);
  assert.ok(later.steps.every((s) => !["live_set_tempo", "live_add_marker"].includes(s.capability)));
  assert.ok(later.steps.filter((s) => s.capability === "live_insert_midi").every((s) => s.args.startBeat === 32));
  const persona = buildPiece(composeSchemas.live_compose_piece.parse({ persona: "french-filter-house", bars: 32 }), 0).summary;
  assert.equal(persona.persona, "french-filter-house");
  assert.deepEqual(persona.mixTargets, { targetLufs: -14, ceilingDb: -1.5 });
  assert.throws(() => buildPiece(composeSchemas.live_compose_piece.parse({ style: "polka" }), 0), /Unknown style; read \/styles/);
  assert.throws(() => buildPiece(composeSchemas.live_compose_piece.parse({ persona: "nobody" }), 0), /Unknown persona; read \/personas/);
  assert.throws(() => buildPiece(composeSchemas.live_compose_piece.parse({ key: "H minor" }), 0));
  assert.throws(() => composeSchemas.live_compose_piece.parse({ bars: 16, seconds: 60 }));
  assert.throws(() => composeSchemas.live_compose_piece.parse({ instruments: { strings: "x" } }));
  // A long, busy piece is cut into clips of at most 2048 notes on bar lines.
  const long = buildPiece(composeSchemas.live_compose_piece.parse({ style: "chiptune", bars: 200, regions: false }), 0);
  const longClips = long.steps.filter((s) => s.capability === "live_insert_midi");
  assert.ok(long.summary.tracks.some((t) => t.clips > 1));
  for (const clip of longClips) {
    const a = musicSchemas.live_insert_midi.parse(clip.args);
    assert.ok(a.notes.length <= 2048 && a.startBeat % 4 === 0 && a.lengthBeats % 4 === 0);
  }
  assert.ok(long.steps.length <= 64);
});
test("single parts follow the chords, register and drum map, and reject unknown styles and chords", () => {
  const base = { track: 1, chords: ["Dm", "Bb", "F", "C"], seed: 2 };
  const melody = buildPart(composeSchemas.live_write_part.parse({ ...base, part: "melody", key: "D minor", low: 60, high: 79, startBar: 4 }));
  assert.equal(melody.steps.length, 1);
  assert.deepEqual([melody.steps[0]!.args.track, melody.steps[0]!.args.startBeat, melody.steps[0]!.args.lengthBeats], [1, 16, 16]);
  assert.ok(melody.summary.lowestPitch >= 60 && melody.summary.highestPitch <= 79);
  const bass = buildPart(composeSchemas.live_write_part.parse({ ...base, part: "bass", style: "walking" }));
  assert.ok(bass.summary.highestPitch < 60);
  const drums = buildPart(composeSchemas.live_write_part.parse({ ...base, part: "drums", style: "four", drumMap: { kick: 35, snare: 40, hat: 44, crash: 57 } }));
  const pitches = new Set((drums.steps[0]!.args.notes as { pitch: number }[]).map((n) => n.pitch));
  assert.ok([...pitches].every((p) => [35, 40, 44, 57].includes(p)) && pitches.has(35));
  const guid = "{6F1C2B3A-0000-4000-8000-00000000ABCD}";
  assert.equal(buildPart(composeSchemas.live_write_part.parse({ ...base, track: guid, part: "accompaniment", style: "block" })).steps[0]!.args.track, guid);
  assert.throws(() => buildPart(composeSchemas.live_write_part.parse({ ...base, part: "bass", style: "arpeggio" })), /Unknown bass style/);
  assert.throws(() => buildPart(composeSchemas.live_write_part.parse({ ...base, part: "accompaniment", chords: ["Dm", "Xyz"] })));
  assert.throws(() => composeSchemas.live_write_part.parse({ ...base, part: "melody" }));
  assert.throws(() => composeSchemas.live_write_part.parse({ ...base, part: "drums", low: 30 }));
  assert.throws(() => composeSchemas.live_write_part.parse({ ...base, part: "bass", chords: [] }));
});
test("composing resolves instruments before writing, previews without a batch and reads the library offline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compose-"));
  const config = path.join(root, "catalogue.json");
  const previous = process.env.REAPER_MCP_INSTRUMENTS;
  process.env.REAPER_MCP_INSTRUMENTS = config;
  await writeFile(config, JSON.stringify([{ id: "keys", name: "Keys", plugin: "Some Synth" }]));
  const calls: any[] = [];
  const bridge = {
    get: async (p: string) => (p === "/tracks" ? [{}, {}, {}] : {}),
    mutate: async () => { throw Error("composition must be one batch"); },
    batch: async (...args: any[]) => { calls.push(args); return { undoLabel: "REAPER MCP: batch #1", project: "p", revision: 9 }; },
  } as unknown as LiveBridge;
  try {
    const request = { style: "ballad", bars: 8, instruments: { lead: "keys" } };
    const preview: any = await runMusic(bridge, "live_compose_piece", request, true);
    assert.equal(preview.dryRun, true);
    assert.equal(calls.length, 0);
    assert.equal(preview.tracks[0].index, 3);
    await assert.rejects(runMusic(bridge, "live_compose_piece", { ...request, instruments: { lead: "missing" } }, false), /Instrument ID not found/);
    assert.equal(calls.length, 0);
    const applied: any = await runMusic(bridge, "live_compose_piece", request, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], false);
    assert.equal(calls[0][0].length, applied.editSteps);
    assert.deepEqual(calls[0][0].find((s: any) => s.action === "live_insert_instrument").args, { track: 3, plugin: "Some Synth", preset: undefined });
    assert.equal(applied.undoLabel, "REAPER MCP: batch #1");
    await runMusic(bridge, "live_write_part", { track: 0, part: "bass", chords: ["Am", "F"] }, false);
    assert.equal(calls[1][0][0].action, "live_insert_midi");
    await assert.rejects(runMusic(bridge, "live_batch", { steps: [{ capability: "live_compose_piece", args: {} }] }, false), /cannot run in a batch/);
  } finally {
    if (previous === undefined) delete process.env.REAPER_MCP_INSTRUMENTS;
    else process.env.REAPER_MCP_INSTRUMENTS = previous;
  }
  const svc = new ReaperService(new Workspace(root), false);
  const stylesResult: any = await call(svc, "reaper_get", { mode: "offline", path: "/styles" });
  assert.ok(stylesResult.structuredContent.result.some((s: any) => s.name === "adventure" && s.bpm > 0));
  const page: any = await call(svc, "reaper_list", { mode: "offline", path: "/personas", offset: 0, limit: 5 });
  assert.equal(page.structuredContent.result.items.length, 5);
  assert.ok(page.structuredContent.result.total >= 18);
  const one: any = await call(svc, "reaper_get", { mode: "offline", path: "/personas/french-filter-house" });
  assert.equal(one.structuredContent.result.tempo.default, 122);
  assert.match(JSON.stringify(await call(svc, "reaper_get", { mode: "offline", path: "/personas/nobody-here" })), /Unknown persona/);
  assert.equal(readLibrary("/styles/extra"), undefined);
});
