// Arrangement lint: note-level checks on a saved project, with no audio needed.
// The rules work on a plain model so they can be unit tested without LMMS. See docs/arranger-lint.md.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Every number the rules use. docs/arranger-lint.md explains each one.
export const thresholds = {
  lineFloorMidi: 48, // median pitch below this is bass register, not a melody
  inferredBassMedian: 55, // the lowest moving line below this is inferred as bass when no role says otherwise
  melodicMinOnsets: 3, melodicMinPitches: 3, monophonicShare: 0.75,
  maxMelodicVoices: 2,
  overlapShare: 0.6,
  bassMaxMedian: 55, bassMaxNote: 67,
  harshIntervals: [1, 13], clashErrorShare: 0.25, clashErrorMinHits: 4,
  leadOverhangTicks: 48, counterLeadWindow: 4, figureMaxPeriod: 8, figureMaxPitches: 4, figureMinOnsets: 6,
  outOfKeyWarning: 0.1, outOfKeyError: 0.25, keyConfidence: 0.5,
  maxOnsetsPerBar: 40, maxActiveParts: 6,
  staticBars: 8, developmentMinBars: 16, developmentMaxPeriod: 4,
  motifMinBars: 4, motifSimilarity: 0.75, noRepeatShare: 0.25, onlyRepeatUnique: 0.2, onlyRepeatMinBars: 8,
  maxLeap: 12, maxRange: 24,
};
export const scoring = { error: 15, warning: 5, note: 1, ruleCap: 30, audioWarning: 4, audioCap: 20, silentAudio: 40, passScore: 70 };

const pitchNames = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const modes = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10, 11], // minor allows the raised leading note
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], 'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
};
const modeWords = { '': 'major', maj: 'major', major: 'major', m: 'minor', min: 'minor', minor: 'minor', aeolian: 'minor',
  ionian: 'major', dorian: 'dorian', phrygian: 'phrygian', lydian: 'lydian', mixolydian: 'mixolydian', 'harmonic minor': 'harmonic minor' };

// "D minor", "Dm", "F#", "Bb dorian" -> { tonic, mode, name }
export function parseKey(text) {
  const match = /^\s*([A-Ga-g])([#b]?)\s*([a-z ]*?)\s*$/i.exec(String(text));
  const word = match?.[3].toLowerCase().replace(/\s+/g, ' ');
  if (!match || !(word in modeWords)) throw new Error(`Unknown key "${text}". Use a name such as "D minor", "Dm", "F# major" or "A dorian".`);
  const tonic = (({ c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 })[match[1].toLowerCase()] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0) + 12) % 12;
  const mode = modeWords[word];
  return { tonic, mode, name: `${pitchNames[tonic]} ${mode}` };
}

// Krumhansl-Kessler key profiles, correlated with a duration-weighted pitch-class histogram.
const profiles = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};
function correlate(a, b) {
  const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
export function detectKey(notes) {
  const histogram = new Array(12).fill(0);
  for (const n of notes) histogram[n.midi % 12] += Math.min(n.length, 192);
  if (!histogram.some(Boolean)) return null;
  let best = null;
  for (const mode of ['major', 'minor']) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = histogram.map((_, i) => histogram[(i + tonic) % 12]);
      const score = correlate(rotated, profiles[mode]);
      if (!best || score > best.confidence) best = { tonic, mode, name: `${pitchNames[tonic]} ${mode}`, confidence: Number(score.toFixed(2)) };
    }
  }
  return best;
}

// ---------- model ----------
// A model is { ticksPerBar, bars, meter, tracks: [{ name, role, kind: 'synth' | 'sample', notes: [{ tick, length, midi, velocity }] }] }.
// Ticks are absolute song positions. Bars start at zero.
export function modelFromDoc(doc, { tracks, children, songInfo, isAnchor, trackRole }) {
  const info = songInfo(doc);
  const out = [], skipped = [];
  for (const t of tracks(doc)) {
    if (isAnchor(t) || t.getAttribute('muted') === '1') continue;
    const name = t.getAttribute('name');
    if (t.getAttribute('type') === '1') { skipped.push(`${name} (Beat/Bassline track)`); continue; }
    if (t.getAttribute('type') !== '0') continue;
    const instrument = children(children(t, 'instrumenttrack')[0], 'instrument')[0]?.getAttribute('name') ?? '';
    const notes = [];
    for (const clip of children(t, 'pattern')) {
      if (clip.getAttribute('muted') === '1') continue;
      const pos = Number(clip.getAttribute('pos')) || 0;
      for (const n of children(clip, 'note')) {
        const length = Number(n.getAttribute('len'));
        notes.push({ tick: pos + Number(n.getAttribute('pos')), length: length > 0 ? length : 12,
          midi: Number(n.getAttribute('key')) + 12, velocity: Number(n.getAttribute('vol') || 100) });
      }
    }
    out.push({ name, role: trackRole(t), kind: instrument === 'audiofileprocessor' ? 'sample' : 'synth', notes });
  }
  return { ticksPerBar: info.ticksPerBar, meter: info.meter, bars: Math.max(1, Math.ceil(info.lengthBars - 1e-9)), tracks: out, skipped };
}

