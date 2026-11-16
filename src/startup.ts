import {
  mkdir,
  open,
  readFile,
  writeFile,
  unlink,
  stat,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locateReaper } from "./render.js";
import { liveIni } from "./profile.js";
import { Workspace } from "./workspace.js";

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
export async function heartbeat(directory: string): Promise<boolean> {
  try {
    const p = path.join(directory, "heartbeat.json");
    const h = JSON.parse(await readFile(p, "utf8"));
    return h.protocol === 2 && Date.now() - (await stat(p)).mtimeMs < 5000;
  } catch {
    return false;
  }
}
// Reuse an owned process; never kill/restart a possibly unsaved session automatically.
export async function ensureRunning(
  workspace: Workspace,
): Promise<{ state: string; pid?: number }> {
  const bridge = await workspace.resolve("reaper-mcp-bridge", true);
  await mkdir(bridge, { recursive: true });
  if (
    process.env.REAPER_MCP_BRIDGE_DIR &&
    path.resolve(process.env.REAPER_MCP_BRIDGE_DIR) !== bridge
  )
    throw Error("Autostart requires the workspace's managed bridge directory");
  if (await heartbeat(bridge)) return { state: "connected" };
  const profile = await workspace.resolve("reaper-mcp-profile", true);
  await mkdir(profile, { recursive: true });
  const lockfile = path.join(profile, "startup.lock"),
    pidfile = path.join(profile, "process.json");
  let lock;
  try {
    lock = await open(lockfile, "wx");
    await lock.writeFile(String(process.pid));
  } catch {
    try {
      const owner = Number(await readFile(lockfile, "utf8"));
      if (!alive(owner) && Date.now() - (await stat(lockfile)).mtimeMs > 10000)
        await unlink(lockfile);
    } catch {}
    return { state: "startup_in_progress" };
  }
  try {
    try {
      const previous = JSON.parse(await readFile(pidfile, "utf8"));
      if (alive(previous.pid))
        return { state: "starting_or_waiting_for_dialog", pid: previous.pid };
    } catch {}
    const executable = await locateReaper();
    if (!executable)
      throw Error("REAPER not found; install separately or set REAPER_PATH");
    const ini = path.join(profile, "reaper.ini");
    try {
      await writeFile(
        ini,
        liveIni(),
        { flag: "wx" },
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const project = process.env.REAPER_MCP_START_PROJECT
      ? await workspace.resolve(process.env.REAPER_MCP_START_PROJECT)
      : undefined;
    const child = spawn(
      executable,
      [
        "-newinst",
        "-nosplash",
        "-cfgfile",
        ini,
        ...(project ? [project] : []),
        fileURLToPath(new URL("../../bridge/reaper-mcp.lua", import.meta.url)),
      ],
      {
        env: { ...process.env, REAPER_MCP_BRIDGE_DIR: bridge },
        stdio: "ignore",
        detached: true,
        windowsHide: process.env.REAPER_MCP_SHOW_WINDOW !== "true",
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await writeFile(
      pidfile,
      JSON.stringify({ pid: child.pid, started: Date.now() }),
    );
    child.unref();
    return { state: "launched", pid: child.pid };
  } finally {
    await lock.close();
    await unlink(lockfile).catch(() => {});
  }
}
