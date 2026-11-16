import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  musicSchemas,
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
    Array(129).fill({ beat: 0, duration: 1, pitch: 60 }),
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
    JSON.stringify({ protocol: 2 }),
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
    { ramps: Array(2).fill({ startBeat: 0, endBeat: 3, controller: 1, startValue: 0, endValue: 127, steps: 64 }) },
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
    assert.match(calls[0][1][4], /0,0.025,40,1,0/);
    assert.equal(calls[0][1][5], "0,11,40,0;1.5,11,70,0;3,11,100,0");
    await assert.rejects(runMusic(bridge, "live_insert_performance", { ...base, articulations: [{ beat: 0, name: "toString" }] }, false), /Unknown instrument/);
    await assert.rejects(runMusic(bridge, "live_insert_performance", { ...base, controllers: [{ beat: 0, controller: 11, value: 1 }] }, false), /Conflicting/);
    assert.equal(calls.length, 1);
  } finally {
    if (previous === undefined) delete process.env.REAPER_MCP_INSTRUMENTS;
    else process.env.REAPER_MCP_INSTRUMENTS = previous;
  }
});
