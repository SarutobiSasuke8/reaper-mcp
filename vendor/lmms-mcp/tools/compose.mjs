// Whole pieces from a short recipe, with no model in the loop: a chord progression, a phrase-based melody, accompaniment,
// bass and drums, arranged with an intro and an ending. Everything is seeded code, so a batch of seeds can be rendered and ranked.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseKey, pitchClassName } from './motif.mjs';
import { writeMelody, writeAccompaniment, chordPlan, rng } from './melody.mjs';
import { lintModel, modelFromDoc, qualityScore } from './arranger-lint.mjs';
import { writeSolo } from './solo.mjs';
import { swingTick } from '../music.mjs';
import { getPersona } from './personas.mjs';

const BAR = 192, STEP = 12;
const mod = (a, n) => ((a % n) + n) % n;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- chord progressions ----------
const numerals = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };
const templates = {
  major: {
    A: [['I', 'V', 'vi', 'IV'], ['I', 'vi', 'IV', 'V'], ['I', 'IV', 'vi', 'V'], ['I', 'iii', 'IV', 'V'], ['Imaj7', 'vi7', 'ii7', 'V7']],
    B: [['vi', 'IV', 'I', 'V'], ['IV', 'V', 'iii', 'vi'], ['ii', 'V', 'I', 'vi'], ['IV', 'I', 'V', 'vi']],
  },
  minor: {
    A: [['i', 'VI', 'III', 'VII'], ['i', 'iv', 'VI', 'V'], ['i', 'VII', 'VI', 'VII'], ['i', 'VI', 'iv', 'V']],
    B: [['VI', 'VII', 'i', 'i'], ['iv', 'VII', 'III', 'VI'], ['III', 'VII', 'i', 'V'], ['VI', 'iv', 'i', 'V']],
  },
};
export function romanToChord(roman, key) {
  const match = /^([ivIV]+)(.*)$/.exec(roman);
  if (!match || !(match[1].toLowerCase() in numerals)) throw new Error(`Unknown Roman numeral "${roman}"`);
  const root = mod(key.tonic + key.scale[numerals[match[1].toLowerCase()]], 12);
  const minor = match[1] === match[1].toLowerCase();
  const suffix = match[2] === '7' && minor ? 'm7' : match[2] === 'maj7' ? 'maj7' : match[2] === '7' ? '7' : minor ? 'm' : '';
  return pitchClassName(root, key) + suffix;
}
// Eight-bar sections in an A A B A order. Sections lead on with the dominant; the last one comes home to the tonic.
export function writeProgression({ key: keyInput, bars, seed = 1 } = {}) {
  const key = parseKey(keyInput), random = rng(seed + 101);
  const family = templates[key.scale[2] === 3 ? 'minor' : 'major'];
  const tonic = key.scale[2] === 3 ? 'i' : 'I';
  const chosen = { A: random.pick(family.A), B: random.pick(family.B) };
  const chords = [], sections = [];
  const order = ['A', 'A', 'B', 'A'];
  for (let bar = 0, s = 0; bar < bars; s++) {
    const name = order[s % order.length], length = Math.min(8, bars - bar);
    sections.push({ name, bar, bars: length });
    for (let i = 0; i < length; i++) chords.push(chosen[name][i % 4]);
    if (length >= 4) chords[bar + length - 1] = 'V';
    bar += length;
  }
  if (bars >= 2) chords[bars - 2] = 'V';
  chords[bars - 1] = tonic;
  return { key: key.name, numerals: chords, chords: chords.map(roman => romanToChord(roman, key)), sections };
}