// ---------- per-track features ----------
const median = values => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
function groupOnsets(notes) {
  const groups = [];
  for (const n of notes) {
    const last = groups.at(-1);
    if (last && last.tick === n.tick) last.notes.push(n); else groups.push({ tick: n.tick, notes: [n] });
  }
  for (const g of groups) g.top = Math.max(...g.notes.map(n => n.midi));
  return groups;
}
// An arpeggio or ostinato: evenly spaced onsets that cycle with a period of up to eight notes,
// or six or more evenly spaced onsets on four or fewer pitches (a broken chord).
export function isFigure(groups) {
  if (groups.length < 4) return false;
  const gap = groups[1].tick - groups[0].tick;
  if (groups.some((g, i) => i && g.tick - groups[i - 1].tick !== gap)) return false;
  const line = groups.map(g => g.top);
  if (line.length >= thresholds.figureMinOnsets && new Set(line).size <= thresholds.figureMaxPitches) return true;
  for (let period = 1; period <= thresholds.figureMaxPeriod && period * 2 <= line.length; period++) {
    if (line.every((p, i) => i < period || p === line[i - period])) return true;
  }
  return false;
}
function describeBar(onsets, sounding) {
  const groups = groupOnsets(onsets);
  const single = groups.filter(g => g.notes.length === 1).length;
  return {
    onsets, sounding, groups,
    pitches: new Set(groups.map(g => g.top)).size,
    monophonic: groups.length ? single / groups.length : 0,
    median: median(sounding.map(n => n.midi)),
    figure: isFigure(groups),
  };
}
function analyseTrack(track, model) {
  const { ticksPerBar: tpb, bars } = model;
  const notes = [...track.notes].sort((a, b) => a.tick - b.tick || a.midi - b.midi);
  const onsetBuckets = Array.from({ length: bars }, () => []), soundBuckets = Array.from({ length: bars }, () => []);
  for (const n of notes) {
    const first = Math.floor(n.tick / tpb);
    if (first >= bars) continue;
    onsetBuckets[first].push(n);
    const last = Math.min(bars - 1, Math.floor((n.tick + n.length - 1) / tpb));
    for (let b = first; b <= last; b++) soundBuckets[b].push(n);
  }
  const pitchSet = new Set(notes.map(n => n.midi));
  const drums = track.role === 'drums' || (notes.length > 0 && (track.kind === 'sample' || notes.every(n => n.length <= 12)) && pitchSet.size <= 3 && !track.role);
  const perBar = onsetBuckets.map((onsets, b) => describeBar(onsets, soundBuckets[b]));
  const t = thresholds;
  for (const bar of perBar) {
    bar.melodic = !drums && bar.groups.length >= t.melodicMinOnsets && bar.pitches >= t.melodicMinPitches &&
      bar.monophonic >= t.monophonicShare && bar.median >= t.lineFloorMidi && !bar.figure;
  }
  const groups = groupOnsets(notes);
  const active = perBar.filter(b => b.sounding.length).length;
  return {
    name: track.name, declared: track.role, kind: track.kind, notes, perBar, drums, groups,
    median: median(notes.map(n => n.midi)), min: notes.length ? Math.min(...pitchSet) : null, max: notes.length ? Math.max(...pitchSet) : null,
    polyShare: groups.length ? groups.filter(g => g.notes.length >= 2).length / groups.length : 0,
    meanLength: notes.length ? notes.reduce((s, n) => s + n.length, 0) / notes.length : 0,
    melodicShare: active ? perBar.filter(b => b.melodic).length / active : 0,
  };
}
// Guess a role from how the notes behave.
export function inferRole(info) {
  if (info.drums) return 'drums';
  if (!info.notes.length) return 'texture';
  if (info.polyShare >= 0.5) return 'harmony';
  if (info.median < thresholds.lineFloorMidi) return 'bass';
  if (info.melodicShare >= 0.3) return 'melodic';
  if (info.meanLength >= 96) return 'harmony';
  return 'texture';
}

