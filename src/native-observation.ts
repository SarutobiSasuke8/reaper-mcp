import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ToolError } from "./errors.js";

// A cold Windows plugin scan can spawn another REAPER process. Stop the owned
// tree on interruption while its parent is still running and identifiable.
export async function stopPrivateReaper(
  child: ChildProcess,
  interrupted: boolean,
) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  if (interrupted && process.platform === "win32" && process.env.SystemRoot) {
    try {
      await promisify(execFile)(
        path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000 },
      );
      return;
    } catch {
      /* The child may already have exited. */
    }
  }
  child.kill();
}

// A packaged ReaScript writes its observation atomically after completing the native operation.
export async function nativeObservation(
  exe: string,
  args: string[],
  file: string,
  deadline: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = spawn(exe, args, { windowsHide: true, stdio: "ignore" });
  let observed = false;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const observation = await readFile(file, "utf8").catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return undefined;
      });
      if (observation !== undefined) {
        observed = true;
        return observation;
      }
      if (child.exitCode !== null || child.signalCode !== null)
        throw new ToolError(
          "native_exit",
          "Private REAPER exited before confirming the operation",
        );
      await delay(100);
    }
    throw new ToolError(
      "native_timeout",
      "Private REAPER timed out. Check referenced media, plugin availability and first-run dialogs.",
    );
  } finally {
    await stopPrivateReaper(child, !observed);
    await exited;
  }
}
