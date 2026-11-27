// Composition layer: turns the vendored LMMS composer's output into live REAPER edit steps.
// The vendored JavaScript stays byte-identical to its source, so it is imported untyped.
import { z } from "zod";
import { ToolError } from "./errors.js";
import { TRACK_GUID } from "./live.js";
// @ts-ignore Vendored JavaScript deliberately remains byte-identical to its source.
import { composePiece, styles, styleNames, bassStyles, drumStyles, writeBass, writeDrums } from "../../vendor/lmms-mcp/tools/compose.mjs";
// @ts-ignore Vendored JavaScript deliberately remains byte-identical to its source.
import { writeMelody, writeAccompaniment, melodyStyles, accompanimentStyles } from "../../vendor/lmms-mcp/tools/melody.mjs";
// @ts-ignore Vendored JavaScript deliberately remains byte-identical to its source.
import { listPersonas, getPersona } from "../../vendor/lmms-mcp/tools/personas.mjs";

// The composer writes 4/4 with 48 ticks to the quarter note.
const TICKS_PER_BEAT = 48;
const BEATS_PER_BAR = 4;
const MAX_CLIP_NOTES = 2048;
const MAX_STEPS = 64;
// Starting track levels in dB by role. Several instruments at unity sum well above full
// scale, so a new piece starts with headroom and the lead, bass and drums in front.
const roleGainDb: Record<string, number> = { lead: -10, harmony: -15, texture: -17, bass: -10, drums: -8, fx: -16 };

const text = z.string().min(1).max(200).regex(/^[^\r\n\x00]+$/);
const midiByte = z.number().int().min(0).max(127);
const seed = z.number().int().min(0).max(2147483647).default(1);
const startBar = z.number().int().min(0).max(10000).default(0);
const track = z.union([
  z.number().int().min(0).max(255),
  z.string().regex(new RegExp(`^${TRACK_GUID}$`), "Track GUID must be {8-4-4-4-12} hexadecimal"),
]);
// General MIDI drum notes, which most drum kits follow.
const drumMap = z
  .object({ kick: midiByte.default(36), snare: midiByte.default(38), hat: midiByte.default(42), crash: midiByte.default(49) })
  .strict()
  .default({ kick: 36, snare: 38, hat: 42, crash: 49 });
const partStyles: Record<string, string[]> = {
  melody: melodyStyles,
  accompaniment: accompanimentStyles,
  bass: bassStyles,
  drums: drumStyles,
};
export const composeSchemas = {
  live_compose_piece: z
    .object({
      style: text.optional(),
      persona: text.optional(),
      key: text.optional(),
      bpm: z.number().min(20).max(300).optional(),
      bars: z.number().int().min(8).max(200).optional(),
      seconds: z.number().min(10).max(1200).optional(),
      seed,
      instruments: z
        .object({ lead: text, harmony: text, pad: text, bass: text, drums: text, fx: text })
        .partial()
        .strict()
        .default({}),
      drumMap,
      startBar,
      setTempo: z.boolean().default(true),
      regions: z.boolean().default(true),
      levels: z.boolean().default(true),
    })
    .strict()
    .refine((a) => a.bars === undefined || a.seconds === undefined, "Give bars or seconds, not both"),
  live_write_part: z
    .object({
      track,
      part: z.enum(["melody", "accompaniment", "bass", "drums"]),
      key: text.optional(),
      chords: z.array(text).min(1).max(64),
      style: text.optional(),
      seed,
      startBar,
      low: midiByte.optional(),
      high: midiByte.optional(),
      name: text.optional(),
      drumMap,
    })
    .strict()
    .superRefine((a, ctx) => {
      const fail = (message: string) => ctx.addIssue({ code: "custom", message });
      if (a.part === "melody" && !a.key) fail("A melody needs a key, for example \"D minor\"");
      if (a.low !== undefined && a.high !== undefined && a.high - a.low < 7) fail("high must be at least 7 semitones above low");
      if (a.part === "drums" && (a.low !== undefined || a.high !== undefined)) fail("Drums take drumMap, not low and high");
    }),
};
export const composeDescriptions: Record<keyof typeof composeSchemas, string> = {
  live_compose_piece:
    "Compose a complete piece and place it in the live project as one undo step: new tracks for lead, harmony, pad, bass and one drum track, with MIDI clips, starting levels and panning, a tempo marker and a region per section. Choose a style (read /styles) or a persona (read /personas); key, bpm, bars or seconds and seed are optional, and the same seed gives the same piece. Pass instruments as catalogue IDs per role (read /instruments), for example {\"lead\":\"piano\",\"bass\":\"bass\",\"drums\":\"drums\"}; a role without one gets a track with MIDI and no sound. The piece is 4/4. Tracks start at conservative levels by role so the mix has headroom; set levels to false to leave them at unity. Returns the form, chords, a melody score and structure warnings. Run live_auto_mix afterwards to set the balance and loudness by measurement. dryRun returns the plan and changes nothing.",
  live_write_part:
    "Write one part over a chord progression onto an existing track: melody, accompaniment, bass or drums. chords is one chord symbol per bar, for example [\"Dm\",\"Bb\",\"F\",\"C\"]. A melody needs key. style is optional: melody lyrical, driving or swing; accompaniment arpeggio, flowing, broken, block, held, skank or bubble; bass roots, pulse, octaves, walking, syncopated, reggae, sub or wobble; drums rock, four, halftime, ballad, onedrop, rockers, steppers, dubstep, chip or swing. low and high bound the register. The same seed gives the same part.",
};