// ---------- bass ----------
export const bassStyles = ['roots', 'pulse', 'octaves', 'walking', 'syncopated', 'reggae', 'sub', 'wobble'];
export function writeBass({ chords, bars, style = 'pulse', seed = 1, low = 28, high = 50, baseVelocity = 92, plan: phrasePlan = [], final = true } = {}) {
  if (!bassStyles.includes(style)) throw new Error(`Unknown style "${style}". Use one of: ${bassStyles.join(', ')}`);
  const plan = chordPlan(chords, bars), random = rng(seed + 211), notes = [];
  const liftAt = bar => phrasePlan.find(p => bar >= p.bar && bar < p.bar + p.bars)?.liftDegrees ?? 0;
  const rootOf = (chord, near) => { let best = low; for (let m = low; m <= high; m++) if (mod(m, 12) === chord.root && Math.abs(m - near) < Math.abs(best - near)) best = m; return mod(best, 12) === chord.root ? best : low + mod(chord.root - low, 12); };
  const tone = (chord, root, which) => { const pc = chord.pcs[which % chord.pcs.length]; let m = root + mod(pc - chord.root, 12); return m > high ? m - 12 : m; };
  const push = (tick, length, midi, velocity) => notes.push({ tick: Math.round(tick), length: Math.max(6, Math.round(length)), midi: clamp(midi, low, high + 12), velocity: Math.round(clamp(velocity, 1, 127)) });
  let last = low + 7;
  for (let bar = 0; bar < bars; bar++) {
    const span = BAR / plan[bar].length, gain = baseVelocity + liftAt(bar) * 2;
    plan[bar].forEach((chord, part) => {
      const from = bar * BAR + part * span, root = rootOf(chord, last), next = (plan[bar][part + 1] ?? plan[Math.min(bar + 1, bars - 1)][0]);
      last = root;
      if (final && bar === bars - 1) return push(from, span - 6, root, gain - 4);
      if (style === 'roots') return push(from, span - 8, root, gain);
      if (style === 'sub') { // dub and dubstep: one long low note, sometimes an octave pickup into the next chord
        push(from, span - 30, root, gain);
        if (span >= BAR && random.chance(0.4)) push(from + span - 24, 20, root + 12, gain - 10);
        return;
      }
      if (style === 'reggae') { // heavy and melodic: the root, then space, then a figure that answers the drums
        if (span < BAR) { push(from, 40, root, gain + 2); if (span >= 96) push(from + 48, 40, tone(chord, root, 2), gain - 5); return; }
        const figure = random.pick([
          [[0, 64, 0, 3], [72, 20, 2, -6], [96, 40, 0, 0], [144, 20, 1, -6], [168, 20, 'approach', -8]],
          [[0, 40, 0, 3], [48, 20, 0, -8], [96, 64, 2, -2], [168, 20, 0, -6]],
          [[0, 88, 0, 3], [96, 20, 1, -5], [120, 20, 2, -5], [144, 40, 0, -2]],
        ]);
        for (const [t, len, which, accent] of figure) push(from + t, len, which === 'approach' ? rootOf(next, root) - 2 : which ? tone(chord, root, which) : root, gain + accent + random.spread(2));
        return;
      }
      if (style === 'wobble') { // dubstep: the root retriggered at a rate that changes every half bar
        for (let half = 0; half * 96 < span; half++) {
          const rate = random.pick([48, 24, 24, 16, 12]), lift = half % 2 === 1 && random.chance(0.25) ? 12 : 0;
          for (let t = 0, i = 0; t < 96 && half * 96 + t < span; t += rate, i++) push(from + half * 96 + t, rate - 2, half === 0 && t === 0 ? root : root + lift, gain + (i % 2 === 0 ? 4 : -8) + random.spread(2));
        }
        return;
      }
      if (style === 'pulse' || style === 'octaves') {
        for (let t = 0, i = 0; t < span; t += 24, i++) {
          const up = style === 'octaves' ? i % 2 === 1 : t + 24 >= span && random.chance(0.35);
          push(from + t, 20, up && root + 12 <= high + 12 ? root + 12 : root, gain + (t % 48 === 0 ? 3 : -5) + random.spread(2));
        }
        return;
      }
      if (style === 'walking') {
        const beats = Math.round(span / 48);
        for (let i = 0; i < beats; i++) {
          let midi = i === 0 ? root : tone(chord, root, 1 + Math.floor(random() * (chord.pcs.length - 1)));
          if (i === beats - 1 && beats > 1) { const target = rootOf(next, root); midi = target + (root > target ? 1 : -1); }
          push(from + i * 48, 44, midi, gain + (i % 2 === 0 ? 2 : -4) + random.spread(3));
        }
        return;
      }
      for (const [t, len, which, accent] of [[0, 34, 0, 4], [72, 20, 0, -4], [96, 44, 2, 0], [144, 20, 0, -3]]) if (t < span) push(from + t, len, which ? tone(chord, root, which) : root, gain + accent + random.spread(2));
      if (span >= BAR && random.chance(0.5)) push(from + 168, 20, rootOf(next, root) - 1, gain - 8);
    });
  }
  return { style, bars, notes: notes.sort((a, b) => a.tick - b.tick) };
}

