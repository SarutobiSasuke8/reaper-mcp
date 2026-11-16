import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Workspace } from "./workspace.js";
import { locateReaper, isolatedIni } from "./render.js";
import { LiveBridge } from "./live.js";

export async function setup(args: string[]): Promise<void> {
  const root = process.env.REAPER_MCP_WORKSPACE;
  if (!root || !path.isAbsolute(root))
    throw Error("Set REAPER_MCP_WORKSPACE to an existing absolute folder");
  const workspace = await Workspace.open(root);
  const directory =
    process.env.REAPER_MCP_BRIDGE_DIR ??
    path.join(workspace.root, "reaper-mcp-bridge");
  const executable = await locateReaper();
  if (args.includes("--doctor")) {
    const live = await new LiveBridge(directory).available();
    console.log(
      JSON.stringify(
        {
          node: process.version,
          workspace: workspace.root,
          reaperInstalled: !!executable,
          live,
          writes: process.env.REAPER_MCP_ALLOW_WRITES === "true",
          next: live
            ? "Read /tracks before editing"
            : "Run --launch, resolve any evaluation prompt, then run --doctor again",
        },
        null,
        2,
      ),
    );
    if (!executable || !live) process.exitCode = 1;
    return;
  }
  const bridgePath = await workspace.resolve("reaper-mcp-bridge", true);
  if (path.resolve(directory) !== bridgePath)
    throw Error(
      "Setup requires REAPER_MCP_BRIDGE_DIR unset or equal to workspace/reaper-mcp-bridge",
    );
  await mkdir(bridgePath, { recursive: true });
  const profile = await workspace.resolve("reaper-mcp-profile", true);
  await mkdir(profile, { recursive: true });
  const ini = path.join(profile, "reaper.ini");
  try {
    await writeFile(ini, isolatedIni(), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  if (args.includes("--launch")) {
    if (!executable)
      throw Error("Install REAPER separately or set REAPER_PATH");
    const projectIndex = args.indexOf("--project");
    if (projectIndex >= 0)
      process.env.REAPER_MCP_START_PROJECT = args[projectIndex + 1];
    console.log(
      JSON.stringify(
        await (await import("./startup.js")).ensureRunning(workspace),
      ),
    );
  } else
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            reaper: {
              command: process.execPath,
              args: [fileURLToPath(new URL("./stdio.js", import.meta.url))],
              env: {
                REAPER_MCP_WORKSPACE: workspace.root,
                REAPER_MCP_BRIDGE_DIR: bridgePath,
                REAPER_MCP_ALLOW_WRITES:
                  process.env.REAPER_MCP_ALLOW_WRITES === "true"
                    ? "true"
                    : "false",
              },
            },
          },
        },
        null,
        2,
      ),
    );
}
