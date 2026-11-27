import { savedProjectBytes } from "./candidate.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { Workspace } from "./workspace.js";
import { ToolError } from "./errors.js";
import { writeRpp } from "./rpp/index.js";
import { songSchema } from "./song/model.js";
// @ts-ignore Source-attributed vendored audio functions.
import { decodeWav, encodeWav, loudness, truePeak } from "../../vendor/lmms-mcp/audio.mjs";

export const auditionCapability = {
  name: "audition_ab", toolset: "editing", modes: ["offline", "live"],
  description: "Create two loudness-matched listening WAVs and an aligned REAPER A/B project from two aligned workspace renders. Optionally select a passage in seconds. Returns a manifest for select_audition_render; dryRun only measures.",
  schema: z.object({
    a: z.string().min(1).max(4096), b: z.string().min(1).max(4096),
    projects: z.object({ a: z.string().regex(/\.rpp$/i), b: z.string().regex(/\.rpp$/i) }).strict().optional(),
    section: z.object({
      startSeconds: z.number().finite().nonnegative(),
      endSeconds: z.number().finite().positive(),
    }).strict().refine(s => s.endSeconds > s.startSeconds, "End must follow start").optional(),
    targetLufs: z.number().min(-40).max(-8).default(-18),
  }).strict(),
};
interface Audio { frames: number; sampleRate: number; channels: Float32Array[] }
function measure(audio: Audio) {
  const measurement = loudness(audio);
  const lufs = measurement.integratedLufs;
  const peakDb = 20 * Math.log10(truePeak(audio));
  if (!Number.isFinite(lufs) || !Number.isFinite(peakDb))
    throw new ToolError("unmeasurable_audio", "Both versions need measurable non-silent audio");
  return { lufs: lufs as number, peakDb, gated: Boolean(measurement.gated) };
}

