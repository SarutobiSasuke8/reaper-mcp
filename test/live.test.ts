import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  unlink,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LiveBridge } from "../src/live.js";
import { bridgeState } from "../src/startup.js";
import { ReaperService } from "../src/service.js";
import { Workspace } from "../src/workspace.js";

async function fixture(reply: (request: any) => unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-test-"));
  await writeFile(
    path.join(root, "heartbeat.json"),
    JSON.stringify({ protocol: 3 }),
  );
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const name = (await readdir(root)).find((n) => n.endsWith(".request"));
      if (!name) return;
      const file = path.join(root, name);
      const raw = await readFile(file, "utf8");
      if (!raw) return;
      const request = JSON.parse(raw);
      await unlink(file);
      await writeFile(
        path.join(root, `${request.id}.json`),
        JSON.stringify({ id: request.id, ok: true, result: reply(request) }),
      );
    } catch {
    } finally {
      busy = false;
    }
  }, 5);
  return {
    root,
    stop: () => clearInterval(timer),
    bridge: new LiveBridge(root, 200),
  };
}
test("correlated requests serialize and live writes require a read and validate bounds", async () => {
  const f = await fixture((a) =>
    a.op === "ping"
      ? { protocol: 3 }
      : a.op === "get"
        ? { project: "p", revision: 3, value: [] }
        : { project: "p", revision: 4 },
  );
  try {
    await assert.rejects(f.bridge.set("/tracks/0/pan", 0, false), /Read/);
    assert.deepEqual(await f.bridge.get("/tracks"), []);
    await assert.rejects(f.bridge.set("/tracks/0/pan", 4, false));
    await f.bridge.set("/tracks/0/pan", 0.4, true);
    assert.deepEqual(
      await Promise.all([f.bridge.available(), f.bridge.available()]),
      [true, true],
    );
  } finally {
    f.stop();
  }
});
test("timeout is bounded; unresolved requests are never overwritten or replayed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-dead-"));
  const b = new LiveBridge(root, 50);
  await assert.rejects(b.request("ping"), /timed out/);
  await assert.rejects(b.request("ping"), /timed out/);
  assert.equal(
    (await readdir(root)).filter((n) => n.endsWith(".request")).length,
    0,
  );
});
test("auto mode fails closed after connection loss but explicit offline remains usable", async () => {
  const f = await fixture(() => ({ protocol: 3 }));
  const svc = new ReaperService(await Workspace.open(f.root), true, f.bridge);
  try {
    assert.equal(await svc.selectMode("auto"), "live");
    f.stop();
    await unlink(path.join(f.root, "heartbeat.json"));
    await assert.rejects(svc.selectMode("auto"), /no offline fallback/);
    assert.equal(await svc.selectMode("offline"), "offline");
  } finally {
    f.stop();
  }
});

test("protocol 3 sends one JSON envelope with named arguments, GUID track references and batches", async () => {
  const seen: any[] = [];
  const f = await fixture((request) => {
    seen.push(request);
    return request.op === "get"
      ? { project: "p", revision: 7, value: [] }
      : { project: "p", revision: 8, steps: [] };
  });
  const guid = "{6F1C2B3A-0000-4000-8000-00000000ABCD}";
  try {
    await assert.rejects(f.bridge.batch([{ action: "live_add_track", args: { name: "x" } }], false), /Read/);
    await f.bridge.get(`/tracks/${guid}/fx`);
    assert.equal(seen[0].protocol, 3);
    assert.equal(seen[0].path, `/tracks/${guid}/fx`);
    assert.equal(typeof seen[0].deadline, "number");
    await f.bridge.set(`/tracks/${guid}/mute`, true, false);
    assert.deepEqual(
      { op: seen[1].op, action: seen[1].action, args: seen[1].args, project: seen[1].project, revision: seen[1].revision, dryRun: seen[1].dryRun },
      { op: "call", action: "set_track", args: { track: guid, field: "mute", value: true }, project: "p", revision: 7, dryRun: false },
    );
    await f.bridge.set("/tracks/3/pan", -0.5, true);
    assert.deepEqual(seen[2].args, { track: 3, field: "pan", value: -0.5 });
    assert.equal(seen[2].revision, 8);
    await assert.rejects(f.bridge.set("/tracks/{not-a-guid}/mute", true, false), /Live set supports/);
    const steps = [
      { action: "live_add_track", args: { name: "Bass" } },
      { action: "set_track", args: { track: 0, field: "volume_db", value: -6, note: undefined, gone: null } },
    ];
    await f.bridge.batch(steps, true);
    assert.equal(seen[3].op, "batch");
    assert.equal(seen[3].dryRun, true);
    assert.deepEqual(seen[3].steps[1].args, { track: 0, field: "volume_db", value: -6 });
    const big = "x".repeat(1_100_000);
    await assert.rejects(f.bridge.mutate("live_add_track", { name: big }, false), /exceeds 1 MB/);
  } finally {
    f.stop();
  }
});
test("a bridge from an older package is reported as outdated, not as live", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-old-"));
  await writeFile(path.join(root, "heartbeat.json"), JSON.stringify({ protocol: 2 }));
  assert.equal(await bridgeState(root), "outdated");
  assert.equal(await new LiveBridge(root).available(), false);
  const svc = new ReaperService(await Workspace.open(root), true, new LiveBridge(root));
  await assert.rejects(svc.selectMode("live"), /older REAPER MCP bridge/);
  assert.equal(await svc.selectMode("offline"), "offline");
});
