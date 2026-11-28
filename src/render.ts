import { access, mkdtemp, writeFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { writeRpp } from "./rpp/index.js";
import { songSchema, type Song } from "./song/model.js";
import { Workspace } from "./workspace.js";
import { ToolError } from "./errors.js";

export async function locateReaper(): Promise<string | undefined> {
  const candidates = process.env.REAPER_PATH
    ? [process.env.REAPER_PATH]
    : process.platform === "win32"
      ? [
          "C:/Program Files/REAPER (x64)/reaper.exe",
          "C:/Program Files/REAPER/reaper.exe",
        ]
      : ["/usr/local/bin/reaper", "/usr/bin/reaper", "/opt/REAPER/reaper"];
  for (const candidate of candidates)
    try {
      await access(candidate);
      return candidate;
    } catch {}
  return undefined;
}
export function isolatedIni(platform = process.platform): string {
  // Windows dummy-device settings observed from REAPER 7.86 preferences.
  // Never copy user config or set licence/nag fields. Auto-close render is bit 0.
  return platform === "win32"
    ? "[REAPER]\nrenderclosewhendone=1\n[audioconfig]\nmode=4\ndummy_srate=44100\ndummy_blocksize=1024\n"
    : "[REAPER]\naudiomode=0\nrenderclosewhendone=1\n";
}
export async function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    let timedOut = false;
    const cancel = () => { child.kill(); };
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", () => {
      signal?.removeEventListener("abort", cancel);
      clearTimeout(timer);
      reject(new ToolError("render_launch", "Could not start REAPER"));
    });
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", cancel);
      clearTimeout(timer);
      if (signal?.aborted) reject(new ToolError("cancelled", "Render cancelled"));
      else if (timedOut)
        reject(
          new ToolError(
            "render_timeout",
            "REAPER timed out; a device, plugin or evaluation dialogue may require attention",
          ),
        );
      else if (code !== 0)
        reject(new ToolError("render_failed", "REAPER exited unsuccessfully"));
      else resolve();
    });
  });
}
export interface RenderOptions {
  target: "mix" | "stems" | "regions";
  timeoutMs?: number;
}
export async function renderSong(
  song: Song,
  workspace: Workspace,
  options: RenderOptions,
): Promise<{ files: string[]; elapsedMs: number }> {
  const executable = await locateReaper();
  if (!executable)
    throw new ToolError(
      "reaper_not_found",
      "REAPER not found. Install it separately or set REAPER_PATH.",
    );
  const validated = songSchema.parse(song);
  // Resolve every referenced audio file before giving a project to REAPER.
  for (const t of validated.tracks)
    for (const item of t.items)
      if (item.kind === "audio") item.file = await workspace.resolve(item.file);
  const jobs: { name: string; song: Song }[] = [];
  if (options.target === "mix") jobs.push({ name: "mix", song: validated });
  if (options.target === "stems")
    for (let i = 0; i < validated.tracks.length; i++) {
      const copy = structuredClone(validated);
      const keep = new Set([i]);
      const route = (idx: number) =>
        copy.tracks[idx]!.sends.forEach((s) => {
          if (!keep.has(s.to)) {
            keep.add(s.to);
            route(s.to);
          }
        });
      route(i);
      // Preserve downstream bus processing but strip other tracks' source items.
      copy.tracks.forEach((t, j) => {
        if (j !== i) t.items = [];
        if (!keep.has(j)) t.mute = true;
      });
      jobs.push({ name: `stem-${i}`, song: copy });
    }
  if (options.target === "regions")
    for (const region of validated.markers)
      if (region.end !== undefined) {
        const copy = structuredClone(validated);
        copy.render.start = region.position;
        copy.render.end = region.end;
        jobs.push({ name: `region-${region.id}`, song: copy });
      }
  if (!jobs.length)
    throw new ToolError("empty_render", "No tracks or regions to render");
  if (jobs.length > 32)
    throw new ToolError("limit", "At most 32 render jobs per call");
  const folder = await mkdtemp(path.join(workspace.root, "render-"));
  const cfg = path.join(folder, "isolated.ini");
  await writeFile(cfg, isolatedIni());
  const started = Date.now(),
    files: string[] = [];
  const timeout = options.timeoutMs ?? 120000;
  for (const job of jobs) {
    const remaining = timeout - (Date.now() - started);
    if (remaining <= 0)
      throw new ToolError("render_timeout", "Render batch timeout reached");
    const project = path.join(folder, `${job.name}.rpp`);
    await writeFile(
      project,
      writeRpp(job.song, { directory: folder, pattern: job.name }),
    );
    await runProcess(
      executable,
      [
        "-newinst",
        "-nosplash",
        "-cfgfile",
        cfg,
        "-renderproject",
        project,
        "-close:nosave:exit",
      ],
      remaining,
    );
    const output = path.join(folder, `${job.name}.wav`);
    let size = 0;
    try {
      size = (await stat(output)).size;
    } catch {}
    if (size <= 44)
      throw new ToolError(
        "missing_output",
        "REAPER did not produce a nonempty WAV",
      );
    files.push(path.relative(workspace.root, output).replaceAll("\\", "/"));
  }
  return { files, elapsedMs: Date.now() - started };
}
