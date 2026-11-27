// DJ suite: analyse tracks (tempo, beat grid, key, energy, drops), plan a beatmatched,
// harmonically ordered set, and build it in the live project on two decks.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolError } from "./errors.js";
import { LiveBridge } from "./live.js";
import { Workspace } from "./workspace.js";
// @ts-ignore Vendored JavaScript deliberately remains byte-identical to its source.
import { decodeWav, estimateTempo, estimateKey, loudness, truePeak, db } from "../../vendor/lmms-mcp/audio.mjs";

const ANALYSIS_VERSION = 1;
const MAX_FILE_BYTES = 250_000_000;
const MAX_TRACKS = 20;
const BEATS_PER_BAR = 4;
const round = (value: number, places = 2) => Number(value.toFixed(places));

export type Audio = { sampleRate: number; frames: number; channels: Float32Array[] };
export type TrackAnalysis = {
  file: string;
  durationSeconds: number;
  bpm: number | null;
  tempoConfidence: number;
  // Source time of the first beat and of the first bar line.
  beatOffsetSeconds: number;
  downbeatOffsetSeconds: number;
  downbeatConfident: boolean;
  bars: number;
  key: string | null;
  camelot: string | null;
  keyConfidence: number;
  integratedLufs: number | null;
  truePeakDbfs: number | null;
  barEnergyDb: number[];
  drops: number[];
  firstDropBar: number | null;
};