// ---------- helpers for findings ----------
export function barRanges(bars) {
  const sorted = [...new Set(bars)].sort((a, b) => a - b), parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return parts.join(', ');
}
const finding = (rule, severity, message, bars, tracks, fix) => ({ rule, severity, message, bars: [...new Set(bars)].sort((a, b) => a - b), tracks: [...new Set(tracks)], fix });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const where = bars => bars.length ? (bars.length === 1 ? ` in bar ${bars[0]}` : ` in bars ${barRanges(bars)}`) : '';

// ---------- context ----------
export function buildContext(model) {
  const infos = model.tracks.map(track => analyseTrack(track, model));
  for (const info of infos) info.inferred = info.declared ? null : inferRole(info);
  // The lowest moving line in the tenor register is a bass line (a walking bass), unless a bass is declared.
  if (!infos.some(i => i.declared === 'bass' || i.inferred === 'bass')) {
    const pitched = infos.filter(i => !i.drums && i.notes.length).sort((a, b) => a.median - b.median);
    if (pitched[0]?.inferred === 'melodic' && pitched[0].median < thresholds.inferredBassMedian) pitched[0].inferred = 'bass';
  }
  // Inferred melodic lines: the highest becomes the lead unless a lead is declared; the rest are counters.
  const declaredLead = infos.some(i => i.declared === 'lead');
  const melodic = infos.filter(i => i.inferred === 'melodic').sort((a, b) => b.median - a.median);
  melodic.forEach((info, index) => { info.inferred = !declaredLead && index === 0 ? 'lead' : 'counter'; });
  for (const info of infos) info.role = info.declared ?? info.inferred;
  return { model, infos, tpb: model.ticksPerBar, bars: model.bars };
}

// ---------- rules ----------
export function checkRoles(ctx) {
  const out = [];
  for (const info of ctx.infos.filter(i => !i.declared && i.notes.length)) {
    out.push(finding('role.missing', 'note', `"${info.name}" has no role; it behaves like ${info.inferred}.`, [], [info.name],
      `Call set_track_role with trackName "${info.name}" and role "${info.inferred}" (or the role you intend).`));
  }
  const active = (role, b) => ctx.infos.filter(i => i.declared === role && plays(ctx, i, b));
  const leads = {}, counters = {}, lonely = [];
  const leadBars = [...Array(ctx.bars).keys()].filter(b => active('lead', b).length);
  for (let b = 0; b < ctx.bars; b++) {
    const l = active('lead', b), c = active('counter', b);
    // Doublings (same rhythm and contour) are one line, so an octave-doubled lead is not two leads.
    if (voicesOf(l, b).length > 1) (leads[l.map(i => i.name).join('|')] ??= []).push(b);
    if (voicesOf(c, b).length > 1) (counters[c.map(i => i.name).join('|')] ??= []).push(b);
    // Call and response is fine: only a counter with no lead within a few bars either side is alone.
    if (c.length && !leadBars.some(x => Math.abs(x - b) <= thresholds.counterLeadWindow)) lonely.push(...c.map(i => ({ b, name: i.name })));
  }
  for (const [names, bars] of Object.entries(leads)) {
    out.push(finding('role.multiple-leads', 'error', `${names.split('|').length} lead tracks (${names.split('|').join(', ')}) play at once${where(bars)}.`, bars, names.split('|'),
      'Keep one lead per bar: move the others to counter, harmony or texture, or give them different sections.'));
  }
  for (const [names, bars] of Object.entries(counters)) {
    out.push(finding('role.multiple-counters', 'warning', `${names.split('|').length} counter-melodies (${names.split('|').join(', ')}) play at once${where(bars)}.`, bars, names.split('|'),
      'Keep at most one counter-melody under the lead; turn the others into harmony or rests.'));
  }
  const byTrack = {};
  for (const { b, name } of lonely) (byTrack[name] ??= []).push(b);
  for (const [name, bars] of Object.entries(byTrack)) {
    out.push(finding('role.counter-without-lead', 'warning', `Counter "${name}" plays with no lead within ${thresholds.counterLeadWindow} bars${where(bars)}.`, bars, [name],
      `Either add the lead in those bars or set "${name}" to lead there.`));
  }
  return out;
}

