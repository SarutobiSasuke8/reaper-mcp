// Auto-mix: render each track's stem, set track levels from role targets, then trim the
// whole mix to a loudness target under a true-peak ceiling, and verify with a fresh render.
// The decisions are the vendored LMMS balance planner's; this file feeds it REAPER stems.
import { z } from "zod";
import { ToolError } from "./errors.js";
import { LiveBridge } from "./live.js";
import { Workspace } from "./workspace.js";
import { sectionSchema, snapshotRender, runRenderJob } from "./music.js";
// @ts-ignore Vendored JavaScript deliberately remains byte-identical to its source.
import { guessRole, targetFor, planBalance, blockStats, windowLevels, loudestWindow, sumStems, defaultTargets } from "../../vendor/lmms-mcp/tools/balance.mjs";
// @ts-ignore Vendored JavaScript deliberately remains byte-identical to its source.
import { decodeWav, loudness, truePeak, slice, db, analyze } from "../../vendor/lmms-mcp/audio.mjs";

const MAX_TRACKS = 12;
const MAX_FADER_DB = 12;
const WINDOW_BARS = 8;
const roleNames = ["lead", "counter", "harmony", "pad", "texture", "bass", "drums", "fx"] as const;
export const autoMixCapability = {
  name: "live_auto_mix",
  toolset: "editing",
  modes: ["live"],
  description:
    "Balance and level the live mix by measurement, as one undo step. Renders a stem per unmuted track, sets each track's volume from a target for its role (lead, bass and drums in front; harmony and pads behind), then moves all tracks together to reach targetLufs without the true peak passing ceilingDb, and renders the mix again to confirm. Roles are guessed from track names (Lead, Bass, Drums, Pad, Keys and similar); pass roles as {\"<track index>\": role} to correct a guess. balance false keeps the current balance and only sets overall loudness. No limiter is added, so a peaky mix may stop short of the loudness target and the result says so. dryRun measures and returns the plan without changing levels. Each stem is a separate render, so allow about a minute per track.",
  schema: z
    .object({
      targetLufs: z.number().min(-40).max(-6).default(-16),
      ceilingDb: z.number().min(-12).max(0).default(-1),
      roles: z.record(z.string().regex(/^(0|[1-9][0-9]{0,2})$/), z.enum(roleNames)).default({}),
      tracks: z.array(z.number().int().min(0).max(255)).min(1).max(MAX_TRACKS).optional(),
      balance: z.boolean().default(true),
      section: sectionSchema.optional(),
      verify: z.boolean().default(true),
      timeoutMs: z.number().int().min(10000).max(600000).describe("milliseconds for each render").default(240000),
    })
    .strict(),
};
type Args = z.infer<typeof autoMixCapability.schema>;
type TrackView = { name: string; guid: string; volume_db: number; mute: boolean; solo?: boolean; itemCount: number };
export type StemFacts = {
  index: number;
  name: string;
  volumeDb: number;
  declared?: string;
  // Levels over the loudest window, in dBFS; null when the stem is silent there.
  peakDbfs: number | null;
  activeRmsDbfs: number | null;
  soundingShare: number;
  crestDb?: number;
};
const round = (value: number, places = 2) => Number(value.toFixed(places));

