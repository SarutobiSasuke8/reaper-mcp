import { z } from "zod";

const number = (min: number, max: number, unit: string) =>
  z.number().finite().min(min).max(max).describe(unit);
const tick = number(0, 2_147_483_647, "ticks at project PPQ").int();
const seconds = number(0, 86400, "seconds");
export const label = z
  .string()
  .max(200)
  .refine((s) => !/[\r\n\x00]/.test(s), "Single-line text required");
export const noteSchema = z
  .object({
    tick,
    duration: tick.positive(),
    pitch: number(0, 127, "MIDI semitones").int(),
    velocity: number(1, 127, "MIDI velocity").int().default(100),
    channel: number(0, 15, "zero-based MIDI channel").int().default(0),
  })
  .strict();
export const fxSchema = z
  .object({
    kind: z.enum(["JS"]),
    name: label
      .min(1)
      .refine(
        (s) => !s.includes("..") && !/[:\\]/.test(s) && !s.startsWith("/"),
        "Use an installed JSFX name, not a filesystem path",
      ),
    enabled: z.boolean().default(true),
    params: z
      .array(number(-1e9, 1e9, "plugin native units; see plugin documentation"))
      .max(256)
      .default([]),
  })
  .strict();
const itemBase = {
  name: label.default(""),
  position: seconds,
  length: seconds.positive(),
};
export const itemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...itemBase,
      kind: z.literal("midi"),
      notes: z.array(noteSchema).max(100000),
    })
    .strict(),
  z
    .object({
      ...itemBase,
      kind: z.literal("audio"),
      file: z
        .string()
        .min(1)
        .max(4096)
        .refine((s) => !/[\r\n\x00]/.test(s)),
      offset: seconds.default(0),
    })
    .strict(),
]);
export const trackSchema = z
  .object({
    name: label.default("Track"),
    volume_db: number(-150, 24, "dB").default(0),
    pan: number(-1, 1, "normalised pan").default(0),
    mute: z.boolean().default(false),
    mainSend: z.boolean().default(true),
    items: z.array(itemSchema).max(10000).default([]),
    fx: z.array(fxSchema).max(128).default([]),
    sends: z
      .array(
        z
          .object({
            to: number(0, 255, "zero-based destination track index").int(),
            volume_db: number(-150, 24, "dB").default(0),
          })
          .strict(),
      )
      .max(256)
      .default([]),
  })
  .strict();
export const markerSchema = z
  .object({
    id: number(1, 65535, "marker ID").int(),
    name: label,
    position: seconds,
    end: seconds.optional(),
  })
  .strict();
export const songSchema = z
  .object({
    version: z.literal(1).default(1),
    name: label.default("Untitled"),
    ppq: number(24, 96000, "ticks per quarter note").int().default(960),
    tempo: number(20, 400, "BPM").default(120),
    numerator: number(1, 32, "beats per measure").int().default(4),
    denominator: z
      .union([
        z.literal(1),
        z.literal(2),
        z.literal(4),
        z.literal(8),
        z.literal(16),
      ])
      .default(4),
    tempoMap: z
      .array(
        z
          .object({
            beat: number(0, 1e7, "quarter-note beats"),
            bpm: number(20, 400, "BPM"),
            numerator: number(1, 32, "beats per measure").int().optional(),
            denominator: z
              .union([
                z.literal(1),
                z.literal(2),
                z.literal(4),
                z.literal(8),
                z.literal(16),
              ])
              .optional(),
          })
          .strict(),
      )
      .max(10000)
      .default([]),
    tracks: z.array(trackSchema).max(256).default([]),
    markers: z.array(markerSchema).max(10000).default([]),
    render: z
      .object({
        sampleRate: z
          .union([z.literal(44100), z.literal(48000), z.literal(96000)])
          .default(44100),
        channels: z.union([z.literal(1), z.literal(2)]).default(2),
        start: seconds.default(0),
        end: seconds.positive().default(4),
      })
      .strict()
      .default({ sampleRate: 44100, channels: 2, start: 0, end: 4 }),
  })
  .strict()
  .superRefine((song, ctx) => {
    if (song.render.end <= song.render.start)
      ctx.addIssue({ code: "custom", message: "Render end must follow start" });
    for (let i = 0; i < song.tempoMap.length; i++)
      if (i && song.tempoMap[i]!.beat <= song.tempoMap[i - 1]!.beat)
        ctx.addIssue({
          code: "custom",
          message: "Tempo points must be strictly increasing",
        });
    if (new Set(song.markers.map((m) => m.id)).size !== song.markers.length)
      ctx.addIssue({ code: "custom", message: "Marker IDs must be unique" });
    for (const m of song.markers)
      if (m.end !== undefined && m.end <= m.position)
        ctx.addIssue({
          code: "custom",
          message: "Region end must follow start",
        });
    song.tracks.forEach((t, i) =>
      t.sends.forEach((s) => {
        if (s.to >= song.tracks.length || s.to === i)
          ctx.addIssue({ code: "custom", message: "Invalid send destination" });
      }),
    );
    const visiting = new Set<number>();
    const done = new Set<number>();
    const visit = (i: number): boolean => {
      if (visiting.has(i)) return false;
      if (done.has(i)) return true;
      visiting.add(i);
      for (const s of song.tracks[i]?.sends ?? [])
        if (!visit(s.to)) return false;
      visiting.delete(i);
      done.add(i);
      return true;
    };
    if (song.tracks.some((_, i) => !visit(i)))
      ctx.addIssue({
        code: "custom",
        message: "Feedback routing is not supported",
      });
  });
export type Song = z.infer<typeof songSchema>;
export type Track = z.infer<typeof trackSchema>;
export const songJsonSchema = z.toJSONSchema(songSchema);
export function beatToSeconds(song: Song, beat: number): number {
  let result = 0,
    previous = 0,
    bpm = song.tempo;
  for (const point of song.tempoMap) {
    if (point.beat > beat) break;
    result += ((point.beat - previous) * 60) / bpm;
    previous = point.beat;
    bpm = point.bpm;
  }
  return result + ((beat - previous) * 60) / bpm;
}
export function secondsToBeat(song: Song, seconds: number): number {
  let elapsed = 0,
    previous = 0,
    bpm = song.tempo;
  for (const point of song.tempoMap) {
    const segment = ((point.beat - previous) * 60) / bpm;
    if (elapsed + segment > seconds) break;
    elapsed += segment;
    previous = point.beat;
    bpm = point.bpm;
  }
  return previous + ((seconds - elapsed) * bpm) / 60;
}