// ---- analysis -------------------------------------------------------------
// Onset strength per hop: the rise in level, full band and below roughly 150 Hz.
function envelopes(audio: Audio, hop: number) {
  const n = audio.frames;
  const frames = Math.floor(n / hop);
  const full = new Float64Array(frames);
  const low = new Float64Array(frames);
  const channels = audio.channels;
  const alpha = 1 - Math.exp((-2 * Math.PI * 150) / audio.sampleRate);
  let state = 0;
  let previousFull = 0;
  let previousLow = 0;
  for (let k = 0; k < frames; k++) {
    let sum = 0;
    let lowSum = 0;
    for (let i = k * hop; i < (k + 1) * hop; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i]!;
      mono /= channels.length;
      state += alpha * (mono - state);
      sum += mono * mono;
      lowSum += state * state;
    }
    const level = Math.sqrt(sum / hop);
    const lowLevel = Math.sqrt(lowSum / hop);
    full[k] = Math.max(0, level - previousFull);
    low[k] = Math.max(0, lowLevel - previousLow);
    previousFull = level;
    previousLow = lowLevel;
  }
  return { full, low, fps: audio.sampleRate / hop };
}
// Finds the tempo and phase whose beat grid lines the onsets up most sharply.
// Onset strength is folded onto one beat; the right tempo piles it into a few narrow bins,
// and any error smears it. The rough estimate is refined in 0.01 BPM steps, because a set
// drifts audibly on a 0.1 BPM error.
export function fitBeatGrid(envelope: Float64Array, fps: number, roughBpm: number) {
  const bins = 128;
  const acc = new Float64Array(bins);
  const at: number[] = [];
  const strength: number[] = [];
  let total = 0;
  for (let k = 0; k < envelope.length; k++) {
    const v = envelope[k]!;
    if (v > 0) {
      at.push(k);
      strength.push(v);
      total += v;
    }
  }
  if (!(total > 0)) return null;
  const score = (bpm: number) => {
    const period = (fps * 60) / bpm;
    acc.fill(0);
    for (let j = 0; j < at.length; j++) {
      const position = at[j]! / period;
      acc[Math.floor((position - Math.floor(position)) * bins)]! += strength[j]!;
    }
    // Smooth over three bins so a beat that straddles a bin edge is not penalised.
    let sharpness = 0;
    let best = 0;
    let bestValue = -1;
    for (let b = 0; b < bins; b++) {
      const v = acc[(b + bins - 1) % bins]! + acc[b]! + acc[(b + 1) % bins]!;
      sharpness += v * v;
      if (v > bestValue) [best, bestValue] = [b, v];
    }
    return { value: sharpness / (total * total), best };
  };
  let top = { bpm: roughBpm, ...score(roughBpm) };
  for (let bpm = Math.ceil(roughBpm * 97) / 100; bpm <= roughBpm * 1.03; bpm = round(bpm + 0.01)) {
    const s = score(bpm);
    if (s.value > top.value) top = { bpm, ...s };
  }
  // Produced music is nearly always at a whole or half BPM; prefer that when it costs almost nothing.
  for (const snapped of [Math.round(top.bpm), Math.round(top.bpm * 2) / 2]) {
    if (Math.abs(snapped - top.bpm) > 0.26 || snapped === top.bpm) continue;
    const s = score(snapped);
    if (s.value >= top.value * 0.97) {
      top = { bpm: snapped, ...s };
      break;
    }
  }
  // Phase: the strength-weighted centre around the fullest bin, at the chosen tempo.
  score(top.bpm);
  let weight = 0;
  let centre = 0;
  for (let d = -2; d <= 2; d++) {
    const w = acc[(top.best + d + bins) % bins]!;
    weight += w;
    centre += w * (top.best + d + 0.5);
  }
  const period = (fps * 60) / top.bpm;
  let offsetSeconds = (((((centre / weight) / bins) % 1) + 1) % 1) * period / fps;
  // A beat that falls just before the file starts wraps to the end of the period; keep it near zero.
  if (offsetSeconds > (period / fps) * 0.95) offsetSeconds -= period / fps;
  return { bpm: round(top.bpm), offsetSeconds, contrast: round(top.value * bins / 3, 3) };
}
export function analyzeTrack(audio: Audio): Omit<TrackAnalysis, "file"> {
  const durationSeconds = audio.frames / audio.sampleRate;
  const empty = {
    durationSeconds: round(durationSeconds, 3), bpm: null, tempoConfidence: 0, beatOffsetSeconds: 0, downbeatOffsetSeconds: 0,
    downbeatConfident: false, bars: 0, key: null, camelot: null, keyConfidence: 0, integratedLufs: null, truePeakDbfs: null,
    barEnergyDb: [], drops: [], firstDropBar: null,
  };
  if (durationSeconds < 4) return empty;
  const rough = estimateTempo(audio);
  const hop = 256;
  const { full, low, fps } = envelopes(audio, hop);
  const grid = rough.bpm ? fitBeatGrid(full, fps, rough.bpm) : null;
  // Key detection is costly, so it listens to two minutes from the middle of the track.
  const span = Math.min(audio.frames, Math.round(120 * audio.sampleRate));
  const start = Math.floor((audio.frames - span) / 2);
  const middle = { sampleRate: audio.sampleRate, channels: audio.channels.map((c) => c.subarray(start, start + span)) };
  const key = estimateKey(middle);
  const peak = truePeak(audio);
  const base = {
    ...empty,
    key: key.key ?? null,
    camelot: key.camelot ?? null,
    keyConfidence: round(key.confidence ?? 0, 3),
    integratedLufs: loudness(audio).integratedLufs ?? null,
    truePeakDbfs: peak > 0 ? db(peak) : null,
  };
  if (!grid) return base;
  const beatSeconds = 60 / grid.bpm;
  // The bar line is the beat position, of the four, that carries the most low-frequency onset strength.
  const strength = [0, 0, 0, 0];
  for (let beat = 0; ; beat++) {
    const frame = Math.round((grid.offsetSeconds + beat * beatSeconds) * fps);
    if (frame >= low.length) break;
    let v = 0;
    for (let d = -2; d <= 2; d++) v += low[frame + d] ?? 0;
    strength[beat % 4]! += v;
  }
  const rank = (values: number[]) => [0, 1, 2, 3].sort((a, b) => values[b]! - values[a]!);
  let order = rank(strength);
  let downbeatConfident = strength[order[0]!]! > strength[order[1]!]! * 1.08;
  if (!downbeatConfident) {
    // Second opinion: sections change on bar lines, so the right bar phase gives the largest
    // bar-to-bar jumps in level. A wrong phase splits each jump across two bars.
    const beats = Math.floor((durationSeconds - Math.max(0, grid.offsetSeconds)) / beatSeconds);
    const beatDb: number[] = [];
    for (let beat = 0; beat < beats; beat++) {
      const from = Math.max(0, Math.round((grid.offsetSeconds + beat * beatSeconds) * audio.sampleRate));
      const to = Math.min(audio.frames, Math.round((grid.offsetSeconds + (beat + 1) * beatSeconds) * audio.sampleRate));
      let sum = 0;
      for (let i = from; i < to; i++) sum += audio.channels[0]![i]! ** 2;
      beatDb.push(10 * Math.log10(sum / Math.max(1, to - from) + 1e-12));
    }
    const jumps = [0, 1, 2, 3].map((rotation) => {
      let total = 0;
      let previous: number | null = null;
      for (let b = rotation; b + 4 <= beatDb.length; b += 4) {
        const bar = (beatDb[b]! + beatDb[b + 1]! + beatDb[b + 2]! + beatDb[b + 3]!) / 4;
        if (previous !== null) total += (bar - previous) ** 2;
        previous = bar;
      }
      return total;
    });
    const byJump = rank(jumps);
    if (jumps[byJump[0]!]! > jumps[byJump[1]!]! * 1.2 && jumps[byJump[0]!]! > 9) {
      order = byJump;
      downbeatConfident = true;
    }
  }
  const downbeatOffsetSeconds = Math.max(0, grid.offsetSeconds + (downbeatConfident ? order[0]! : 0) * beatSeconds);
  const barSeconds = beatSeconds * BEATS_PER_BAR;
  const bars = Math.max(0, Math.floor((durationSeconds - downbeatOffsetSeconds) / barSeconds));
  const barEnergyDb: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const from = Math.round((downbeatOffsetSeconds + bar * barSeconds) * audio.sampleRate);
    const to = Math.min(audio.frames, Math.round((downbeatOffsetSeconds + (bar + 1) * barSeconds) * audio.sampleRate));
    let sum = 0;
    for (const channel of audio.channels) for (let i = from; i < to; i++) sum += channel[i]! * channel[i]!;
    const mean = sum / Math.max(1, (to - from) * audio.channels.length);
    barEnergyDb.push(mean > 0 ? round(10 * Math.log10(mean), 1) : -120);
  }
  const drops = findDrops(barEnergyDb);
  return {
    ...base,
    bpm: grid.bpm,
    tempoConfidence: round(Math.min(1, grid.contrast), 2),
    beatOffsetSeconds: round(Math.max(0, grid.offsetSeconds), 4),
    downbeatOffsetSeconds: round(downbeatOffsetSeconds, 4),
    downbeatConfident,
    bars,
    barEnergyDb,
    drops,
    firstDropBar: drops[0] ?? null,
  };
}
// A drop is a bar that jumps at least 6 dB above the four bars before it and sits near the track's loudest level.
export function findDrops(barEnergyDb: number[], { riseDb = 6, window = 4, minGap = 8 } = {}): number[] {
  const loudest = Math.max(...barEnergyDb, -120);
  const drops: number[] = [];
  for (let bar = window; bar < barEnergyDb.length; bar++) {
    let linear = 0;
    for (let i = bar - window; i < bar; i++) linear += 10 ** (barEnergyDb[i]! / 10);
    const before = 10 * Math.log10(linear / window);
    const last = drops.at(-1);
    if (barEnergyDb[bar]! - before >= riseDb && barEnergyDb[bar]! >= loudest - 3 && (last === undefined || bar - last >= minGap)) drops.push(bar);
  }
  return drops;
}
export async function analyzeFiles(workspace: Workspace, files: string[]): Promise<TrackAnalysis[]> {
  const cacheDir = path.join(workspace.root, ".reaper-mcp-dj");
  const out: TrackAnalysis[] = [];
  for (const file of files) {
    if (!/\.wav$/i.test(file)) throw new ToolError("unsupported_audio", `DJ analysis reads WAV files; convert ${path.basename(file).slice(0, 80)} to WAV first`);
    const absolute = await workspace.resolve(file);
    const info = await stat(absolute);
    if (info.size > MAX_FILE_BYTES) throw new ToolError("limit", `${path.basename(file).slice(0, 80)} is larger than 250 MB`);
    const id = createHash("sha1").update(`${ANALYSIS_VERSION}|${absolute}|${info.size}|${info.mtimeMs}`).digest("hex");
    const cached = path.join(cacheDir, `${id}.json`);
    try {
      out.push({ ...JSON.parse(await readFile(cached, "utf8")), file });
      continue;
    } catch {}
    let audio: Audio;
    try {
      audio = decodeWav(await workspace.read(file, MAX_FILE_BYTES));
    } catch (error) {
      throw new ToolError("unsupported_audio", `Cannot read ${path.basename(file).slice(0, 80)} as WAV: ${String((error as Error).message).slice(0, 120)}`);
    }
    const analysis = { file, ...analyzeTrack(audio) };
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cached, JSON.stringify(analysis)).catch(() => {});
    out.push(analysis);
  }
  return out;
}

