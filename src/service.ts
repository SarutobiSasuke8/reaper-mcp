import { z } from "zod";
import { packageVersion } from "./version.js";
import { LiveBridge } from "./live.js";
import MidiPackage from "@tonejs/midi";
import path from "node:path";
import {
  songSchema,
  songJsonSchema,
  trackSchema,
  itemSchema,
  fxSchema,
  secondsToBeat,
  beatToSeconds,
  type Song,
} from "./song/model.js";
import { readRpp, writeRpp } from "./rpp/index.js";
import { ToolError } from "./errors.js";
import { Workspace } from "./workspace.js";
import { locateReaper, renderSong } from "./render.js";
import { decodeWav, analyze } from "./audio.js";

export type Mode = "auto" | "live" | "offline";
export const modeSchema = z.enum(["auto", "live", "offline"]).default("auto");
export const pathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    // A track may also be addressed live by its GUID in braces: /tracks/{GUID}/fx
    // /styles and /personas/<id> read the built-in composition library in either mode.
    /^\/(?:project|tracks|markers|plugins|instruments|styles|personas)(?:\/(?:[a-zA-Z_]+|[a-z0-9]+(?:-[a-z0-9]+)+|0|[1-9][0-9]*|\{[0-9A-Fa-f-]{36}\}))*$/,
  );
export { capabilities } from "./editing.js";
import { capabilities, editSong } from "./editing.js";
import { selectAuditionCapability, auditionCapability } from "./audition.js";
import { autoMixCapability } from "./automix.js";
import { lintCapability } from "./lint.js";
import { grooveCapability } from "./groove.js";
import { djAnalyzeCapability, djBuildCapability } from "./dj.js";
import { musicCapabilities } from "./music.js";
import { bridgeState } from "./startup.js";

