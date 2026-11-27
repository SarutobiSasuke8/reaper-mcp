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
      sources: [a, b].map(({file, sha256}) => ({file, sha256})),
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

const sourceSchema = z.object({ file: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const manifestSchema = z.object({ version: z.literal(1), sources: z.tuple([sourceSchema, sourceSchema]) });

export async function selectAuditionRender(workspace: Workspace, args: z.infer<typeof selectAuditionCapability.schema>, dryRun: boolean) {
  const raw = await workspace.read(args.manifest, 64_000);
  const manifest = manifestSchema.parse(JSON.parse(raw.toString("utf8")));
  const source = manifest.sources[args.choice === "A" ? 0 : 1];
  const bytes = await workspace.read(source.file, 64_000_000);
  if (digest(bytes) !== source.sha256)
    throw new ToolError("source_changed", "The selected render changed after auditioning. Create a new audition.");
  // A manifest can also be supplied by the caller. Verify the selected file is a supported WAV.
  decodeWav(bytes);
  const result = { choice: args.choice, source: source.file, sha256: source.sha256, dryRun };
  if (dryRun) return result;
  const folder = await mkdtemp(path.join(workspace.root, "selected-render-"));
  try {
    await writeFile(path.join(folder, "full.wav"), bytes, { flag: "wx" });
    return { ...result, file: path.basename(folder) + "/full.wav" };
  } catch (err) {
    await rm(folder, { recursive: true, force: true });
    throw err;
  }
}
