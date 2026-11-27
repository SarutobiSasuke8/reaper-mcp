// Solo lines: an improvised-sounding lead for one instrument over a chord progression.
// The line is built in phrases that breathe. Each phrase mixes paces (held notes, pushed off-beat notes, eighths,
// sixteenth runs, arpeggios and triplets) so it never settles into one speed, takes its notes from the scale that
// fits each chord, lands on chord tones, and the whole solo rises to one high point and comes back.
import { parseChord } from '../music.mjs';
import { parseKey } from './motif.mjs';
import { parseProgression, chordSpans } from './blueprints.mjs';

const barTicks = 192, stepTicks = 12;
const mod = (a, n) => ((a % n) + n) % n;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

// The seven-note scale to play over a chord: the key's scale, with any note that clashes with a chord tone moved
// onto that chord tone. Over the V7 of a minor key this raises the seventh, giving the harmonic minor sound.
export function chordScale(chord, key) {
  const scale = key.scale.map(s => mod(key.tonic + s, 12));
  const tones = [...new Set(chord.intervals.filter(i => i < 12).map(i => mod(chord.root + i, 12)))];
  for (const tone of tones) {
    if (scale.includes(tone)) continue;
    // The neighbour a semitone away gives way, but never the key's tonic or fifth if the other neighbour can.
    const anchors = [key.tonic, mod(key.tonic + 7, 12)];
    const neighbours = [mod(tone - 1, 12), mod(tone + 1, 12)].filter(pc => scale.includes(pc) && !tones.includes(pc)).sort((a, b) => anchors.includes(a) - anchors.includes(b));
    if (neighbours.length) scale[scale.indexOf(neighbours[0])] = tone; else scale.push(tone);
  }
  return [...new Set(scale)].sort((a, b) => a - b);
}
const ladder = (pcs, low, high) => { const out = []; for (let m = low; m <= high; m++) if (pcs.includes(mod(m, 12))) out.push(m); return out; };
const nearest = (list, pitch) => list.reduce((best, m) => (Math.abs(m - pitch) < Math.abs(best - pitch) ? m : best), list[0]);
function stepAlong(list, pitch, steps) {
  let index = list.indexOf(nearest(list, pitch));
  if (list[index] !== pitch && steps !== 0 && Math.sign(list[index] - pitch) === Math.sign(steps)) steps -= Math.sign(steps);
  return list[clamp(index + steps, 0, list.length - 1)];
}

// Rhythm cells, two beats (8 sixteenth steps) each. Positive numbers are note lengths in steps, negative are rests,
// 'T' is a triplet of three notes across one beat. Grouped by how busy they are.
export const cells = {
  calm: [[8], [6, 2], [-2, 6], [3, 5], [4, 4], [-4, 4]],
  moving: [[2, 2, 4], [3, 3, 2], [-1, 3, 4], [2, 1, 1, 4], [3, 1, 4], [-2, 2, 2, 2], [4, 2, 2]],
  busy: [[1, 1, 1, 1, 4], [1, 1, 1, 1, 1, 1, 2], [2, 2, 2, 2], [1, 1, 2, 1, 1, 2], ['T', 4], [2, 1, 1, 'T'], [-1, 1, 1, 1, 4]],
};
const isFast = cell => cell.filter(x => x === 1 || x === 'T').length >= 2;
const startsLong = cell => typeof cell[0] === 'number' && cell[0] >= 3;

// Lay out one phrase: cells of contrasting pace, then a rest long enough to breathe.
export function phraseRhythm(steps, energy, next, previous) {
  const breath = clamp(Math.round((energy < 0.4 ? 10 : energy < 0.7 ? 7 : 5) + (next() - 0.5) * 3), 4, Math.max(4, steps - 8));
  const pickup = next() < 0.55 ? [0, 2, 3][Math.floor(next() * 3)] : 0;
  const out = [];
  let used = 0, last = previous ?? null;
  if (pickup) { out.push(-pickup); used += pickup; }
  while (steps - breath - used >= 8) {
    const roll = next() + (energy - 0.5) * 0.9;
    let group = roll < 0.35 ? 'calm' : roll < 0.8 ? 'moving' : 'busy';
    // Contrast: a fast figure is answered by a held note, and the same cell never comes twice running.
    if (last && isFast(last) && next() < 0.75) group = 'calm';
    let options = cells[group].filter(c => c !== last);
    if (last && isFast(last)) options = options.filter(startsLong).length ? options.filter(startsLong) : options;
    const cell = options[Math.floor(next() * options.length)];
    out.push(...cell);
    used += 8;
    last = cell;
  }
  const left = steps - breath - used;
  if (left >= 2) { out.push(left); used += left; }
  out.push(-(steps - used));
  return out;
}

