// Groove for live MIDI: swing and humanise an existing clip at REAPER's full timing resolution.
// The swing templates and their amounts come from the LMMS MCP groove engine, which works on a
// 48-tick grid; they are re-stated here in beats so a clip is not snapped to that grid.
import { z } from "zod";
import { ToolError } from "./errors.js";
import { LiveBridge, TRACK_GUID } from "./live.js";

// Delay of each off-beat step, as a fraction of the step.
export const swingTemplates: Record<string, number> = {
  straight: 0,
  "house-shuffle": 0.12,
  "mpc-swing-60": 0.15,
  "ukg-shuffle": 0.2,
  "mpc-swing-70": 0.25,
  triplet: 1 / 3,
};
const stepBeats = { "16th": 0.25, "8th": 0.5 } as const;
const MAX_NOTES = 2048;
const text = z.string().min(1).max(200).regex(/^[^\r\n\x00]+$/);
const track = z.union([
  z.number().int().min(0).max(255),
  z.string().regex(new RegExp(`^${TRACK_GUID}$`), "Track GUID must be {8-4-4-4-12} hexadecimal"),
]);
export const grooveCapability = {
  name: "live_apply_groove",
  toolset: "editing",
  modes: ["live"],
  description:
    "Give an existing MIDI clip a feel, as one undo step: swing, humanise, or both. Swing delays every off-beat step: pass template (house-shuffle, mpc-swing-60, ukg-shuffle, mpc-swing-70, triplet) or swing as a fraction of the step from 0 to 0.5, on a 16th or 8th grid (use 8th with triplet for jazz swing). strength scales it. humanize adds small random timing (timingMs) and velocity (velocity) changes, repeatable from seed; tight halves it for kicks, snares and bass. pitches limits the edit to those MIDI notes, for example only the hats. Read the item first for its takeGuid. Notes keep their length and stay inside the clip. Swing only moves notes that sit on the grid, so applying it twice does not double it. dryRun reports what would move.",
  schema: z
    .object({
      track,
      item: z.number().int().min(0).max(9999),
      takeGuid: text,
      template: z.enum(Object.keys(swingTemplates) as [string, ...string[]]).optional(),
      swing: z.number().min(0).max(0.5).optional(),
      grid: z.enum(["16th", "8th"]).default("16th"),
      strength: z.number().min(0).max(1).default(1),
      humanize: z
        .object({
          timingMs: z.number().min(0).max(50).default(8),
          velocity: z.number().min(0).max(40).default(10),
          seed: z.number().int().min(0).max(2147483647).default(1),
          tight: z.boolean().default(false),
        })
        .strict()
        .optional(),
      pitches: z.array(z.number().int().min(0).max(127)).min(1).max(128).optional(),
    })
    .strict()
    .superRefine((a, ctx) => {
      if (a.template !== undefined && a.swing !== undefined) ctx.addIssue({ code: "custom", message: "Give template or swing, not both" });
      if (a.template === undefined && a.swing === undefined && a.humanize === undefined) ctx.addIssue({ code: "custom", message: "Give a template, a swing amount or humanize" });
    }),
};
type Args = z.infer<typeof grooveCapability.schema>;
export type ClipNote = { index: number; beat: number; duration: number; pitch: number; velocity: number };
export type GrooveOptions = Pick<Args, "template" | "swing" | "grid" | "strength" | "humanize" | "pitches">;

