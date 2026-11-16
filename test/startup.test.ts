import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { heartbeat, ensureRunning } from "../src/startup.js";
import { LiveBridge } from "../src/live.js";
import { Workspace } from "../src/workspace.js";
test("health checks never leave a request behind when disconnected; stale heartbeat is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-test-"));
  const b = new LiveBridge(root);
  assert.equal(await b.available(), false);
  assert.deepEqual(await readdir(root), []);
  const file = path.join(root, "heartbeat.json");
  await writeFile(file, JSON.stringify({ protocol: 2 }));
  assert.equal(await heartbeat(root), true);
  await utimes(file, 1, 1);
  assert.equal(await heartbeat(root), false);
});
test("managed startup does not spawn over an existing process or a live heartbeat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-test-"));
  const w = await Workspace.open(root);
  const profile = path.join(root, "reaper-mcp-profile");
  await mkdir(profile);
  await writeFile(
    path.join(profile, "process.json"),
    JSON.stringify({ pid: process.pid }),
  );
  const states = await Promise.all([ensureRunning(w), ensureRunning(w)]);
  assert.ok(
    states.every((s) =>
      ["starting_or_waiting_for_dialog", "startup_in_progress"].includes(
        s.state,
      ),
    ),
  );
  await writeFile(
    path.join(root, "reaper-mcp-bridge", "heartbeat.json"),
    JSON.stringify({ protocol: 2 }),
  );
  assert.equal((await ensureRunning(w)).state, "connected");
});
