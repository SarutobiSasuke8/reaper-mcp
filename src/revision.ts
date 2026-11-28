import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { auditionCapability, createAudition } from "./audition.js";
import {
  candidateCapability,
  forkSavedProject,
  savedProjectBytes,
} from "./candidate.js";
import { ToolError } from "./errors.js";
import { LiveBridge } from "./live.js";
import { arrangeSchemas, liveProject, runMusic } from "./music.js";
import { liveIni } from "./profile.js";
import { locateReaper } from "./render.js";
import { digest, jobStatus, saveState, startRenderJob } from "./render-job.js";
import { alive } from "./startup.js";
import { stopPrivateReaper } from "./native-observation.js";
import { Workspace } from "./workspace.js";

const waitMs = z.number().int().min(0).max(600000).default(120000);
const start = candidateCapability.schema.extend({
  ride: arrangeSchemas.live_add_gain_ride.safeExtend({
    track: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n\0]+$/)
      .describe("Track GUID or unique exact saved track name"),
  }),
  section: auditionCapability.schema.shape.section,
  waitMs,
});
const resume = z
  .object({
    resume: z.string().min(1).max(4000).endsWith(".audition.json"),
    waitMs,
  })
  .strict();
export const revisionCapability = {
  name: "audition_gain_ride",
  toolset: "editing",
  modes: ["offline", "live"],
  description:
    "Preview then apply a bounded stereo gain ride to a saved sibling candidate in private REAPER. Render both full versions and return matched listening copies. Supply the preview's sourceSha256. Resume from candidate.rpp.audition.json after disconnect. Choose separately via select_audition_render.",
  schema: z.union([start, resume]),
};
const receipt = z.object({
  source: z.string(),
  candidate: z.string(),
  sourceSha256: z.string(),
  candidateSha256: z.string(),
  a: z.string().uuid(),
  b: z.string().uuid(),
  section: auditionCapability.schema.shape.section,
});
async function finish(ws: Workspace, file: string, wait: number, dry: boolean) {
  const data = JSON.parse((await ws.read(file, 128000)).toString());
  if (data.phase !== "rendering") {
    const interrupted = data.phase === "preparing" && !alive(data.ownerPid);
    return {
      ...data,
      workflow: file,
      phase: interrupted ? "interrupted" : data.phase,
    };
  }
  const pair = receipt.parse(data),
    deadline = Date.now() + wait;
  while (true) {
    const [a, b] = await Promise.all([
      jobStatus(ws, pair.a),
      jobStatus(ws, pair.b),
    ]);
    if ("files" in a && "files" in b) {
      async function validate() {
        for (const [name, sha] of [
          [pair.source, pair.sourceSha256],
          [pair.candidate, pair.candidateSha256],
        ] as const)
          if (digest(await savedProjectBytes(ws, name)) !== sha)
            throw new ToolError(
              "source_changed",
              "A saved project changed after its render was queued",
            );
      }
      await validate();
      const ready = file + ".ready.json";
      async function cached() {
        try {
          return JSON.parse((await ws.read(ready, 128000)).toString());
        } catch (e) {
          if (e instanceof ToolError && e.code === "not_found")
            return undefined;
          throw e;
        }
      }
      const prior = await cached();
      if (prior) return prior;
      const result = await createAudition(
        ws,
        {
          a: a.files[0],
          b: b.files[0],
          projects: { a: pair.source, b: pair.candidate },
          section: pair.section,
          targetLufs: -18,
        },
        dry,
      );
      await validate();
      const output = { workflow: file, phase: "ready", ...result };
      if (!dry) {
        try {
          await ws.writeNew(ready, JSON.stringify(output));
        } catch (e) {
          if (e instanceof ToolError && e.code === "exists") return cached();
          throw e;
        }
      }
      return output;
    }
    if (
      Date.now() >= deadline ||
      [a, b].some((j) =>
        ["cancelled", "interrupted", "failed"].includes(j.state),
      )
    )
      return { workflow: file, phase: "rendering", a, b };
    await delay(250);
  }
}
export async function auditionRide(
  ws: Workspace,
  args: z.infer<typeof revisionCapability.schema>,
  dry: boolean,
) {
  if ("resume" in args) return finish(ws, args.resume, args.waitMs, dry);
  const { source, candidate, sourceSha256 } = args;
  const checked = await forkSavedProject(
    ws,
    { source, candidate, sourceSha256 },
    true,
  );
  const candidatePath = await ws.resolve(candidate, true);
  if (
    await stat(candidatePath).then(
      () => true,
      () => false,
    )
  )
    throw new ToolError(
      "exists",
      "Use a new candidate path or resume its saved audition",
    );
  const workflow = candidate + ".audition.json";
  if (dry) return { ...checked, workflow, ride: args.ride };
  if (sourceSha256 !== checked.sourceSha256)
    throw new ToolError("source_revision", "Supply the preview fingerprint");
  const exe = await locateReaper();
  if (!exe)
    throw new ToolError(
      "reaper_not_found",
      "Install REAPER or set REAPER_PATH",
    );
  await ws.writeNew(
    workflow,
    JSON.stringify({
      phase: "preparing",
      source,
      candidate,
      ownerPid: process.pid,
    }),
  );
  const update = (data: unknown) =>
    saveState(
      path.dirname(candidatePath),
      path.basename(candidatePath) + ".audition",
      data,
    );
  const scratch = await mkdtemp(path.join(ws.root, "revision-session-")),
    ini = path.join(scratch, "private.ini");
  const shadow = path.join(
    path.dirname(source),
    "revision-source-" + randomUUID() + ".rpp",
  );
  const progress: { a?: string; b?: string } = {};
  let ownsShadow = false;
  try {
    await forkSavedProject(
      ws,
      { source, candidate: shadow, sourceSha256 },
      false,
    );
    ownsShadow = true;
    await writeFile(ini, liveIni(process.platform, "dummy"));
    const bridge = new LiveBridge(path.join(scratch, "bridge"));
    await mkdir(bridge.directory);
    const child = spawn(
      exe,
      [
        "-newinst",
        "-nosplash",
        "-cfgfile",
        ini,
        await ws.resolve(shadow),
        fileURLToPath(new URL("../../bridge/reaper-mcp.lua", import.meta.url)),
      ],
      {
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, REAPER_MCP_BRIDGE_DIR: bridge.directory },
      },
    );
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const deadline = Date.now() + 180000;
      while (!(await bridge.available())) {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new ToolError(
            "revision_startup",
            "Private REAPER did not open the saved project",
          );
        await delay(200);
      }
      const tracks = z
        .array(z.object({ guid: z.string(), name: z.string() }))
        .parse(await bridge.get("/tracks"));
      const matches = tracks.filter(
        (t) =>
          t.guid.toUpperCase() === args.ride.track.toUpperCase() ||
          t.name === args.ride.track,
      );
      if (matches.length !== 1)
        throw new ToolError(
          "track_identity",
          "Supply a track GUID or a unique exact saved track name",
        );
      const ride = { ...args.ride, track: matches[0]!.guid };
      const preview = await runMusic(
        bridge,
        "live_add_gain_ride",
        ride,
        true,
        ws,
      );
      const points = preview.points;
      const section = args.section ?? {
        startSeconds: points[0].timeSeconds,
        endSeconds: points[points.length - 1].timeSeconds,
      };
      const queue = async (afterJob?: string) => {
        const job = await startRenderJob(
          bridge,
          ws,
          { timeoutMs: 600000 },
          false,
          afterJob,
        );
        if (!("jobId" in job) || !job.jobId) throw Error("Missing render job");
        return job.jobId;
      };
      progress.a = await queue();
      await update({
        phase: "preparing",
        source,
        candidate,
        ownerPid: process.pid,
        ...progress,
      });
      await runMusic(bridge, "live_add_gain_ride", ride, false, ws);
      await liveProject(bridge, ws, "save", candidate);
      const candidateSha256 = digest(await savedProjectBytes(ws, candidate));
      progress.b = await queue(progress.a);
      await update({
        phase: "rendering",
        source,
        candidate,
        sourceSha256,
        candidateSha256,
        ...progress,
        section,
        ride,
      });
    } finally {
      await stopPrivateReaper(child,!progress.b);
      await exited;
    }
  } catch (e) {
    await update({
      phase: "failed",
      source,
      candidate,
      ...progress,
      error: e instanceof Error ? e.message : "Revision failed",
    });
    throw e;
  } finally {
    if (ownsShadow) await unlink(await ws.resolve(shadow));
  }
  return finish(ws, workflow, args.waitMs, false);
}