// ---------- drums ----------
const grooves = { // 16 steps per bar: [step, velocity]
  rock: { kick: [[0, 100], [8, 92], [10, 70]], snare: [[4, 96], [12, 98]], hat: [0, 2, 4, 6, 8, 10, 12, 14].map(s => [s, s % 4 === 0 ? 78 : 58]) },
  four: { kick: [[0, 100], [4, 94], [8, 98], [12, 94]], snare: [[4, 88], [12, 90]], hat: [[2, 70], [6, 66], [10, 70], [14, 66]] },
  halftime: { kick: [[0, 100], [10, 78]], snare: [[8, 100]], hat: [0, 2, 4, 6, 8, 10, 12, 14].map(s => [s, s % 4 === 0 ? 72 : 52]) },
  ballad: { kick: [[0, 84], [10, 60]], snare: [[8, 74]], hat: [[0, 56], [4, 46], [8, 54], [12, 46]] },
  onedrop: { kick: [[8, 100]], snare: [[8, 90]], hat: [0, 2, 4, 6, 8, 10, 12, 14].map(s => [s, s % 4 === 2 ? 74 : 50]) }, // reggae: kick and rim together on beat three, nothing on one
  rockers: { kick: [[0, 94], [8, 100]], snare: [[8, 92]], hat: [0, 2, 4, 6, 8, 10, 12, 14].map(s => [s, s % 4 === 2 ? 74 : 50]) },
  steppers: { kick: [[0, 98], [4, 92], [8, 100], [12, 92]], snare: [[8, 90]], hat: [0, 2, 4, 6, 8, 10, 12, 14].map(s => [s, s % 4 === 2 ? 72 : 48]) },
  dubstep: { kick: [[0, 112], [11, 78]], snare: [[8, 112]], hat: [[2, 58], [6, 56], [10, 48], [12, 62], [14, 56]] }, // half-time at 140
  chip: { kick: [[0, 100], [6, 76], [8, 94]], snare: [[4, 94], [12, 96]], hat: Array.from({ length: 16 }, (_, s) => [s, s % 4 === 0 ? 74 : s % 2 === 0 ? 58 : 40]) },
};
export const drumStyles = [...Object.keys(grooves), 'swing', 'none'];
export function writeDrums({ bars, style = 'rock', seed = 1, phraseBars = 4, plan: phrasePlan = [], quietBars = 0, ending = true, build = false, crashAtStart = false } = {}) {
  if (!drumStyles.includes(style)) throw new Error(`Unknown style "${style}". Use one of: ${drumStyles.join(', ')}`);
  const random = rng(seed + 307), parts = { kick: [], snare: [], hat: [], crash: [] };
  if (style === 'none') return { style, bars, parts };
  const liftAt = bar => phrasePlan.find(p => bar >= p.bar && bar < p.bar + p.bars)?.liftDegrees ?? 0;
  const hit = (part, bar, tick, velocity, length = 40) => parts[part].push({ tick: bar * BAR + Math.round(tick), length: Math.min(length, bars * BAR - bar * BAR - Math.round(tick)), midi: 69, velocity: Math.round(clamp(velocity, 1, 127)) });
  for (let bar = 0; bar < bars; bar++) {
    const gain = 0.86 + liftAt(bar) * 0.035, last = ending && bar === bars - 1;
    if (crashAtStart && bar === 0 && quietBars === 0 && !last) hit('crash', bar, 0, 80 * gain, 380);
    if (build && bar === bars - 1 && style !== 'swing' && bar >= quietBars) { // a snare build into the next section, with the hats dropped
      for (let step = 0; step < 16; step++) hit('snare', bar, step * STEP, (44 + step * 4) * gain);
      for (const step of [0, 4, 8, 12]) hit('kick', bar, step * STEP, 90 * gain);
      continue;
    }
    const fill = !last && bar >= quietBars && (bar - quietBars) % phraseBars === phraseBars - 1;
    if (last) { hit('kick', bar, 0, 100 * gain); hit('crash', bar, 0, 92, 380); continue; }
    if (bar > quietBars && (bar - quietBars) % phraseBars === 0) hit('crash', bar, 0, 78 * gain, 380);
    if (style === 'swing') {
      for (const [t, v] of [[0, 76], [48, 70], [80, 48], [96, 74], [144, 70], [176, 48]]) if (!(v < 60 && random.chance(0.1))) hit('hat', bar, t + 2, v * gain + random.spread(4), 110);
      if (bar < quietBars) continue;
      for (const t of [0, 48, 96, 144]) hit('kick', bar, t, 34 * gain + random.spread(3));
      if (fill) [96, 112, 128, 144, 160, 176].forEach((t, i) => hit('snare', bar, t, (50 + i * 8) * gain));
      else for (const t of [32, 80, 128, 176].filter(() => random.chance(0.3))) hit('snare', bar, t, (random.chance(0.25) ? 78 : 40) * gain);
      continue;
    }
    const groove = grooves[style];
    for (const [s, v] of groove.hat) if (!(fill && s >= 12)) hit('hat', bar, s * STEP + (s % 2 ? random.spread(1) : 0), v * gain + random.spread(3), 24);
    if (bar < quietBars) continue;
    for (const [s, v] of groove.kick) hit('kick', bar, s * STEP, v * gain + random.spread(2));
    if (random.chance(0.22) && !['ballad', 'onedrop', 'rockers', 'steppers'].includes(style)) hit('kick', bar, 14 * STEP, 66 * gain); // reggae grooves keep their kick pattern exact
    for (const [s, v] of groove.snare) if (!(fill && s >= 12)) hit('snare', bar, s * STEP, v * gain + random.spread(2));
    if (fill) (style === 'ballad' ? [12, 14] : [12, 13, 14, 15]).forEach((s, i) => hit('snare', bar, s * STEP, (62 + i * 11) * gain));
  }
  return { style, bars, parts };
}

// ---------- styles ----------
export const { styles } = JSON.parse(await readFile(new URL('./styles.json', import.meta.url), 'utf8'));
export const styleNames = Object.keys(styles);

// ---------- the piece ----------
// The form in four-bar units, chosen to fit the length: a short piece states and restates, a longer one adds a contrast and a solo.
export function planForm(totalBars) {
  if (totalBars < 8) throw new Error('A piece needs at least 8 bars');
  const intro = totalBars >= 14 ? 2 : 0;
  const units = Math.floor((totalBars - intro - 1) / 4), ending = totalBars - intro - units * 4;
  const table = { 1: [['theme', 4]], 2: [['theme', 8]], 3: [['theme', 8], ['return', 4]], 4: [['theme', 8], ['solo', 4], ['return', 4]], 5: [['theme', 8], ['solo', 8], ['return', 4]],
    6: [['theme', 8], ['contrast', 4], ['solo', 8], ['return', 4]], 7: [['theme', 8], ['contrast', 4], ['solo', 8], ['return', 8]], 8: [['theme', 8], ['contrast', 8], ['solo', 8], ['return', 8]] };
  let body = table[Math.min(units, 8)].map(([kind, bars]) => ({ kind, bars }));
  for (let extra = units - 8, turn = 0; extra > 0; turn++) { // longer pieces: say the theme twice, stretch the solo, then add a bridge before the return
    const again = body.find(x => x.kind === 'theme again'), solo = body.find(x => x.kind === 'solo'), bridge = body.find(x => x.kind === 'bridge');
    if (turn % 2 === 0 && (!again || again.bars < 8)) { if (again) again.bars += 4; else body.splice(1, 0, { kind: 'theme again', bars: 4 }); extra--; }
    else if (turn % 2 === 1 && solo.bars < 16) { solo.bars += 4; extra--; }
    else if (!bridge || bridge.bars < 8) { if (bridge) bridge.bars += 4; else body.splice(body.length - 1, 0, { kind: 'bridge', bars: 4 }); extra--; }
    else if (turn > 40) { body.at(-1).bars += 4 * extra; extra = 0; }
  }
  const sections = [...(intro ? [{ kind: 'intro', bars: intro }] : []), ...body, { kind: 'ending', bars: ending }];
  let bar = 0;
  return sections.map(section => { const placed = { name: section.kind, kind: section.kind, startBar: bar, bars: section.bars }; bar += section.bars; return placed; });
}