// A track plays in a bar when a note starts there, or a held note covers more than a short overhang of it.
export function plays(ctx, info, b) {
  const bar = info.perBar[b];
  if (bar.onsets.length) return true;
  const start = b * ctx.tpb, end = start + ctx.tpb;
  return bar.sounding.some(n => Math.min(end, n.tick + n.length) - Math.max(start, n.tick) > thresholds.leadOverhangTicks);
}
// Group tracks into lines for one bar. Tracks with the same rhythm and contour (doublings in octaves, thirds or sixths) are one line.
export function voicesOf(infos, b) {
  const voices = [];
  for (const info of infos) {
    const bar = info.perBar[b];
    const rhythm = bar.groups.map(g => g.tick).join(',');
    const contour = bar.groups.map((g, k) => k ? Math.sign(g.top - bar.groups[k - 1].top) : 0).join(',');
    const same = rhythm && voices.find(v => v.rhythm === rhythm && v.contour === contour);
    if (same) same.tracks.push(info.name); else voices.push({ rhythm, contour, tracks: [info.name] });
  }
  return voices.map(v => v.tracks);
}
// Roles that support the melody. Their lines never count as competing melodies, however they move.
const supportRoles = ['drums', 'bass', 'harmony', 'texture'];
// Melodic voices in a bar, from tracks not declared as a supporting role.
export function melodicVoices(ctx, b) {
  return voicesOf(ctx.infos.filter(i => i.perBar[b].melodic && !supportRoles.includes(i.declared) && i.inferred !== 'bass'), b);
}
export function checkCompetingMelodies(ctx) {
  const bad = [], involved = new Set();
  for (let b = 0; b < ctx.bars; b++) {
    const voices = melodicVoices(ctx, b);
    if (voices.length > thresholds.maxMelodicVoices) { bad.push({ b, count: voices.length }); voices.flat().forEach(n => involved.add(n)); }
  }
  if (!bad.length) return [];
  const most = Math.max(...bad.map(x => x.count));
  return [finding('melody.competing', 'error',
    `Up to ${most} independent melodies play at once${where(bad.map(x => x.b))} (${[...involved].join(', ')}); listeners can follow at most two.`,
    bad.map(x => x.b), [...involved],
    'Pick one lead and at most one sparse counter-melody; turn the other lines into held chords, an arpeggio, a bass line or rests.')];
}

export function checkRegister(ctx) {
  const out = [];
  const leads = ctx.infos.filter(i => i.role === 'lead');
  const overlap = {}, buried = [], bassHigh = {};
  for (let b = 0; b < ctx.bars; b++) {
    const leadNotes = leads.flatMap(i => i.perBar[b].sounding);
    if (leadNotes.length) {
      const lo = Math.min(...leadNotes.map(n => n.midi)), hi = Math.max(...leadNotes.map(n => n.midi));
      const start = b * ctx.tpb, end = start + ctx.tpb;
      for (const info of ctx.infos.filter(i => i.role === 'harmony' || i.role === 'counter')) {
        let total = 0, inside = 0;
        for (const n of info.perBar[b].sounding) {
          const span = Math.min(end, n.tick + n.length) - Math.max(start, n.tick);
          total += span;
          if (n.midi >= lo && n.midi <= hi) inside += span;
        }
        if (total && inside / total > thresholds.overlapShare) (overlap[info.name] ??= []).push(b);
      }
      const harmonyNotes = ctx.infos.filter(i => i.role === 'harmony').flatMap(i => i.perBar[b].sounding.map(n => n.midi));
      if (harmonyNotes.length && median(leadNotes.map(n => n.midi)) < median(harmonyNotes)) buried.push(b);
    }
    for (const info of ctx.infos.filter(i => i.role === 'bass')) {
      const bar = info.perBar[b];
      if (bar.onsets.length && (median(bar.onsets.map(n => n.midi)) > thresholds.bassMaxMedian || bar.onsets.some(n => n.midi > thresholds.bassMaxNote))) (bassHigh[info.name] ??= []).push(b);
    }
  }
  for (const [name, bars] of Object.entries(overlap)) {
    out.push(finding('register.overlap', 'warning', `"${name}" sits inside the lead's range for most of the bar${where(bars)}, so it masks the melody.`, bars, [name, ...leads.map(i => i.name)],
      `Move "${name}" an octave down, or voice it below the lead's lowest note.`));
  }
  if (buried.length) {
    out.push(finding('register.lead-buried', 'warning', `The lead sits below the harmony${where(buried)}.`, buried, [...leads, ...ctx.infos.filter(i => i.role === 'harmony')].map(i => i.name),
      'Raise the lead an octave or voice the chords lower so the melody is on top.'));
  }
  for (const [name, bars] of Object.entries(bassHigh)) {
    out.push(finding('register.bass-high', 'warning', `Bass "${name}" climbs above its range${where(bars)} (median above ${thresholds.bassMaxMedian} or notes above ${thresholds.bassMaxNote}).`, bars, [name],
      `Transpose "${name}" down an octave; keep bass lines roughly between E1 and G3.`));
  }
  return out;
}