export type Step = { capability: string; args: Record<string, unknown> };
type ComposerNote = { tick: number; length: number; midi: number; velocity: number };
type ClipNote = { beat: number; duration: number; pitch: number; velocity: number; channel: number };

// Composer errors are written for the caller (unknown chord, unknown style), so pass them through.
function composerCall<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("invalid_input", String((error as Error)?.message ?? error).slice(0, 300));
  }
}
// Splits a part into clips of at most 2048 notes, cut on bar lines.
function clips(name: string, notes: ComposerNote[], bars: number, firstBar: number, trackRef: number | string): Step[] {
  const sorted = [...notes].filter((n) => n.tick >= 0 && n.tick < bars * BEATS_PER_BAR * TICKS_PER_BEAT).sort((a, b) => a.tick - b.tick);
  const barOf = (n: ComposerNote) => Math.floor(n.tick / (BEATS_PER_BAR * TICKS_PER_BEAT));
  const out: Step[] = [];
  let from = 0;
  while (from < sorted.length) {
    let to = Math.min(sorted.length, from + MAX_CLIP_NOTES);
    if (to < sorted.length) {
      const cutBar = barOf(sorted[to]!);
      while (to > from && barOf(sorted[to - 1]!) === cutBar) to--;
      if (to === from) throw new ToolError("limit", "One bar holds more than 2048 notes");
    }
    const clipStartBar = out.length === 0 ? 0 : barOf(sorted[from]!);
    const clipEndBar = to < sorted.length ? barOf(sorted[to]!) : bars;
    const lengthBeats = (clipEndBar - clipStartBar) * BEATS_PER_BAR;
    const clipNotes: ClipNote[] = sorted.slice(from, to).map((n) => {
      const beat = n.tick / TICKS_PER_BEAT - clipStartBar * BEATS_PER_BAR;
      return {
        beat,
        duration: Math.min(Math.max(n.length, 1) / TICKS_PER_BEAT, lengthBeats - beat),
        pitch: Math.min(127, Math.max(0, Math.round(n.midi))),
        velocity: Math.min(127, Math.max(1, Math.round(n.velocity))),
        channel: 0,
      };
    });
    out.push({
      capability: "live_insert_midi",
      args: {
        track: trackRef,
        name: out.length || to < sorted.length ? `${name} ${out.length + 1}` : name,
        startBeat: (firstBar + clipStartBar) * BEATS_PER_BAR,
        lengthBeats,
        notes: clipNotes,
      },
    });
    from = to;
  }
  return out;
}
const mergeDrums = (parts: Record<string, ComposerNote[]>, map: Record<string, number>): ComposerNote[] =>
  Object.entries(map).flatMap(([part, pitch]) => (parts[part] ?? []).map((n) => ({ ...n, midi: pitch })));

