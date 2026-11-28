import { open, rename, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError } from "./errors.js";
import { nativeObservation } from "./native-observation.js";
import { locateReaper } from "./render.js";
import { liveIni } from "./profile.js";
import {
  digest,
  inputSchema,
  jobDirectory,
  jobStatus,
  saveState,
} from "./render-job.js";
import { Workspace } from "./workspace.js";

// Validate the complete chunk table without loading an orchestral render into RAM.
export async function verifyMix(
  file: string,
  endSeconds: number,
  startSeconds = 0,
) {
  const wav = await open(file, "r");
  const invalid = () =>
    new ToolError(
      "invalid_output",
      "Expected a complete 44.1 kHz stereo PCM render of the requested duration",
    );
  try {
    const size = (await wav.stat()).size;
    async function header(offset: number, length: number) {
      const buf = Buffer.alloc(length);
      if ((await wav.read(buf, 0, length, offset)).bytesRead !== length)
        throw invalid();
      return buf;
    }
    const riff = await header(0, 12);
    if (
      riff.toString("ascii", 0, 4) !== "RIFF" ||
      riff.toString("ascii", 8, 12) !== "WAVE" ||
      riff.readUInt32LE(4) + 8 !== size
    )
      throw invalid();
    let format = false,
      frames = 0,
      offset = 12;
    while (offset < size) {
      const chunk = await header(offset, 8),
        length = chunk.readUInt32LE(4);
      const name = chunk.toString("ascii", 0, 4);
      if (offset + 8 + length > size) throw invalid();
      if (name === "fmt ") {
        if (format || length < 16) throw invalid();
        const fmt = await header(offset + 8, 16);
        if (
          fmt.readUInt16LE(0) !== 1 ||
          fmt.readUInt16LE(2) !== 2 ||
          fmt.readUInt32LE(4) !== 44100 ||
          fmt.readUInt16LE(12) !== 6 ||
          fmt.readUInt16LE(14) !== 24
        )
          throw invalid();
        format = true;
      }
      if (name === "data") {
        if (!format || frames || !length || length % 6) throw invalid();
        frames = length / 6;
      }
      offset += 8 + length + (length % 2);
    }
    // REAPER's native render dialog can round fractional bounds to milliseconds.
    const exact = (endSeconds - startSeconds) * 44100;
    const dialog =
      (Math.round(endSeconds * 1000) - Math.round(startSeconds * 1000)) * 44.1;
    if (
      offset !== size ||
      !frames ||
      Math.min(Math.abs(frames - exact), Math.abs(frames - dialog)) > 1.01
    )
      throw invalid();
    return { frames, sampleRate: 44100, channels: 2, bytes: size };
  } finally {
    await wav.close();
  }
}

async function work(
  ws: Workspace,
  jobId: string,
  attempt: number,
  timeout: number,
) {
  if (
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > 999 ||
    !Number.isInteger(timeout) ||
    timeout < 1000 ||
    timeout > 600000
  )
    throw Error("Invalid worker request");
  const dir = jobDirectory(jobId);
  const relative = dir + "/attempt-" + attempt;
  const folder = await ws.resolve(relative);
  const cancel = path.join(folder, "cancel");
  const controller = new AbortController();
  const check = async () => {
    if (
      await stat(cancel).then(
        () => true,
        () => false,
      )
    )
      controller.abort();
  };
  const timer = setInterval(() => {
    void check();
  }, 200);
  try {
    await saveState(folder, "worker", {
      pid: process.pid,
      deadline: Date.now() + timeout,
    });
    const input = inputSchema.parse(
      JSON.parse((await ws.read(dir + "/input.json")).toString()),
    );
    // A/B renders load the same instruments. Serialise the two private plugin scans.
    if (input.afterJob) {
      const deadline = Date.now() + 630000;
      await saveState(folder, "worker", {
        pid: process.pid,
        deadline,
        stage: "waiting",
      });
      while (
        ["queued", "waiting", "rendering", "cancelling"].includes(
          (await jobStatus(ws, input.afterJob)).state,
        )
      ) {
        await check();
        controller.signal.throwIfAborted();
        if (Date.now() > deadline)
          throw new ToolError(
            "dependency_timeout",
            "Previous render did not finish",
          );
        await delay(250);
      }
      await saveState(folder, "worker", {
        pid: process.pid,
        deadline: Date.now() + timeout,
        stage: "rendering",
      });
    }
    const source = await ws.read(dir + "/mix.rpp", 64_000_000);
    if (digest(source) !== input.sha256)
      throw new ToolError(
        "source_changed",
        "Render snapshot changed since submission",
      );
    // Keep the project beside the original snapshot to preserve relative media paths.
    const project = await ws.resolve(
      dir + "/attempt-" + attempt + ".rpp",
      true,
    );
    await writeFile(project, source, { flag: "wx" });
    const ini = path.join(folder, "worker.ini");
    await writeFile(ini, liveIni(process.platform, "dummy"), { flag: "wx" });
    const exe = await locateReaper();
    if (!exe)
      throw new ToolError(
        "reaper_not_found",
        "Install REAPER or set REAPER_PATH",
      );
    await check();
    const observation = await nativeObservation(
      exe,
      [
        "-newinst",
        "-nosplash",
        "-cfgfile",
        ini,
        project,
        fileURLToPath(new URL("../../bridge/render-job.lua", import.meta.url)),
      ],
      path.join(folder, "observation.txt"),
      Date.now() + timeout,
      controller.signal,
    );
    if (observation !== "ok") throw new ToolError("render_failed", observation);
    const wav = path.join(folder, "mix.wav"),
      measurement = await verifyMix(wav, input.endSeconds, input.startSeconds);
    await check();
    controller.signal.throwIfAborted();
    await rename(wav, path.join(folder, "verified.wav"));
    await saveState(folder, "result", {
      state: "completed",
      files: [relative + "/verified.wav"],
      measurement,
    });
  } catch (e) {
    await saveState(folder, "result", {
      state: controller.signal.aborted ? "cancelled" : "failed",
      code: e instanceof ToolError ? e.code : undefined,
      error: controller.signal.aborted
        ? "Render cancelled"
        : e instanceof Error
          ? e.message
          : "Render failed",
    });
  } finally {
    clearInterval(timer);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , root, jobId, attempt, timeout] = process.argv;
  await work(
    await Workspace.open(root!),
    jobId!,
    Number(attempt),
    Number(timeout),
  );
}