// Harsh intervals between different pitched tracks on strong beats.
export function checkClashes(ctx) {
  const pitched = ctx.infos.filter(i => !i.drums && i.role !== 'fx');
  const strong = ctx.model.meter?.[0] % 2 === 0 || !ctx.model.meter ? [0, ctx.tpb / 2] : [0];
  const pairs = {};
  for (let b = 0; b < ctx.bars; b++) {
    for (const offset of strong) {
      const tick = b * ctx.tpb + offset;
      // A harmony track's chord is every pitch class it plays in the bar (an arpeggio spreads its chord over the bar); other tracks own only what sounds on the beat.
      const at = pitched.map(i => {
        const notes = i.perBar[b].sounding.filter(n => n.tick <= tick && n.tick + n.length > tick);
        return { name: i.name, notes, own: new Set((i.role === 'harmony' ? i.perBar[b].sounding : notes).map(n => n.midi % 12)) };
      }).filter(x => x.notes.length);
      for (let x = 0; x < at.length; x++) {
        for (let y = x + 1; y < at.length; y++) {
          const key = `${at[x].name}|${at[y].name}`;
          const pair = pairs[key] ??= { eligible: 0, bars: [], examples: [] };
          pair.eligible++;
          // A pitch class that one track already plays is part of its chord (a major seventh, an added ninth), so doubling it elsewhere is not a clash.
          const ownX = at[x].own, ownY = at[y].own;
          const hit = at[x].notes.flatMap(a => at[y].notes.filter(c => thresholds.harshIntervals.includes(Math.abs(a.midi - c.midi)) &&
            !ownX.has(c.midi % 12) && !ownY.has(a.midi % 12)).map(c => [a.midi, c.midi]));
          if (hit.length) { pair.bars.push(b); if (pair.examples.length < 3) pair.examples.push(hit[0]); pair.hits = (pair.hits ?? 0) + 1; }
        }
      }
    }
  }
  const out = [];
  for (const [key, pair] of Object.entries(pairs)) {
    if (!pair.hits) continue;
    const share = pair.hits / pair.eligible;
    const names = key.split('|');
    out.push(finding('clash.harsh-interval', pair.hits >= thresholds.clashErrorMinHits && share > thresholds.clashErrorShare ? 'error' : 'warning',
      `"${names[0]}" and "${names[1]}" form minor seconds or minor ninths on ${plural(pair.hits, 'strong beat')}${where(pair.bars)} (for example MIDI ${pair.examples[0].join(' against ')}).`,
      pair.bars, names, 'Move one of the clashing notes to a chord tone on the beat, or delay it to a weak beat as a passing note.'));
  }
  return out;
}

export function checkKey(ctx, key) {
  const notes = ctx.infos.filter(i => !i.drums).flatMap(i => i.notes);
  if (!notes.length || !key) return [];
  if (key.confidence !== undefined && key.confidence < thresholds.keyConfidence) {
    return [finding('key.unclear', 'note', `No clear key: the best match, ${key.name}, scores only ${key.confidence}. The music may be modal, whole-tone or chromatic.`, [], [],
      'Pass key (for example "D dorian") to check the notes against the scale you intend.')];
  }
  const allowed = new Set(modes[key.mode].map(i => (i + key.tonic) % 12));
  let total = 0, outside = 0;
  const strays = {}, bars = [];
  for (const n of notes) {
    const weight = Math.min(n.length, 192);
    total += weight;
    if (!allowed.has(n.midi % 12)) { outside += weight; strays[pitchNames[n.midi % 12]] = true; bars.push(Math.floor(n.tick / ctx.tpb)); }
  }
  const share = outside / total;
  if (share <= thresholds.outOfKeyWarning) return [];
  const tracks = ctx.infos.filter(i => !i.drums && i.notes.some(n => !allowed.has(n.midi % 12))).map(i => i.name);
  // Detection only knows major and minor, so a detected key can warn but never block.
  return [finding('key.out-of-key', share > thresholds.outOfKeyError && key.confidence === undefined ? 'error' : 'warning',
    `${Math.round(share * 100)}% of the pitched note time is outside ${key.name} (${Object.keys(strays).join(', ')})${where(bars)}.`, bars, tracks,
    `Bring the stray notes into ${key.name}, or pass the key you intend if ${key.name} is wrong.`)];
}

