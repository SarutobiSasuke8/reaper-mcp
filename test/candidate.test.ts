import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { Workspace } from "../src/workspace.js";
import { forkSavedProject } from "../src/candidate.js";

test("candidate fork requires the saved revision, preserves opaque RPP bytes and refuses collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "candidate-"));
  const ws = await Workspace.open(root);
  const source = '<REAPER_PROJECT 0.1 "7" 1\r\n  <UNKNOWN\r\n  >\r\n>\r\n';
  await ws.writeNew("take.rpp", source);
  const args = {source:"take.rpp",candidate:"next.rpp"};
  const {sourceSha256} = await forkSavedProject(ws,args,true);
  await mkdir(path.join(root,"media"));
  await assert.rejects(forkSavedProject(ws,{...args,sourceSha256,candidate:"media/next.rpp"},false), /beside/);
  await assert.rejects(forkSavedProject(ws,args,false), /Preview/);
  await forkSavedProject(ws,{...args,sourceSha256},false);
  assert.equal(await readFile(path.join(root,args.candidate),"utf8"),source);
  await assert.rejects(forkSavedProject(ws,{...args,sourceSha256},false), /exists/);
  await writeFile(path.join(root,args.source),source+"\r\n");
  await assert.rejects(forkSavedProject(ws,{...args,sourceSha256,candidate:"other.rpp"},false), /Preview/);
});
