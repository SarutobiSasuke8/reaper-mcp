import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LiveBridge } from "../src/live.js";
import { ReaperService } from "../src/service.js";
import { Workspace } from "../src/workspace.js";

async function fixture(reply: (parts: string[]) => unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-test-"));
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const file = path.join(root, "request.txt");
      const raw = await readFile(file, "utf8");
      if (!raw) return;
      const parts = raw
        .trimEnd()
        .split("\n")
        .map((s) => Buffer.from(s, "hex").toString());
      await unlink(file);
      await writeFile(
        path.join(root, `${parts[1]}.json`),
        JSON.stringify({ id: parts[1], ok: true, result: reply(parts) }),
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
    a[3] === "ping"
      ? { protocol: 1 }
      : a[3] === "get"
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
  const original = await readFile(path.join(root, "request.txt"), "utf8");
  await assert.rejects(b.request("ping"), /unresolved/);
  assert.equal(
    await readFile(path.join(root, "request.txt"), "utf8"),
    original,
  );
});
test("auto mode fails closed after connection loss but explicit offline remains usable", async () => {
  const f = await fixture(() => ({ protocol: 1 }));
  const svc = new ReaperService(await Workspace.open(f.root), true, f.bridge);
  try {
    assert.equal(await svc.selectMode("auto"), "live");
    f.stop();
    await assert.rejects(svc.selectMode("auto"), /no offline fallback/);
    assert.equal(await svc.selectMode("offline"), "offline");
  } finally {
    f.stop();
  }
});