const fingerprint = (ctx, b) => ctx.infos.map(i => i.perBar[b].onsets.map(n => `${n.tick - b * ctx.tpb}:${n.midi}:${n.length}`).join(' ')).join('|');
export function checkDensity(ctx) {
  const out = [];
  const crowded = [], busy = [], empty = [];
  for (let b = 0; b < ctx.bars; b++) {
    const pitched = ctx.infos.filter(i => !i.drums);
    if (pitched.reduce((s, i) => s + i.perBar[b].onsets.length, 0) > thresholds.maxOnsetsPerBar) crowded.push(b);
    if (pitched.filter(i => i.perBar[b].sounding.length).length > thresholds.maxActiveParts) busy.push(b);
    if (!ctx.infos.some(i => i.perBar[b].sounding.length)) empty.push(b);
  }
  if (crowded.length) out.push(finding('density.crowded', 'warning', `More than ${thresholds.maxOnsetsPerBar} pitched notes start${where(crowded)}.`, crowded, [],
    'Thin the busiest parts: hold chords instead of repeating them, or give fast lines to one track at a time.'));
  if (busy.length) out.push(finding('density.too-many-parts', 'warning', `More than ${thresholds.maxActiveParts} pitched parts play at once${where(busy)}.`, busy, [],
    'Drop or rest some parts in those bars and bring them in later for contrast.'));
  const filled = [...Array(ctx.bars).keys()].filter(b => !empty.includes(b));
  if (filled.length) {
    const inner = empty.filter(b => b > filled[0] && b < filled.at(-1)), edges = empty.filter(b => !inner.includes(b));
    if (inner.length) out.push(finding('density.empty', 'warning', `Nothing plays${where(inner)}.`, inner, [], 'Fill the gap or shorten the song; silence inside a game loop sounds like a bug.'));
    if (edges.length) out.push(finding('density.empty-edge', 'note', `Nothing plays${where(edges)} at the start or end of the song.`, edges, [],
      'Keep this only if it is a deliberate pause or a tail; otherwise set_song_length to trim it.'));
  }
  // Runs of identical bars.
  const prints = [...Array(ctx.bars).keys()].map(b => fingerprint(ctx, b));
  for (let b = 0; b < ctx.bars;) {
    let e = b;
    while (e + 1 < ctx.bars && prints[e + 1] === prints[b]) e++;
    if (e - b + 1 >= thresholds.staticBars && !empty.includes(b)) {
      const bars = Array.from({ length: e - b + 1 }, (_, k) => b + k);
      out.push(finding('density.static', 'warning', `The same bar repeats unchanged ${e - b + 1} times${where(bars)}.`, bars, [],
        'Vary something every four bars or so: a fill, a new chord, a melody answer or a part dropping out.'));
    }
    b = e + 1;
  }
  if (ctx.bars >= thresholds.developmentMinBars) {
    for (let period = 1; period <= thresholds.developmentMaxPeriod; period++) {
      if (prints.every((p, b) => b < period || p === prints[b - period])) {
        out.push(finding('density.no-development', 'note', `The whole song is one ${plural(period, 'bar')} block repeated ${Math.round(ctx.bars / period)} times.`, [], [],
          'Add a contrasting section or vary the repeats (drop parts, add a counter-line, change the last bar).'));
        break;
      }
    }
  }
  return out;
}

// How alike two bars of a melody are: half rhythm (shared onsets), half intervals.
export function barSimilarity(a, b) {
  const ra = new Set(a.rhythm), rb = new Set(b.rhythm);
  const union = new Set([...ra, ...rb]).size;
  const rhythm = union ? [...ra].filter(x => rb.has(x)).length / union : 1;
  const longest = Math.max(a.intervals.length, b.intervals.length);
  let same = 0;
  for (let i = 0; i < Math.min(a.intervals.length, b.intervals.length); i++) if (a.intervals[i] === b.intervals[i]) same++;
  return 0.5 * rhythm + 0.5 * (longest ? same / longest : 1);
}
export function motifStats(info, ctx) {
  const bars = [];
  info.perBar.forEach((bar, b) => {
    if (bar.groups.length < 2) return;
    const tops = bar.groups.map(g => g.top);
    // Onsets are compared on a 32nd-note grid, so a humanised repeat still counts as a repeat.
    bars.push({ b, rhythm: bar.groups.map(g => Math.round((g.tick - b * ctx.tpb) / 6) * 6), intervals: tops.slice(1).map((p, k) => p - tops[k]), exact: bar.groups.map(g => `${g.tick - b * ctx.tpb}:${g.top}`).join(' ') });
  });
  const related = bars.filter(x => bars.some(y => y !== x && barSimilarity(x, y) >= thresholds.motifSimilarity)).length;
  return { track: info.name, bars: bars.length, relatedShare: bars.length ? Number((related / bars.length).toFixed(2)) : 0,
    uniqueShare: bars.length ? Number((new Set(bars.map(x => x.exact)).size / bars.length).toFixed(2)) : 0, barList: bars.map(x => x.b) };
}
export function checkMotif(ctx) {
  const out = [];
  for (const info of ctx.infos.filter(i => i.role === 'lead')) {
    const stats = motifStats(info, ctx);
    if (stats.bars >= thresholds.motifMinBars && stats.relatedShare < thresholds.noRepeatShare) {
      out.push(finding('motif.no-repetition', 'warning', `Lead "${info.name}" never comes back to its own material: only ${Math.round(stats.relatedShare * 100)}% of its ${stats.bars} bars echo another bar.`, stats.barList, [info.name],
        'Write a one or two bar motif and repeat it, varying the ending or transposing it, instead of new notes every bar.'));
    }
    if (stats.bars >= thresholds.onlyRepeatMinBars && stats.uniqueShare < thresholds.onlyRepeatUnique) {
      out.push(finding('motif.only-repeats', 'warning', `Lead "${info.name}" repeats the same bar: ${Math.round(stats.uniqueShare * stats.bars)} different bars across ${stats.bars}.`, stats.barList, [info.name],
        'Keep the motif but vary it: change the last bar of each phrase, transpose a repeat, or answer it with a new phrase.'));
    }
  }
  return out;
}

