import { z } from "zod";
import {
  songSchema,
  trackSchema,
  itemSchema,
  fxSchema,
  markerSchema,
  noteSchema,
  type Song,
} from "./song/model.js";
import { ToolError } from "./errors.js";

const track = z
  .number()
  .int()
  .min(0)
  .max(255)
  .describe("zero-based track index");
const item = z
  .number()
  .int()
  .min(0)
  .max(9999)
  .describe("zero-based item index");
const time = z.number().finite().min(0).max(86400).describe("seconds");
const editSchemas = {
  add_track: z.object({ track: trackSchema }).strict(),
  add_item: z.object({ track, item: itemSchema }).strict(),
  add_fx: z.object({ track, fx: fxSchema }).strict(),
  delete_track: z.object({ track }).strict(),
  delete_item: z.object({ track, item }).strict(),
  duplicate_item: z.object({ track, item, position: time }).strict(),
  move_item: z.object({ track, item, position: time }).strict(),
  add_notes: z
    .object({ track, item, notes: z.array(noteSchema).min(1).max(10000) })
    .strict(),
  transpose_notes: z
    .object({ track, item, semitones: z.number().int().min(-127).max(127) })
    .strict(),
  quantize_notes: z
    .object({
      track,
      item,
      gridTicks: z.number().int().min(1).max(96000),
      strength: z.number().min(0).max(1).default(1),
    })
    .strict(),
  add_send: z
    .object({
      track,
      to: track,
      volume_db: z.number().min(-150).max(24).default(0),
    })
    .strict(),
  add_marker: z.object({ marker: markerSchema }).strict(),
};
const descriptions: Record<keyof typeof editSchemas, string> = {
  add_track: "Append a track",
  add_item: "Append a MIDI or audio item",
  add_fx: "Append an installed JSFX reference",
  delete_track:
    "Remove a track and its incoming sends; remap remaining send indexes",
  delete_item: "Remove an item",
  duplicate_item: "Copy an item to a new position in seconds",
  move_item: "Move an item to a position in seconds",
  add_notes: "Append MIDI notes using project PPQ ticks relative to the item",
  transpose_notes:
    "Transpose all notes; reject the entire edit if a pitch leaves 0..127",
  quantize_notes:
    "Move note starts towards a PPQ tick grid; preserve durations",
  add_send: "Add an acyclic send with dB gain",
  add_marker: "Add a marker or region with a unique ID",
};
export const batchSchema = z
  .object({
    operations: z
      .array(
        z
          .object({
            capability: z.enum(
              Object.keys(editSchemas) as [
                keyof typeof editSchemas,
                ...(keyof typeof editSchemas)[],
              ],
            ),
            args: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
export const capabilities = [
  ...Object.entries(editSchemas).map(([name, schema]) => ({
    name,
    schema,
    toolset: "editing",
    description: descriptions[name as keyof typeof descriptions],
  })),
  {
    name: "batch_edit",
    toolset: "editing",
    description:
      "Apply up to 64 offline edits atomically; indexes refer to the evolving candidate",
    schema: batchSchema,
  },
];

function apply(song: Song, name: keyof typeof editSchemas, raw: unknown): void {
  // Parse first, then dispatch. No caller-provided code or arbitrary API names.
  const args = editSchemas[name].parse(raw) as Record<string, any>;
  if (name === "add_track") {
    song.tracks.push(args.track);
    return;
  }
  if (name === "add_marker") {
    song.markers.push(args.marker);
    return;
  }
  const target = song.tracks[args.track];
  if (!target) throw new ToolError("not_found", "Track not found");
  if (name === "delete_track") {
    song.tracks.splice(args.track, 1);
    for (const t of song.tracks)
      t.sends = t.sends
        .filter((s) => s.to !== args.track)
        .map((s) => ({ ...s, to: s.to > args.track ? s.to - 1 : s.to }));
    return;
  }
  if (name === "add_item") {
    target.items.push(args.item);
    return;
  }
  if (name === "add_fx") {
    target.fx.push(args.fx);
    return;
  }
  if (name === "add_send") {
    target.sends.push({ to: args.to, volume_db: args.volume_db });
    return;
  }
  const clip = target.items[args.item];
  if (!clip) throw new ToolError("not_found", "Item not found");
  if (name === "delete_item") {
    target.items.splice(args.item, 1);
    return;
  }
  if (name === "duplicate_item") {
    target.items.push({ ...structuredClone(clip), position: args.position });
    return;
  }
  if (name === "move_item") {
    clip.position = args.position;
    return;
  }
  if (clip.kind !== "midi")
    throw new ToolError("invalid_item", "This capability requires a MIDI item");
  if (name === "add_notes") clip.notes.push(...args.notes);
  if (name === "transpose_notes")
    for (const note of clip.notes) note.pitch += args.semitones;
  if (name === "quantize_notes")
    for (const note of clip.notes)
      note.tick = Math.round(
        note.tick +
          (Math.round(note.tick / args.gridTicks) * args.gridTicks -
            note.tick) *
            args.strength,
      );
  clip.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
}

export function editSong(song: Song, name: string, args: unknown): Song {
  const candidate = structuredClone(song);
  if (name === "batch_edit") {
    for (const op of batchSchema.parse(args).operations) {
      apply(candidate, op.capability, op.args);
      // Validate every operation so an invalid intermediate state cannot hide in a batch.
      songSchema.parse(candidate);
    }
  } else {
    if (!Object.hasOwn(editSchemas, name))
      throw new ToolError("not_found", "Unknown capability");
    apply(candidate, name as keyof typeof editSchemas, args);
  }
  return songSchema.parse(candidate);
}