const alternates = { // how each part changes from the theme, so every section sounds like a new place
  harmony: { contrast: { arpeggio: 'broken', flowing: 'arpeggio', broken: 'arpeggio', block: 'block' }, solo: { arpeggio: 'held', flowing: 'broken', broken: 'held', block: 'held' },
    return: { arpeggio: 'flowing', flowing: 'flowing', broken: 'arpeggio', block: 'block' } },
  bass: { contrast: { wobble: 'sub', roots: 'pulse', pulse: 'roots', octaves: 'pulse', walking: 'walking', syncopated: 'roots' }, solo: { roots: 'pulse', pulse: 'syncopated', octaves: 'octaves', walking: 'walking', syncopated: 'syncopated' } },
  drums: { contrast: { onedrop: 'rockers', rockers: 'steppers', steppers: 'onedrop', dubstep: 'dubstep', rock: 'halftime', four: 'halftime', chip: 'halftime', halftime: 'rock', ballad: 'ballad', swing: 'swing', none: 'none' } },
};

function personaKeys(persona, keys) {
  if (!persona) return keys;
  if (persona.harmony.keys) return persona.harmony.keys;
  const supported = [];
  for (const mode of [...persona.harmony.modes, ...persona.harmony.scales]) {
    try { supported.push(parseKey(`C ${mode}`).mode); } catch { /* A future harmony engine may recognise this name. */ }
  }
  return supported.length ? keys.map((key, index) =>
    `${key.split(' ')[0]} ${supported[index % supported.length]}`) : keys;
}

