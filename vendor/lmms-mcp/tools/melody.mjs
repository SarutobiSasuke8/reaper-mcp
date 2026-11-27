// Phrase-based melody and accompaniment writing.
// A melody here is one short idea that is stated, answered, developed to a peak and closed, with a breath after every phrase,
// dynamics that follow the phrase and a register that rises to one climax. Pure functions; everything is seeded.
import { parseChord } from '../music.mjs';
import { parseKey } from './motif.mjs';

const BAR = 192, BEAT = 48;
const mod = (a, n) => ((a % n) + n) % n;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function rng(seed) {
  // Mix the seed first, so neighbouring seeds give unrelated sequences.
  let s = Math.imul((Number(seed) >>> 0) ^ 0x9e3779b9, 2654435761) >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  next.pick = list => list[Math.floor(next() * list.length)];
  next.chance = p => next() < p;
  next.spread = n => Math.round((next() * 2 - 1) * n);
  return next;
}

// Rhythm cells for one bar: [onset, duration] in ticks. "idea" cells carry the motif, "tail" cells end a phrase and leave a breath.
const cells = {
  lyrical: {
    idea: [
      [[0, 48], [48, 24], [72, 24], [96, 96]], [[0, 72], [72, 24], [96, 48], [144, 48]], [[0, 24], [24, 24], [48, 48], [96, 96]],
      [[0, 48], [48, 48], [96, 72], [168, 24]], [[24, 24], [48, 48], [96, 48], [144, 48]], [[0, 36], [36, 36], [72, 24], [96, 96]],
      [[0, 96], [96, 24], [120, 24], [144, 48]],
    ],
    tail: [[[0, 144]], [[0, 48], [48, 96]], [[0, 72], [72, 72]], [[0, 24], [24, 24], [48, 96]]],
  },
  driving: {
    idea: [
      [[0, 24], [24, 24], [48, 24], [72, 24], [96, 48], [144, 48]], [[0, 36], [36, 36], [72, 24], [96, 36], [132, 36], [168, 24]],
      [[0, 24], [24, 12], [36, 12], [48, 48], [96, 24], [120, 24], [144, 48]], [[0, 48], [48, 24], [72, 24], [96, 24], [120, 24], [144, 48]],
      [[12, 12], [24, 24], [48, 24], [72, 24], [96, 96]],
    ],
    tail: [[[0, 96]], [[0, 24], [24, 24], [48, 72]], [[0, 48], [48, 48]], [[0, 36], [36, 60]]],
  },
  swing: { // triplet feel: off-beat eighths sit two thirds of the way through the beat
    idea: [
      [[0, 32], [32, 16], [48, 32], [80, 16], [96, 96]], [[0, 32], [32, 16], [80, 48], [128, 16], [144, 48]],
      [[48, 32], [80, 16], [96, 32], [128, 16], [144, 48]], [[0, 16], [16, 16], [32, 16], [48, 48], [96, 48], [144, 48]],
      [[32, 16], [48, 48], [96, 32], [128, 16], [144, 32]], [[0, 96], [96, 32], [128, 16], [144, 48]],
    ],
    tail: [[[0, 128]], [[0, 32], [32, 96]], [[0, 80], [80, 64]], [[0, 32], [32, 16], [48, 96]]],
  },
};
export const melodyStyles = Object.keys(cells);
const feels = { lyrical: { layBack: 0, humanize: 1, gate: 0.97 }, driving: { layBack: 0, humanize: 0, gate: 0.86 }, swing: { layBack: 3, humanize: 2, gate: 0.92 } };

// Chords: one entry per bar, looped. "Dm" fills the bar, "F C" splits it evenly.
export function chordPlan(chords, bars) {
  const list = (Array.isArray(chords) ? chords : String(chords).split('|')).map(entry => String(entry).trim().split(/\s+/).filter(Boolean));
  if (!list.length || list.some(bar => !bar.length)) throw new Error('Give at least one chord per bar, for example ["Dm", "Bb", "F", "C"] or "Dm | Bb | F C | A"');
  const plan = [];
  for (let bar = 0; bar < bars; bar++) plan.push(list[bar % list.length].map(symbol => {
    const chord = parseChord(symbol);
    return { symbol, root: chord.root, pcs: [...new Set(chord.intervals.map(i => mod(chord.root + i, 12)))] };
  }));
  return plan;
}
const chordAt = (plan, tick) => {
  const bar = plan[clamp(Math.floor(tick / BAR), 0, plan.length - 1)];
  return bar[clamp(Math.floor((mod(tick, BAR) / BAR) * bar.length), 0, bar.length - 1)];
};

