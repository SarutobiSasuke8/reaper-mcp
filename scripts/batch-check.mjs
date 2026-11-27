// Native acceptance for bridge protocol 3: JSON envelope, GUID addressing, large
// payloads and batch transactions with rollback. Opens a disposable isolated REAPER.
import { mkdtemp, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { LiveBridge } from "../dist/src/live.js";
import { isolatedIni, locateReaper } from "../dist/src/render.js";
import { writeRpp } from "../dist/src/rpp/index.js";
import { songSchema } from "../dist/src/song/model.js";
if (process.env.REAPER_MCP_RUN_LIVE_CHECK !== "true")
  throw Error(
    "Set REAPER_MCP_RUN_LIVE_CHECK=true; opens a disposable isolated REAPER instance",
  );
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-batch-"));
const bridge = path.join(root, "bridge");
await mkdir(bridge);
const ini = path.join(root, "reaper.ini");
await writeFile(ini, isolatedIni());
await writeFile(
  path.join(root, "a.rpp"),
  writeRpp(songSchema.parse({ name: "a", tracks: [{ name: "first" }, { name: "second" }] })),
);
const b = new LiveBridge(bridge);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(
  await locateReaper(),
  [
    "-newinst",
    "-nosplash",
    "-cfgfile",
    ini,
    path.join(root, "a.rpp"),
    fileURLToPath(new URL("../bridge/reaper-mcp.lua", import.meta.url)),
  ],
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
try {
  const until = Date.now() + 90000;
  while (!(await b.available())) {
    if (Date.now() > until) throw Error("Startup timeout: inspect isolated evaluation/dialog prompt");
    await delay(500);
  }
  const ping = await b.request("ping");
  assert.equal(ping.protocol, 3);
  assert.deepEqual(ping.limits, { requestBytes: 1048576, events: 2048, batchSteps: 64 });

  // GUID addressing reads and writes the same track as its index.
  const tracks = await b.get("/tracks");
  assert.deepEqual(tracks.map((t) => t.name), ["first", "second"]);
  const second = tracks[1].guid;
  assert.deepEqual(await b.get(`/tracks/${second}`), tracks[1]);
  assert.equal(await b.get(`/tracks/${second.toLowerCase()}/name`), "second");
  await assert.rejects(b.get("/tracks/{00000000-0000-0000-0000-000000000000}"), /Track not found/);
  const byGuid = await b.set(`/tracks/${second}/volume_db`, -12, false);
  assert.ok(Math.abs(byGuid.track.volume_db + 12) < 1e-9);
  assert.ok(Math.abs((await b.get("/tracks/1/volume_db")) + 12) < 1e-9);
  assert.equal(await b.get("/tracks/0/volume_db"), tracks[0].volume_db);

  // Text survives the JSON round trip, including quotes, backslashes and non-ASCII.
  const awkward = 'Bässe "A\\B" 低音 🎚';
  await b.set("/tracks/0/name", awkward, false);
  assert.equal(await b.get("/tracks/0/name"), awkward);

  // A malformed request gets an error reply instead of poisoning the queue.
  const bad = "22222222-2222-2222-2222-222222222222";
  await writeFile(path.join(bridge, `${bad}.request`), '{"protocol":3,"id":');
  let reply;
  for (let i = 0; i < 100 && !reply; i++) {
    await delay(50);
    reply = await readFile(path.join(bridge, `${bad}.json`), "utf8").catch(() => undefined);
  }
  assert.match(JSON.parse(reply).error, /Invalid JSON/);
  await unlink(path.join(bridge, `${bad}.json`));
  await assert.rejects(b.request("call", { project: "x", revision: 0, action: "set_track", args: { track: 0, field: "pan", value: null } }), /Project changed/);

  // Dry-run batch validates every step and changes nothing.
  await b.get("/tracks");
  const notes = Array.from({ length: 2048 }, (_, i) => ({
    beat: i * 0.25, duration: 0.25, pitch: 36 + (i % 48), velocity: 1 + (i % 127), channel: 0,
  }));
  const steps = [
    { action: "live_add_track", args: { name: "Batch keys" } },
    { action: "set_track", args: { track: 2, field: "pan", value: -0.5 } },
    { action: "live_insert_midi", args: { track: 2, name: "Long line", startBeat: 0, lengthBeats: 512, notes } },
    { action: "set_track", args: { track: second, field: "mute", value: true } },
  ];
  const preview = await b.batch(steps, true);
  assert.equal(preview.dryRun, true);
  // Steps 2 and 3 address the track that step 1 would create, so they cannot be validated yet.
  assert.deepEqual(preview.steps.map((s) => s.valid), [true, false, false, true]);
  assert.equal(preview.valid, false);
  assert.equal((await b.get("/tracks")).length, 2);

  // One transaction: new track, a 2048-note clip and edits to an existing track.
  const applied = await b.batch(steps, false);
  assert.equal(applied.steps.length, 4);
  assert.equal(applied.steps[0].index, 2);
  assert.equal(applied.steps[2].noteCount, 2048);
  assert.match(applied.undoLabel, /^REAPER MCP: batch #\d+$/);
  const after = await b.get("/tracks");
  assert.equal(after.length, 3);
  assert.equal(after[2].name, "Batch keys");
  assert.equal(after[2].pan, -0.5);
  assert.equal(after[1].mute, true);
  const written = await b.get("/tracks/2/items/0/notes");
  assert.equal(written.length, 2048);
  assert.equal(written[2047].pitch, 36 + (2047 % 48));
  assert.ok(Math.abs(written[2047].startBeat - 2047 * 0.25) < 1e-6);

  // A failing step undoes the steps before it and reports which step failed.
  const beforeFailure = await b.get("/tracks");
  await assert.rejects(
    b.batch(
      [
        { action: "live_add_track", args: { name: "Must not survive" } },
        { action: "set_track", args: { track: 0, field: "name", value: "Must not stick" } },
        { action: "live_insert_midi", args: { track: 99, name: "x", startBeat: 0, lengthBeats: 4, notes: [notes[0]] } },
      ],
      false,
    ),
    /Batch step 3 \(live_insert_midi\) failed: Track not found; earlier steps were rolled back/,
  );
  assert.deepEqual(await b.get("/tracks"), beforeFailure);
  await assert.rejects(
    b.batch([{ action: "live_insert_midi", args: { track: 99, name: "x", startBeat: 0, lengthBeats: 4, notes: [notes[0]] } }], false),
    /Batch step 1 .* nothing was changed/,
  );
  assert.deepEqual(await b.get("/tracks"), beforeFailure);

  // Operations that are not undoable edits are refused before anything runs.
  await assert.rejects(b.batch([{ action: "project_new", args: { tempo: 120 } }], false), /cannot run in a batch/);
  await assert.rejects(b.batch([], false), /Batch requires/);
  // The batch left the revision guard intact for the next single edit.
  await b.set("/tracks/0/pan", 0.25, false);
  assert.equal(await b.get("/tracks/0/pan"), 0.25);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        checks: [
          "protocol 3 ping with limits",
          "track GUID read and write",
          "unicode and escaped text round trip",
          "malformed request answered without blocking",
          "dry-run batch leaves project unchanged",
          "4-step batch with 2048-note clip",
          "failed step rolls back earlier steps",
          "non-edit operations refused in a batch",
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