export function composePiece({ style: requestedStyle, persona, key, bpm, bars, seconds, seed = 1, voices = {} } = {}, { personasDirectory } = {}) {
  const profile = persona === undefined ? undefined : getPersona(persona, personasDirectory);
  const pattern = profile?.drums.patterns;
  const styleName = requestedStyle ?? (Object.hasOwn(styles, pattern) ? pattern : 'adventure');
  if (!Object.hasOwn(styles, styleName)) throw new Error(`Unknown style "${styleName}". Use one of: ${styleNames.join(', ')}`);
  const style = styles[styleName];
  const drumsStyle = requestedStyle === undefined && drumStyles.includes(pattern) ? pattern : style.drums;
  const bassStyle = bassStyles.includes(profile?.bass.archetype) ? profile.bass.archetype : style.bass;
  const melodyOptions = { ...style.melody };
  if (profile) {
    melodyOptions.phraseBars = profile.arrangement.phraseBars;
    if (profile.groove.humanizeMs !== undefined) {
      melodyOptions.feel = { humanize: Math.round(profile.groove.humanizeMs * (bpm ?? profile.tempo.default) * 48 / 60000) };
    }
  }
  const random = rng(seed + 11), tempo = bpm ?? profile?.tempo.default ?? style.bpm;
  const keyName = key ?? random.pick(personaKeys(profile, style.keys));
  if (bars !== undefined && seconds !== undefined) throw new Error('Give bars or seconds, not both');
  const total = bars ?? Math.max(8, Math.round((seconds ?? 60) * tempo / 240));
  if (total < 8 || total > 200) throw new Error('A piece needs between 8 and 200 bars');
  const parsedKey = parseKey(keyName), minor = parsedKey.scale[2] === 3;
  const family = templates[minor ? 'minor' : 'major'], pickRandom = rng(seed + 101);
  const progressions = profile?.harmony.progressions;
  const chosen = progressions?.length
    ? { A: pickRandom.pick(progressions), B: pickRandom.pick(progressions) }
    : { A: pickRandom.pick(family.A), B: pickRandom.pick(family.B) };
  const tonic = romanToChord(minor ? 'i' : 'I', parsedKey), sub = romanToChord(minor ? 'iv' : 'IV', parsedKey), dominant = romanToChord('V', parsedKey);
  const sections = planForm(total);
  const lastBody = sections.at(-2);
  // Chords: the theme, the solo and the return share one progression, the contrast and the bridge take another. Sections lead on with the dominant.
  for (const section of sections) {
    const template = ['contrast', 'bridge'].includes(section.kind) ? chosen.B : chosen.A;
    if (section.kind === 'ending') section.chords = Array.from({ length: section.bars }, (_, i) => section.bars > 1 && i === 0 ? sub : tonic);
    else {
      section.chords = Array.from({ length: section.bars }, (_, i) => romanToChord(template[i % template.length], parsedKey));
      if (section.kind !== 'intro' && section.bars >= 4) section.chords[section.bars - 1] = dominant;
      if (section === lastBody && section.bars >= 2) { section.chords[section.bars - 2] = dominant; section.chords[section.bars - 1] = tonic; }
    }
  }
  const chords = sections.flatMap(section => section.chords);
  const shift = (notes, by) => notes.map(note => ({ ...note, tick: note.tick + by * BAR }));
  const lead = [], plan = [], harmony = [], pad = [], bass = [], siren = [], drums = { kick: [], snare: [], hat: [], crash: [] };
  const { always: padAlways, ...padSpec } = style.pad === true ? { style: 'block', low: 45, high: 62, baseVelocity: 50 } : style.pad ?? {};
  let theme = null, motif = null, lastMain = 72;
  // A quiet second voice under the long notes: the nearest chord tone a third to a sixth below, struck with the tune.
  const secondVoice = (notes, sectionChords, from = 0) => notes.filter(note => note.tick >= from && note.length >= 36).map(note => {
    const chord = chordPlan([sectionChords[Math.min(sectionChords.length - 1, Math.floor(note.tick / BAR))]], 1)[0][0];
    for (let m = note.midi - 3; m >= note.midi - 9; m--) if (chord.pcs.includes(mod(m, 12)) && m >= style.melody.low) return { ...note, midi: m, velocity: Math.max(1, note.velocity - 18) };
    return null;
  }).filter(Boolean);
  const { low, high } = style.melody;
  sections.forEach((section, index) => {
    const at = section.startBar, n = section.bars, next = sections[index + 1];
    let notes = [], phrases = [];
    if (section.kind === 'theme' || section.kind === 'theme again') {
      const written = writeMelody({ key: keyName, chords: section.chords, bars: n, seed: section.kind === 'theme' ? seed : seed + 5, ...melodyOptions, ...(motif ? { motif } : {}) });
      if (!theme) { theme = written; motif = written.motif; }
      notes = written.notes; phrases = written.plan; lastMain = written.notes.at(-1).midi;
      if (section.kind === 'theme again') notes = [...written.notes, ...secondVoice(written.notes, section.chords)]; // fuller the second time
    } else if (section.kind === 'contrast' || section.kind === 'bridge') {
      // New material from the same idea: the reply rhythm leads and the contour turns over.
      const turned = { rhythm: motif.reply, contour: motif.reply.map((_, i) => -(motif.contour[i % motif.contour.length])), reply: motif.rhythm };
      const written = writeMelody({ key: keyName, chords: section.chords, bars: n, seed: seed + 17 + index, ...melodyOptions, motif: turned });
      notes = written.notes; phrases = written.plan.map(p => ({ ...p, liftDegrees: Math.max(2, p.liftDegrees), climax: false }));
    } else if (section.kind === 'solo') {
      // The solo starts by quoting the theme, then loosens it: busier, wider, rising to its own peak, and it breathes before the return.
      const quoteBars = Math.min(2, n - 2);
      const quote = theme.notes.filter(note => note.tick < quoteBars * BAR).map(note => ({ ...note, length: Math.min(note.length, quoteBars * BAR - note.tick) }));
      const free = n - quoteBars;
      const spans = section.chords.slice(quoteBars).map((symbol, i) => ({ symbol, tick: i * BAR, ticks: BAR }));
      const solo = writeSolo({ key: keyName, spans, bars: free, seed: seed + 31, low: low + (style.melody.style === 'driving' ? 1 : 0), high: Math.min(100, high + (style.melody.style === 'driving' ? 2 : 1)), energy: styleName === 'ballad' ? 0.72 : style.melody.style === 'driving' ? 1 : 0.95, arc: 'rise', climax: true,
        phraseBars: 2, resolve: true, baseVelocity: style.melody.baseVelocity + 4 });
      const line = solo.notes.map(({ short, ...note }) => note).filter(note => note.tick < free * BAR - 36).map(note => ({ ...note, length: Math.min(note.length, free * BAR - 36 - note.tick) })).filter(note => note.length >= 6);
      // Keep the solo's dynamics in the piece's range: a little above the theme, with its own shape kept.
      const mean = line.reduce((sum, note) => sum + note.velocity, 0) / Math.max(1, line.length), centre = style.melody.baseVelocity + 7;
      for (const note of line) note.velocity = Math.round(clamp(centre + (note.velocity - mean) * 0.6, 30, style.melody.baseVelocity + 24));
      notes = [...quote, ...shift(line, quoteBars)];
      phrases = Array.from({ length: Math.ceil(n / 2) }, (_, i) => ({ phrase: i, bar: i * 2, bars: Math.min(2, n - i * 2), role: i === 0 ? 'quote' : 'solo', liftDegrees: Math.min(4, 1 + i), climax: false }));
    } else if (section.kind === 'return') {
      // The theme again, the same seed and idea, now cadencing home, with a second voice under its last phrase for weight.
      const written = writeMelody({ key: keyName, chords: section.chords, bars: n, seed, ...melodyOptions, motif });
      const final = written.plan.at(-1);
      const louder = written.notes.map(note => ({ ...note, velocity: Math.min(127, note.velocity + 4) }));
      notes = [...louder, ...secondVoice(louder, section.chords, final.bar * BAR)];
      lastMain = written.notes.at(-1).midi;
      phrases = written.plan.map(p => ({ ...p, liftDegrees: Math.max(3, p.liftDegrees) }));
    } else if (section.kind === 'ending') {
      const finalChord = chordPlan([tonic], 1)[0][0], home = lastMain;
      let last = home;
      for (let m = low; m <= high; m++) if (mod(m, 12) === finalChord.root && Math.abs(m - home) < Math.abs(last - home) + (mod(last, 12) === finalChord.root ? 0 : 99)) last = m;
      notes = [{ tick: (n - 1) * BAR, length: BAR - 12, midi: last, velocity: Math.max(40, style.melody.baseVelocity - 8) }];
    }
    lead.push(...shift(notes, at));
    const local = phrases.map(p => ({ ...p })), placed = phrases.map(p => ({ ...p, bar: p.bar + at, section: section.kind }));
    plan.push(...placed);
    const base = style.harmony.style, kindKey = section.kind === 'bridge' ? 'contrast' : section.kind === 'theme again' ? 'theme' : section.kind;
    const harmonyStyle = kindKey === 'ending' ? 'block' : alternates.harmony[kindKey]?.[base] ?? base;
    const quiet = kindKey === 'intro' ? -8 : kindKey === 'solo' ? -6 : kindKey === 'return' ? 4 : 0;
    const dropped = style.dropout?.includes(kindKey); // the dub drop-out: the chords fall away to one echoing stab and the bass and drums carry on
    if (dropped) harmony.push(...shift(writeAccompaniment({ chords: section.chords.slice(0, 1), bars: 1, seed: seed + index, ...style.harmony, echo: 5, final: false }).notes.filter(note => note.tick >= 144), at));
    else harmony.push(...shift(writeAccompaniment({ chords: section.chords, bars: n, seed: seed + index, plan: local, ...style.harmony, style: harmonyStyle, baseVelocity: style.harmony.baseVelocity + quiet, final: !next }).notes, at));
    if (style.siren && ['solo', 'return'].includes(kindKey) && at >= 1) { // a siren in the bar before, rising into the new section
      const top = 84 + mod(parsedKey.tonic - 84, 12);
      for (let i = 0; i < 8; i++) siren.push({ tick: (at - 1) * BAR + i * 24, length: 22, midi: top - 12 + (i % 2 ? 5 : 0) + (i >= 4 ? 7 : 0), velocity: 58 + i * 6 });
    }
    if (style.pad && !dropped && (padAlways ? kindKey !== 'intro' : ['contrast', 'return', 'ending'].includes(kindKey)))
      pad.push(...shift(writeAccompaniment({ chords: section.chords, bars: n, seed: seed + 1, plan: local, ...padSpec, ...(kindKey === 'ending' ? { style: 'block' } : {}), final: !next }).notes, at));
    if (kindKey !== 'intro') bass.push(...shift(writeBass({ chords: section.chords, bars: n, seed: seed + index, style: alternates.bass[kindKey]?.[bassStyle] ?? bassStyle, plan: local, final: !next }).notes, at));
    const beat = writeDrums({ bars: n, seed: seed + index, style: alternates.drums[kindKey]?.[drumsStyle] ?? drumsStyle, phraseBars: profile?.groove.fillInterval, plan: local, quietBars: kindKey === 'intro' ? n : 0, ending: !next,
      build: next?.kind === 'return' || (next?.kind === 'solo' && n >= 8), crashAtStart: !['intro', 'theme', 'ending'].includes(kindKey) }).parts;
    for (const part of Object.keys(drums)) drums[part].push(...shift(beat[part], at));
  });
  const fallbacks = Object.fromEntries((profile?.signatureSounds ?? []).map(({ role, fallback }) => [role, fallback]));
  const sound = { ...style.voices, ...fallbacks, ...voices };
  const swing = profile?.swing.amount ?? 0;
  if (swing) {
    for (const notes of [bass, ...Object.values(drums)]) {
      for (const note of notes) {
        note.tick = Math.min(total * BAR - 1, swingTick(note.tick, STEP, swing));
        note.length = Math.min(note.length, total * BAR - note.tick);
      }
    }
  }
  const track = (name, role, slot, notes) => notes?.length ? { name, role, pan: 0, ...sound[slot], patterns: [{ name, bar: 0, bars: total, notes: [...notes].sort((a, b) => a.tick - b.tick) }] } : null;
  const tracks = [track('Lead', 'lead', 'lead', lead), track('Harmony', 'harmony', 'harmony', harmony), track('Pad', 'texture', 'pad', pad), track('Bass', 'bass', 'bass', bass),
    track('Kick', 'drums', 'kick', drums.kick), track('Snare', 'drums', 'snare', drums.snare), track('Hat', 'drums', 'hat', drums.hat), track('Crash', 'drums', 'crash', drums.crash), track('Siren', 'fx', 'siren', siren)].filter(Boolean);
  const out = sections.map(({ chords: sectionChords, ...section }) => section);
  const result = { style: styleName, key: parsedKey.name, bpm: tempo, seed, lengthBars: total, lengthSeconds: Number((total * 240 / tempo).toFixed(3)), masterVolume: 80,
    form: out.map(section => section.kind).join(', '), chords, sections: out, plan, motif, tune: tuneScore(theme.notes, theme.plan), tracks };
  if (profile) {
    result.persona = profile.id;
    result.mix = { targetLufs: profile.mix.targets.lufs, ceilingDb: profile.mix.targets.truePeakDb };
    if (profile.tempo.timeSignature !== '4/4') result.personaWarnings = ['The current composer uses 4/4; the persona metre is retained for future arrangers.'];
  }
  result.structure = structureCheck(result);
  return result;
}