// Diatonic ladder: degree 0 is the key's tonic in MIDI octave -1.
const midiOf = (degree, key) => key.tonic + 12 * Math.floor(degree / 7) + key.scale[mod(degree, 7)];
function degreeNear(midi, key) {
  let best = 0;
  for (let d = 0; d < 80; d++) if (Math.abs(midiOf(d, key) - midi) < Math.abs(midiOf(best, key) - midi)) best = d;
  return best;
}
function nearestChordTone(midi, chord, low, high, prefer = 0) {
  let best = null;
  for (let m = Math.max(low, midi - 5); m <= Math.min(high, midi + 5); m++) {
    if (!chord.pcs.includes(mod(m, 12))) continue;
    const cost = Math.abs(m - midi) - (Math.sign(m - midi) === prefer ? 0.4 : 0);
    if (best === null || cost < best.cost) best = { m, cost };
  }
  return best ? best.m : midi;
}

const contours = {
  arch: n => Array.from({ length: n }, (_, i) => Math.round(2.4 * Math.sin(Math.PI * i / Math.max(1, n - 1)))),
  rise: n => Array.from({ length: n }, (_, i) => i),
  fall: n => Array.from({ length: n }, (_, i) => -i),
  wave: n => Array.from({ length: n }, (_, i) => [0, 1, -1, 2, 0, 1, -1][i % 7]),
  leap: n => Array.from({ length: n }, (_, i) => i === 0 ? 0 : 4 - i),
  turn: n => Array.from({ length: n }, (_, i) => [0, 1, 0, -1, 0, 2, 1][i % 7]),
};
export const contourNames = Object.keys(contours);