export function checkPlayability(ctx) {
  const out = [];
  for (const info of ctx.infos.filter(i => i.role === 'lead' && i.notes.length)) {
    const leaps = [];
    info.groups.forEach((g, k) => { if (k && Math.abs(g.top - info.groups[k - 1].top) > thresholds.maxLeap) leaps.push(Math.floor(g.tick / ctx.tpb)); });
    if (leaps.length) out.push(finding('lead.leap', 'warning', `Lead "${info.name}" leaps more than an octave ${plural(leaps.length, 'time')}${where(leaps)}.`, leaps, [info.name],
      'Fill big leaps with a step or two, or move part of the phrase by an octave.'));
    const range = info.max - info.min;
    if (range > thresholds.maxRange) out.push(finding('lead.range', 'warning', `Lead "${info.name}" spans ${range} semitones, wider than two octaves.`, [], [info.name],
      'Keep the lead within about two octaves; transpose the outlying phrases.'));
  }
  return out;
}

// ---------- entry points ----------
const order = { error: 0, warning: 1, note: 2 };
export function lintModel(model, { key, strict = false } = {}) {
  const ctx = buildContext(model);
  const given = key ? (typeof key === 'string' ? parseKey(key) : key) : null;
  const detected = detectKey(ctx.infos.filter(i => !i.drums).flatMap(i => i.notes));
  const used = given ?? detected;
  const findings = [
    ...checkRoles(ctx), ...checkCompetingMelodies(ctx), ...checkRegister(ctx), ...checkClashes(ctx),
    ...checkKey(ctx, used), ...checkDensity(ctx), ...checkMotif(ctx), ...checkPlayability(ctx),
  ].sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = { error: 0, warning: 0, note: 0 };
  for (const f of findings) counts[f.severity]++;
  const voices = [...Array(ctx.bars).keys()].map(b => melodicVoices(ctx, b).length);
  return {
    pass: counts.error === 0 && (!strict || counts.warning === 0), strict, counts,
    key: used ? { name: used.name, source: given ? 'given' : 'detected', ...(given ? {} : { confidence: used.confidence }) } : null,
    bars: ctx.bars,
    roles: ctx.infos.map(i => ({ track: i.name, role: i.role, ...(i.declared ? {} : { inferred: true }) })),
    melodicVoicesPerBar: voices,
    motif: ctx.infos.filter(i => i.role === 'lead').map(i => { const { barList, ...rest } = motifStats(i, ctx); return rest; }),
    findings,
    ...(model.skipped?.length ? { skipped: model.skipped } : {}),
  };
}

// 0 to 100. Each finding costs points by severity, capped per rule; audio warnings from dsp.advise cost a little each.
export function qualityScore(lint, { audioWarnings = [], silent = false, threshold = scoring.passScore } = {}) {
  const reasons = [];
  const byRule = {};
  for (const f of lint.findings) (byRule[f.rule] ??= []).push(f);
  for (const [rule, list] of Object.entries(byRule)) {
    const raw = list.reduce((s, f) => s + scoring[f.severity], 0);
    const penalty = Math.min(scoring.ruleCap, raw);
    if (penalty) reasons.push({ source: 'arrangement', rule, severity: list[0].severity, penalty, reason: list.map(f => f.message).join(' ') });
  }
  if (silent) reasons.push({ source: 'audio', penalty: scoring.silentAudio, reason: 'The rendered audio is silent.' });
  const audioPenalty = Math.min(scoring.audioCap, audioWarnings.length * scoring.audioWarning);
  if (audioPenalty) reasons.push({ source: 'audio', penalty: audioPenalty, reason: audioWarnings.join(' ') });
  reasons.sort((a, b) => b.penalty - a.penalty);
  const score = Math.max(0, 100 - reasons.reduce((s, r) => s + r.penalty, 0));
  const pass = score >= threshold && lint.counts.error === 0;
  const verdict = pass ? `Pass: ${score} of 100, threshold ${threshold}.`
    : lint.counts.error ? `Fail: ${plural(lint.counts.error, 'arrangement error')} must be fixed (score ${score} of 100).`
      : `Fail: ${score} of 100 is under the threshold of ${threshold}.`;
  return { score, threshold, pass, verdict, reasons };
}

