import {
  songSchema,
  trackSchema,
  beatToSeconds,
  secondsToBeat,
  type Song,
} from "../song/model.js";
import { ToolError } from "../errors.js";

export interface RppNode {
  tag: string;
  args: string[];
  children: (RppNode | string[])[];
}
export function tokenize(line: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i]!)) {
      i++;
      continue;
    }
    const quote = line[i];
    let value = "";
    if (quote === '"' || quote === "'" || quote === "`") {
      i++;
      while (i < line.length && line[i] !== quote) value += line[i++];
      if (i === line.length)
        throw new ToolError("invalid_rpp", "Unclosed quoted value");
      i++;
    } else {
      while (i < line.length && !/\s/.test(line[i]!)) value += line[i++];
    }
    result.push(value);
  }
  return result;
}
export function parseTree(text: string): RppNode {
  if (Buffer.byteLength(text) > 20_000_000)
    throw new ToolError("limit", "RPP exceeds 20 MB");
  const stack: RppNode[] = [];
  let root: RppNode | undefined;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === ">") {
      if (!stack.length)
        throw new ToolError("invalid_rpp", "Unexpected closing block");
      stack.pop();
    } else if (line.startsWith("<")) {
      const [tag, ...args] = tokenize(line.slice(1));
      if (!tag) throw new ToolError("invalid_rpp", "Empty block");
      const node: RppNode = { tag, args, children: [] };
      if (stack.length) stack.at(-1)!.children.push(node);
      else {
        if (root) throw new ToolError("invalid_rpp", "Multiple roots");
        root = node;
      }
      stack.push(node);
      if (stack.length > 64)
        throw new ToolError("limit", "RPP nesting exceeds 64 levels");
    } else {
      if (!stack.length)
        throw new ToolError("invalid_rpp", "Line outside root");
      stack.at(-1)!.children.push(tokenize(line));
    }
  }
  if (stack.length || root?.tag !== "REAPER_PROJECT")
    throw new ToolError("invalid_rpp", "Incomplete REAPER_PROJECT");
  return root;
}
const q = (value: string): string => {
  if (/[\r\n\x00]/.test(value))
    throw new ToolError("invalid_input", "RPP text must be single-line");
  for (const delim of ['"', "'", "`"])
    if (!value.includes(delim)) return delim + value + delim;
  throw new ToolError(
    "invalid_input",
    "Text contains every RPP quoting delimiter",
  );
};
const gain = (db: number) => 10 ** (db / 20);
const db = (g: number) =>
  g > 0 ? Number(Math.max(-150, 20 * Math.log10(g)).toFixed(12)) : -150;
const leaf = (n: RppNode, tag: string): string[] | undefined =>
  n.children.find((c) => Array.isArray(c) && c[0] === tag) as
    | string[]
    | undefined;
const blocks = (n: RppNode, tag: string): RppNode[] =>
  n.children.filter((c) => !Array.isArray(c) && c.tag === tag) as RppNode[];
const val = (n: RppNode, tag: string, index = 1, fallback = 0) =>
  Number(leaf(n, tag)?.[index] ?? fallback);