// The whole piece as abstract notes, before pitch fitting: { tick, dur, degree, phrase, end, peak, strong }.
function sketch({ bars, phraseBars, style, random, start, motif }) {
  const vocabulary = cells[style];
  const idea = motif?.rhythm ?? random.pick(vocabulary.idea);
  const shape = motif?.contour ?? contours[random.pick(contourNames)](idea.length);
  const others = vocabulary.idea.filter(cell => cell !== idea && JSON.stringify(cell) !== JSON.stringify(idea));
  const reply = motif?.reply ?? random.pick(others.length ? others : vocabulary.idea);
  const tail = random.pick(vocabulary.tail);
  const phrases = Math.ceil(bars / phraseBars);
  const climax = phrases < 3 ? phrases - 1 : Math.round(0.62 * (phrases - 1));
  const span = Math.max(1, climax, phrases - 1 - climax);
  const notes = [], plan = [];
  const place = (bar, cell, degrees, phrase, flags = {}) => cell.forEach(([onset, dur], i) => {
    if (bar >= bars) return;
    notes.push({ tick: bar * BAR + onset, dur, degree: degrees[Math.min(i, degrees.length - 1)], phrase, strong: onset % 96 === 0 || dur >= 72, ...(typeof flags === 'function' ? flags(i) : flags) });
  });
  for (let p = 0; p < phrases; p++) {
    const first = p * phraseBars, last = Math.min(bars, first + phraseBars) - 1, length = last - first + 1;
    const lift = Math.round(4 * (1 - Math.abs(p - climax) / span));
    const role = p === phrases - 1 ? 'close' : p === climax && phrases > 2 ? 'develop' : p % 2 === 0 ? 'state' : 'answer';
    const home = start + (role === 'state' || role === 'close' ? 0 : lift); // statements return at their first pitch, so the tune is recognised; the lift shows in their dynamics
    plan.push({ phrase: p, bar: first, bars: length, role, liftDegrees: lift, climax: p === climax });
    const ending = (bar, landing) => place(bar, tail, tail.map((_, i) => landing + (tail.length - 1 - i)), p, i => ({ end: i === tail.length - 1, landing: role }));
    if (length === 1) { ending(first, home); continue; }
    if (role === 'develop') {
      // Fragment the idea, climb with it, peak, then come down to the cadence.
      const fragment = idea.filter(([onset]) => onset < 96);
      const half = fragment.length ? fragment : idea.slice(0, 2);
      const twice = [...half, ...half.map(([onset, dur]) => [onset + 96, dur])];
      const climb = twice.map((_, i) => home + shape[i % half.length] + (i >= half.length ? 1 : 0));
      place(first, twice, climb, p);
      if (length > 2) {
        const higher = twice.map((_, i) => home + 2 + shape[i % half.length] + (i >= half.length ? 1 : 0));
        const top = higher.indexOf(Math.max(...higher));
        place(first + 1, twice, higher, p, i => ({ peak: i === top }));
      }
      for (let bar = first + 2; bar < last; bar++) place(bar, idea, idea.map((_, i) => home + 3 - i - (bar - first - 2) * 2), p);
      ending(last, home);
      continue;
    }
    // State or answer: the idea, the idea again one step away with a new ending, then a tail.
    const varied = role === 'answer' && p >= 2;
    const offset = role === 'answer' ? -1 : 1;
    place(first, idea, shape.map(d => start + d), p); // every phrase opens with the idea at its first pitch, so it is recognised
    for (let bar = first + 1; bar < last; bar++) {
      if ((bar - first) % 2 === 1) { // a contrasting reply: another rhythm that falls back from where the idea ended
        const from = home + shape.at(-1);
        place(bar, reply, reply.map((_, i) => from - offset * [1, 2, 1, 0, 1, 2, 3][i % 7]), p);
        continue;
      }
      const second = shape.map((d, i) => home + offset + (varied && i === shape.length - 1 ? -d : d));
      place(bar, idea, second, p, i => ({ peak: role !== 'close' && p === climax && i === second.indexOf(Math.max(...second)) }));
    }
    ending(last, role === 'state' ? home + 2 : home);
  }
  return { notes, plan, motif: { rhythm: idea, contour: shape, reply } };
}

