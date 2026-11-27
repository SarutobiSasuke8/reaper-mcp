import { z } from "zod";
import { readFile, realpath, stat, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError } from "./errors.js";
import { Workspace } from "./workspace.js";
import { LiveBridge, TRACK_GUID } from "./live.js";
import { composeSchemas, composeDescriptions, buildPiece, buildPart, type Step } from "./compose.js";
import { isolatedIni, locateReaper, runProcess } from "./render.js";

const text = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\r\n\x00]+$/);
// A zero-based index, or the track GUID in braces, which survives reordering.
const track = z.union([
  z.number().int().min(0).max(255),
  z.string().regex(new RegExp(`^${TRACK_GUID}$`), "Track GUID must be {8-4-4-4-12} hexadecimal"),
]);
const MAX_EVENTS = 2048;
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
  notes: z.array(note).max(MAX_EVENTS).default([]),
  controllers: z.array(controller).max(MAX_EVENTS).default([]),
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
  if (count < 1 || count > MAX_EVENTS) fail(`Performance must contain 1-${MAX_EVENTS} expanded events`);
});
const editIndex = z.number().int().min(0).max(9999);
const editPerformance = z.object({
  track, item: editIndex, takeGuid: text,
  notes: z.array(z.object({index: editIndex, beat: beat.optional(),
    duration: z.number().finite().positive().max(10000).optional(),
    pitch: midiByte.optional(), velocity: z.number().int().min(1).max(127).optional(),
    channel: z.number().int().min(0).max(15).optional(),
  }).strict()).max(MAX_EVENTS).default([]),
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
  if (count < 1 || count > MAX_EVENTS) fail(`Edits must contain 1-${MAX_EVENTS} expanded events`);
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
      notes: z.array(note).min(1).max(MAX_EVENTS),
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
const batchSchema = z.object({
  steps: z.array(z.object({
    capability: z.string().min(1).max(100),
    args: z.unknown(),
  }).strict()).min(1).max(64),
}).strict();
const itemRef = { track, item: editIndex, itemGuid: text };
const markerRef = { id: z.number().int().min(0).max(2147483647), isRegion: z.boolean().default(false) };
// Arrangement capabilities: transport, markers and regions, tempo map, items and track removal.
export const arrangeSchemas = {
  live_transport: z.object({
    command: z.enum(["play", "stop", "pause", "seek", "set_loop"]),
    beat: beat.optional(),
    enabled: z.boolean().optional(),
    startBeat: beat.optional(),
    endBeat: beat.optional(),
  }).strict().superRefine((a, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const loopFields = a.enabled !== undefined || a.startBeat !== undefined || a.endBeat !== undefined;
    if (a.command === "seek" ? a.beat === undefined : a.beat !== undefined) fail("beat is required for seek and not allowed otherwise");
    if (a.command !== "set_loop" && loopFields) fail("Loop fields are only allowed with set_loop");
    if (a.command === "set_loop") {
      if ((a.startBeat === undefined) !== (a.endBeat === undefined)) fail("Give both startBeat and endBeat");
      if (a.startBeat !== undefined && a.endBeat !== undefined && a.endBeat <= a.startBeat) fail("Loop must move forward");
      if (!loopFields) fail("Nothing to change");
    }
  }),
  live_add_marker: z.object({ name: text.optional(), beat, endBeat: beat.optional() }).strict()
    .refine(a => a.endBeat === undefined || a.endBeat > a.beat, "Region must move forward"),
  live_edit_marker: z.object({ ...markerRef, name: text.optional(), beat: beat.optional(), endBeat: beat.optional() }).strict()
    .refine(a => a.name !== undefined || a.beat !== undefined || a.endBeat !== undefined, "Nothing to change")
    .refine(a => a.isRegion || a.endBeat === undefined, "A marker has no end; use a region"),
  live_delete_marker: z.object(markerRef).strict(),
  live_set_tempo: z.object({
    beat: beat.default(0),
    bpm: z.number().min(20).max(300),
    timeSignature: z.object({
      numerator: z.number().int().min(1).max(64),
      denominator: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32), z.literal(64)]),
    }).strict().optional(),
    linear: z.boolean().optional(),
  }).strict(),
  live_delete_tempo_marker: z.object({ index: editIndex, bpm: z.number().min(1).max(1000) }).strict(),
  live_insert_audio: z.object({
    track, file: z.string().min(1).max(4096).regex(/\.(wav|flac|mp3|ogg|aiff?)$/i, "Supported audio: wav, flac, mp3, ogg, aiff"),
    startBeat: beat, name: text.optional(),
  }).strict(),
  live_edit_item: z.object({
    ...itemRef,
    startBeat: beat.optional(),
    lengthBeats: z.number().finite().positive().max(100000).optional(),
    mute: z.boolean().optional(),
    gainDb: z.number().min(-150).max(24).optional(),
    fadeInSeconds: z.number().min(0).max(3600).optional(),
    fadeOutSeconds: z.number().min(0).max(3600).optional(),
    name: text.optional(),
    toTrack: track.optional(),
  }).strict().refine(a => Object.keys(a).length > 3, "Nothing to change"),
  live_split_item: z.object({ ...itemRef, beat }).strict(),
  live_delete_item: z.object(itemRef).strict(),
  live_delete_track: z.object({ track, trackGuid: text }).strict(),
};
const arrangeDescriptions: Record<keyof typeof arrangeSchemas, string> = {
  live_transport: "Control playback: play, stop, pause, seek (beat) or set_loop (enabled and/or startBeat with endBeat). Read /project/transport for state. Not a project edit: no undo step and not allowed in live_batch. Refused while REAPER is recording; recording is not controlled by this server.",
  live_add_marker: "Add a marker at beat, or a region when endBeat is given. Returns its id. Read /markers to list them.",
  live_edit_marker: "Rename or move a marker or region found by id and isRegion from /markers. Omitted fields are kept.",
  live_delete_marker: "Delete a marker or region by id and isRegion from /markers.",
  live_set_tempo: "Set the tempo from a beat onward (default beat 0), optionally with a time signature. Replaces a tempo marker already at that beat, otherwise adds one. linear ramps to the next marker. Read /project/tempo_map first; item positions follow each item's timebase.",
  live_delete_tempo_marker: "Delete one tempo marker by its index from /project/tempo_map. Supply its current bpm as an identity check.",
  live_insert_audio: "Place a workspace audio file (wav, flac, mp3, ogg, aiff) on a track at startBeat as a new item at its full length.",
  live_edit_item: "Edit one MIDI or audio item: startBeat, lengthBeats, mute, gainDb, fades, name, or toTrack to move it. Read /tracks/{track}/items for index and GUID. Item indexes follow timeline order, so list the items again after moving or splitting.",
  live_split_item: "Split one item at a project beat inside it. Returns both halves.",
  live_delete_item: "Delete one item, guarded by its GUID.",
  live_delete_track: "Delete a track with its items, FX and sends. Supply trackGuid from /tracks as an identity check. One undo step restores it.",
};
const baseCapabilities = Object.entries({...musicSchemas, live_batch: batchSchema}).map(
  ([name, schema]) => ({
    name,
    schema,
    toolset: "editing",
    modes: ["live"],
    description:
      name === "live_batch"
        ? "Run 1-64 live edit capabilities as one transaction and one native undo step. Each step is {capability, args} using that capability's own schema. If any step fails, the earlier steps are undone and the project is left as read. A new track takes the next free index, so later steps can address it. dryRun validates every step against the current project only, so a step that depends on an earlier one reports an error there. Not allowed: live_batch, live_revert_fx_edit, live_transport, live_compose_piece, live_write_part (the last two are already one undo step)."
        : name === "live_edit_fx_envelope_point"
        ? "Adjust one existing interior FX automation point. Read the parameter's /envelope first. Preserves its time and adjacent anchors; supports linear/square segments on unscaled 0-1 controls."
        : name === "live_add_send"
        ? "Create a post-fader stereo audio send to destination channels 1/2 or sidechain 3/4. Read track GUIDs first. MIDI is disabled."
        : name === "live_revert_fx_edit"
        ? "Undo the most recent guarded FX edit using its returned undoToken while the project is still at that revision."
        : name === "live_set_fx_parameter"
        ? "Set one track FX parameter. Read /tracks/{track}/fx for its GUID and /tracks/{track}/fx/{fx}/parameters for controls. Supply normalized 0-1. Returns native readback."
        : name === "live_edit_performance"
        ? "Edit indexed notes and catalogue keyswitches in an existing MIDI take. Read notes and item metadata first. Beats are clip-relative. Ramps replace matching CC/channel events within inclusive ranges. Rejects looped, pooled or external MIDI; maximum 2048 expanded edits. Re-read indices after every edit."
        : name === "live_insert_performance"
        ? "Insert notes, CC events, sampled linear dynamics ramps and catalogue-named keyswitch articulations in one clip; offsets are clip-relative quarter-note beats, maximum 2048 expanded events. Place keyswitches before musical notes."
        : name === "live_add_track"
        ? "Append a named native track"
        : name === "live_insert_instrument"
          ? "Insert a configured library instrument and its optional VST3 preset"
          : "Insert a MIDI clip; project start and clip-relative note offsets are quarter-note beats, channels 0-15; at most 2048 notes per clip",
  }),
);
export const musicCapabilities = [
  ...baseCapabilities,
  ...Object.entries(arrangeSchemas).map(([name, schema]) => ({
    name,
    schema: schema as z.ZodType,
    toolset: "editing",
    modes: ["live"],
    description: arrangeDescriptions[name as keyof typeof arrangeSchemas],
  })),
];
const liveSchemas: Record<string, z.ZodType> = { ...musicSchemas, ...arrangeSchemas };
musicCapabilities.push(
  ...Object.entries(composeSchemas).map(([name, schema]) => ({
    name,
    schema: schema as z.ZodType,
    toolset: "editing",
    modes: ["live"],
    description: composeDescriptions[name as keyof typeof composeSchemas],
  })),
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
// Validates one capability call and resolves catalogue names into the bridge's named arguments.
async function prepare(
  capability: string,
  raw: unknown,
  workspace?: Workspace,
): Promise<Record<string, unknown>> {
  const schema = Object.hasOwn(liveSchemas, capability) ? liveSchemas[capability] : undefined;
  if (!schema)
    throw new ToolError(
      "unsupported_live",
      "Unknown live music capability; describe available capabilities",
    );
  const a: any = schema.parse(raw);
  if (capability === "live_insert_audio") {
    if (!workspace) throw new ToolError("invalid_path", "Audio import requires a workspace");
    // The bridge receives an absolute path that has already been confined to the workspace.
    return { ...a, file: await workspace.resolve(a.file) };
  }
  if (capability === "live_edit_performance") {
    const entry = a.articulations.length ? (await instruments()).find(e => e.id === a.instrument) : undefined;
    const articulations = a.articulations.map((e: any) => {
      const map = entry?.articulations;
      if (!map || !Object.hasOwn(map,e.from) || !Object.hasOwn(map,e.to))
        throw new ToolError("not_found", "Unknown instrument/articulation; read /instruments");
      return { index: e.index, from: map[e.from], to: map[e.to] };
    });
    return { track: a.track, item: a.item, takeGuid: a.takeGuid, notes: a.notes, articulations, ramps: a.ramps };
  }
  if (capability === "live_insert_midi" || capability === "live_insert_performance") {
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
    const clip = { track: a.track, name: a.name, startBeat: a.startBeat, lengthBeats: a.lengthBeats, notes };
    return capability === "live_insert_performance" ? { ...clip, controllers } : clip;
  }
  if (capability === "live_insert_instrument") {
    const entry = (await instruments()).find((e) => e.id === a.instrument);
    if (!entry)
      throw new ToolError(
        "not_found",
        "Instrument ID not found; read /instruments",
      );
    let preset: string | undefined;
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
    return { track: a.track, plugin: entry.plugin, preset };
  }
  // The remaining schemas already use the bridge's argument names.
  return a;
}
export async function runMusic(
  bridge: LiveBridge,
  capability: string,
  raw: unknown,
  dry: boolean,
  workspace?: Workspace,
) {
  if (capability === "live_compose_piece" || capability === "live_write_part") {
    let built: { steps: Step[]; summary: Record<string, unknown> };
    if (capability === "live_compose_piece") {
      const args = composeSchemas.live_compose_piece.parse(raw);
      // New tracks are appended, so their indexes follow from the current track count.
      const tracks = await bridge.get("/tracks");
      built = buildPiece(args, Array.isArray(tracks) ? tracks.length : 0);
    } else {
      built = buildPart(composeSchemas.live_write_part.parse(raw));
      await bridge.get("/project");
    }
    // Resolving every step first means an unknown instrument fails before anything is written.
    const prepared = [];
    for (const step of built.steps)
      // set_track is the bridge action behind reaper_set; its arguments need no resolving.
      prepared.push({ action: step.capability, args: step.capability === "set_track" ? step.args : await prepare(step.capability, step.args, workspace) });
    if (dry) return { dryRun: true, ...built.summary, editSteps: prepared.length };
    const applied = await bridge.batch(prepared, false);
    return { dryRun: false, ...built.summary, editSteps: prepared.length, undoLabel: applied.undoLabel, project: applied.project, revision: applied.revision };
  }
  if (capability === "live_batch") {
    const { steps } = batchSchema.parse(raw);
    const prepared = [];
    for (const [i, step] of steps.entries()) {
      if (["live_batch", "live_revert_fx_edit", "live_transport", "live_compose_piece", "live_write_part", "live_auto_mix"].includes(step.capability))
        throw new ToolError("invalid_input", `Step ${i + 1}: ${step.capability} cannot run in a batch`);
      try {
        prepared.push({ action: step.capability, args: await prepare(step.capability, step.args, workspace) });
      } catch (error) {
        if (error instanceof ToolError) throw new ToolError(error.code, `Step ${i + 1} (${step.capability}): ${error.message}`);
        if (error instanceof z.ZodError)
          throw new ToolError("invalid_input", `Step ${i + 1} (${step.capability}) does not match its schema; describe the capability`);
        throw error;
      }
    }
    return bridge.batch(prepared, dry);
  }
  return bridge.mutate(capability, await prepare(capability, raw, workspace), dry);
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
    return bridge.mutate("project_new", { tempo: a.tempo }, false);
  }
  if (song !== undefined || !file || !/\.rpp$/i.test(file))
    throw new ToolError(
      "invalid_input",
      "Live open/save requires a workspace-relative .rpp filename",
    );
  if (operation === "open")
    return bridge.mutate(
      "project_open",
      { file: await workspace.resolve(file) },
      false,
    );
  // Exclusive reservation prevents overwriting an existing project. Failed reservations remain reviewable.
  await workspace.writeNew(file, "");
  const output = await workspace.resolve(file);
  const result = await bridge.mutate("project_save", { file: output }, false);
  if ((await stat(output)).size === 0)
    throw new ToolError(
      "save_failed",
      "REAPER did not write the reserved project file",
    );
  return result;
}
export type RenderJob = { folder: string; project: string; snapshot: any; bounds?: z.infer<typeof sectionSchema>; stem: boolean };
// Stage 1: a render-ready copy of the live project. This goes through the bridge, so callers run it one at a time.
export async function snapshotRender(
  bridge: LiveBridge,
  workspace: Workspace,
  section?: z.infer<typeof sectionSchema>,
  stemTrack?: { index: number; guid: string },
): Promise<RenderJob> {
  const folder = await mkdtemp(path.join(workspace.root, "live-render-"));
  const project = path.join(folder, "mix.rpp");
  const bounds = section ? sectionSchema.parse(section) : undefined;
  const snapshot = await bridge.mutate(
    "snapshot",
    { file: project, folder, stemTrack: stemTrack?.index, stemGuid: stemTrack?.guid, section: bounds },
    false,
  );
  if (bounds && (!Number.isFinite(snapshot.startSeconds) || !Number.isFinite(snapshot.endSeconds)))
    throw new ToolError("bridge_upgrade_required", "Section rendering requires the updated bridge; start a fresh managed session");
  return { folder, project, snapshot, bounds, stem: !!stemTrack };
}
// Stage 2: render one snapshot in its own isolated REAPER process. Jobs are independent and may run side by side.
export async function runRenderJob(job: RenderJob, workspace: Workspace, timeout: number) {
  const exe = await locateReaper();
  if (!exe) throw new ToolError("reaper_not_found", "REAPER is not installed");
  const { folder, project, snapshot, bounds } = job;
  const stemTrack = job.stem;
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
export async function renderLive(
  bridge: LiveBridge,
  workspace: Workspace,
  timeout: number,
  section?: z.infer<typeof sectionSchema>,
  stemTrack?: { index: number; guid: string },
) {
  if (!(await locateReaper())) throw new ToolError("reaper_not_found", "REAPER is not installed");
  return runRenderJob(await snapshotRender(bridge, workspace, section, stemTrack), workspace, timeout);
}
