#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Workspace } from "./workspace.js";
import { ReaperService } from "./service.js";
import { createMcpServer } from "./server.js";

const root = process.env.REAPER_MCP_WORKSPACE;
if (!root || !path.isAbsolute(root)) {
  process.stderr.write(
    "REAPER_MCP_WORKSPACE must name an absolute workspace directory.\n",
  );
  process.exit(1);
}
const service = new ReaperService(
  await Workspace.open(root),
  process.env.REAPER_MCP_ALLOW_WRITES === "true",
);
const server = createMcpServer(service);
await server.connect(new StdioServerTransport());
process.on("SIGINT", () => void server.close());
process.on("SIGTERM", () => void server.close());