export class ReaperService {
  song: Song = songSchema.parse({});
  enabled = new Set<string>();
  live?: LiveBridge;
  private hadLive = false;
  constructor(
    public workspace: Workspace,
    public allowWrites = false,
    bridge?: LiveBridge,
  ) {
    this.live =
      bridge ??
      (process.env.REAPER_MCP_BRIDGE_DIR
        ? new LiveBridge(process.env.REAPER_MCP_BRIDGE_DIR)
        : undefined);
  }
  async selectMode(mode: Mode): Promise<"offline" | "live"> {
    if (mode === "offline") return "offline";
    if (this.live && (await this.live.available())) {
      this.hadLive = true;
      return "live";
    }
    if (this.live && (await bridgeState(this.live.directory)) === "outdated")
      throw new ToolError(
        "bridge_upgrade_required",
        "REAPER is running an older REAPER MCP bridge script. Save your work, close that REAPER session and start it again so it loads the bridge shipped with this server; no offline fallback occurred",
      );
    if (
      mode === "live" ||
      this.hadLive ||
      process.env.REAPER_MCP_AUTOSTART === "true"
    )
      throw new ToolError(
        "live_unavailable",
        "Live bridge unavailable or starting; no offline fallback after a live connection or during managed startup. Inspect REAPER dialogs or retry; use explicit offline mode for offline work",
      );
    return "offline";
  }
  private checkWrites(): void {
    if (!this.allowWrites)
      throw new ToolError(
        "writes_disabled",
        "Enable writes in the server configuration",
      );
  }
  private segments(input: string): string[] {
    return pathSchema.parse(input).slice(1).split("/");
  }
  private modelView(song = this.song): Record<string, unknown> {
    const { tracks, markers, ...project } = song;
    return { project, tracks, markers };
  }
  get(input: string): unknown {
    let current: unknown = this.modelView();
    for (const segment of this.segments(input)) {
      if (
        current === null ||
        typeof current !== "object" ||
        !Object.hasOwn(current, segment)
      )
        throw new ToolError("not_found", "Object path does not exist");
      current = (current as Record<string, unknown>)[segment];
    }
    return structuredClone(current);
  }
  list(input: string, offset = 0, limit = 100): unknown {
    const value = this.get(input);
    if (!Array.isArray(value))
      throw new ToolError("invalid_path", "List requires an array path");
    return {
      total: value.length,
      offset,
      items: value.slice(offset, offset + limit),
    };
  }
  set(input: string, value: unknown, dryRun = false): unknown {
    this.checkWrites();
    const segments = this.segments(input);
    const view = this.modelView(structuredClone(this.song));
    let current: unknown = view;
    for (const key of segments.slice(0, -1)) {
      if (
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, key)
      )
        throw new ToolError("not_found", "Object path does not exist");
      current = (current as Record<string, unknown>)[key];
    }
    const key = segments.at(-1)!;
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key))
      throw new ToolError("not_found", "Object path does not exist");
    (current as Record<string, unknown>)[key] = structuredClone(value);
    const candidate = songSchema.parse({
      ...(view.project as object),
      tracks: view.tracks,
      markers: view.markers,
    });
    if (!dryRun) this.song = candidate;
    return { path: input, dryRun, value };
  }
  async project(
    operation: "new" | "open" | "save",
    file?: string,
    song?: unknown,
  ): Promise<unknown> {
    this.checkWrites();
    if (operation === "new") {
      this.song = songSchema.parse(song ?? {});
      return { song: this.song };
    }
    if (!file)
      throw new ToolError("invalid_input", "A project filename is required");
    if (!/\.(json|rpp)$/i.test(file))
      throw new ToolError(
        "invalid_input",
        "Project filename must end in .json or .rpp",
      );
    if (operation === "open") {
      const source = (await this.workspace.read(file)).toString("utf8");
      const parsed = /\.rpp$/i.test(file)
        ? readRpp(source)
        : songSchema.parse(JSON.parse(source));
      // RPP media references are relative to the project, not the server root.
      for (const t of parsed.tracks)
        for (const item of t.items)
          if (item.kind === "audio") {
            if (/\.rpp$/i.test(file))
              item.file = path
                .join(path.dirname(file), item.file)
                .replaceAll("\\", "/");
            await this.workspace.resolve(item.file);
          }
      this.song = parsed;
      return { song: this.song };
    }
    const saved = structuredClone(this.song);
    if (/\.rpp$/i.test(file))
      for (const t of saved.tracks)
        for (const item of t.items)
          if (item.kind === "audio") {
            const source = await this.workspace.resolve(item.file);
            const destination = await this.workspace.resolve(file, true);
            item.file = path
              .relative(path.dirname(destination), source)
              .replaceAll("\\", "/");
          }
    await this.workspace.writeNew(
      file,
      /\.rpp$/i.test(file) ? writeRpp(saved) : JSON.stringify(saved, null, 2),
    );
    return { file };
  }
  async importMidi(file: string, position = 0): Promise<unknown> {
    this.checkWrites();
    const buffer = await this.workspace.read(file, 5_000_000);
    const midi = new MidiPackage.Midi(new Uint8Array(buffer));
    if (!midi.header.ppq || midi.tracks.length > 256)
      throw new ToolError("invalid_midi", "Unsupported PPQ or too many tracks");
    if (
      midi.tracks.some(
        (t) =>
          Object.values(t.controlChanges).some((events) => events.length) ||
          t.pitchBends.length,
      )
    )
      throw new ToolError(
        "unsupported_midi",
        "Controller and pitch-bend import is not supported yet",
      );
    const candidate = structuredClone(this.song);
    const empty = candidate.tracks.length === 0;
    if (empty && position === 0) {
      candidate.ppq = midi.header.ppq;
      candidate.tempo = midi.header.tempos[0]?.bpm ?? 120;
      candidate.tempoMap = midi.header.tempos.map((t) => ({
        beat: t.ticks / midi.header.ppq,
        bpm: t.bpm,
      }));
      const first = midi.header.timeSignatures[0];
      if (first) {
        candidate.numerator = first.timeSignature[0]!;
        candidate.denominator = first.timeSignature[1] as Song["denominator"];
      }
      for (const signature of midi.header.timeSignatures) {
        const beat = signature.ticks / midi.header.ppq;
        let point = candidate.tempoMap.find((p) => p.beat === beat);
        if (!point) {
          const bpm =
            [...candidate.tempoMap].reverse().find((p) => p.beat <= beat)
              ?.bpm ?? candidate.tempo;
          point = { beat, bpm };
          candidate.tempoMap.push(point);
          candidate.tempoMap.sort((a, b) => a.beat - b.beat);
        }
        point.numerator = signature.timeSignature[0];
        point.denominator = signature.timeSignature[1] as Song["denominator"];
      }
    } else if (
      midi.header.tempos.length > 1 ||
      midi.header.timeSignatures.length > 1
    )
      throw new ToolError(
        "tempo_conflict",
        "Import tempo-changing MIDI into a new empty project",
      );
    const ratio = candidate.ppq / midi.header.ppq;
    const added = midi.tracks
      .filter((t) => t.notes.length)
      .map((t) =>
        trackSchema.parse({
          name: t.name || "MIDI",
          items: [
            {
              kind: "midi",
              name: t.name,
              position,
              length: Math.max(
                0.001,
                beatToSeconds(
                  candidate,
                  secondsToBeat(candidate, position) +
                    t.durationTicks / midi.header.ppq,
                ) - position,
              ),
              notes: t.notes.map((n) => ({
                tick: Math.round(n.ticks * ratio),
                duration: Math.max(1, Math.round(n.durationTicks * ratio)),
                pitch: n.midi,
                velocity: Math.max(1, Math.round(n.velocity * 127)),
                channel: t.channel,
              })),
            },
          ],
        }),
      );
    candidate.tracks.push(...added);
    candidate.render.end = Math.max(
      candidate.render.end,
      ...added.flatMap((t) => t.items.map((i) => i.position + i.length)),
    );
    this.song = songSchema.parse(candidate);
    return {
      addedTracks: added.length,
      ppq: this.song.ppq,
      instrumentNotice: "MIDI notes need an instrument FX to sound",
    };
  }
  async importAudio(
    file: string,
    track: number | undefined,
    position = 0,
  ): Promise<unknown> {
    this.checkWrites();
    const audio = decodeWav(await this.workspace.read(file, 100_000_000));
    const candidate = structuredClone(this.song);
    const item = {
      kind: "audio" as const,
      name: path.basename(file),
      file,
      position,
      length: audio.frames / audio.sampleRate,
      offset: 0,
    };
    if (track === undefined) {
      candidate.tracks.push(
        trackSchema.parse({ name: item.name, items: [item] }),
      );
      track = candidate.tracks.length - 1;
    } else {
      if (!candidate.tracks[track])
        throw new ToolError("not_found", "Track does not exist");
      candidate.tracks[track]!.items.push(item);
    }
    candidate.render.end = Math.max(
      candidate.render.end,
      position + item.length,
    );
    this.song = songSchema.parse(candidate);
    return { track, item };
  }
  async analyze(file: string, referencePath?: string): Promise<unknown> {
    const audio = decodeWav(await this.workspace.read(file, 100_000_000));
    if (referencePath === undefined) return analyze(audio);
    let reference;
    try {
      reference = decodeWav(await this.workspace.read(referencePath, 100_000_000));
    } catch (error) {
      throw new ToolError("invalid_reference", `Cannot read reference WAV: ${(error as Error).message}`);
    }
    return analyze(audio, { reference });
  }
  async render(
    target: "mix" | "stems" | "regions",
    timeoutMs: number,
  ): Promise<unknown> {
    this.checkWrites();
    return renderSong(this.song, this.workspace, { target, timeoutMs });
  }
  async health(): Promise<unknown> {
    return {
      version: packageVersion,
      offline: true,
      live: this.live ? await this.live.available() : false,
      liveCapabilities: [
        "project/track inspection",
        "FX inventory, paged parameter inspection and guarded parameter edits",
        "track name/gain/pan/mute/solo and track removal",
        "transport: play, stop, pause, seek and loop range",
        "markers, regions and tempo map edits",
        "audio and MIDI item listing, import, move, trim, split, fade and delete",
        "multi-step batches as one undo step",
        "composition: whole pieces by style or persona, and single parts over a chord progression",
        "auto-mix: stem-measured role balance and loudness target with a verifying render",
        "DJ: track analysis (tempo, key, drops) and beatmatched, harmonically ordered sets on two decks",
        "arrangement lint with fixes, and swing and humanise for MIDI clips",
        "native track, catalogue instrument and beat-based MIDI insertion",
        "native project new/open/save, mix and selected-track stem renders",
        "stereo sends, sidechain routing and matched A/B audition projects",
      ],
      reaperInstalled: !!(await locateReaper()),
      writesEnabled: this.allowWrites,
    };
  }
  describe(subject: string): unknown {
    if (subject === "song" || subject === "/project") return songJsonSchema;
    const cap = [...capabilities, ...musicCapabilities, auditionCapability, selectAuditionCapability, autoMixCapability, djAnalyzeCapability, djBuildCapability, lintCapability, grooveCapability].find(
      (c) => c.name === subject,
    );
    if (cap)
      return {
        name: cap.name,
        toolset: cap.toolset,
        schema: z.toJSONSchema(cap.schema),
      };
    if (subject.startsWith("/"))
      return {
        path: subject,
        value: this.get(subject),
        songSchema: songJsonSchema,
      };
    throw new ToolError("not_found", "Unknown model or capability");
  }
  run(name: string, args: unknown, dryRun = false): unknown {
    this.checkWrites();
    const cap = capabilities.find((c) => c.name === name);
    if (!cap) throw new ToolError("not_found", "Unknown capability");
    if (!this.enabled.has(cap.toolset))
      throw new ToolError(
        "toolset_disabled",
        "Enable the editing toolset first",
      );
    const validated = editSong(this.song, name, args);
    if (!dryRun) this.song = validated;
    return { capability: name, dryRun, trackCount: validated.tracks.length };
  }
}