// spans: [{ symbol, tick, ticks }] over the solo. Returns notes in ticks from the start, each flagged short or long.
export function writeSolo({ key: keyInput, spans, bars, seed = 1, low = 62, high = 84, energy = 0.6, arc = 'rise', climax = true, phraseBars = 2, resolve = true, baseVelocity = 80 }) {
  const key = parseKey(keyInput), next = random(seed), total = bars * barTicks;
  if (!spans?.length) throw new Error('Give the chords the solo plays over');
  if (high - low < 12) throw new Error('The solo needs a range of at least an octave');
  const chords = spans.map(span => { const chord = parseChord(span.symbol), scale = chordScale(chord, key);
    const tones = [...new Set(chord.intervals.filter(i => i < 12).map(i => mod(chord.root + i, 12)))];
    return { ...span, chord, scalePcs: scale, tonePcs: tones, scale: ladder(scale, low, high), tones: ladder(tones, low, high) }; });
  const chordAt = tick => chords.find(c => tick >= c.tick && tick < c.tick + c.ticks) ?? chords.at(-1);
  const phraseSteps = phraseBars * 16, count = Math.ceil(bars / phraseBars), peakAt = climax ? Math.max(0, Math.round((count - 1) * 0.7)) : -1;
  const energyOf = p => {
    if (arc === 'flat' || count === 1) return energy;
    const t = count === 1 ? 1 : p / (count - 1), peak = 0.7;
    const shape = t <= peak ? 0.55 + 0.45 * (t / peak) : 1 - 0.35 * ((t - peak) / (1 - peak));
    return clamp(energy * shape * 1.25, 0.1, 1);
  };
  const notes = [], phrases = [], rhythms = [];
  let current = nearest(chords[0].tones, low + (high - low) * 0.4), lastCell = null;
  for (let p = 0; p < count; p++) {
    const e = energyOf(p), startStep = p * phraseSteps, steps = Math.min(phraseSteps, bars * 16 - startStep);
    if (steps < 4) break;
    // A phrase often reuses the rhythm of the phrase two back, so the solo has an idea that returns.
    const reuse = p >= 2 && rhythms[p - 2].steps === steps && next() < 0.5 && p !== peakAt;
    const rhythm = reuse ? rhythms[p - 2].rhythm : phraseRhythm(steps, e, next, lastCell);
    rhythms.push({ steps, rhythm });
    const target = low + (high - low) * clamp(0.3 + 0.5 * e + (p === peakAt ? 0.15 : 0), 0.2, 0.92);
    // Expand the rhythm into timed slots.
    const slots = [];
    let at = startStep * stepTicks;
    for (const item of rhythm) {
      if (item === 'T') { for (let i = 0; i < 3; i++) slots.push({ tick: at + i * 16, ticks: 16, fast: true }); at += 48; }
      else if (item < 0) at += -item * stepTicks;
      else { slots.push({ tick: at, ticks: item * stepTicks, fast: item === 1 }); at += item * stepTicks; }
    }
    const first = notes.length;
    let direction = current < target ? 1 : -1, runMode = null;
    slots.forEach((slot, index) => {
      // A note that starts just before a chord change belongs to the new chord: the pushed, anticipated note.
      const ahead = chordAt(Math.min(total - 1, slot.tick + 24)), here = chordAt(slot.tick);
      const c = slot.ticks >= 24 && ahead !== here ? ahead : here;
      const strong = mod(slot.tick, 48) === 0, long = slot.ticks >= 36, following = slots[index + 1];
      const inRun = slot.fast && (slots[index - 1]?.fast || following?.fast);
      let pitch;
      if (inRun) {
        if (!slots[index - 1]?.fast) { runMode = next() < 0.45 ? 'arpeggio' : 'scale'; direction = current < target ? 1 : -1; if (next() < 0.2) direction = -direction; }
        pitch = stepAlong(runMode === 'arpeggio' ? c.tones : c.scale, current, direction);
        if (pitch === current) { direction = -direction; pitch = stepAlong(runMode === 'arpeggio' ? c.tones : c.scale, current, direction); }
      } else if (long || strong || slots[index - 1]?.fast) {
        // Land on a chord tone near where the line is heading.
        const drift = Math.sign(target - current) * Math.round(next() * 4) + Math.round((next() - 0.5) * 4);
        const options = c.tones.filter(m => Math.abs(m - current) <= 9 && (m !== current || next() < 0.25));
        pitch = nearest(options.length ? options : c.tones, current + drift);
      } else {
        // A passing note: one scale step, mostly towards the target register.
        const way = next() < 0.7 ? Math.sign(target - current) || 1 : -(Math.sign(target - current) || 1);
        pitch = stepAlong(c.scale, current, way);
      }
      current = clamp(pitch, low, high);
      const offbeat = mod(slot.tick, 48) !== 0 && slot.ticks >= 24;
      const position = slots.length > 1 ? index / (slots.length - 1) : 0;
      // Loudness follows the phrase: it swells to the middle and tapers, with accents on held and pushed notes.
      const swell = Math.sin(Math.PI * clamp(position * 0.9 + 0.1, 0, 1)) * 10;
      const velocity = clamp(Math.round(baseVelocity + 30 * e + swell + (long ? 6 : 0) + (offbeat ? 5 : 0) + (inRun ? -4 : 0) + (next() - 0.5) * 6), 35, 127);
      const short = slot.ticks <= 24;
      const length = Math.max(6, Math.round(slot.ticks * (short ? 0.6 : long ? 0.86 : 0.78)));
      notes.push({ tick: slot.tick, length: Math.min(length, total - slot.tick), midi: current, velocity, short });
    });
    const made = notes.slice(first);
    if (!made.length) continue;
    if (p === peakAt) {
      // The one high point: the longest note of this phrase goes to the top chord tone, and nothing else matches it.
      const top = made.reduce((best, n) => (n.length > best.length ? n : best), made[0]);
      const c = chordAt(top.tick), peak = c.tones.at(-1);
      top.midi = peak; top.velocity = clamp(top.velocity + 10, 35, 127);
      current = made.at(-1).midi;
    }
    lastCell = null;
    phrases.push({ phrase: p + 1, startBar: p * phraseBars, energy: Number(e.toFixed(2)), notes: made.length,
      shortest: Math.min(...made.map(n => n.length)), longest: Math.max(...made.map(n => n.length)), lowest: Math.min(...made.map(n => n.midi)), highest: Math.max(...made.map(n => n.midi)) });
  }
  if (!notes.length) throw new Error('The solo came out empty. Give it more bars.');
  // No awkward jumps inside a phrase: fold any leap over a ninth back by an octave.
  for (let i = 1; i < notes.length; i++) {
    const gap = notes[i].tick - (notes[i - 1].tick + notes[i - 1].length);
    if (gap > 48) continue;
    while (notes[i].midi - notes[i - 1].midi > 14 && notes[i].midi - 12 >= low) notes[i].midi -= 12;
    while (notes[i - 1].midi - notes[i].midi > 14 && notes[i].midi + 12 <= high) notes[i].midi += 12;
  }
  if (resolve) {
    // End at rest: the last note is the root of the final chord, held.
    const end = notes.at(-1), c = chordAt(end.tick), roots = ladder([mod(c.chord.root, 12)], low, high);
    if (roots.length) end.midi = nearest(roots, end.midi);
    end.length = Math.min(Math.max(end.length, 72), total - end.tick);
    end.short = false;
  }
  // Keep the high point unique. This runs last, after leaps are folded and the ending is set.
  if (peakAt >= 0) {
    const peak = Math.max(...notes.map(n => n.midi)), holders = notes.filter(n => n.midi === peak);
    const keep = holders.reduce((best, n) => (n.length > best.length ? n : best), holders[0]);
    for (const n of holders) if (n !== keep) { const lower = chordAt(n.tick).scale.filter(m => m < peak); if (lower.length) n.midi = lower.at(-1); }
  }
  return { notes, phrases, scales: [...new Map(chords.map(c => [c.symbol, c.scalePcs])).entries()].map(([symbol, pcs]) => ({ chord: symbol, pitchClasses: pcs })) };
}
// Checks that describe a solo in the listener's terms.
export function describeSolo(notes, bars) {
  const lengths = notes.map(n => n.length), distinct = new Set(lengths.map(l => Math.round(l / 6))).size;
  let longestSamePace = 1, run = 1;
  for (let i = 1; i < notes.length; i++) {
    const samePace = Math.abs((notes[i].tick - notes[i - 1].tick) - (notes[i - 1].tick - (notes[i - 2]?.tick ?? -999))) < 2;
    run = samePace ? run + 1 : 1;
    longestSamePace = Math.max(longestSamePace, run);
  }
  let silent = 0, cursor = 0;
  for (const n of notes) { silent += Math.max(0, n.tick - cursor); cursor = Math.max(cursor, n.tick + n.length); }
  silent += Math.max(0, bars * barTicks - cursor);
  return { notes: notes.length, notesPerBar: Number((notes.length / bars).toFixed(1)), lowest: Math.min(...notes.map(n => n.midi)), highest: Math.max(...notes.map(n => n.midi)),
    shortNotes: notes.filter(n => n.short).length, heldNotes: notes.filter(n => n.length >= 60).length, differentLengths: distinct, longestRunAtOnePace: longestSamePace,
    silentShare: Number((silent / (bars * barTicks)).toFixed(2)), quietest: Math.min(...notes.map(n => n.velocity)), loudest: Math.max(...notes.map(n => n.velocity)) };
}

