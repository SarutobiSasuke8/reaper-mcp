import { auditionCapability, createAudition } from "./audition.js";
import { autoMixCapability, autoMix } from "./automix.js";
import { isLibraryPath, readLibrary, libraryPaths } from "./compose.js";
import { sectionSchema } from "./music.js";
// House-template contract annotations and safe-error wrapper adapted for SDK 1.x.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolError } from "./errors.js";
import { packageVersion } from "./version.js";
import {
  instruments,
  musicCapabilities,
  runMusic,
  liveProject,
  renderLive,
} from "./music.js";
import {
  ReaperService,
  capabilities,
  modeSchema,
  pathSchema,
  type Mode,
} from "./service.js";

const string = z.string().min(1).max(4096);
const mode = { mode: modeSchema };
const file = { file: string.describe("Workspace-relative filename") };
const index = z
  .number()
  .int()
  .min(0)
  .max(255)
  .describe("zero-based track index");
const seconds = z
  .number()
  .finite()
  .min(0)
  .max(86400)
  .describe("seconds")
  .default(0);
const definitions = {
  reaper_health: {
    writes: false,
    description:
      "Report offline/live availability and REAPER installation status.",
    schema: z.object(mode),
  },
  reaper_list_toolsets: {
    writes: false,
    description:
      "List supported capability groups and whether they are enabled.",
    schema: z.object(mode),
  },
  reaper_enable_toolset: {
    writes: true,
    description: "Enable a supported capability group for this server session.",
    schema: z.object({ ...mode, name: z.enum(["editing"]) }),
  },
  reaper_describe: {
    writes: false,
    description:
      "Describe a song, object path or capability, including schema units and bounds.",
    schema: z.object({ ...mode, subject: z.string().min(1).max(256) }),
  },
  reaper_find_capability: {
    writes: false,
    description:
      "Search the available capabilities without expanding the top-level tool list.",
    schema: z.object({ ...mode, query: z.string().max(200) }),
  },
  reaper_get: {
    writes: false,
    description:
      "Read a supported object path. Track and item indexes start at zero.",
    schema: z.object({ ...mode, path: pathSchema }),
  },
  reaper_list: {
    writes: false,
    description: "List a bounded page from an array object path.",
    schema: z.object({
      ...mode,
      path: pathSchema,
      offset: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .describe("item offset")
        .default(0),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .describe("item count")
        .default(100),
    }),
  },
  reaper_set: {
    writes: true,
    description:
      "Set an existing object path; validates the complete song before committing. dryRun performs validation only.",
    schema: z.object({
      ...mode,
      path: pathSchema,
      value: z.unknown(),
      dryRun: z.boolean().default(false),
    }),
  },
  reaper_project: {
    writes: true,
    description:
      "Create, open or save a song JSON/RPP project. Save creates a new file; it never overwrites.",
    schema: z.object({
      ...mode,
      operation: z.enum(["new", "open", "save"]),
      file: string.optional(),
      song: z.unknown().optional(),
    }),
  },
  reaper_import_midi: {
    writes: true,
    description:
      "Import MIDI notes with explicit PPQ; new empty songs also import tempo and meter maps.",
    schema: z.object({ ...mode, ...file, position: seconds }),
  },
  reaper_import_audio: {
    writes: true,
    description:
      "Import a WAV file as an audio item; create a new track when track is omitted.",
    schema: z.object({
      ...mode,
      ...file,
      track: index.optional(),
      position: seconds,
    }),
  },
  reaper_render: {
    writes: true,
    description:
      "Render an isolated REAPER job to WAV: mix, source stems through buses, or regions. Requires a separately installed REAPER.",
    schema: z.object({
      ...mode,
      target: z.enum(["mix", "stems", "regions"]).default("mix"),
      section: sectionSchema.optional(),
      stemTrack: z.object({index, guid: string.max(200)}).strict().optional().describe("Live stems require the index and GUID of one track"),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(600000)
        .describe("milliseconds for the complete batch")
        .default(120000),
    }),
  },
  reaper_analyze: {
    writes: false,
    description:
      "Measure a WAV file with the ported LMMS audio analyser; LUFS and true peak are estimates.",
    schema: z.object({ ...mode, ...file, referencePath: string.optional().describe("Optional workspace-relative reference WAV") }),
  },
  reaper_run: {
    writes: true,
    description:
      "Run an enabled capability after describe. Arguments must match its schema. dryRun validates without mutation.",
    schema: z.object({
      ...mode,
      capability: z.string().min(1).max(100),
      args: z.unknown(),
      dryRun: z.boolean().default(false),
    }),
  },
};
export const TOOL_CONTRACTS = Object.fromEntries(
  Object.entries(definitions).map(([name, d]) => [
    name,
    {
      ...d,
      annotations: {
        readOnlyHint: !d.writes,
        destructiveHint: d.writes,
        idempotentHint: !d.writes,
        openWorldHint: false,
      },
    },
  ]),
);
export type ToolName = keyof typeof definitions;
export async function call(
  service: ReaperService,
  name: ToolName,
  raw: unknown,
): Promise<CallToolResult> {
  try {
    if (Buffer.byteLength(JSON.stringify(raw) ?? "") > 2_000_000)
      throw new ToolError("limit", "Request exceeds 2 MB");
    const args = definitions[name].schema.strict().parse(raw) as Record<
      string,
      unknown
    >;
    const selected =
      name === "reaper_health"
        ? (await service.live?.available())
          ? "live"
          : "offline"
        : await service.selectMode(args.mode as Mode);
    if (definitions[name].writes && !service.allowWrites)
      throw new ToolError("writes_disabled", "Writes are disabled");
    let value: unknown;
    const common = new Set([
      "reaper_health",
      "reaper_list_toolsets",
      "reaper_enable_toolset",
      "reaper_describe",
      "reaper_find_capability",
    ]);
    if ((name === "reaper_get" || name === "reaper_list") && isLibraryPath(args.path)) {
      const found = readLibrary(args.path);
      if (found === undefined) throw new ToolError("not_found", "Unknown library path; use /styles, /personas or /personas/{id}");
      if (name === "reaper_get") value = found;
      else {
        if (!Array.isArray(found)) throw new ToolError("invalid_path", "List requires an array path");
        const offset = args.offset as number;
        value = { total: found.length, offset, items: found.slice(offset, offset + (args.limit as number)) };
      }
    } else if (name === "reaper_run" && args.capability === auditionCapability.name) {
      if (!service.enabled.has("editing")) throw new ToolError("toolset_disabled", "Enable the editing toolset first");
      value = await createAudition(service.workspace, auditionCapability.schema.parse(args.args), args.dryRun as boolean);
    } else if (selected === "live" && !common.has(name)) {
      if (
        (name === "reaper_get" || name === "reaper_list") &&
        args.path === "/instruments"
      ) {
        const all = await instruments();
        value =
          name === "reaper_get"
            ? all
            : {
                total: all.length,
                offset: args.offset,
                items: all.slice(
                  args.offset as number,
                  (args.offset as number) + (args.limit as number),
                ),
              };
      } else if (name === "reaper_run") {
        if (!service.enabled.has("editing"))
          throw new ToolError(
            "toolset_disabled",
            "Enable the editing toolset first",
          );
        if (args.capability === autoMixCapability.name)
          value = await autoMix(service.live!, service.workspace, autoMixCapability.schema.parse(args.args), args.dryRun as boolean);
        else value = await runMusic(
          service.live!,
          args.capability as string,
          args.args,
          args.dryRun as boolean,
          service.workspace,
        );
      } else if (name === "reaper_project") {
        value = await liveProject(
          service.live!,
          service.workspace,
          args.operation as string,
          args.file as string | undefined,
          args.song,
        );
      } else if (name === "reaper_render") {
        if (args.target === "stems" && !args.stemTrack)
          throw new ToolError("invalid_input", "Live stem rendering requires stemTrack index and GUID");
        if (args.target !== "stems" && args.stemTrack)
          throw new ToolError("invalid_input", "stemTrack requires target stems");
        if (args.target === "regions")
          throw new ToolError(
            "unsupported_live",
            "Live region rendering requires explicit section bounds with target mix",
          );
        value = await renderLive(
          service.live!,
          service.workspace,
          args.timeoutMs as number,
          args.section as z.infer<typeof sectionSchema> | undefined,
          args.stemTrack as { index: number; guid: string } | undefined,
        );
      } else if (name === "reaper_analyze") {
        value = await service.analyze(args.file as string, args.referencePath as string | undefined);
      } else if (name === "reaper_get")
        value = await service.live!.get(args.path as string);
      else if (name === "reaper_list") {
        value = await service.live!.list(args.path as string, args.offset as number, args.limit as number);
      } else if (name === "reaper_set")
        value = await service.live!.set(
          args.path as string,
          args.value,
          args.dryRun as boolean,
        );
      else
        throw new ToolError(
          "unsupported_live",
          "Capability is not implemented live; select offline explicitly if appropriate",
        );
    } else
      switch (name) {
        case "reaper_health":
          value = await service.health();
          break;
        case "reaper_list_toolsets":
          value = [
            {
              name: "editing",
              enabled: service.enabled.has("editing"),
              capabilities: [...capabilities, ...musicCapabilities, auditionCapability, autoMixCapability].map(
                (c) => c.name,
              ),
            },
          ];
          break;
        case "reaper_enable_toolset":
          service.enabled.add(args.name as string);
          value = { enabled: args.name };
          break;
        case "reaper_describe":
          value = {
            supportedModes: ["offline", "live"],
            definition: service.describe(args.subject as string),
            live: {
              get: [
                "/project",
                "/project/tempo",
                "/project/tempo_map",
                "/project/transport",
                "/markers",
                "/tracks/{index}/items",
                "/tracks/{index}/items/{item}",
                "/tracks",
                "/tracks/{index}",
                "/tracks/{index}/sends",
                "/tracks/{index}/fx",
                "/tracks/{index}/fx/{fx}/parameters",
                "/tracks/{index}/fx/{fx}/parameters/{parameter}",
                "/tracks/{index}/fx/{fx}/parameters/{parameter}/envelope",
              ],
              library: libraryPaths,
              trackAddressing:
                "{index} is zero-based; a track GUID in braces from /tracks works in its place and survives reordering",
              transactions:
                "live_batch runs several edit capabilities as one undo step and rolls back on failure",
              set: [
                "/tracks/{index}/name",
                "/tracks/{index}/volume_db",
                "/tracks/{index}/pan",
                "/tracks/{index}/mute",
                "/tracks/{index}/solo",
              ],
            },
          };
          break;
        case "reaper_find_capability":
          value = [
            ...capabilities.map((c) => ({ ...c, modes: ["offline"] })),
            ...musicCapabilities, auditionCapability, autoMixCapability,
          ]
            .filter((c) =>
              `${c.name} ${c.description}`
                .toLowerCase()
                .includes((args.query as string).toLowerCase()),
            )
            .map((c) => ({
              name: c.name,
              description: c.description,
              toolset: c.toolset,
              modes: c.modes,
            }));
          break;
        case "reaper_get":
          value = service.get(args.path as string);
          break;
        case "reaper_list":
          value = service.list(
            args.path as string,
            args.offset as number,
            args.limit as number,
          );
          break;
        case "reaper_set":
          value = service.set(
            args.path as string,
            args.value,
            args.dryRun as boolean,
          );
          break;
        case "reaper_project":
          value = await service.project(
            args.operation as "new" | "open" | "save",
            args.file as string | undefined,
            args.song,
          );
          break;
        case "reaper_import_midi":
          value = await service.importMidi(
            args.file as string,
            args.position as number,
          );
          break;
        case "reaper_import_audio":
          value = await service.importAudio(
            args.file as string,
            args.track as number | undefined,
            args.position as number,
          );
          break;
        case "reaper_render":
          if (args.stemTrack) throw new ToolError("unsupported_offline", "stemTrack requires live mode");
          if (args.section) throw new ToolError("unsupported_offline", "Section rendering requires live mode");
          value = await service.render(
            args.target as "mix" | "stems" | "regions",
            args.timeoutMs as number,
          );
          break;
        case "reaper_analyze":
          value = await service.analyze(args.file as string, args.referencePath as string | undefined);
          break;
        case "reaper_run":
          value = service.run(
            args.capability as string,
            args.args,
            args.dryRun as boolean,
          );
          break;
      }
    const result = { mode: selected, result: value };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const code =
      error instanceof ToolError
        ? error.code
        : error instanceof z.ZodError
          ? "invalid_input"
          : "internal_error";
    const message =
      error instanceof ToolError
        ? error.message
        : error instanceof z.ZodError
          ? "Input does not match the described schema"
          : "Operation failed; inspect local inputs and server configuration";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "unresolved",
            error: { code, message },
          }),
        },
      ],
    };
  }
}
export function createMcpServer(service: ReaperService): McpServer {
  const server = new McpServer({
    name: "reaper-mcp",
    version: packageVersion,
  });
  // Serialize calls so async imports cannot overwrite edits made while reading files.
  let queue: Promise<unknown> = Promise.resolve();
  for (const [name, contract] of Object.entries(TOOL_CONTRACTS)) {
    if (contract.writes && !service.allowWrites) continue;
    server.registerTool(
      name,
      {
        description: contract.description,
        inputSchema: contract.schema,
        annotations: contract.annotations,
      },
      async (args: unknown) => {
        const result = queue.then(() => call(service, name as ToolName, args));
        queue = result.catch(() => {});
        return result;
      },
    );
  }
  return server;
}