export function writeMelody({ key: keyInput, chords, bars, seed = 1, low = 60, high = 84, style = 'lyrical', phraseBars = 4, baseVelocity = 78,
  dynamics = 1, ornament = true, feel = {}, motif } = {}) {
  if (!cells[style]) throw new Error(`Unknown style "${style}". Use one of: ${melodyStyles.join(', ')}`);
  if (!Number.isInteger(bars) || bars < 1) throw new Error('bars must be a whole number of at least 1');
  if (high - low < 12) throw new Error('Give the melody a range of at least an octave');
  const key = parseKey(keyInput), plan = chordPlan(chords, bars), random = rng(seed);
  const touch = { ...feels[style], ...feel };
  const centre = (low + high) / 2;
  const opening = nearestChordTone(Math.round(centre - 3), plan[0][0], low, high);
  const draft = sketch({ bars, phraseBars, style, random, start: degreeNear(opening, key), motif });
  // Pitch: strong and long notes take chord tones, the rest keep the contour in the key. Whole phrases move by octaves to stay in range.
  const byPhrase = new Map();
  for (const note of draft.notes) byPhrase.set(note.phrase, [...(byPhrase.get(note.phrase) ?? []), note]);
  const out = [];
  let previous = opening;
  for (const [index, group] of byPhrase) {
    const info = draft.plan[index];
    let pitches = group.map(note => midiOf(note.degree, key));
    while (Math.max(...pitches) > high) pitches = pitches.map(m => m - 12);
    while (Math.min(...pitches) < low) pitches = pitches.map(m => m + 12);
    const phraseStart = info.bar * BAR, phraseLength = info.bars * BAR;
    const peakAt = group.find(note => note.peak)?.tick ?? phraseStart + phraseLength * 0.55;
    group.forEach((note, i) => {
      const chord = chordAt(plan, note.tick);
      let midi = clamp(pitches[i], low, high);
      if (note.end) {
        const finalNote = info.role === 'close';
        const target = finalNote && chord.pcs.includes(key.tonic) ? { ...chord, pcs: [key.tonic] }
          : info.role === 'state' ? { ...chord, pcs: chord.pcs.filter(pc => pc !== chord.root).length ? chord.pcs.filter(pc => pc !== chord.root) : chord.pcs } : chord;
        midi = nearestChordTone(midi, target, low, high);
      } else if (note.strong) midi = nearestChordTone(midi, chord, low, high, Math.sign(midi - previous));
      if (i > 0) { // no leaps wider than a sixth inside a phrase
        while (midi - previous > 9 && midi - 12 >= low) midi -= 12;
        while (previous - midi > 9 && midi + 12 <= high) midi += 12;
      }
      if (!note.end && midi === previous && i > 0 && !note.strong) midi = clamp(midiOf(degreeNear(midi, key) + (random.chance(0.5) ? 1 : -1), key), low, high);
      previous = midi;
      // Dynamics: swell to the phrase peak, taper the ending, lean on the beat, and let the climax phrase carry more weight.
      const t = (note.tick - phraseStart) / phraseLength, peakT = clamp((peakAt - phraseStart) / phraseLength, 0.2, 0.9);
      const arc = t <= peakT ? t / peakT : 1 - (t - peakT) / (1 - peakT) * 0.9;
      const beat = mod(note.tick, BAR);
      const accent = beat === 0 ? 4 : beat === 96 ? 2 : beat % BEAT === 0 ? 0 : -3;
      const velocity = baseVelocity + dynamics * (info.liftDegrees * 2.5 + 12 * arc - 7 + accent + (midi - centre) * 0.3 + (note.peak ? 6 : 0) - (note.end ? 5 : 0)) + random.spread(2);
      const next = group[i + 1];
      const joined = next && next.tick <= note.tick + note.dur;
      const length = note.end ? note.dur : Math.round(note.dur * (joined ? touch.gate : Math.min(touch.gate, 0.88)));
      const late = (beat === 0 ? 0 : random.spread(touch.humanize)) + touch.layBack + (note.end && style === 'lyrical' ? 3 : 0);
      const tick = clamp(note.tick + late, 0, bars * BAR - 6);
      if (ornament && (note.peak || (note.dur >= 96 && !note.end && random.chance(0.18))) && tick >= 16) {
        const grace = clamp(midiOf(degreeNear(midi, key) - 1, key), low, high);
        if (grace !== midi) out.push({ tick: tick - 14, length: 12, midi: grace, velocity: Math.round(clamp(velocity - 18, 1, 127)) });
      }
      out.push({ tick, length: Math.max(6, Math.min(length, bars * BAR - tick)), midi, velocity: Math.round(clamp(velocity, 1, 127)) });
    });
  }
  out.sort((a, b) => a.tick - b.tick);
  return { key: key.name, style, bars, seed, notes: out, motif: draft.motif, plan: draft.plan };
}

