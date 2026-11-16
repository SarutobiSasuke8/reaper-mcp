import { z } from "zod";
import { readFile, realpath, stat, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./errors.js";
import { Workspace } from "./workspace.js";
import { LiveBridge } from "./live.js";
import { isolatedIni, locateReaper, runProcess } from "./render.js";

const text = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\r\n\x00]+$/);
const track = z.number().int().min(0).max(255);
const beat = z.number().finite().min(0).max(100000);
const note = z
  .object({
    beat,
    duration: z.number().finite().positive().max(10000),
    pitch: z.number().int().min(0).max(127),
    velocity: z.number().int().min(1).max(127).default(90),
    channel: z.number().int().min(0).max(15).default(0),
  })
  .strict();
export const musicSchemas = {
  live_add_track: z.object({ name: text }).strict(),
  live_insert_instrument: z.object({ track, instrument: text }).strict(),
  live_insert_midi: z
    .object({
      track,
      name: text.default("MIDI"),
      startBeat: beat,
      lengthBeats: z.number().finite().positive().max(10000),
      notes: z.array(note).min(1).max(128),
    })
    .strict()
    .superRefine((a, ctx) => {
      if (a.notes.some((n) => n.beat + n.duration > a.lengthBeats))
        ctx.addIssue({
          code: "custom",
          message: "Notes must fit within the clip",
        });
    }),
};
export const musicCapabilities = Object.entries(musicSchemas).map(
  ([name, schema]) => ({
    name,
    schema,
    toolset: "editing",
    modes: ["live"],
    description:
      name === "live_add_track"
        ? "Append a named native track"
        : name === "live_insert_instrument"
          ? "Insert a configured library instrument and its optional VST3 preset"
          : "Insert a MIDI clip; project start and clip-relative note offsets are quarter-note beats, channels 0-15; at most 128 notes per clip",
  }),
);
const entrySchema = z
  .object({
    id: text,
    name: text,
    plugin: text,
    preset: z.string().min(1).max(4096).optional(),
  })
  .strict();
export async function instruments() {
  const file = process.env.REAPER_MCP_INSTRUMENTS;
  if (!file) return [];
  if (!path.isAbsolute(file) || (await stat(file)).size > 100000)
    throw new ToolError(
      "library_config",
      "Instrument catalogue must be a bounded absolute local JSON file",
    );
  const entries = z
    .array(entrySchema)
    .max(128)
    .parse(JSON.parse(await readFile(file, "utf8")));
  if (new Set(entries.map((e) => e.id)).size !== entries.length)
    throw new ToolError("library_config", "Duplicate instrument IDs");
  return entries;
}
export async function runMusic(
  bridge: LiveBridge,
  capability: string,
  raw: unknown,
  dry: boolean,
) {
  const schema = musicSchemas[capability as keyof typeof musicSchemas];
  if (!schema)
    throw new ToolError(
      "unsupported_live",
      "Unknown live music capability; describe available capabilities",
    );
  const a: any = schema.parse(raw);
  let fields: string[];
  if (capability === "live_add_track") fields = [a.name];
  else if (capability === "live_insert_midi")
    fields = [
      String(a.track),
      a.name,
      String(a.startBeat),
      String(a.lengthBeats),
      a.notes
        .map((n: any) =>
          [n.beat, n.duration, n.pitch, n.velocity, n.channel].join(","),
        )
        .join(";"),
    ];
  else {
    const entry = (await instruments()).find((e) => e.id === a.instrument);
    if (!entry)
      throw new ToolError(
        "not_found",
        "Instrument ID not found; read /instruments",
      );
    let preset = "";
    if (entry.preset) {
      if (!path.isAbsolute(entry.preset) || !/\.vstpreset$/i.test(entry.preset))
        throw new ToolError(
          "library_config",
          "Preset must be an absolute .vstpreset path",
        );
      preset = await realpath(entry.preset);
      const info = await stat(preset);
      if (!info.isFile() || info.size > 20_000_000)
        throw new ToolError("library_config", "Invalid preset file");
    }
    fields = [String(a.track), entry.plugin, preset];
  }
  return bridge.mutate(capability, fields, dry);
}
export async function liveProject(
  bridge: LiveBridge,
  workspace: Workspace,
  operation: string,
  file?: string,
  song?: unknown,
) {
  if (operation === "new") {
    if (file)
      throw new ToolError(
        "invalid_input",
        "Save the new project in a separate call",
      );
    const a = z
      .object({ tempo: z.number().min(20).max(300).default(120) })
      .strict()
      .parse(song ?? {});
    return bridge.mutate("project_new", [String(a.tempo)], false);
  }
  if (song !== undefined || !file || !/\.rpp$/i.test(file))
    throw new ToolError(
      "invalid_input",
      "Live open/save requires a workspace-relative .rpp filename",
    );
  if (operation === "open")
    return bridge.mutate(
      "project_open",
      [await workspace.resolve(file)],
      false,
    );
  // Exclusive reservation prevents overwriting an existing project. Failed reservations remain reviewable.
  await workspace.writeNew(file, "");
  const output = await workspace.resolve(file);
  const result = await bridge.mutate("project_save", [output], false);
  if ((await stat(output)).size === 0)
    throw new ToolError(
      "save_failed",
      "REAPER did not write the reserved project file",
    );
  return result;
}
export async function renderLive(
  bridge: LiveBridge,
  workspace: Workspace,
  timeout: number,
) {
  const exe = await locateReaper();
  if (!exe) throw new ToolError("reaper_not_found", "REAPER is not installed");
  const folder = await mkdtemp(path.join(workspace.root, "live-render-"));
  const project = path.join(folder, "mix.rpp");
  await bridge.mutate("snapshot", [project, folder], false);
  const cfg = path.join(folder, "reaper.ini");
  const vstPaths = process.env.REAPER_MCP_VST_PATHS;
  if (vstPaths && /[\r\n]/.test(vstPaths))
    throw new ToolError("library_config", "Invalid VST paths");
  await writeFile(
    cfg,
    isolatedIni().replace(
      "[REAPER]\n",
      `[REAPER]\n${vstPaths ? `vstpath64=${vstPaths}\n` : ""}`,
    ),
  );
  const started = Date.now();
  await runProcess(
    exe,
    [
      "-newinst",
      "-nosplash",
      "-cfgfile",
      cfg,
      "-renderproject",
      project,
      "-close:nosave:exit",
    ],
    timeout,
  );
  const output = path.join(folder, "mix.wav");
  if ((await stat(output).catch(() => ({ size: 0 }))).size <= 44)
    throw new ToolError(
      "missing_output",
      "Native render did not produce a WAV",
    );
  return {
    files: [path.relative(workspace.root, output).replaceAll("\\", "/")],
    elapsedMs: Date.now() - started,
  };
}