export function buildPiece(a: z.infer<typeof composeSchemas.live_compose_piece>, trackCount: number) {
  if (a.style !== undefined && !Object.hasOwn(styles, a.style))
    throw new ToolError("not_found", `Unknown style; read /styles. Available: ${styleNames.join(", ")}`);
  if (a.persona !== undefined) {
    try {
      getPersona(a.persona);
    } catch {
      throw new ToolError("not_found", "Unknown persona; read /personas");
    }
  }
  const { instruments, drumMap: map, startBar: firstBar, setTempo, regions, levels, ...request } = a;
  const piece: any = composerCall(() => composePiece(request));
  const slotOf: Record<string, keyof typeof instruments> = { lead: "lead", harmony: "harmony", texture: "pad", bass: "bass", fx: "fx" };
  const parts: { name: string; role: string; slot: keyof typeof instruments; notes: ComposerNote[]; pan: number }[] = [];
  const drumParts: Record<string, ComposerNote[]> = {};
  for (const t of piece.tracks) {
    const notes: ComposerNote[] = t.patterns.flatMap((p: any) => p.notes);
    if (t.role === "drums") drumParts[String(t.name).toLowerCase()] = notes;
    else parts.push({ name: t.name, role: t.role, slot: slotOf[t.role] ?? "fx", notes, pan: Math.max(-1, Math.min(1, (Number(t.pan) || 0) / 100)) });
  }
  const drums = mergeDrums(drumParts, map);
  if (drums.length) parts.push({ name: "Drums", role: "drums", slot: "drums", notes: drums, pan: 0 });
  const steps: Step[] = [];
  if (setTempo) steps.push({ capability: "live_set_tempo", args: { beat: firstBar * BEATS_PER_BAR, bpm: piece.bpm } });
  const tracks = parts.map((part, i) => {
    const index = trackCount + i;
    if (index > 255) throw new ToolError("limit", "The project has too many tracks for another piece");
    steps.push({ capability: "live_add_track", args: { name: part.name } });
    const instrument = instruments[part.slot] ?? null;
    if (instrument) steps.push({ capability: "live_insert_instrument", args: { track: index, instrument } });
    const written = clips(part.name, part.notes, piece.lengthBars, firstBar, index);
    steps.push(...written);
    const volumeDb = levels ? roleGainDb[part.role] ?? -14 : 0;
    if (levels) {
      steps.push({ capability: "set_track", args: { track: index, field: "volume_db", value: volumeDb } });
      if (part.pan !== 0) steps.push({ capability: "set_track", args: { track: index, field: "pan", value: part.pan } });
    }
    return { name: part.name, role: part.role, index, instrument, notes: part.notes.length, clips: written.length, volumeDb, pan: levels ? part.pan : 0 };
  });
  if (regions)
    for (const section of piece.sections)
      steps.push({
        capability: "live_add_marker",
        args: {
          name: section.name,
          beat: (firstBar + section.startBar) * BEATS_PER_BAR,
          endBeat: (firstBar + section.startBar + section.bars) * BEATS_PER_BAR,
        },
      });
  if (steps.length > MAX_STEPS)
    throw new ToolError("limit", "The piece needs more than 64 edit steps; ask for fewer bars or set regions to false");
  const silent = tracks.filter((t) => !t.instrument).map((t) => t.role === "texture" ? "pad" : t.role);
  return {
    steps,
    summary: {
      style: piece.style,
      persona: piece.persona ?? null,
      key: piece.key,
      bpm: piece.bpm,
      seed: piece.seed,
      startBar: firstBar,
      lengthBars: piece.lengthBars,
      lengthSeconds: piece.lengthSeconds,
      form: piece.form,
      sections: piece.sections,
      chords: piece.chords,
      tracks,
      rolesWithoutInstrument: silent,
      melodyScore: piece.tune,
      structureWarnings: piece.structure?.warnings ?? [],
      mixTargets: piece.mix ?? null,
      personaWarnings: piece.personaWarnings ?? [],
      next: silent.length
        ? "Some tracks have no instrument and will be silent; read /instruments and insert one with live_insert_instrument, then render and analyse"
        : "Run live_auto_mix to set balance and loudness by measurement, then render and listen",
    },
  };
}

export function buildPart(a: z.infer<typeof composeSchemas.live_write_part>) {
  const allowed = partStyles[a.part]!;
  if (a.style !== undefined && !allowed.includes(a.style))
    throw new ToolError("not_found", `Unknown ${a.part} style. Available: ${allowed.join(", ")}`);
  const bars = a.chords.length;
  const options: Record<string, unknown> = { chords: a.chords, bars, seed: a.seed };
  for (const key of ["key", "style", "low", "high"] as const) if (a[key] !== undefined) options[key] = a[key];
  const written: any = composerCall(() =>
    a.part === "melody" ? writeMelody(options)
    : a.part === "accompaniment" ? writeAccompaniment(options)
    : a.part === "bass" ? writeBass(options)
    : writeDrums({ bars, seed: a.seed, ...(a.style ? { style: a.style } : {}) }),
  );
  const notes: ComposerNote[] = a.part === "drums" ? mergeDrums(written.parts, a.drumMap) : written.notes;
  if (!notes.length) throw new ToolError("invalid_input", "That request produced no notes");
  const label = a.name ?? a.part[0]!.toUpperCase() + a.part.slice(1);
  const steps = clips(label, notes, bars, a.startBar, a.track);
  const pitches = notes.map((n) => n.midi);
  return {
    steps,
    summary: {
      part: a.part,
      style: written.style ?? a.style ?? null,
      key: a.key ?? null,
      chords: a.chords,
      bars,
      startBar: a.startBar,
      startBeat: a.startBar * BEATS_PER_BAR,
      notes: notes.length,
      lowestPitch: Math.min(...pitches),
      highestPitch: Math.max(...pitches),
      clips: steps.length,
    },
  };
}

// Read-only library paths, available in both modes.
export const libraryPaths = ["/styles", "/personas", "/personas/{id}"];
export function readLibrary(objectPath: string): unknown {
  if (objectPath === "/styles")
    return styleNames.map((name: string) => ({
      name,
      about: styles[name].about,
      bpm: styles[name].bpm,
      keys: styles[name].keys,
      parts: partStyles,
    }));
  if (objectPath === "/personas")
    return listPersonas({}).map((p: any) => ({ id: p.id, name: p.name, kind: p.kind, tags: p.tags, brief: p.brief, tempo: p.tempo }));
  const id = /^\/personas\/([a-z0-9][a-z0-9-]*)$/.exec(objectPath)?.[1];
  if (id) {
    try {
      return getPersona(id);
    } catch {
      throw new ToolError("not_found", "Unknown persona; read /personas");
    }
  }
  return undefined;
}
export const isLibraryPath = (objectPath: unknown): objectPath is string =>
  typeof objectPath === "string" && /^\/(styles|personas)(\/|$)/.test(objectPath);