// Left hand or backing part that follows the same chords and the melody's plan, so it swells where the melody does.
const patterns = {
  arpeggio: { step: 24, shape: [0, 1, 2, 3, 2, 1, 2, 1] },
  flowing: { step: 12, shape: [0, 1, 2, 3, 4, 3, 2, 1, 2, 3, 4, 3, 2, 1, 2, 1] },
  broken: { step: 48, shape: [0, 2, 1, 2] },
  block: { step: 96, shape: ['chord', 'chord'] },
  held: { step: 192, shape: ['chord'] }, // one chord a bar, for backing a solo
  skank: { step: 48, shape: ['offbeat'] }, // reggae guitar or piano: a short chord on every off-beat
  bubble: { step: 48, shape: ['offbeat'] }, // reggae organ: the off-beat chord with quiet low notes either side
};
export const accompanimentStyles = Object.keys(patterns);
export function writeAccompaniment({ chords, bars, seed = 1, low = 36, high = 67, style = 'arpeggio', baseVelocity = 56, dynamics = 1, pedal = true, plan: melodyPlan = [], final: endsPiece = true, echo = 0 } = {}) {
  if (!patterns[style]) throw new Error(`Unknown style "${style}". Use one of: ${accompanimentStyles.join(', ')}`);
  const plan = chordPlan(chords, bars), random = rng(seed + 7919), { step, shape } = patterns[style];
  const liftAt = bar => melodyPlan.find(p => bar >= p.bar && bar < p.bar + p.bars)?.liftDegrees ?? 0;
  const notes = [];
  let lastRoot = low + 8;
  for (let bar = 0; bar < bars; bar++) {
    const span = BAR / plan[bar].length, final = endsPiece && bar === bars - 1;
    plan[bar].forEach((chord, part) => {
      const from = bar * BAR + part * span;
      let root = low; // the chord root nearest the last one, kept in the bottom octave and a half
      for (let m = low; m <= low + 16; m++) if (mod(m, 12) === chord.root && Math.abs(m - lastRoot) < Math.abs(root - lastRoot)) root = m;
      if (mod(root, 12) !== chord.root) root = low + mod(chord.root - low, 12);
      lastRoot = root;
      const third = chord.pcs.find(pc => [3, 4].includes(mod(pc - chord.root, 12))) ?? chord.pcs[1] ?? chord.root;
      const colour = chord.pcs.find(pc => [10, 11, 2, 9].includes(mod(pc - chord.root, 12)));
      const ladder = [root, root + 7, root + 12, root + 12 + mod(third - chord.root, 12), colour === undefined ? root + 19 : root + 12 + mod(colour - chord.root, 12) + (mod(colour - chord.root, 12) < 5 ? 12 : 0)]
        .map(m => m > high ? m - 12 : m);
      const swell = dynamics * liftAt(bar) * 2;
      if (final || style === 'block' || style === 'held') {
        const hits = final || style === 'held' ? [0] : [0, 96].filter(t => t < span);
        for (const t of hits) for (const m of [ladder[0], ladder[1], ladder[2], ladder[3]]) notes.push({ tick: from + t, length: (final || style === 'held' ? span : Math.min(96, span - t)) - 4, midi: m, velocity: Math.round(clamp(baseVelocity + swell + (t ? -6 : 2) - (final ? 4 : 0) + random.spread(2), 1, 127)) });
        return;
      }
      if (style === 'skank' || style === 'bubble') {
        const stab = [ladder[2], ladder[3], ladder[2] + 7].map(m => m > high ? m - 12 : m);
        const beats = Math.round(span / 48);
        for (let beat = 0; beat < beats; beat++) {
          const at = from + beat * 48 + 24, loud = baseVelocity + swell + (beat % 2 ? 3 : -1) + random.spread(2);
          for (const m of style === 'bubble' ? stab.slice(0, 2) : stab) notes.push({ tick: at, length: style === 'bubble' ? 14 : 18, midi: m, velocity: Math.round(clamp(loud, 1, 127)) });
          if (style === 'bubble') for (const t of [12, 36]) notes.push({ tick: from + beat * 48 + t, length: 10, midi: ladder[1], velocity: Math.round(clamp(loud - 18, 1, 127)) });
          // Dub echo: the last stab of the bar repeats on dotted eighths and fades.
          if (echo > 0 && beat === beats - 1) for (let k = 1; k <= echo; k++) {
            const t = at + k * 36;
            if (t + 16 > bars * BAR) break;
            for (const m of stab.slice(1)) notes.push({ tick: t, length: 16, midi: m, velocity: Math.round(clamp(loud * 0.62 ** k, 1, 127)) });
          }
        }
        return;
      }
      for (let t = 0, i = 0; t < span; t += step, i++) {
        const midi = ladder[shape[i % shape.length]];
        const wave = -4 * Math.abs(Math.sin(Math.PI * t / span)) + (t === 0 ? 7 : 0);
        notes.push({ tick: from + t + (t ? random.spread(1) : 0), length: (pedal ? span - t : step) - 3, midi, velocity: Math.round(clamp(baseVelocity + swell + wave + random.spread(2), 1, 127)) });
      }
    });
  }
  return { style, bars, notes: notes.sort((a, b) => a.tick - b.tick) };
}