export async function createAudition(workspace: Workspace, args: z.infer<typeof auditionCapability.schema>, dryRun: boolean) {
  async function readInput(file: string) {
    const bytes = await workspace.read(file, 64_000_000);
    const audio: Audio = decodeWav(bytes);
    if (audio.sampleRate < 8000 || audio.sampleRate > 192000)
      throw new ToolError("unsupported_audio", "Audition supports sample rates from 8 to 192 kHz");
    if (audio.channels.some(ch => !ch.every(Number.isFinite)))
      throw new ToolError("invalid_audio", "WAV contains a non-finite sample");
    return { file, audio, sha256: digest(bytes) };
  }
  const [a, b] = await Promise.all([readInput(args.a), readInput(args.b)]);
  if (a.audio.sampleRate !== b.audio.sampleRate || a.audio.frames !== b.audio.frames ||
      a.audio.channels.length !== b.audio.channels.length)
    throw new ToolError("unaligned_audio", "Render the same section, sample rate and channel layout for A and B");
  const rate = a.audio.sampleRate;
  const startFrame = args.section ? Math.round(args.section.startSeconds * rate) : 0;
  const endFrame = args.section ? Math.round(args.section.endSeconds * rate) : a.audio.frames;
  if (endFrame > a.audio.frames || startFrame >= endFrame)
    throw new ToolError("invalid_section", "Choose a non-empty passage inside both renders");
  const inputs = [a, b].map(({file, audio}) => {
    const excerpt = { ...audio, frames: endFrame - startFrame, channels: audio.channels.map(ch => ch.subarray(startFrame, endFrame)) };
    return { file, audio: excerpt, input: measure(excerpt) };
  });
  // Give both copies the same target and reserve 1 dB of estimated true-peak headroom.
  const target = Math.min(args.targetLufs, ...inputs.map(({input}) => input.lufs - input.peakDb - 1.05));
  const copies = inputs.map(({file, audio, input}) => {
    let gainDb = target - input.lufs;
    for (let pass = 0; pass < 4; pass++) {
      const gain = 10 ** (gainDb / 20);
      const wav: Buffer = encodeWav({ ...audio, channels: audio.channels.map(ch => ch.map(x => x * gain)) });
      const output = measure(decodeWav(wav));
      if (Math.abs(output.lufs - target) <= 0.24 && output.peakDb <= -1)
        return { wav, report: { source: file, input, gainDb, output } };
      gainDb += Math.min(target - output.lufs, -1.05 - output.peakDb);
    }
    throw new ToolError("loudness_match_failed", "Could not match this pair within 0.5 LU and the peak ceiling");
  });
  const summary = { targetLufs: target, deltaLu: Math.abs(copies[0]!.report.output.lufs - copies[1]!.report.output.lufs),
    versions: copies.map(copy => copy.report), dryRun };
  const sources = await Promise.all([a, b].map(async ({file, sha256}, i) => {
    const project = args.projects?.[i === 0 ? "a" : "b"];
    if (!project) return { file, sha256 };
    return { file, sha256, project: { file: project, sha256: digest(await savedProjectBytes(workspace, project)) } };
  }));
  if (dryRun) return summary;
  const folder = await mkdtemp(path.join(workspace.root, "audition-"));
  const relative = path.basename(folder);
  const length = (endFrame - startFrame) / rate;
  try {
    const tracks = [];
    for (const [i, name] of ["A", "B"].entries()) {
      const file = name + ".wav";
      await writeFile(path.join(folder, file), copies[i]!.wav, { flag: "wx" });
      tracks.push({ name, mute: i === 1, items: [{ kind: "audio", file, position: 0, length }] });
    }
    const nativeRate = [44100, 48000, 96000].includes(a.audio.sampleRate) ? a.audio.sampleRate : 44100;
    const project = writeRpp(songSchema.parse({ name: "A-B audition", tracks,
      render: { sampleRate: nativeRate, channels: a.audio.channels.length, end: length } }));
    await writeFile(path.join(folder, "audition.rpp"), project, { flag: "wx" });
    const manifest = {
      version: 1, sampleRate: rate, startFrame, endFrame,
      sources,
    };
    await writeFile(path.join(folder, "audition.json"), JSON.stringify(manifest, null, 2), {flag: "wx"});
    return { ...summary, manifest: relative + "/audition.json", files: [relative + "/A.wav", relative + "/B.wav"], project: relative + "/audition.rpp" };
  } catch (err) {
    await rm(folder, { recursive: true, force: true });
    throw err;
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const selectAuditionCapability = {
  name: "select_audition_render", toolset: "editing", modes: ["offline", "live"],
  description: "Export the original full WAV for the selected A or B listening copy after checking its source fingerprint.",
  schema: z.object({ manifest: z.string().min(1).max(4096), choice: z.enum(["A", "B"]) }).strict(),
};

const fileFingerprint = z.object({ file: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const sourceSchema = fileFingerprint.extend({ project: fileFingerprint.optional() });
const passageSchema = z.object({ sampleRate: z.number().int().positive(), startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() });
const manifestSchema = passageSchema.extend({ version: z.literal(1), sources: z.tuple([sourceSchema, sourceSchema]) });

export async function selectAuditionRender(workspace: Workspace, args: z.infer<typeof selectAuditionCapability.schema>, dryRun: boolean) {
  const raw = await workspace.read(args.manifest, 64_000);
  const manifest = manifestSchema.parse(JSON.parse(raw.toString("utf8")));
  const source = manifest.sources[args.choice === "A" ? 0 : 1];
  const bytes = await workspace.read(source.file, 64_000_000);
  if (digest(bytes) !== source.sha256)
    throw new ToolError("source_changed", "The selected render changed after auditioning. Create a new audition.");
  // A manifest can also be supplied by the caller. Verify the selected file is a supported WAV.
  decodeWav(bytes);
  if (source.project && digest(await savedProjectBytes(workspace, source.project.file)) !== source.project.sha256)
    throw new ToolError("source_changed", "The selected project changed after auditioning. Create a new audition.");
  const result = { project: source.project, choice: args.choice, source: source.file, sha256: source.sha256, dryRun };
  if (dryRun) return result;
  const folder = await mkdtemp(path.join(workspace.root, "selected-render-"));
  try {
    await writeFile(path.join(folder, "full.wav"), bytes, { flag: "wx" });
    const exported = { ...result, passage: passageSchema.parse(manifest), manifest: args.manifest, file: path.basename(folder) + "/full.wav" };
    await writeFile(path.join(folder, "selection.json"), JSON.stringify(exported, null, 2), { flag: "wx" });
    return { ...exported, receipt: path.basename(folder) + "/selection.json" };
  } catch (err) {
    await rm(folder, { recursive: true, force: true });
    throw err;
  }
}

export const verifyAuditionCapability = {
  name: "verify_audition_render", toolset: "editing", modes: ["offline", "live"],
  description: "Compare the approved passage with an independent full re-render using the saved selection receipt. Reports alignment and relative waveform error. Supply a known delivery gain in dB if one was applied to the new render.",
  schema: z.object({
    receipt: z.string().min(1).max(4096), rendered: z.string().min(1).max(4096),
    deliveryGainDb: z.number().min(-40).max(24).default(0),
  }).strict(),
};

export async function verifyAuditionRender(workspace: Workspace, args: z.infer<typeof verifyAuditionCapability.schema>) {
  const raw = await workspace.read(args.receipt, 64_000);
  const receipt = fileFingerprint.extend({ passage: passageSchema }).parse(JSON.parse(raw.toString("utf8")));
  const bytes = await workspace.read(receipt.file, 64_000_000);
  if (digest(bytes) !== receipt.sha256)
    throw new ToolError("source_changed", "The approved full WAV differs from the selection receipt");
  const approved: Audio = decodeWav(bytes);
  const fresh: Audio = decodeWav(await workspace.read(args.rendered, 64_000_000));
  const { sampleRate, startFrame, endFrame } = receipt.passage;
  if (sampleRate !== approved.sampleRate || endFrame > approved.frames || startFrame >= endFrame)
    throw new ToolError("invalid_section", "Selection boundaries do not fit the approved render");
  if (approved.frames !== fresh.frames || sampleRate !== fresh.sampleRate || approved.channels.length !== fresh.channels.length)
    return { passed: false, reason: "format_or_duration_changed" };
  const gain = 10 ** (args.deliveryGainDb / 20);
  let energy = 0;
  let error = 0;
  for (const [channel, source] of approved.channels.entries()) {
    const candidate = fresh.channels[channel]!;
    for (let i = startFrame; i < endFrame; i++) {
      const expected = source[i]! * gain;
      energy += expected * expected;
      error += (candidate[i]! - expected) ** 2;
    }
  }
  if (!Number.isFinite(energy) || energy === 0 || !Number.isFinite(error))
    throw new ToolError("unmeasurable_audio", "The passage needs finite samples and audible reference energy");
  const relativeRmsError = Math.sqrt(error / energy);
  return { passed: relativeRmsError <= 0.01, relativeRmsError, tolerance: 0.01, sampleRate,
    startFrame, endFrame, deliveryGainDb: args.deliveryGainDb };
}
