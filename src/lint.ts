// Arrangement lint for a live session: reads every MIDI track and runs the vendored LMMS
// arranger checks (clashing notes, competing melodies, register overlap, key, density, motif).
import { z } from "zod";
import { ToolError } from "./errors.js";
import { LiveBridge } from "./live.js";
// @ts-ignore Vendored JavaScript deliberately remains byte-identical to its source.
import { lintModel, qualityScore } from "../../vendor/lmms-mcp/tools/arranger-lint.mjs";
// @ts-ignore Vendored JavaScript deliberately remains byte-identical to its source.
import { guessRole } from "../../vendor/lmms-mcp/tools/balance.mjs";

const TICKS_PER_BEAT = 48;
const BEATS_PER_BAR = 4;
const MAX_TRACKS = 64;
const MAX_FINDINGS = 60;
const roleNames = ["lead", "counter", "harmony", "pad", "texture", "bass", "drums", "fx"] as const;
export const lintCapability = {
  name: "live_lint_arrangement",
  toolset: "editing",
  modes: ["live"],
  description:
    "Check the live arrangement's notes for musical problems and return findings with a fix for each. Reads every unmuted MIDI track and reports harsh clashes between parts on strong beats, two melodies competing, parts masking the lead's register, notes outside the key, bars that are too busy or empty, and a lead with no recurring idea. Changes nothing. Roles are guessed from track names and from the notes; pass roles as {\"<track index>\": role} to correct them, and key (for example \"D minor\") to check against the key you intend. Findings are error, warning or note; pass is false when there is an error, or a warning with strict. Assumes 4/4.",
  schema: z
    .object({
      key: z.string().min(1).max(40).regex(/^[^\r\n\x00]+$/).optional(),
      roles: z.record(z.string().regex(/^(0|[1-9][0-9]{0,2})$/), z.enum(roleNames)).default({}),
      tracks: z.array(z.number().int().min(0).max(255)).min(1).max(MAX_TRACKS).optional(),
      strict: z.boolean().default(false),
    })
    .strict(),
};
type Args = z.infer<typeof lintCapability.schema>;
type TrackView = { name: string; mute: boolean; itemCount: number };
export type LiveNote = { startBeat: number; endBeat: number; pitch: number; velocity: number };
export type LintTrack = { index: number; name: string; declared?: string; notes: LiveNote[] };

// Pure step: build the lint model from live notes and run the checks. Exported for unit tests.
export function lintTracks(tracks: LintTrack[], options: { key?: string; strict?: boolean } = {}) {
  let lastBeat = 0;
  const model = {
    ticksPerBar: TICKS_PER_BEAT * BEATS_PER_BAR,
    meter: { numerator: 4, denominator: 4 },
    bars: 1,
    tracks: tracks.map((t) => {
      // A role given by the caller, or read from the track name, counts as declared; otherwise the lint infers it from the notes.
      const named = t.declared === "pad" ? "texture" : t.declared ?? (guessRole({ name: t.name }).source === "guess from name" ? guessRole({ name: t.name }).role : undefined);
      for (const n of t.notes) lastBeat = Math.max(lastBeat, n.endBeat);
      return {
        name: t.name,
        role: named,
        kind: named === "drums" ? "sample" : "synth",
        notes: t.notes.map((n) => ({
          tick: Math.max(0, Math.round(n.startBeat * TICKS_PER_BEAT)),
          length: Math.max(1, Math.round((n.endBeat - n.startBeat) * TICKS_PER_BEAT)),
          midi: n.pitch,
          velocity: n.velocity,
        })),
      };
    }),
  };
  model.bars = Math.max(1, Math.ceil(lastBeat / BEATS_PER_BAR - 1e-9));
  let lint: any;
  try {
    lint = lintModel(model, { key: options.key, strict: options.strict ?? false });
  } catch (error) {
    throw new ToolError("invalid_input", String((error as Error)?.message ?? error).slice(0, 300));
  }
  const indexOf = new Map(tracks.map((t) => [t.name, t.index]));
  const findings = (lint.findings as any[]).map((f) => ({
    severity: f.severity as string,
    rule: f.rule as string,
    message: f.message as string,
    bars: f.bars as number[],
    tracks: (f.tracks as string[]).map((name) => ({ name, index: indexOf.get(name) ?? null })),
    // The source wording names an LMMS tool; say how to do the same thing here.
    fix: f.rule === "role.missing"
      ? `Pass roles {"${indexOf.get(f.tracks[0]) ?? "<track index>"}": "<role>"} to live_lint_arrangement, or name the track after its role`
      : (f.fix as string),
  }));
  return {
    pass: lint.pass as boolean,
    strict: lint.strict as boolean,
    counts: lint.counts as { error: number; warning: number; note: number },
    score: qualityScore(lint).score as number,
    key: lint.key,
    bars: lint.bars as number,
    roles: (lint.roles as any[]).map((r, i) => ({
      index: tracks[i]!.index,
      track: r.track as string,
      role: r.role === "texture" ? "pad" : (r.role as string),
      source: tracks[i]!.declared ? "given" : r.inferred ? "inferred from notes" : "track name",
    })),
    melodicVoicesPerBar: lint.melodicVoicesPerBar as number[],
    motif: lint.motif,
    findings: findings.slice(0, MAX_FINDINGS),
    findingsOmitted: Math.max(0, findings.length - MAX_FINDINGS),
  };
}
export async function lintArrangement(bridge: LiveBridge, a: Args) {
  const all = (await bridge.get("/tracks")) as TrackView[];
  for (const i of a.tracks ?? []) if (!all[i]) throw new ToolError("not_found", `Track ${i} not found; read /tracks`);
  for (const key of Object.keys(a.roles)) if (!all[Number(key)]) throw new ToolError("not_found", `roles names track ${key}, which does not exist`);
  const picked = (a.tracks ?? all.map((_, i) => i)).filter((i) => !all[i]!.mute && all[i]!.itemCount > 0);
  if (picked.length > MAX_TRACKS) throw new ToolError("limit", `The lint reads up to ${MAX_TRACKS} tracks; pass tracks to choose which`);
  const tracks: LintTrack[] = [];
  for (const i of picked) {
    const notes = (await bridge.get(`/tracks/${i}/notes`)) as LiveNote[];
    if (notes.length) tracks.push({ index: i, name: all[i]!.name, declared: a.roles[String(i)], notes });
  }
  if (!tracks.length) throw new ToolError("invalid_state", "No unmuted MIDI notes to check; audio items are not linted");
  return lintTracks(tracks, { key: a.key, strict: a.strict });
}
