import { nativeObservation } from "./native-observation.js";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { decodeWav } from "./audio.js";
import { savedProjectBytes } from "./candidate.js";
import { ToolError } from "./errors.js";
import { instruments } from "./music.js";
import { liveIni } from "./profile.js";
import { locateReaper } from "./render.js";
import { Workspace } from "./workspace.js";

export const probeCapability = {
  name: "probe_instrument",
  toolset: "editing",
  modes: ["offline", "live"],
  description:
    "Test one catalogue instrument or a saved RPP track GUID in isolated REAPER. Play a note with CC1/11, render, reopen and measure again. Reports the host identity, audible result and files. The plugin's internal patch may be opaque.",
  schema: z
    .object({
      source: z.union([
        z.object({ instrument: z.string().min(1).max(200) }).strict(),
        z
          .object({
            project: z
              .string()
              .max(4096)
              .regex(/\.rpp$/i),
            trackGuid: z.string().regex(/^\{[a-fA-F0-9-]{36}\}$/),
          })
          .strict(),
        z
          .object({
            project: z
              .string()
              .max(4096)
              .regex(/\.rpp$/i),
            trackName: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[^\r\n\0]+$/),
          })
          .strict(),
      ]),
      pitch: z.number().int().min(0).max(127).default(72),
      velocity: z.number().int().min(1).max(127).default(90),
      channel: z.number().int().min(0).max(15).default(0),
      cc1: z.number().int().min(0).max(127).default(90),
      cc11: z.number().int().min(0).max(127).default(110),
      timeoutMs: z.number().int().min(1000).max(600000).default(180000),
    })
    .strict(),
};
export async function probeInstrument(
  ws: Workspace,
  a: z.infer<typeof probeCapability.schema>,
  dry: boolean,
) {
  let plugin = "",
    preset = "",
    guid = "",
    sourcePath: string | undefined;
  if ("instrument" in a.source) {
    const id = a.source.instrument;
    const entry = (await instruments()).find((e) => e.id === id);
    if (!entry)
      return {
        passed: false,
        stage: "catalogue",
        reason: "instrument_not_listed",
      };
    plugin = entry.plugin;
    preset = entry.preset ?? "";
    if (
      preset &&
      (!path.isAbsolute(preset) ||
        !/\.vstpreset$/i.test(preset) ||
        /[\r\n\0]/.test(preset))
    )
      throw new ToolError(
        "library_config",
        "Expected an absolute VST preset path",
      );
    if (
      preset &&
      !(await stat(preset).then(
        (s) => s.isFile() && s.size <= 20_000_000,
        () => false,
      ))
    )
      return {
        passed: false,
        stage: "preset",
        reason: "preset_file_unavailable",
      };
  } else {
    sourcePath = await ws.resolve(a.source.project);
    guid =
      "trackGuid" in a.source
        ? a.source.trackGuid
        : "name:" + a.source.trackName;
  }
  if (dry)
    return {
      dryRun: true,
      source: a.source,
      plugin,
      preset,
      channel: a.channel,
      pitch: a.pitch,
    };
  const exe = await locateReaper();
  if (!exe)
    throw new ToolError(
      "reaper_not_found",
      "Install REAPER or set REAPER_PATH",
    );
  const folder = await mkdtemp(path.join(ws.root, "instrument-probe-"));
  const relative = (name: string) =>
    path.relative(ws.root, path.join(folder, name)).replaceAll("\\", "/");
  const profile = path.join(folder, "probe.ini");
  await writeFile(profile, liveIni(process.platform, "dummy"));
  await writeFile(
    path.join(folder, "request.txt"),
    [
      sourcePath ? "saved" : "catalogue",
      plugin,
      preset,
      guid,
      a.pitch,
      a.velocity,
      a.channel,
      a.cc1,
      a.cc11,
    ].join("\n") + "\n",
  );
  let copy: string | undefined;
  const deadline = Date.now() + a.timeoutMs;
  let stage = "startup";
  try {
    if (sourcePath && "project" in a.source) {
      // A sibling retains relative media paths. Only the disposable copy is opened in REAPER.
      const relativeCopy = path.join(
        path.dirname(a.source.project),
        "probe-source-" + randomUUID() + ".rpp",
      );
      await ws.writeNew(
        relativeCopy,
        await savedProjectBytes(ws, a.source.project),
      );
      copy = await ws.resolve(relativeCopy);
    }
    async function observe(project?: string) {
      const result = await nativeObservation(
        exe!,
        [
          "-newinst",
          "-nosplash",
          "-cfgfile",
          profile,
          ...(project ? [project] : []),
          fileURLToPath(
            new URL("../../bridge/probe-instrument.lua", import.meta.url),
          ),
        ],
        path.join(folder, "observation.txt"),
        deadline,
      );
      return result.split(/\r?\n/);
    }
    stage = "load_and_render";
    const [outcome, detail, hostPreset, trackName] = await observe(copy);
    if (outcome !== "ok")
      return {
        passed: false,
        stage: outcome,
        reason: detail,
        source: a.source,
      };
    const measure = async (name: string) => {
      const audio = decodeWav(await ws.read(relative(name), 8_000_000));
      if (
        audio.sampleRate !== 44100 ||
        audio.channels.length !== 2 ||
        Math.abs(audio.frames - 88200) > 1
      )
        throw new ToolError(
          "invalid_output",
          "Expected a two-second stereo probe",
        );
      let energy = 0,
        peak = 0;
      for (const ch of audio.channels)
        for (const sample of ch.subarray(11025, 66150)) {
          energy += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
      const rms = Math.sqrt(energy / (55125 * 2));
      return {
        file: relative(name),
        rmsDbfs: rms > 0 ? 20 * Math.log10(rms) : null,
        peakDbfs: peak > 0 ? 20 * Math.log10(peak) : null,
        audible: rms > 0.0001,
      };
    };
    stage = "first_render";
    await rename(path.join(folder, "mix.wav"), path.join(folder, "first.wav"));
    const first = await measure("first.wav");
    stage = "reopen_render";
    if (Date.now() >= deadline)
      throw new ToolError(
        "probe_timeout",
        "Time budget expired before reopening",
      );
    await rename(
      path.join(folder, "observation.txt"),
      path.join(folder, "first-observation.txt"),
    );
    await writeFile(
      path.join(folder, "request.txt"),
      [
        "reopen",
        detail,
        "",
        "",
        a.pitch,
        a.velocity,
        a.channel,
        a.cc1,
        a.cc11,
      ].join("\n") + "\n",
    );
    const [reopenStage, reopenDetail] = await observe(
      path.join(folder, "probe.rpp"),
    );
    if (reopenStage !== "ok")
      return { passed: false, stage: reopenStage, reason: reopenDetail, first };
    const reopened = await measure("mix.wav");
    return {
      passed: first.audible && reopened.audible,
      stage: "completed",
      reason: !first.audible
        ? "silent_test_note"
        : !reopened.audible
          ? "silent_after_reopen"
          : "audible_after_reopen",
      source: a.source,
      fxName: detail,
      hostPreset: hostPreset || null,
      trackName: trackName || null,
      test: {
        pitch: a.pitch,
        channel: a.channel,
        velocity: a.velocity,
        cc1: a.cc1,
        cc11: a.cc11,
      },
      thresholdDbfs: -80,
      first,
      reopened,
      project: relative("probe.rpp"),
    };
  } catch (e) {
    return {
      passed: false,
      stage,
      reason: e instanceof ToolError ? e.code : "probe_failed",
      detail: e instanceof Error ? e.message : "Unknown probe error",
    };
  } finally {
    if (copy) await unlink(copy);
  }
}