// Short output for the server hooks on create_project, add_track, apply_edits and export_game_audio.
export function hookReport(lint, maxLines = 8) {
  const serious = lint.findings.filter(f => f.severity !== 'note');
  if (!serious.length) return null; // missing roles alone are reported by lint_arrangement, not on every save
  const unroled = lint.roles.filter(r => r.inferred && r.role !== 'texture').map(r => `${r.track} (${r.role})`);
  const warnings = serious.slice(0, maxLines).map(f => `${f.severity.toUpperCase()} ${f.rule}: ${f.message} Fix: ${f.fix}`);
  if (serious.length > maxLines) warnings.push(`${serious.length - maxLines} more; run lint_arrangement for the full list.`);
  if (unroled.length) warnings.push(`Tracks without a role: ${unroled.join(', ')}. Declare them with set_track_role.`);
  return { summary: `Arrangement: ${plural(lint.counts.error, 'error')}, ${plural(lint.counts.warning, 'warning')}.${lint.counts.error ? ' Fix errors before export.' : ''}`,
    blocking: lint.counts.error > 0, warnings };
}

export function register(context) {
  const { tool, z, dsp, schemas, project, root, moduleGuidance } = context;
  const lintProject = async (name, options) => lintModel(modelFromDoc(await project.load(name), project), options);
  const keyArg = z.string().max(40).optional().describe('Key such as "D minor", "Dm" or "A dorian". Detected from the notes when omitted.');

  tool('lint_arrangement', 'Check the arrangement of a saved project from its notes, with no rendering: role limits (one lead, at most one counter), competing melodies, register overlaps, harsh clashes on strong beats, out-of-key notes, crowded, empty or static bars, motif repetition and lead playability. Returns findings with a rule id, severity (error, warning, note), the bars (from zero) and tracks involved, and a one-sentence fix. Run it before rendering and fix every error before export.', {
    project: schemas.projectName, key: keyArg,
    strict: z.boolean().default(false).describe('Also fail on warnings.'),
  }, async ({ project: name, key, strict }) => lintProject(name, { key, strict }));

  tool('quality_report', 'Score a project from 0 to 100 with the reasons listed, combining lint_arrangement findings with audio analysis of an optional rendered WAV (loudness, peaks, clipping, balance and loop seam). Fails on any arrangement error or a score under the threshold.', {
    project: schemas.projectName, audio: schemas.workspaceWav.optional().describe('A render of this project, for example from render_mix.'),
    key: keyArg, loop: z.boolean().default(false).describe('Check the audio as a loop.'),
    targetLufs: schemas.loudnessTarget, threshold: z.number().min(0).max(100).default(scoring.passScore),
  }, async ({ project: name, audio, key, loop, targetLufs, threshold }) => {
    const lint = await lintProject(name, { key });
    let audioReport, audioWarnings = [], silent = false;
    if (audio) {
      const report = dsp.analyze(dsp.decodeWav(await readFile(path.join(root, audio))));
      audioWarnings = dsp.advise(report, { loop, targetLufs });
      silent = report.integratedLufs === null;
      audioReport = { file: audio, integratedLufs: report.integratedLufs, truePeakDbfs: report.truePeakDbfs, clippedSamples: report.clippedSamples,
        stereoCorrelation: report.stereoCorrelation, warnings: audioWarnings };
    }
    const quality = qualityScore(lint, { audioWarnings, silent, threshold });
    return { project: name, ...quality, arrangement: { counts: lint.counts, key: lint.key, roles: lint.roles, findings: lint.findings },
      ...(audioReport ? { audio: audioReport } : { audio: null, audioNote: 'No audio given: render_mix the project and pass the WAV to include mix checks.' }) };
  });

  const check = async doc => hookReport(lintModel(modelFromDoc(doc, project)));
  context.postSave?.push(check);
  context.exportChecks?.push(check);
  moduleGuidance.push('Run lint_arrangement after composing and before rendering; fix every error (competing melodies, two leads, harsh clashes) before export_game_audio. quality_report gives a 0 to 100 score with reasons, and create_project, add_track, apply_edits and export_game_audio attach an arrangement field with the same warnings (pass strict to block on errors).');
}