// Does each section differ from the one before it? Compares the lead's rhythm bar by bar, its density and the chords.
export function structureCheck(piece) {
  const lead = piece.tracks.find(track => track.role === 'lead')?.patterns[0].notes ?? [];
  const facts = piece.sections.map(section => {
    const from = section.startBar * BAR, to = (section.startBar + section.bars) * BAR;
    const notes = lead.filter(note => note.tick >= from && note.tick < to);
    const rhythms = Array.from({ length: section.bars }, (_, b) => notes.filter(note => Math.floor(note.tick / BAR) === section.startBar + b).map(note => Math.round((note.tick - (section.startBar + b) * BAR) / 12)).join(','));
    return { ...section, rhythms, density: Number((notes.length / section.bars).toFixed(2)), top: notes.length ? Math.max(...notes.map(note => note.midi)) : null,
      chords: piece.chords.slice(section.startBar, section.startBar + section.bars).join(' ') };
  });
  const warnings = [];
  const body = facts.filter(section => !['intro', 'ending'].includes(section.kind));
  for (let i = 1; i < body.length; i++) {
    const a = body[i - 1], b = body[i];
    const sameChords = a.chords.split(' ').slice(0, 4).join(' ') === b.chords.split(' ').slice(0, 4).join(' ');
    const shared = Math.min(a.bars, b.bars), alike = Array.from({ length: shared }, (_, k) => a.rhythms[k] === b.rhythms[k]).filter(Boolean).length / shared;
    if (sameChords && alike >= 0.75 && Math.abs(a.density - b.density) < 0.4) warnings.push(`"${b.kind}" at bar ${b.startBar} sounds like the "${a.kind}" before it: same chords, same rhythm in ${Math.round(alike * 100)}% of bars, same density.`);
  }
  if (piece.lengthBars >= 22 && !body.some(section => section.kind === 'solo')) warnings.push('A piece this long has no solo section.');
  if (piece.lengthBars >= 27 && !body.some(section => section.kind === 'contrast')) warnings.push('A piece this long has no contrasting section.');
  return { sections: facts.map(({ chords: sectionChords, rhythms, ...section }) => section), warnings };
}

