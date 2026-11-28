import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ToolError } from "./errors.js";

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
      if (observation !== undefined) return observation;
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
    child.kill();
    await exited;
  }
}