// ---- planning -------------------------------------------------------------
// Steps around the Camelot wheel: 0 same key, 1 a classic compatible move, more is a clash.
export function camelotDistance(a: string | null, b: string | null): number | null {
  const parse = (code: string | null) => {
    const m = /^(\d{1,2})([AB])$/.exec(code ?? "");
    return m ? { n: Number(m[1]), letter: m[2]! } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  const around = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  return around + (x.letter === y.letter ? 0 : 1);
}
export const planOptions = {
  order: z.enum(["given", "harmonic", "bpm"]).default("harmonic"),
  tempo: z.union([z.enum(["median", "first"]), z.number().min(60).max(200)]).default("median"),
  transitionBars: z.number().int().min(4).max(64).multipleOf(4).default(16),
  maxBarsPerTrack: z.number().int().min(16).max(2000).optional(),
  alignDrops: z.boolean().default(true),
  matchLoudness: z.boolean().default(true),
  loudnessLufs: z.number().min(-30).max(-8).default(-16),
  startBar: z.number().int().min(0).max(10000).default(0),
};
const planSchema = z.object(planOptions).strict();
export type PlanOptions = z.infer<typeof planSchema>;
export type PlannedTrack = {
  file: string; deck: "A" | "B"; order: number;
  sourceBpm: number; playRate: number; tempoChangePercent: number;
  key: string | null; camelot: string | null;
  startBar: number; playBars: number; startBeat: number;
  offsetSeconds: number; lengthSeconds: number;
  fadeInSeconds: number; fadeOutSeconds: number; gainDb: number;
  enterAtSourceBar: number; dropLandsAtBar: number | null;
};
export function planSet(analyses: TrackAnalysis[], raw: Partial<PlanOptions> = {}) {
  const o = planSchema.parse(raw);
  if (analyses.length < 1 || analyses.length > MAX_TRACKS) throw new ToolError("limit", `A set takes 1 to ${MAX_TRACKS} tracks`);
  for (const a of analyses) {
    const name = path.basename(a.file).slice(0, 80);
    if (!a.bpm) throw new ToolError("invalid_input", `No steady tempo found in ${name}; it cannot be beatmatched`);
    if (a.bars < 8) throw new ToolError("invalid_input", `${name} is shorter than 8 bars`);
  }
  const bpms = analyses.map((a) => a.bpm!);
  const sorted = [...bpms].sort((x, y) => x - y);
  const setBpm = round(typeof o.tempo === "number" ? o.tempo : o.tempo === "first" ? bpms[0]! : sorted[Math.floor((sorted.length - 1) / 2)]!);
  // A track at half or double the set tempo is matched in that relation, not stretched across it.
  const effective = (bpm: number) => {
    let b = bpm;
    while (setBpm / b > 1.5) b *= 2;
    while (setBpm / b < 0.75) b /= 2;
    return b;
  };
  let order = analyses.map((_, i) => i);
  if (o.order === "bpm") order.sort((x, y) => effective(bpms[x]!) - effective(bpms[y]!));
  if (o.order === "harmonic") {
    const left = new Set(order.slice(1));
    const path_ = [order[0]!];
    while (left.size) {
      const from = analyses[path_.at(-1)!]!;
      let best = -1;
      let bestCost = Infinity;
      for (const i of left) {
        const to = analyses[i]!;
        const cost = (camelotDistance(from.camelot, to.camelot) ?? 3) * 10 + (Math.abs(effective(to.bpm!) - effective(from.bpm!)) / setBpm) * 100;
        if (cost < bestCost) [best, bestCost] = [i, cost];
      }
      path_.push(best);
      left.delete(best);
    }
    order = path_;
  }
  const warnings: string[] = [];
  const seconds = (bars: number) => (bars * BEATS_PER_BAR * 60) / setBpm;
  const tracks: PlannedTrack[] = [];
  const transitions: { from: string; to: string; startBar: number; bars: number; camelot: string; keyMove: number | null; compatible: boolean | null }[] = [];
  let cursor = o.startBar;
  order.forEach((index, n) => {
    const a = analyses[index]!;
    const name = path.basename(a.file);
    const bpm = effective(a.bpm!);
    const playRate = setBpm / bpm;
    const sourceBars = Math.floor(a.bars * (bpm / a.bpm!));
    const dropBar = a.firstDropBar === null ? null : Math.floor(a.firstDropBar * (bpm / a.bpm!));
    const previous = tracks.at(-1);
    let transition = 0;
    let enter = 0;
    if (previous) {
      // The incoming track enters so that its first drop lands as the transition ends.
      enter = o.alignDrops && dropBar !== null ? Math.max(0, dropBar - o.transitionBars) : 0;
      const room = Math.min(sourceBars - enter, o.maxBarsPerTrack ?? Infinity);
      transition = Math.max(4, Math.min(o.transitionBars, Math.floor(previous.playBars / 2 / 4) * 4, Math.floor(room / 2 / 4) * 4));
      if (transition < o.transitionBars) {
        warnings.push(`${path.basename(previous.file)} into ${name}: transition shortened to ${transition} bars to fit the tracks`);
        if (o.alignDrops && dropBar !== null) enter = Math.max(0, dropBar - transition);
      }
    }
    const playBars = Math.min(sourceBars - enter, o.maxBarsPerTrack ?? Infinity);
    if (playBars < 8) throw new ToolError("invalid_input", `${name.slice(0, 80)} leaves fewer than 8 bars to play`);
    const startBar = previous ? previous.startBar + previous.playBars - transition : cursor;
    if (previous) {
      previous.fadeOutSeconds = round(seconds(transition), 4);
      const move = camelotDistance(analyses[order[n - 1]!]!.camelot, a.camelot);
      transitions.push({
        from: path.basename(previous.file), to: name, startBar, bars: transition,
        camelot: `${previous.camelot ?? "?"} to ${a.camelot ?? "?"}`, keyMove: move, compatible: move === null ? null : move <= 1,
      });
      if (move !== null && move > 1) warnings.push(`${path.basename(previous.file)} into ${name}: keys clash (${previous.camelot} to ${a.camelot})`);
      if (move === null) warnings.push(`${path.basename(previous.file)} into ${name}: key not detected, so the blend is unchecked`);
    }
    const change = (playRate - 1) * 100;
    if (Math.abs(change) > 8) warnings.push(`${name}: tempo changes by ${round(change, 1)}%, which is audible`);
    if (a.camelot !== null && a.keyConfidence < 0.5) warnings.push(`${name}: the key (${a.key}) is a low-confidence estimate; check the blend by ear`);
    if (a.tempoConfidence < 0.35) warnings.push(`${name}: the beat grid is uncertain; check this track's alignment by ear`);
    if (!a.downbeatConfident) warnings.push(`${name}: the bar line is a guess, so phrases may sit a beat or two off`);
    tracks.push({
      file: a.file, deck: n % 2 === 0 ? "A" : "B", order: n,
      sourceBpm: a.bpm!, playRate: round(playRate, 6), tempoChangePercent: round(change, 2),
      key: a.key, camelot: a.camelot,
      startBar, playBars, startBeat: startBar * BEATS_PER_BAR,
      offsetSeconds: round(a.downbeatOffsetSeconds + (enter * BEATS_PER_BAR * 60) / bpm, 4),
      lengthSeconds: round(seconds(playBars), 4),
      fadeInSeconds: round(seconds(transition), 4),
      // The last track fades over its final four bars; earlier tracks get their fade from the next transition.
      fadeOutSeconds: round(seconds(Math.min(4, playBars)), 4),
      gainDb: o.matchLoudness && a.integratedLufs !== null ? round(Math.max(-24, Math.min(12, o.loudnessLufs - a.integratedLufs))) : 0,
      enterAtSourceBar: enter,
      dropLandsAtBar: dropBar !== null && dropBar >= enter ? startBar + dropBar - enter : null,
    });
  });
  const last = tracks.at(-1)!;
  const lengthBars = last.startBar + last.playBars - o.startBar;
  return {
    bpm: setBpm,
    startBar: o.startBar,
    lengthBars,
    lengthSeconds: round(seconds(lengthBars), 2),
    order: o.order,
    tracks,
    transitions,
    warnings,
  };
}

// ---- capabilities -----------------------------------------------------------
const fileList = z.array(z.string().min(1).max(4096)).min(1).max(MAX_TRACKS);
export const djAnalyzeCapability = {
  name: "dj_analyze_tracks",
  toolset: "editing",
  modes: ["offline", "live"],
  description:
    "Analyse workspace WAV tracks for DJ use: tempo to 0.01 BPM, first beat and bar line, key with its Camelot code, loudness, energy per bar and where the drops are. Results are cached per file. Use it to choose tracks before live_build_dj_set.",
  schema: z.object({ files: fileList }).strict(),
};
export const djBuildCapability = {
  name: "live_build_dj_set",
  toolset: "editing",
  modes: ["live"],
  description:
    "Build a beatmatched DJ set from workspace WAV tracks in the live project, as one undo step. Analyses each track, orders them (harmonic by Camelot key, bpm, or given), stretches every track to one set tempo with pitch preserved, and lays them alternately on Deck A and Deck B so bar lines coincide and each transition crossfades over transitionBars. With alignDrops the incoming track enters so its first drop lands as the transition ends. Tracks are loudness-matched with item gain. Adds a region per track and a marker per transition, and sets the project tempo from startBar. dryRun returns the full plan with warnings (key clashes, large tempo changes, uncertain beat grids) and changes nothing. Afterwards render with reaper_render, and use live_auto_mix with balance false for final loudness.",
  schema: z.object({ files: fileList, ...planOptions, regions: z.boolean().default(true) }).strict(),
};
export async function djAnalyze(workspace: Workspace, a: z.infer<typeof djAnalyzeCapability.schema>) {
  return { tracks: await analyzeFiles(workspace, a.files) };
}
export async function djBuild(bridge: LiveBridge, workspace: Workspace, a: z.infer<typeof djBuildCapability.schema>, dryRun: boolean) {
  const { files, regions, ...options } = a;
  if (new Set(files).size !== files.length) throw new ToolError("invalid_input", "Each file may appear once in a set");
  const plan = planSet(await analyzeFiles(workspace, files), options);
  const existing = (await bridge.get("/tracks")) as unknown[];
  const tempoMap = (await bridge.get("/project/tempo_map")) as { markers: { beat: number }[] };
  const startBeat = plan.startBar * BEATS_PER_BAR;
  if (tempoMap.markers.some((m) => m.beat > startBeat + 1e-6))
    throw new ToolError("invalid_state", "The project has tempo changes after the set's start; a beatmatched set needs one steady tempo from there on");
  const decks = plan.tracks.length > 1 ? ["Deck A", "Deck B"] : ["Deck A"];
  const deckIndex = { A: existing.length, B: existing.length + 1 };
  if (existing.length + decks.length > 256) throw new ToolError("limit", "The project has too many tracks");
  const steps: { action: string; args: Record<string, unknown> }[] = [
    { action: "live_set_tempo", args: { beat: startBeat, bpm: plan.bpm } },
    ...decks.map((name) => ({ action: "live_add_track", args: { name } })),
  ];
  for (const t of plan.tracks) {
    steps.push({
      action: "live_insert_audio",
      args: {
        track: deckIndex[t.deck], file: await workspace.resolve(t.file), startBeat: t.startBeat,
        name: path.basename(t.file).replace(/\.wav$/i, "").slice(0, 200),
        playRate: t.playRate, preservePitch: true, offsetSeconds: t.offsetSeconds, lengthSeconds: t.lengthSeconds,
        fadeInSeconds: t.fadeInSeconds, fadeOutSeconds: t.fadeOutSeconds, gainDb: t.gainDb,
      },
    });
    if (regions)
      steps.push({
        action: "live_add_marker",
        args: { name: path.basename(t.file).replace(/\.wav$/i, "").slice(0, 200), beat: t.startBeat, endBeat: (t.startBar + t.playBars) * BEATS_PER_BAR },
      });
  }
  for (const x of plan.transitions)
    steps.push({ action: "live_add_marker", args: { name: `Mix ${x.camelot}`.slice(0, 200), beat: x.startBar * BEATS_PER_BAR } });
  if (steps.length > 64) throw new ToolError("limit", "The set needs more than 64 edit steps; use fewer tracks or set regions to false");
  const result: Record<string, unknown> = {
    dryRun,
    ...plan,
    decks: decks.map((name, i) => ({ name, index: existing.length + i })),
    editSteps: steps.length,
    next: "Render with reaper_render and listen to each transition; run live_auto_mix with balance false to set the final loudness",
  };
  if (!dryRun) {
    const applied = await bridge.batch(steps, false);
    result.undoLabel = applied.undoLabel;
  }
  return result;
}
