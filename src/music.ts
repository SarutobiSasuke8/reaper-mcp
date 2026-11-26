import { z } from "zod";
import { readFile, realpath, stat, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const channel = z.number().int().min(0).max(15).default(0);
const midiByte = z.number().int().min(0).max(127);
const controller = z.object({ beat, controller: midiByte, value: midiByte, channel }).strict();
const performance = z.object({
  track, name: text.default("Performance"), startBeat: beat,
  lengthBeats: z.number().finite().positive().max(10000),
  notes: z.array(note).max(128).default([]),
  controllers: z.array(controller).max(128).default([]),
  ramps: z.array(z.object({
    startBeat: beat, endBeat: beat, controller: midiByte,
    startValue: midiByte, endValue: midiByte,
    steps: z.number().int().min(1).max(64).default(16), channel,
  }).strict()).max(16).default([]),
  instrument: text.optional(),
  articulations: z.array(z.object({
    beat, name: text, duration: z.number().finite().positive().max(1).default(0.025), channel,
  }).strict()).max(64).default([]),
}).strict().superRefine((a, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (a.notes.some(n => n.beat + n.duration > a.lengthBeats) ||
      a.controllers.some(e => e.beat >= a.lengthBeats) ||
      a.articulations.some(e => e.beat + e.duration > a.lengthBeats) ||
      a.ramps.some(r => r.endBeat <= r.startBeat || r.endBeat >= a.lengthBeats))
    fail("Performance events must fit within the clip; ramps must move forward");
  if (a.articulations.length && !a.instrument) fail("Named articulations require an instrument catalogue ID");
  const count = a.notes.length + a.controllers.length + a.articulations.length + a.ramps.reduce((n, r) => n + r.steps + 1, 0);
  if (count < 1 || count > 128) fail("Performance must contain 1-128 expanded events");
});
const editIndex = z.number().int().min(0).max(9999);
const editPerformance = z.object({
  track, item: editIndex, takeGuid: text,
  notes: z.array(z.object({index: editIndex, beat: beat.optional(),
    duration: z.number().finite().positive().max(10000).optional(),
    pitch: midiByte.optional(), velocity: z.number().int().min(1).max(127).optional(),
    channel: z.number().int().min(0).max(15).optional(),
  }).strict()).max(128).default([]),
  instrument: text.optional(),
  articulations: z.array(z.object({index: editIndex, from: text, to: text}).strict()).max(64).default([]),
  ramps: z.array(z.object({startBeat: beat, endBeat: beat, controller: midiByte,
    startValue: midiByte, endValue: midiByte, steps: z.number().int().min(1).max(64).default(16), channel,
  }).strict()).max(16).default([]),
}).strict().superRefine((a, ctx) => {
  const fail = (message: string) => ctx.addIssue({code: "custom", message});
  const indices = [...a.notes, ...a.articulations].map(n => n.index);
  if (new Set(indices).size !== indices.length) fail("Duplicate note/articulation index");
  if (a.notes.some(n => Object.keys(n).length === 1)) fail("Empty note edit");
  if (a.articulations.length && !a.instrument) fail("Articulations require an instrument catalogue ID");
  const count = indices.length + a.ramps.reduce((n,r) => n+r.steps+1,0);
  if (count < 1 || count > 128) fail("Edits must contain 1-128 expanded events");
  a.ramps.forEach((r,i) => {
    if (r.endBeat <= r.startBeat) fail("Ramp must move forward");
    if (a.ramps.slice(0,i).some(q => q.channel===r.channel && q.controller===r.controller && q.endBeat>=r.startBeat && r.endBeat>=q.startBeat)) fail("Overlapping controller ranges");
  });
});
export const sectionSchema = z.object({startBeat: beat, endBeat: beat,
  tailSeconds: z.number().finite().min(0).max(30).default(0),
}).strict().refine(s => s.endBeat > s.startBeat, "Section must move forward");
export const musicSchemas = {
  live_edit_fx_envelope_point: z.object({
    track, fx: editIndex, fxGuid: text, parameter: editIndex, point: editIndex,
    timeSeconds: z.number().min(0).max(86400), normalized: z.number().min(0).max(1),
  }).strict(),
  live_add_send: z.object({
    source: track, sourceGuid: text, destination: track, destinationGuid: text,
    pair: z.enum(["1/2","3/4"]).default("1/2"), gainDb: z.number().min(-150).max(12).default(0),
  }).strict(),
  live_revert_fx_edit: z.object({ undoToken: text }).strict(),
  live_set_fx_parameter: z.object({
    track, fx: z.number().int().nonnegative(), fxGuid: text,
    parameter: z.number().int().nonnegative(), normalized: z.number().min(0).max(1),
  }).strict(),
  live_edit_performance: editPerformance,
  live_insert_performance: performance,
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
      name === "live_edit_fx_envelope_point"
        ? "Adjust one existing interior FX automation point. Read the parameter's /envelope first. Preserves its time and adjacent anchors; supports linear/square segments on unscaled 0-1 controls."
        : name === "live_add_send"
        ? "Create a post-fader stereo audio send to destination channels 1/2 or sidechain 3/4. Read track GUIDs first. MIDI is disabled."
        : name === "live_revert_fx_edit"
        ? "Undo the most recent guarded FX edit using its returned undoToken while the project is still at that revision."
        : name === "live_set_fx_parameter"
        ? "Set one track FX parameter. Read /tracks/{track}/fx for its GUID and /tracks/{track}/fx/{fx}/parameters for controls. Supply normalized 0-1. Returns native readback."
        : name === "live_edit_performance"
        ? "Edit indexed notes and catalogue keyswitches in an existing MIDI take. Read notes and item metadata first. Beats are clip-relative. Ramps replace matching CC/channel events within inclusive ranges. Rejects looped, pooled or external MIDI; maximum 128 expanded edits. Re-read indices after every edit."
        : name === "live_insert_performance"
        ? "Insert notes, CC events, sampled linear dynamics ramps and catalogue-named keyswitch articulations in one clip; offsets are clip-relative quarter-note beats, maximum 128 expanded events. Place keyswitches before musical notes."
        : name === "live_add_track"
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
    articulations: z.record(text, midiByte).refine(m => Object.keys(m).length <= 64, "Articulation map limit").optional(),
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
  else if (capability === "live_edit_fx_envelope_point")
    fields = [String(a.track), String(a.fx), a.fxGuid, String(a.parameter), String(a.point), String(a.timeSeconds), String(a.normalized)];
  else if (capability === "live_add_send")
    fields = [String(a.source), a.sourceGuid, String(a.destination), a.destinationGuid, a.pair, String(a.gainDb)];
  else if (capability === "live_revert_fx_edit") fields = [a.undoToken];
  else if (capability === "live_set_fx_parameter")
    fields = [String(a.track), String(a.fx), a.fxGuid, String(a.parameter), String(a.normalized)];
  else if (capability === "live_edit_performance") {
    const entry = a.articulations.length ? (await instruments()).find(e => e.id === a.instrument) : undefined;
    const arts = a.articulations.map((e: any) => {
      const map = entry?.articulations;
      if (!map || !Object.hasOwn(map,e.from) || !Object.hasOwn(map,e.to))
        throw new ToolError("not_found", "Unknown instrument/articulation; read /instruments");
      return [e.index,map[e.from],map[e.to]].join(",");
    });
    fields = [String(a.track),String(a.item),a.takeGuid,
      a.notes.map((n: any) => [n.index,n.beat??"",n.duration??"",n.pitch??"",n.velocity??"",n.channel??""].join(",")).join(";"),
      arts.join(";"),a.ramps.map((r: any) => [r.startBeat,r.endBeat,r.controller,r.startValue,r.endValue,r.steps,r.channel].join(",")).join(";")];
  }
  else if (capability === "live_insert_midi" || capability === "live_insert_performance") {
    let notes = a.notes;
    let controllers = a.controllers ?? [];
    if (capability === "live_insert_performance") {
      if (a.articulations.length) {
        const entry = (await instruments()).find(e => e.id === a.instrument);
        notes = [...notes, ...a.articulations.map((event: any) => {
          const mapping = entry?.articulations;
          const pitch = mapping && Object.hasOwn(mapping, event.name) ? mapping[event.name] : undefined;
          if (pitch === undefined) throw new ToolError("not_found", "Unknown instrument/articulation; read /instruments");
          return { beat: event.beat, duration: event.duration, pitch, velocity: 1, channel: event.channel };
        })];
      }
      controllers = [...controllers, ...a.ramps.flatMap((r: any) =>
        Array.from({ length: r.steps + 1 }, (_, i) => ({
          beat: r.startBeat + (r.endBeat - r.startBeat) * i / r.steps,
          controller: r.controller, channel: r.channel,
          value: Math.round(r.startValue + (r.endValue - r.startValue) * i / r.steps),
        })))];
      const positions = new Set<string>();
      for (const e of controllers) {
        const key = `${e.channel}:${e.controller}:${e.beat}`;
        if (positions.has(key)) throw new ToolError("invalid_input", "Conflicting controller events at the same beat");
        positions.add(key);
      }
      controllers.sort((x: any, y: any) => x.beat - y.beat);
    }
    fields = [
      String(a.track),
      a.name,
      String(a.startBeat),
      String(a.lengthBeats),
      notes
        .map((n: any) =>
          [n.beat, n.duration, n.pitch, n.velocity, n.channel].join(","),
        )
        .join(";"),
    ];
    if (capability === "live_insert_performance") fields.push(controllers.map((e: any) => [e.beat, e.controller, e.value, e.channel].join(",")).join(";"));
  }
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
  section?: z.infer<typeof sectionSchema>,
  stemTrack?: { index: number; guid: string },
) {
  const exe = await locateReaper();
  if (!exe) throw new ToolError("reaper_not_found", "REAPER is not installed");
  const folder = await mkdtemp(path.join(workspace.root, "live-render-"));
  const project = path.join(folder, "mix.rpp");
  const bounds = section ? sectionSchema.parse(section) : undefined;
  const fields = [project, folder];
  if (stemTrack) fields.push(String(stemTrack.index), stemTrack.guid);
  if (bounds) fields.push(String(bounds.startBeat), String(bounds.endBeat), String(bounds.tailSeconds));
  const snapshot = await bridge.mutate(stemTrack ? "snapshot_stem" : "snapshot", fields, false);
  if (bounds && (!Number.isFinite(snapshot.startSeconds) || !Number.isFinite(snapshot.endSeconds)))
    throw new ToolError("bridge_upgrade_required", "Section rendering requires the updated bridge; start a fresh managed session");
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
  let renderArgs = ["-renderproject", project, "-close:nosave:exit"];
  if (stemTrack) {
    await writeFile(path.join(folder, "stem-track.txt"), snapshot.stemGuid, { flag: "wx" });
    renderArgs = [project, fileURLToPath(new URL("../../bridge/render-stem.lua", import.meta.url))];
  }
  const started = Date.now();
  await runProcess(
    exe,
    [
      "-newinst",
      "-nosplash",
      "-cfgfile",
      cfg,
      ...renderArgs,
    ],
    timeout,
  );
  const output = path.join(folder, stemTrack ? "stem.wav" : "mix.wav");
  if ((await stat(output).catch(() => ({ size: 0 }))).size <= 44)
    throw new ToolError(
      "missing_output",
      "Native render did not produce a WAV",
    );
  return {
    files: [path.relative(workspace.root, output).replaceAll("\\", "/")],
    elapsedMs: Date.now() - started,
    section: bounds ?? null,
    snapshot,
  };
}