// Pure planning step: role, target and new level for each stem. Exported for unit tests.
export function planLevels(stems: StemFacts[], balance: boolean) {
  const rows = stems.map((stem) => {
    const guess = guessRole({
      name: stem.name,
      declared: stem.declared === "pad" ? "texture" : stem.declared,
      crestDb: stem.crestDb,
      activeShare: stem.soundingShare,
    });
    const target = targetFor(guess, stem.name, {});
    const measuredDb = target.measure === "peak" ? stem.peakDbfs : stem.activeRmsDbfs;
    return { stem, guess, target, measuredDb };
  });
  const planned = balance
    ? planBalance(
        rows.map((row) => ({
          measuredDb: row.measuredDb,
          targetDb: row.target.db,
          // The planner works in LMMS volume units, where 100 is unity and 200 the fader top.
          control: { kind: "static", volume: 100 * 10 ** (row.stem.volumeDb / 20) },
        })),
      )
    : { rows: rows.map(() => ({ factor: 1, gainDb: 0 })), targetShiftDb: 0 };
  return {
    targetShiftDb: planned.targetShiftDb as number,
    tracks: rows.map((row, i) => {
      const plan = planned.rows[i];
      return {
        index: row.stem.index,
        name: row.stem.name,
        role: row.guess.role === "texture" ? "pad" : (row.guess.role as string),
        roleSource: row.guess.source as string,
        measure: row.target.measure as string,
        measuredDb: row.measuredDb,
        targetDb: balance ? (row.target.db as number) : null,
        factor: plan.factor as number,
        balanceDb: plan.skipped ? 0 : round(20 * Math.log10(plan.factor)),
        skipped: (plan.skipped as string | undefined) ?? null,
        warning: (plan.warning as string | undefined) ?? null,
      };
    }),
  };
}
// How far the whole mix may move: to the loudness target, but never past the peak ceiling.
export function masterOffset(predictedLufs: number, predictedTruePeakDb: number, targetLufs: number, ceilingDb: number) {
  const wanted = targetLufs - predictedLufs;
  const room = ceilingDb - predictedTruePeakDb;
  return wanted > room ? { offsetDb: round(room), limitedBy: "peak" as const } : { offsetDb: round(wanted), limitedBy: null };
}
async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]!);
      }
    }),
  );
  return out;
}

export function verifyMix(measured: { integratedLufs: number | null; truePeakDbfs: number | null; clippedSamples: number }, targetLufs: number, ceilingDb: number) {
  const failures: string[] = [];
  if (measured.integratedLufs === null || !Number.isFinite(measured.integratedLufs)) failures.push("unmeasurable_loudness");
  else if (Math.abs(measured.integratedLufs - targetLufs) > 1) failures.push("loudness_outside_tolerance");
  if (measured.truePeakDbfs === null || !Number.isFinite(measured.truePeakDbfs)) failures.push("unmeasurable_peak");
  else if (measured.truePeakDbfs > ceilingDb) failures.push("peak_ceiling_exceeded");
  if (measured.clippedSamples > 0) failures.push("clipping");
  return { passed: failures.length === 0, failures, expectedLufs: targetLufs, toleranceLu: 1 };
}