// A transparent score for the tune alone, from its notes. It rewards the habits of singable melodies; it cannot tell whether a tune is good.
export function tuneScore(notes, plan = []) {
  const main = notes.filter(note => note.length > 12);
  if (main.length < 4) return { score: 0, reasons: ['Too few notes to judge'] };
  const moves = main.slice(1).map((note, i) => Math.abs(note.midi - main[i].midi));
  const steps = moves.filter(m => m > 0 && m <= 2).length / moves.length, repeats = moves.filter(m => m === 0).length / moves.length;
  const range = Math.max(...main.map(n => n.midi)) - Math.min(...main.map(n => n.midi));
  const bars = Math.ceil((main.at(-1).tick + main.at(-1).length) / BAR);
  const sounding = main.reduce((sum, note) => sum + note.length, 0) / (bars * BAR);
  const rhythms = new Set(Array.from({ length: bars }, (_, b) => main.filter(n => Math.floor(n.tick / BAR) === b).map(n => Math.round((n.tick - b * BAR) / STEP)).join(','))).size / bars;
  const top = Math.max(...main.map(n => n.midi)), tops = main.filter(n => n.midi === top);
  const climax = plan.find(p => p.climax);
  const topInClimax = climax ? tops.some(n => n.tick >= climax.bar * BAR && n.tick < (climax.bar + climax.bars) * BAR) : true;
  const near = (value, lo, hi, slope) => value < lo ? Math.max(0, 1 - (lo - value) * slope) : value > hi ? Math.max(0, 1 - (value - hi) * slope) : 1;
  const parts = [
    ['Stepwise motion', 25 * near(steps, 0.45, 0.8, 3), `${Math.round(steps * 100)}% of moves are steps`],
    ['Range', 15 * near(range, 10, 21, 0.12), `${range} semitones`],
    ['Breathing room', 15 * near(sounding, 0.55, 0.88, 4), `sounding ${Math.round(sounding * 100)}% of the time`],
    ['Rhythmic variety', 15 * near(rhythms, 0.2, 0.6, 3), `${Math.round(rhythms * 100)}% of bars have their own rhythm`],
    ['One clear peak', 20 * (topInClimax ? near(tops.length, 1, 3, 0.25) : 0.3), `top note heard ${tops.length} time${tops.length === 1 ? '' : 's'}${topInClimax ? ' in the climax phrase' : ', outside the climax phrase'}`],
    ['Few repeated notes', 10 * near(repeats, 0, 0.18, 4), `${Math.round(repeats * 100)}% of moves repeat a note`],
  ];
  return { score: Math.round(parts.reduce((sum, [, points]) => sum + points, 0)), parts: parts.map(([name, points, detail]) => ({ name, points: Number(points.toFixed(1)), detail })) };
}

