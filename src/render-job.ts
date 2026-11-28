import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ToolError } from "./errors.js";
import { sectionSchema, snapshotRender } from "./music.js";
import type { LiveBridge } from "./live.js";
import { alive } from "./startup.js";
import { Workspace } from "./workspace.js";

const id = z.string().uuid();
const timeout = z.number().int().min(1000).max(600000).default(120000);
export const startJobCapability = {
  name: "start_render_job",
  toolset: "editing",
  modes: ["live"],
  description:
    "Snapshot the current mix or section and start an independent Windows render. Read /render_jobs/{id} to reconnect. Source media and plugins must remain available.",
  schema: z
    .object({ section: sectionSchema.optional(), timeoutMs: timeout })
    .strict(),
};
export const controlJobCapability = {
  name: "control_render_job",
  toolset: "editing",
  modes: ["offline", "live"],
  description:
    "Request cancellation or retry a failed, cancelled or interrupted mix from its original snapshot. Supply the observed attempt number. Works offline after a bridge disconnect.",
  schema: z
    .object({
      jobId: id,
      attempt: z.number().int().nonnegative().max(999),
      action: z.enum(["cancel", "retry"]),
      timeoutMs: timeout,
    })
    .strict(),
};
export const inputSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  project: z.string(),
  revision: z.number(),
  startSeconds: z.number().finite(),
  endSeconds: z.number().finite(),
});
export const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function jobDirectory(jobId: string) {
  return "render-job-" + id.parse(jobId);
}
export async function saveState(folder: string, name: string, value: unknown) {
  const temp = path.join(folder, randomUUID() + ".tmp");
  await writeFile(temp, JSON.stringify(value), { flag: "wx" });
  await rename(temp, path.join(folder, name + ".json"));
}
async function readOptional(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
async function launch(
  workspace: Workspace,
  jobId: string,
  attempt: number,
  timeoutMs: number,
) {
  const dir = jobDirectory(jobId);
  const folder = await workspace.resolve(dir + "/attempt-" + attempt, true);
  try {
    await mkdir(folder);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new ToolError(
        "stale_attempt",
        "Another client already started this attempt",
      );
    throw e;
  }
  try {
    const worker = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./render-worker.js", import.meta.url)),
        workspace.root,
        jobId,
        String(attempt),
        String(timeoutMs),
      ],
      { windowsHide: true, detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      worker.once("spawn", resolve);
      worker.once("error", reject);
    });
    worker.unref();
  } catch {
    await saveState(folder, "result", {
      state: "failed",
      error: "Could not launch the packaged render worker",
    });
  }
  return { jobId, attempt, statusPath: "/render_jobs/" + jobId };
}
export async function startRenderJob(
  bridge: LiveBridge,
  ws: Workspace,
  args: z.infer<typeof startJobCapability.schema>,
  dry: boolean,
) {
  if (dry)
    return {
      dryRun: true,
      section: args.section ?? null,
      timeoutMs: args.timeoutMs,
    };
  const jobId = randomUUID(),
    dir = jobDirectory(jobId);
  const folder = await ws.resolve(dir, true);
  await mkdir(folder);
  const { snapshot } = await snapshotRender(
    bridge,
    ws,
    args.section,
    undefined,
    folder,
  );
  const input = inputSchema.parse({
    ...snapshot,
    sha256: digest(await ws.read(dir + "/mix.rpp", 64_000_000)),
  });
  await saveState(folder, "input", input);
  return { ...(await launch(ws, jobId, 1, args.timeoutMs)), source: input };
}
export async function jobStatus(ws: Workspace, jobId: string) {
  const dir = jobDirectory(jobId),
    folder = await ws.resolve(dir);
  const input = inputSchema.parse(
    JSON.parse((await ws.read(dir + "/input.json")).toString()),
  );
  const attempts = (await readdir(folder))
    .filter((n) => /^attempt-[1-9]\d{0,2}$/.test(n))
    .map((n) => Number(n.slice(8)));
  const attempt = Math.max(0, ...attempts);
  const base = { jobId, attempt, source: input };
  if (!attempt) return { ...base, state: "interrupted" };
  const current = await ws.resolve(dir + "/attempt-" + attempt);
  const result = await readOptional(path.join(current, "result.json"));
  if (result?.state === "completed") {
    const file = dir + "/attempt-" + attempt + "/verified.wav";
    const size = await ws
      .resolve(file)
      .then((f) => stat(f))
      .then(
        (s) => (s.isFile() ? s.size : 0),
        () => 0,
      );
    if (!size || size !== result.measurement?.bytes)
      return {
        ...base,
        state: "failed",
        code: "output_changed",
        error: "Verified WAV is missing or has changed size",
      };
    return {
      ...base,
      state: "completed",
      files: [file],
      measurement: result.measurement,
    };
  }
  if (result) return { ...base, ...result };
  const owner = await readOptional(path.join(current, "worker.json"));
  const interrupted = owner
    ? !alive(owner.pid) || Date.now() > owner.deadline + 30000
    : Date.now() - (await stat(current)).birthtimeMs > 30000;
  const cancelled = await stat(path.join(current, "cancel")).then(
    () => true,
    () => false,
  );
  return {
    ...base,
    state: interrupted
      ? "interrupted"
      : cancelled
        ? "cancelling"
        : owner
          ? "rendering"
          : "queued",
  };
}
export async function listJobs(ws: Workspace) {
  const entries = await readdir(ws.root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      entry.name.startsWith("render-job-") &&
      id.safeParse(entry.name.slice(11)).success &&
      (await stat(path.join(ws.root, entry.name, "input.json")).then(
        () => true,
        () => false,
      ))
    )
      result.push(entry.name.slice(11));
  }
  return result;
}
export async function controlRenderJob(
  ws: Workspace,
  args: z.infer<typeof controlJobCapability.schema>,
  dry: boolean,
) {
  const current = await jobStatus(ws, args.jobId);
  if (current.attempt !== args.attempt)
    throw new ToolError(
      "stale_attempt",
      "Read current job status before retrying",
    );
  if (args.action === "retry") {
    if (
      !["interrupted", "failed", "cancelled"].includes(current.state) ||
      current.attempt >= 999
    )
      throw new ToolError(
        "job_state",
        "Retry requires a failed, interrupted or cancelled attempt",
      );
    return dry
      ? current
      : launch(ws, args.jobId, args.attempt + 1, args.timeoutMs);
  }
  if (!dry && ["queued", "rendering", "cancelling"].includes(current.state)) {
    const file = await ws.resolve(
      jobDirectory(args.jobId) + "/attempt-" + args.attempt + "/cancel",
      true,
    );
    await writeFile(file, "", { flag: "wx" }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
  return jobStatus(ws, args.jobId);
}