export async function autoMix(bridge: LiveBridge, workspace: Workspace, a: Args, dryRun: boolean) {
  const started = Date.now();
  const all = (await bridge.get("/tracks")) as TrackView[];
  const soloed = all.filter((t) => t.solo).map((t) => t.name);
  if (soloed.length)
    throw new ToolError("invalid_state", `Solo is on for ${soloed.join(", ").slice(0, 200)}. Auto-mix balances the whole mix: clear solo and mute what should stay out`);
  for (const i of a.tracks ?? []) if (!all[i]) throw new ToolError("not_found", `Track ${i} not found; read /tracks`);
  for (const key of Object.keys(a.roles)) if (!all[Number(key)]) throw new ToolError("not_found", `roles names track ${key}, which does not exist`);
  const picked = (a.tracks ?? all.map((_, i) => i)).filter((i) => !all[i]!.mute && all[i]!.itemCount > 0);
  if (!picked.length) throw new ToolError("invalid_state", "No unmuted tracks with items to mix");
  if (picked.length > MAX_TRACKS)
    throw new ToolError("limit", `Auto-mix renders one stem per track and handles up to ${MAX_TRACKS}; pass tracks to choose which, or group tracks first`);
  const tempo = Number(await bridge.get("/project/tempo")) || 120;

  // Snapshots go through the bridge one at a time; the renders then run side by side.
  const jobs = [];
  for (const i of picked) jobs.push(await snapshotRender(bridge, workspace, a.section, { index: i, guid: all[i]!.guid }));
  const parallel = Math.min(4, Math.max(1, Number(process.env.REAPER_MCP_PARALLEL_RENDERS) || 2));
  const rendered = await pool(jobs, parallel, (job) => runRenderJob(job, workspace, a.timeoutMs));
  let stems: any[] = [];
  for (const r of rendered) stems.push(decodeWav(await workspace.read(r.files[0]!, 100_000_000)));
  const frames = Math.min(...stems.map((s) => s.frames));
  if (!(frames > 0)) throw new ToolError("missing_output", "Stem renders are empty");
  stems = stems.map((s) => (s.frames === frames ? s : slice(s, 0, frames)));

  // Judge levels over the loudest eight bars, where the balance matters most.
  const barFrames = Math.max(1, Math.round((stems[0].sampleRate * 240) / tempo));
  const unity = sumStems(stems, stems.map(() => 1));
  const window = loudestWindow(blockStats(unity, barFrames, { bands: false }), WINDOW_BARS);
  const facts: StemFacts[] = stems.map((stem, k) => {
    const levels = windowLevels(blockStats(stem, barFrames, { bands: false }), window.start, window.start + window.length);
    const i = picked[k]!;
    return {
      index: i,
      name: all[i]!.name,
      volumeDb: all[i]!.volume_db,
      declared: a.roles[String(i)],
      peakDbfs: levels.peakDbfs,
      activeRmsDbfs: levels.activeRmsDbfs,
      soundingShare: levels.soundingShare,
      crestDb: levels.peakDbfs !== null && levels.activeRmsDbfs !== null ? levels.peakDbfs - levels.activeRmsDbfs : undefined,
    };
  });
  const plan = planLevels(facts, a.balance);
  const balanced = sumStems(stems, plan.tracks.map((t) => t.factor));
  const predictedLufs = loudness(balanced).integratedLufs as number | null;
  if (predictedLufs === null) throw new ToolError("invalid_state", "The mix is silent; check that the tracks have instruments or audio");
  const predictedPeak = db(truePeak(balanced)) as number;
  const master = masterOffset(predictedLufs, predictedPeak, a.targetLufs, a.ceilingDb);
  const tracks = plan.tracks.map(({ factor, ...t }, k) => {
    const beforeDb = round(facts[k]!.volumeDb);
    const wanted = facts[k]!.volumeDb + t.balanceDb + master.offsetDb;
    const afterDb = round(Math.min(MAX_FADER_DB, Math.max(-150, wanted)));
    return {
      ...t,
      beforeDb,
      afterDb,
      changeDb: round(afterDb - beforeDb),
      warning: wanted > MAX_FADER_DB + 0.05 ? `Needs ${round(wanted, 1)} dB but the fader stops at +${MAX_FADER_DB}; raise the instrument's own output` : t.warning,
    };
  });
  const steps = tracks
    .filter((t) => Math.abs(t.changeDb) >= 0.05)
    .map((t) => ({ action: "set_track", args: { track: all[t.index]!.guid, field: "volume_db", value: t.afterDb } }));
  const result: Record<string, unknown> = {
    dryRun,
    targetLufs: a.targetLufs,
    ceilingDb: a.ceilingDb,
    window: { startBar: window.start, bars: window.length, note: "levels were judged over the loudest bars of the render" },
    tracks,
    targetShiftDb: plan.targetShiftDb,
    masterOffsetDb: master.offsetDb,
    limitedBy: master.limitedBy,
    predicted: { integratedLufs: round(predictedLufs + master.offsetDb), truePeakDbfs: round(predictedPeak + master.offsetDb) },
    stemRenders: stems.length,
  };
  if (master.limitedBy)
    result.note = `Reaching ${a.targetLufs} LUFS would push the true peak past ${a.ceilingDb} dBFS, so the mix stops at ${round(predictedLufs + master.offsetDb)} LUFS. A limiter or compressor on the master is needed to go louder`;
  if (!dryRun && steps.length) {
    const applied = await bridge.batch(steps, false);
    result.undoLabel = applied.undoLabel;
  }
  result.changedTracks = dryRun ? 0 : steps.length;
  if (a.verify && !dryRun) {
    const job = await snapshotRender(bridge, workspace, a.section);
    const mix = await runRenderJob(job, workspace, a.timeoutMs);
    const measured: any = analyze(decodeWav(await workspace.read(mix.files[0]!, 100_000_000)));
    result.verified = {
      ...verifyMix(measured, predictedLufs + master.offsetDb, a.ceilingDb),
      file: mix.files[0],
      integratedLufs: measured.integratedLufs,
      truePeakDbfs: measured.truePeakDbfs,
      clippedSamples: measured.clippedSamples,
      differenceFromPredictionLu: measured.integratedLufs === null ? null : round(measured.integratedLufs - (predictedLufs + master.offsetDb)),
    };
  }
  result.elapsedMs = Date.now() - started;
  return result;
}
export const autoMixRoleTargets = defaultTargets;