export function register({ tool, z, moduleGuidance }) {
  moduleGuidance.push('For a tune that sounds played rather than generated, use write_melody: it states one idea, answers it, builds to a single climax and breathes between phrases. Pair it with write_accompaniment and pass the returned patterns to create_project. Use develop_motif to vary a tune you already have.');
  const chordsArg = z.union([z.string().min(1).max(2000), z.array(z.string().min(1).max(40)).min(1).max(128)])
    .describe('One entry per bar, looped to fill the piece. "Dm" fills a bar and "F C" splits it. A string may separate bars with |.');
  const cell = z.array(z.tuple([z.number().int().min(0).max(191), z.number().int().min(6).max(192)])).min(2).max(12);
  tool('write_melody', 'Write a phrase-based melody over a chord progression. One short idea is stated, answered, developed to a single climax and closed, with a rest after every phrase, chord tones on strong beats, velocities that swell and taper with each phrase, and optional grace notes. Returns a ready pattern of raw notes plus the motif and the phrase plan. Seeded: the same seed gives the same tune.', {
    key: z.string().min(1).max(30).describe('Tonic and mode, for example "D minor" or "Bb major".'),
    chords: chordsArg, bars: z.number().int().min(1).max(64),
    style: z.enum(melodyStyles).default('lyrical').describe('lyrical: singing lines. driving: busier, shorter notes. swing: triplet feel, laid back.'),
    seed: z.number().int().min(1).max(2147483647).default(1), low: z.number().int().min(24).max(96).default(60), high: z.number().int().min(36).max(108).default(84),
    phraseBars: z.union([z.literal(2), z.literal(4), z.literal(8)]).default(4), baseVelocity: z.number().int().min(20).max(120).default(78),
    dynamics: z.number().min(0).max(2).default(1).describe('How far velocities follow the phrase. 0 is flat.'),
    ornament: z.boolean().default(true).describe('Grace notes on the peak and a few long notes.'),
    motif: z.object({ rhythm: cell, contour: z.array(z.number().int().min(-7).max(7)).min(2).max(12), reply: cell.optional() }).optional()
      .describe('Reuse a motif returned by an earlier call, so several parts or sections share one idea.'),
    name: z.string().min(1).max(100).default('Melody'), bar: z.number().int().min(0).max(999).default(0),
  }, async ({ name, bar, ...options }) => {
    const result = writeMelody(options);
    return { pattern: { name, bar, bars: result.bars, notes: result.notes }, key: result.key, style: result.style, seed: result.seed, motif: result.motif, plan: result.plan };
  });
  tool('write_accompaniment', 'Write a backing part over the same chords: rolling arpeggios, broken chords or held blocks, voiced in the low register with the pedal held through each chord. Pass the plan from write_melody so it swells where the melody does.', {
    chords: chordsArg, bars: z.number().int().min(1).max(64), style: z.enum(accompanimentStyles).default('arpeggio'),
    seed: z.number().int().min(1).max(2147483647).default(1), low: z.number().int().min(24).max(72).default(36), high: z.number().int().min(36).max(96).default(67),
    baseVelocity: z.number().int().min(20).max(120).default(56), dynamics: z.number().min(0).max(2).default(1),
    pedal: z.boolean().default(true).describe('Let every note ring until the chord changes.'),
    echo: z.number().int().min(0).max(6).default(0).describe('For skank and bubble: how many fading dub echoes follow the last off-beat chord of each bar.'),
    plan: z.array(z.object({ bar: z.number().int().min(0), bars: z.number().int().min(1), liftDegrees: z.number() }).passthrough()).max(64).default([]),
    name: z.string().min(1).max(100).default('Accompaniment'), bar: z.number().int().min(0).max(999).default(0),
  }, async ({ name, bar, ...options }) => {
    const result = writeAccompaniment(options);
    return { pattern: { name, bar, bars: result.bars, notes: result.notes }, style: result.style };
  });
}