export function register({ tool, z, dsp, root, schemas, project, render, moduleGuidance, personasDirectory }) {
  moduleGuidance.push('compose_piece writes a whole arranged piece from a style and a seed with no further composing calls, and compose_batch renders several seeds and ranks them by measured checks so a listener only needs to hear the best few. Both are plain code: use them for drafts and bulk work, then edit the winner.');
  const voice = z.object({ voice: z.enum(['pluck', 'bass', 'pad', 'kick', 'clap', 'hat', 'sample', 'preset']), preset: schemas.presetFile.optional(), factorySample: schemas.factorySample.optional(),
    sample: schemas.workspaceWav.optional(), volume: schemas.volume.optional(), pan: z.number().int().min(-100).max(100).optional() });
  const recipe = {
    persona: z.string().min(1).optional().describe('Persona id from list_personas.'),
    style: z.enum(styleNames).optional().describe(styleNames.map(name => `${name}: ${styles[name].about}`).join(' ')),
    key: z.string().min(1).max(30).optional().describe('Such as "D minor". Default: chosen from the style by the seed.'),
    bpm: z.number().min(45).max(240).optional(), seconds: z.number().min(10).max(600).optional(), bars: z.number().int().min(8).max(200).optional(),
    voices: z.record(z.enum(['lead', 'harmony', 'pad', 'bass', 'kick', 'snare', 'hat', 'crash', 'siren']), voice).default({}).describe('Replace the sound of any part, for example {"lead": {"voice": "preset", "preset": "TripleOscillator/Square.xpf", "volume": 14}}.'),
  };
  async function build(options, output) {
    const piece = composePiece(options, { personasDirectory });
    const items = piece.tracks.map(item => schemas.track.parse(item));
    for (const item of items) await project.checkTrack(item);
    const doc = project.createSong(piece.bpm, items, piece.masterVolume);
    for (const item of items.filter(i => i.preset)) await project.loadPreset(doc, project.instrumentOf(doc, item.name), item.preset, { tuning: 'concert' });
    project.setAnchor(doc, piece.lengthBars);
    await project.save(doc, output);
    return { piece, doc };
  }
  const summary = piece => ({ style: piece.style, key: piece.key, bpm: piece.bpm, seed: piece.seed, lengthBars: piece.lengthBars, lengthSeconds: piece.lengthSeconds,
    ...(piece.persona ? { persona: piece.persona, mix: piece.mix, ...(piece.personaWarnings ? { personaWarnings: piece.personaWarnings } : {}) } : {}), form: piece.form, structure: piece.structure, chords: piece.chords.join(' '),
    sections: piece.sections, phrases: piece.plan.map(p => ({ bar: p.bar, bars: p.bars, role: p.role, climax: p.climax })), tune: piece.tune,
    tracks: piece.tracks.map(t => ({ name: t.name, role: t.role, notes: t.patterns[0].notes.length })) });

  tool('compose_piece', 'Write a complete arranged piece from a style and a seed in one call: chord progression, phrase-based melody, accompaniment, bass and drums, with an intro and an ending, saved as an editable project. Plain seeded code, so the same seed gives the same piece. Render it with render_mix, or use compose_batch to try many seeds.', {
    output: schemas.projectName, seed: z.number().int().min(1).max(2147483647).default(1), ...recipe,
  }, async ({ output, ...options }) => {
    const { piece } = await build(options, output);
    return { project: output, ...summary(piece), next: 'render_mix the project, analyze_audio with the sections, then edit any part with replace_pattern or change sounds with apply_preset.' };
  });

  tool('compose_batch', 'Compose several seeds of the same recipe, render each one, and rank them by measured checks: the arrangement lint, mix warnings from the render, and a tune score (stepwise motion, range, breathing room, rhythmic variety, one clear peak). Returns the ranking with reasons so a listener only needs to hear the top few. The scores catch faults; they cannot tell whether a tune is good.', {
    name: schemas.folderName.describe('Prefix for the files: <name>-s<seed>.mmp and .wav.'), count: z.number().int().min(2).max(24).default(6),
    seedStart: z.number().int().min(1).max(2147483000).default(1), targetLufs: schemas.loudnessTarget, ceilingDb: schemas.ceilingTarget, ...recipe,
  }, async ({ name, count, seedStart, targetLufs, ceilingDb, ...options }) => {
    const results = [];
    for (let seed = seedStart; seed < seedStart + count; seed++) {
      const file = `${name}-s${seed}`;
      const { piece, doc } = await build({ ...options, seed }, file + '.mmp');
      const lint = lintModel(modelFromDoc(await project.load(file + '.mmp'), project), { key: piece.key });
      const loudness = targetLufs ?? piece.mix?.targetLufs ?? -16;
      const ceiling = ceilingDb ?? piece.mix?.ceilingDb ?? -1.5;
      const { wav } = await render.renderMix(doc, { tail: 'keep', targetLufs: loudness, ceilingDb: ceiling });
      await render.writeAudio(path.join(root, file + '.wav'), wav);
      const report = dsp.analyze(dsp.decodeWav(await readFile(path.join(root, file + '.wav'))), { expectedBpm: piece.bpm, expectedKey: /^[A-G][#b]? (major|minor)$/i.test(piece.key) ? piece.key : undefined });
      const warnings = dsp.advise(report, { targetLufs: loudness });
      const quality = qualityScore(lint, { audioWarnings: warnings, silent: report.integratedLufs === null });
      results.push({ seed, project: file + '.mmp', audio: file + '.wav', key: piece.key, form: piece.form, score: Math.max(0, Math.round(quality.score * 0.5 + piece.tune.score * 0.5) - 6 * piece.structure.warnings.length),
        structureWarnings: piece.structure.warnings,
        arrangementAndMix: quality.score, tune: piece.tune.score, integratedLufs: report.integratedLufs, truePeakDbfs: report.truePeakDbfs,
        findings: lint.findings.slice(0, 4).map(f => f.message ?? f), mixWarnings: warnings, tuneParts: piece.tune.parts });
    }
    results.sort((a, b) => b.score - a.score);
    return { recipe: { ...(!options.persona && !options.style ? { style: 'adventure' } : {}), ...options, count, seedStart }, ranking: results.map((r, i) => ({ rank: i + 1, ...r })), next: `Listen to ${results[0].audio} first. Build an audition page with build_audition_page to collect notes, then edit the winner.` };
  });
}