function generator(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
// Pure step: the note edits a groove needs. Beats are clip-relative. Exported for unit tests.
export function grooveEdits(notes: ClipNote[], lengthBeats: number, bpm: number, o: GrooveOptions) {
  const amount = (o.template !== undefined ? swingTemplates[o.template]! : o.swing ?? 0) * (o.strength ?? 1);
  const step = stepBeats[o.grid ?? "16th"];
  const tolerance = step * 0.08;
  const random = o.humanize ? generator(o.humanize.seed) : null;
  const scale = o.humanize?.tight ? 0.5 : 1;
  const only = o.pitches ? new Set(o.pitches) : null;
  const edits: { index: number; beat?: number; velocity?: number }[] = [];
  let swung = 0;
  let largestShiftBeats = 0;
  // Walk in a fixed order so the random sequence, and so the result, is the same every time.
  for (const note of [...notes].sort((a, b) => a.index - b.index)) {
    if (only && !only.has(note.pitch)) continue;
    let beat = note.beat;
    if (amount > 0) {
      // Off-beat steps are the odd ones: the second 16th of each 8th, or the second 8th of each beat.
      const position = note.beat / step;
      const nearest = Math.round(position);
      if (Math.abs(position - nearest) * step <= tolerance && nearest % 2 === 1) {
        beat += amount * step;
        swung++;
      }
    }
    let velocity = note.velocity;
    if (random && o.humanize) {
      beat += (((random() - 0.5) * 2 * o.humanize.timingMs * scale) / 1000) * (bpm / 60);
      velocity = Math.round(Math.max(1, Math.min(127, note.velocity + (random() - 0.5) * 2 * o.humanize.velocity * scale)));
    }
    // A note keeps its length, so it can move only as far as the clip allows.
    beat = Math.max(0, Math.min(beat, lengthBeats - note.duration));
    const edit: { index: number; beat?: number; velocity?: number } = { index: note.index };
    if (Math.abs(beat - note.beat) > 1e-7) {
      edit.beat = beat;
      largestShiftBeats = Math.max(largestShiftBeats, Math.abs(beat - note.beat));
    }
    if (velocity !== note.velocity) edit.velocity = velocity;
    if (edit.beat !== undefined || edit.velocity !== undefined) edits.push(edit);
  }
  return { edits, swung, largestShiftBeats };
}
export async function applyGroove(bridge: LiveBridge, a: Args, dryRun: boolean) {
  const trackToken = typeof a.track === "number" ? String(a.track) : a.track;
  const itemPath = `/tracks/${trackToken}/items/${a.item}`;
  const item = (await bridge.get(itemPath)) as { takeGuid: string; isMidi: boolean; startBeat: number; lengthBeats: number };
  if (!item.isMidi) throw new ToolError("invalid_input", "Groove applies to MIDI items");
  if (item.takeGuid !== a.takeGuid) throw new ToolError("live_rejected", "MIDI take identity mismatch; read the item again");
  const bpm = Number(await bridge.get("/project/tempo")) || 120;
  const read = (await bridge.get(`${itemPath}/notes`)) as { index: number; startBeat: number; endBeat: number; pitch: number; velocity: number }[];
  if (read.length > MAX_NOTES) throw new ToolError("limit", `The clip has more than ${MAX_NOTES} notes; split it first`);
  const notes: ClipNote[] = read.map((n) => ({ index: n.index, beat: n.startBeat - item.startBeat, duration: n.endBeat - n.startBeat, pitch: n.pitch, velocity: n.velocity }));
  const planned = grooveEdits(notes, item.lengthBeats, bpm, a);
  const summary = {
    notes: notes.length,
    changed: planned.edits.length,
    swung: planned.swung,
    largestShiftMs: Number(((planned.largestShiftBeats * 60000) / bpm).toFixed(1)),
    template: a.template ?? null,
    swing: a.template !== undefined ? swingTemplates[a.template]! : a.swing ?? 0,
    grid: a.grid,
  };
  if (!planned.edits.length) return { dryRun, ...summary, note: "Nothing to change: no notes sit on the off-beat steps of this grid" };
  if (dryRun) return { dryRun: true, ...summary };
  const applied = await bridge.mutate("live_edit_performance", { track: a.track, item: a.item, takeGuid: a.takeGuid, notes: planned.edits, articulations: [], ramps: [] }, false);
  return { dryRun: false, ...summary, project: applied.project, revision: applied.revision };
}