export function writeRpp(
  input: Song,
  render?: { directory: string; pattern: string },
): string {
  const song = songSchema.parse(input);
  const lines = [
    `<REAPER_PROJECT 0.1 "7.0" 1`,
    `  TEMPO ${song.tempo} ${song.numerator} ${song.denominator}`,
    `  SAMPLERATE ${song.render.sampleRate} 1 0`,
    `  RENDER_FILE ${q(render?.directory ?? "")}`,
    `  RENDER_PATTERN ${q(render?.pattern ?? song.name)}`,
    `  RENDER_FMT 0 ${song.render.channels} ${song.render.sampleRate}`,
    `  RENDER_RANGE 0 ${song.render.start} ${song.render.end} 0 0`,
    "  RENDER_DITHER 0",
    "  <RENDER_CFG",
    "    ZXZhdxgAAA==",
    "  >",
    "  <EXTSTATE",
    `    REAPER_MCP song_name ${q(song.name)}`,
    `    REAPER_MCP ppq ${song.ppq}`,
    "  >",
  ];
  if (song.tempoMap.length) {
    lines.push("  <TEMPOENVEX", "    ACT 1", "    VIS 1 0 0");
    if (song.tempoMap[0]!.beat !== 0) lines.push(`    PT 0 ${song.tempo} 1`);
    for (const p of song.tempoMap)
      lines.push(
        `    PT ${beatToSeconds(song, p.beat)} ${p.bpm} 1 ${p.numerator && p.denominator ? p.numerator + (p.denominator << 16) : 0}`,
      );
    lines.push("  >");
  }
  for (const marker of song.markers) {
    lines.push(
      `  MARKER ${marker.id} ${marker.position} ${q(marker.name)} ${marker.end === undefined ? 0 : 1}`,
    );
    if (marker.end !== undefined)
      lines.push(`  MARKER ${marker.id} ${marker.end} "" 1`);
  }
  for (let index = 0; index < song.tracks.length; index++) {
    const track = song.tracks[index]!;
    lines.push(
      "  <TRACK",
      `    NAME ${q(track.name)}`,
      `    VOLPAN ${gain(track.volume_db)} ${track.pan} -1 -1 1`,
      `    MUTESOLO ${Number(track.mute)} 0 0`,
      `    MAINSEND ${Number(track.mainSend)} 0`,
    );
    song.tracks.forEach((source, from) =>
      source.sends
        .filter((s) => s.to === index)
        .forEach((s) =>
          lines.push(
            `    AUXRECV ${from} 0 ${gain(s.volume_db)} 0 0 0 0 0 0 -1:U 0 -1`,
          ),
        ),
    );
    if (track.fx.length) {
      lines.push(
        "    <FXCHAIN",
        "      SHOW 0",
        "      LASTSEL 0",
        "      DOCKED 0",
      );
      for (const fx of track.fx)
        lines.push(
          `      BYPASS ${Number(!fx.enabled)} 0 0`,
          `      <JS ${q(fx.name)} ""`,
          `        ${fx.params.join(" ")}`,
          "      >",
          "      WAK 0 0",
        );
      lines.push("    >");
    }
    for (const item of track.items) {
      lines.push(
        "    <ITEM",
        `      POSITION ${item.position}`,
        `      LENGTH ${item.length}`,
        "      LOOP 0",
        `      NAME ${q(item.name)}`,
        "      VOLPAN 1 0 1 -1",
        `      SOFFS ${item.kind === "audio" ? item.offset : 0}`,
        "      PLAYRATE 1 1 0 -1 0 0.0025",
      );
      if (item.kind === "audio")
        lines.push(
          "      <SOURCE WAVE",
          `        FILE ${q(item.file.replaceAll("\\", "/"))}`,
          "      >",
        );
      else {
        lines.push("      <SOURCE MIDI", `        HASDATA 1 ${song.ppq} QN`);
        const events = item.notes.flatMap((n) => [
          {
            tick: n.tick,
            status: 0x90 + n.channel,
            pitch: n.pitch,
            v: n.velocity,
          },
          {
            tick: n.tick + n.duration,
            status: 0x80 + n.channel,
            pitch: n.pitch,
            v: 0,
          },
        ]);
        events.sort(
          (a, b) => a.tick - b.tick || a.status - b.status || a.pitch - b.pitch,
        );
        let last = 0;
        for (const e of events) {
          lines.push(
            `        E ${e.tick - last} ${e.status.toString(16)} ${e.pitch.toString(16).padStart(2, "0")} ${e.v.toString(16).padStart(2, "0")}`,
          );
          last = e.tick;
        }
        const itemBeats =
          secondsToBeat(song, item.position + item.length) -
          secondsToBeat(song, item.position);
        lines.push(
          `        E ${Math.max(0, Math.round(itemBeats * song.ppq) - last)} b0 7b 00`,
          "      >",
        );
      }
      lines.push("    >");
    }
    lines.push("  >");
  }
  lines.push(">", "");
  return lines.join("\n");
}
export function readRpp(text: string): Song {
  const root = parseTree(text);
  const childrenByTag: Record<string, string[]> = {
    REAPER_PROJECT: ["TRACK", "TEMPOENVEX", "EXTSTATE", "RENDER_CFG"],
    TRACK: ["ITEM", "FXCHAIN"],
    ITEM: ["SOURCE"],
    SOURCE: [],
    FXCHAIN: ["JS"],
    JS: [],
    TEMPOENVEX: [],
    EXTSTATE: [],
    RENDER_CFG: [],
  };
  const rowsByTag: Record<string, string[]> = {
    REAPER_PROJECT: [
      "TEMPO",
      "SAMPLERATE",
      "RENDER_FILE",
      "RENDER_PATTERN",
      "RENDER_FMT",
      "RENDER_RANGE",
      "RENDER_DITHER",
      "MARKER",
    ],
    TRACK: ["NAME", "VOLPAN", "MUTESOLO", "MAINSEND", "AUXRECV", "ISBUS"],
    ITEM: [
      "POSITION",
      "LENGTH",
      "LOOP",
      "NAME",
      "VOLPAN",
      "SOFFS",
      "PLAYRATE",
      "FADEIN",
      "FADEOUT",
    ],
    SOURCE: ["HASDATA", "E", "e", "FILE"],
    FXCHAIN: ["SHOW", "LASTSEL", "DOCKED", "BYPASS", "WAK"],
    TEMPOENVEX: ["ACT", "VIS", "PT"],
  };
  const preserve = (node: RppNode): void => {
    for (const child of node.children) {
      if (Array.isArray(child)) {
        const allowed = rowsByTag[node.tag];
        if (allowed && !allowed.includes(child[0] ?? ""))
          throw new ToolError(
            "unsupported_rpp",
            `Cannot preserve ${node.tag} field ${child[0]}`,
          );
      } else {
        if (!childrenByTag[node.tag]?.includes(child.tag))
          throw new ToolError(
            "unsupported_rpp",
            `Unsupported block: ${child.tag}`,
          );
        preserve(child);
      }
    }
  };
  preserve(root);
  // Conversion deliberately refuses DAW features we cannot preserve yet.
  const unsupported = [
    "VST",
    "VST3",
    "CLAP",
    "AU",
    "VIDEO_EFFECT",
    "TAKE",
    "SOURCE SECTION",
    "VOLENV",
    "PANENV",
    "PARMENV",
    "MIDIPOOL",
  ];
  const visit = (n: RppNode): void => {
    if (
      unsupported.includes(n.tag) ||
      (n.tag.includes("ENV") && n.tag !== "TEMPOENVEX")
    )
      throw new ToolError("unsupported_rpp", `Unsupported block: ${n.tag}`);
    for (const c of n.children) if (!Array.isArray(c)) visit(c);
  };
  visit(root);
  const ext = blocks(root, "EXTSTATE")[0];
  const extValue = (key: string) =>
    ext?.children.find(
      (c) => Array.isArray(c) && c[0] === "REAPER_MCP" && c[1] === key,
    ) as string[] | undefined;
  const song = songSchema.parse({
    name: extValue("song_name")?.[2] ?? "Imported",
    ppq: Number(extValue("ppq")?.[2] ?? 960),
    tempo: val(root, "TEMPO", 1, 120),
    numerator: val(root, "TEMPO", 2, 4),
    denominator: val(root, "TEMPO", 3, 4),
    render: {
      sampleRate: val(root, "SAMPLERATE", 1, 44100),
      channels: val(root, "RENDER_FMT", 2, 2),
      start: val(root, "RENDER_RANGE", 2, 0),
      end: Math.max(0.001, val(root, "RENDER_RANGE", 3, 4)),
    },
  });
  const tempo = blocks(root, "TEMPOENVEX")[0];
  if (tempo)
    for (const c of tempo.children)
      if (Array.isArray(c) && c[0] === "PT") {
        if (Number(c[3]) !== 1)
          throw new ToolError(
            "unsupported_rpp",
            "Only step tempo changes are supported",
          );
        const beat = secondsToBeat(song, Number(c[1]));
        const packed = Number(c[4] ?? 0);
        const point = {
          beat,
          bpm: Number(c[2]),
          ...(packed
            ? {
                numerator: packed & 65535,
                denominator: (packed >>> 16) as 1 | 2 | 4 | 8 | 16,
              }
            : {}),
        };
        if (
          !(
            song.tempoMap.length === 0 &&
            beat === 0 &&
            point.bpm === song.tempo &&
            !packed
          )
        )
          song.tempoMap.push(point);
      }
  const regionStarts = new Map<number, Song["markers"][number]>();
  for (const c of root.children)
    if (Array.isArray(c) && c[0] === "MARKER") {
      const id = Number(c[1]);
      if (Number(c[4]) === 1 && regionStarts.has(id))
        regionStarts.get(id)!.end = Number(c[2]);
      else {
        const marker = { id, position: Number(c[2]), name: c[3] ?? "" };
        song.markers.push(marker);
        if (Number(c[4]) === 1) regionStarts.set(id, marker);
      }
    }
  const trackNodes = blocks(root, "TRACK");
  for (const node of trackNodes) {
    if (val(node, "ISBUS", 1, 0) !== 0)
      throw new ToolError(
        "unsupported_rpp",
        "Folder routing is not supported by this converter",
      );
    if (val(node, "MUTESOLO", 2, 0) !== 0)
      throw new ToolError(
        "unsupported_rpp",
        "Solo state is not supported by this converter",
      );
    const track = trackSchema.parse({
      name: leaf(node, "NAME")?.[1] ?? "Track",
      volume_db: db(val(node, "VOLPAN", 1, 1)),
      pan: val(node, "VOLPAN", 2, 0),
      mute: !!val(node, "MUTESOLO"),
      mainSend: !!val(node, "MAINSEND", 1, 1),
    });
    const chain = blocks(node, "FXCHAIN")[0];
    if (chain) {
      let enabled = true;
      for (const c of chain.children) {
        if (Array.isArray(c)) {
          if (c[0] === "BYPASS") enabled = c[1] === "0";
        } else {
          if (c.tag !== "JS")
            throw new ToolError(
              "unsupported_rpp",
              "Only JSFX state is supported",
            );
          track.fx.push({
            kind: "JS",
            name: c.args[0] ?? "",
            enabled,
            params: c.children.flatMap((p) =>
              Array.isArray(p) ? p.map(Number) : [],
            ),
          });
        }
      }
    }
    for (const item of blocks(node, "ITEM")) {
      if (
        val(item, "LOOP") !== 0 ||
        val(item, "PLAYRATE", 1, 1) !== 1 ||
        val(item, "VOLPAN", 1, 1) !== 1
      )
        throw new ToolError(
          "unsupported_rpp",
          "Looped, stretched or gain-adjusted items are not supported",
        );
      if (val(item, "FADEIN", 2, 0) !== 0 || val(item, "FADEOUT", 2, 0) !== 0)
        throw new ToolError(
          "unsupported_rpp",
          "Nonzero item fades cannot yet be preserved",
        );
      const sources = blocks(item, "SOURCE");
      if (sources.length !== 1)
        throw new ToolError(
          "unsupported_rpp",
          "Exactly one source per item required",
        );
      const source = sources[0]!;
      const base = {
        name: leaf(item, "NAME")?.[1] ?? "",
        position: val(item, "POSITION"),
        length: val(item, "LENGTH"),
      };
      if (source.args[0] === "WAVE")
        track.items.push({
          ...base,
          kind: "audio",
          file: leaf(source, "FILE")?.[1] ?? "",
          offset: val(item, "SOFFS"),
        });
      else if (source.args[0] === "MIDI") {
        if (val(item, "SOFFS") !== 0)
          throw new ToolError(
            "unsupported_rpp",
            "MIDI source offsets are not supported",
          );
        const ppq = val(source, "HASDATA", 2, 960);
        const ratio = song.ppq / ppq;
        const notes: Extract<
          Song["tracks"][number]["items"][number],
          { kind: "midi" }
        >["notes"] = [];
        const active = new Map<string, { tick: number; velocity: number }[]>();
        let tick = 0;
        for (const e of source.children)
          if (Array.isArray(e) && e[0]?.toUpperCase() === "E") {
            tick += Number(e[1]);
            const status = parseInt(e[2]!, 16),
              pitch = parseInt(e[3]!, 16),
              velocity = parseInt(e[4]!, 16),
              kind = status & 240,
              channel = status & 15,
              key = `${channel}:${pitch}`;
            if (kind === 144 && velocity) {
              const queue = active.get(key) ?? [];
              queue.push({ tick, velocity });
              active.set(key, queue);
            } else if (kind === 128 || kind === 144) {
              const start = active.get(key)?.shift();
              if (!start)
                throw new ToolError("invalid_rpp", "Unmatched MIDI note off");
              notes.push({
                tick: Math.round(start.tick * ratio),
                duration: Math.round((tick - start.tick) * ratio),
                pitch,
                velocity: start.velocity,
                channel,
              });
            } else if (!(kind === 176 && pitch === 123))
              throw new ToolError(
                "unsupported_rpp",
                "MIDI controllers or other events cannot yet be preserved",
              );
          }
        if ([...active.values()].some((q) => q.length))
          throw new ToolError("invalid_rpp", "Unmatched MIDI note on");
        notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
        track.items.push({ ...base, kind: "midi", notes });
      } else
        throw new ToolError(
          "unsupported_rpp",
          "Only WAVE and MIDI sources are supported",
        );
    }
    song.tracks.push(track);
  }
  trackNodes.forEach((node, to) =>
    node.children.forEach((c) => {
      if (Array.isArray(c) && c[0] === "AUXRECV") {
        const source = song.tracks[Number(c[1])];
        if (!source)
          throw new ToolError("invalid_rpp", "Invalid receive source");
        source.sends.push({ to, volume_db: db(Number(c[3])) });
      }
    }),
  );
  if (val(root, "RENDER_RANGE", 1, 1) === 1)
    song.render.end = Math.max(
      0.001,
      ...song.tracks.flatMap((t) => t.items.map((i) => i.position + i.length)),
    );
  return songSchema.parse(song);
}
