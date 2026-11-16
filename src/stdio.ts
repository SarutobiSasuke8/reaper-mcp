#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Workspace } from "./workspace.js";
import { ReaperService } from "./service.js";
import { createMcpServer } from "./server.js";

if (
  process.argv.includes("--doctor") ||
  process.argv.includes("--setup") ||
  process.argv.includes("--launch")
) {
  await (await import("./setup.js")).setup(process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
}
const root = process.env.REAPER_MCP_WORKSPACE;
if (!root || !path.isAbsolute(root)) {
  process.stderr.write(
    "REAPER_MCP_WORKSPACE must name an absolute workspace directory.\n",
  );
  process.exit(1);
}
const workspace = await Workspace.open(root);
if (process.env.REAPER_MCP_AUTOSTART === "true") {
  process.env.REAPER_MCP_BRIDGE_DIR ??= path.join(root, "reaper-mcp-bridge");
  const { ensureRunning } = await import("./startup.js");
  const start = () =>
    ensureRunning(workspace).catch((e) =>
      process.stderr.write(`REAPER startup: ${e.message}\n`),
    );
  void start();
  setInterval(() => void start(), 10000).unref();
}
const service = new ReaperService(
  workspace,
  process.env.REAPER_MCP_ALLOW_WRITES === "true",
);
const server = createMcpServer(service);
await server.connect(new StdioServerTransport());
process.on("SIGINT", () => void server.close());
process.on("SIGTERM", () => void server.close());