export function register({ tool, edit, z, schemas, project, moduleGuidance }) {
  moduleGuidance.push('For a solo or lead line on one instrument (trumpet, sax, flute, synth lead), use write_solo or add_solo instead of writing notes by hand: it takes the scale that fits each chord, mixes fast runs and arpeggios with held notes and rests, and builds to one high point. Give short notes a staccato sound and long notes a sustained one when the instrument has both.');
  const args = {
    key: z.string().min(1).max(30).describe('Such as "D minor".'),
    progression: z.string().min(1).max(400).describe('Chord symbols or Roman numerals for the bars the solo covers, looped: "Dm Gm A7 Dm".'),
    barsPerChord: z.number().min(0.25).max(16).default(1), bars: z.number().int().min(1).max(64),
    seed: z.number().int().min(1).max(2147483647).default(1).describe('Change it for a different solo over the same chords.'),
    low: z.number().int().min(24).max(100).default(62).describe('Lowest MIDI note. Trumpet 58, alto sax 55, flute 60.'),
    high: z.number().int().min(36).max(108).default(84).describe('Highest MIDI note. Trumpet 84, alto sax 80, flute 93.'),
    energy: z.number().min(0.1).max(1).default(0.6).describe('How busy and loud overall. 0.3 is long notes and space, 0.9 is runs and high notes.'),
    arc: z.enum(['rise', 'flat']).default('rise').describe('rise builds across the solo to a peak about 70% through; flat keeps one level.'),
    climax: z.boolean().default(true).describe('Give the solo one highest held note.'),
    phraseBars: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(2), resolve: z.boolean().default(true).describe('End on the root of the last chord.'),
    baseVelocity: z.number().int().min(30).max(110).default(80),
  };
  const build = ({ key, progression, barsPerChord, bars, ...options }) => {
    const spans = chordSpans(parseProgression(progression, parseKey(key)), bars, barsPerChord).map(s => ({ symbol: s.symbol, tick: s.tick, ticks: s.ticks }));
    return writeSolo({ key, spans, bars, ...options });
  };
  const strip = notes => notes.map(({ short, ...n }) => n);
  tool('write_solo', 'Write a solo line for one instrument over chords. Returns notes for a pattern, split into short and long notes so a staccato and a sustained sound can share the line, with a per-phrase summary and the scale used over each chord.', args, async input => {
    const solo = build(input);
    return { notes: strip(solo.notes), shortNotes: strip(solo.notes.filter(n => n.short)), longNotes: strip(solo.notes.filter(n => !n.short)), phrases: solo.phrases, scales: solo.scales,
      summary: describeSolo(solo.notes, input.bars), next: 'Put notes in one pattern, or shortNotes and longNotes on two tracks of the same instrument (staccato and sustained).' };
  });
  edit('add_solo', 'Write a solo line and add it to a project as a new lead track.', {
    ...args, startBar: z.number().int().min(0).max(999),
    track: z.object({ name: z.string().min(1).max(100), voice: z.enum(['pluck', 'bass', 'pad', 'sample', 'preset']).default('pluck'), preset: schemas.presetFile.optional(), sample: schemas.workspaceWav.optional(),
      factorySample: schemas.factorySample.optional(), rootMidi: z.number().int().min(12).max(119).default(69), volume: schemas.volume.default(60), pan: z.number().int().min(-100).max(100).default(0) }),
  }, async (doc, { startBar, track, ...input }) => {
    if (project.tracks(doc).some(t => t.getAttribute('name') === track.name)) throw new Error(`Track name "${track.name}" is already in use`);
    const solo = build(input);
    const item = schemas.track.parse({ ...track, role: 'lead', patterns: [{ name: 'Solo', bar: startBar, bars: input.bars, notes: strip(solo.notes) }] });
    await project.checkTrack(item);
    const anchor = project.tracks(doc).find(project.isAnchor);
    const instrument = project.addTrack(project.container(doc), item);
    if (item.preset) await project.loadPreset(doc, instrument, item.preset, { tuning: 'concert' });
    if (anchor) project.container(doc).appendChild(anchor);
    return { added: track.name, phrases: solo.phrases, summary: describeSolo(solo.notes, input.bars) };
  }, { checked: true });
}
