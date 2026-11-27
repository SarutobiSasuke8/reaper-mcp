import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
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
    "Set REAPER_MCP_RUN_LIVE_CHECK=true; opens disposable isolated REAPER instances",
  );
const root = await mkdtemp(path.join(os.tmpdir(), "reaper-lifecycle-"));
const bridge = path.join(root, "bridge");
await mkdir(bridge);
const ini = path.join(root, "reaper.ini");
await writeFile(ini, isolatedIni());
for (const name of ["a", "b"])
  await writeFile(
    path.join(root, `${name}.rpp`),
    writeRpp(songSchema.parse({ name, tracks: [{ name }] })),
  );
const luaPath = fileURLToPath(
  new URL("../bridge/reaper-mcp.lua", import.meta.url),
);
const luaString = (s) => "[[" + s.replaceAll("\\", "/") + "]]";
const harness = path.join(root, "harness.lua");
await writeFile(
  harness,
  `dofile(${luaString(luaPath)})
local function test_tick()
 local f=io.open(${luaString(path.join(root, "switch"))},'r')
 if f then f:close(); os.remove(${luaString(path.join(root, "switch"))}); reaper.Main_openProject('noprompt:'..${luaString(path.join(root, "b.rpp"))}) end
 reaper.defer(test_tick)
end
reaper.defer(test_tick)
`,
);
const b = new LiveBridge(bridge);
let child;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function launch() {
  child = spawn(
    await locateReaper(),
    [
      "-newinst",
      "-nosplash",
      "-cfgfile",
      ini,
      path.join(root, "a.rpp"),
      harness,
    ],
    {
      env: {
        ...process.env,
        REAPER_MCP_BRIDGE_DIR: bridge,
        REAPER_MCP_ALLOW_WRITES: "true",
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    if (await b.available()) {
      await b.request("ping");
      return;
    }
    await delay(500);
  }
  throw Error("Startup timeout: inspect isolated evaluation/dialog prompt");
}
async function stop() {
  if (child && child.exitCode === null) {
    const done = new Promise((r) => child.once("exit", r));
    child.kill();
    await done;
  }
}
try {
  await launch();
  await b.get("/tracks");
  await writeFile(path.join(root, "switch"), "switch disposable project");
  await delay(800);
  await assert.rejects(b.set("/tracks/0/pan", 0.25, false), /Project changed/);
  assert.equal((await b.get("/tracks"))[0].name, "b");
  const stale = {
    id: "11111111-1111-1111-1111-111111111111",
    body: {
      protocol: 3,
      id: "11111111-1111-1111-1111-111111111111",
      deadline: Date.now() - 10000,
      op: "call",
      project: "bad",
      revision: 0,
      action: "set_track",
      args: { track: 0, field: "pan", value: 1 },
      dryRun: false,
    },
  };
  await writeFile(
    path.join(bridge, stale.id + ".request"),
    JSON.stringify(stale.body),
  );
  await delay(200);
  assert.equal(await b.get("/tracks/0/pan"), 0);
  const old = await b.request("ping");
  await stop();
  await delay(5500);
  assert.equal(await b.available(), false);
  await launch();
  assert.notEqual((await b.request("ping")).project, old.project);
  await assert.rejects(b.set("/tracks/0/pan", 0.25, false), /Project changed/);
  assert.equal((await b.get("/tracks"))[0].name, "a");
  const other = new LiveBridge(bridge);
  await other.get("/tracks");
  await b.set("/tracks/0/pan", 0.2, false);
  await assert.rejects(
    other.set("/tracks/0/pan", 0.3, false),
    /changed since read/,
  );
  await other.get("/tracks");
  await other.set("/tracks/0/pan", 0, false);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        checks: [
          "project switch rejects stale edit",
          "expired request does not mutate or block",
          "closed process loses heartbeat",
          "restart reconnects existing client",
          "old session write rejected",
          "fresh read re-enables edits",
          "concurrent-client revision guard",
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
