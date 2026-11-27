// Develop one musical idea: diatonic motif operations that return melody lines ready for create_project patterns.
// Pure functions work on events: { midi: number | null (a rest), steps: number, velocity?: number }.
import { noteNumber, parseChord } from '../music.mjs';

export const modes = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};
const modeAliases = { '': 'major', maj: 'major', ionian: 'major', m: 'minor', min: 'minor', aeolian: 'minor', harmonicminor: 'harmonicMinor', harmonic: 'harmonicMinor' };
// Where the mode sits in its parent major scale, used to decide between sharp and flat spelling.
const parentOffset = { major: 0, minor: 9, harmonicMinor: 9, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7 };
const letters = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const sharpNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const flatNames = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const mod = (a, n) => ((a % n) + n) % n;
const fmt = n => String(Number(Number(n).toFixed(3)));

// "D minor", "Dm", "F# dorian", "C harmonic minor", "Bb" or { tonic: 'D', mode: 'minor' }.
export function parseKey(input) {
  if (input && typeof input === 'object' && input.scale) return input;
  const text = typeof input === 'object' ? `${input.tonic} ${input.mode ?? ''}` : String(input ?? '');
  const match = /^\s*([A-Ga-g])([#b]?)\s*(.*?)\s*$/.exec(text);
  if (!match) throw new Error(`Unknown key "${text}". Use a tonic and mode such as "D minor", "F# dorian" or "Bb".`);
  const word = match[3].replace(/[\s_-]/g, '').toLowerCase();
  const mode = modeAliases[word] ?? Object.keys(modes).find(name => name.toLowerCase() === word);
  if (!mode) throw new Error(`Unknown mode "${match[3]}". Use one of: ${Object.keys(modes).join(', ')}`);
  const letter = match[1].toUpperCase();
  const tonic = mod(letters[letter] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0), 12);
  const parent = mod(tonic - parentOffset[mode], 12);
  const flats = match[2] === 'b' || (match[2] !== '#' && [5, 10, 3, 8, 1, 6].includes(parent));
  return { tonic, mode, scale: modes[mode], flats, name: `${letter}${match[2]} ${mode === 'harmonicMinor' ? 'harmonic minor' : mode}` };
}
export function noteName(midi, key) {
  return (key?.flats ? flatNames : sharpNames)[mod(midi, 12)] + (Math.floor(midi / 12) - 1);
}
export const pitchClassName = (pc, key) => (key?.flats ? flatNames : sharpNames)[mod(pc, 12)];

// Diatonic index: octave * 7 + scale degree, counted from the tonic. Chromatic notes snap to the nearest scale tone.
function toDegree(midi, key) {
  const rel = midi - key.tonic, octave = Math.floor(rel / 12), pc = mod(rel, 12);
  let best = 0, bestDistance = Infinity;
  for (let degree = 0; degree < 7; degree++) {
    for (const wrap of [-12, 0, 12]) {
      const distance = Math.abs(key.scale[degree] + wrap - pc);
      if (distance < bestDistance) { bestDistance = distance; best = degree + (wrap / 12) * 7; }
    }
  }
  return { index: octave * 7 + best, exact: bestDistance === 0 };
}
export function fromDegree(index, key) {
  return key.tonic + Math.floor(index / 7) * 12 + key.scale[mod(index, 7)] + 12;
}
// fromDegree counts octave 0 from MIDI 12 (C0), so degreeOf and fromDegree round trip.
export const degreeOf = (midi, key) => toDegree(midi - 12, key).index;
export const inKey = (midi, key) => key.scale.includes(mod(midi - key.tonic, 12));

// ---------- reading and writing motifs ----------
export function parseLine(line) {
  const tokens = String(line).replace(/\|/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('The motif is empty');
  return tokens.map(token => {
    const match = /^([^:\s]+)(?::([\d.]+))?(?::(\d+))?$/.exec(token);
    if (!match || match[1].startsWith('[')) throw new Error(`Cannot read motif token "${token}". Motifs are single notes: NOTE:steps, NOTE:steps:velocity or r:steps.`);
    const steps = Number(match[2] ?? 1);
    if (!(steps > 0)) throw new Error(`Motif token "${token}" needs a positive length in steps`);
    const rest = /^[rR_]$/.test(match[1]);
    const midi = rest ? null : noteNumber(match[1]);
    if (midi !== null && (midi < 12 || midi > 119)) throw new Error(`Motif note "${match[1]}" is outside MIDI 12-119. Use note names such as D5, or scale degrees 1-7 for every token.`);
    return { midi, steps, ...(match[3] && !rest ? { velocity: Number(match[3]) } : {}) };
  });
}
// Raw notes (ticks) to events. Gaps become rests. Notes must not overlap: a motif is one line.
export function fromNotes(notes, stepsPerBar = 16) {
  const step = 192 / stepsPerBar;
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const events = [];
  let at = 0;
  for (const n of sorted) {
    if (n.tick < at) throw new Error('Motif notes overlap. Give a single melody line.');
    if (n.tick > at) events.push({ midi: null, steps: (n.tick - at) / step });
    events.push({ midi: n.midi, steps: n.length / step, ...(n.velocity ? { velocity: n.velocity } : {}) });
    at = n.tick + n.length;
  }
  return events;
}
// Scale-degree motifs for blueprints: "1:2 3:2 5:4 r:2". ' raises an octave, , lowers one.
export function parseDegrees(text, key) {
  return String(text).trim().split(/\s+/).map(token => {
    const match = /^(r|[1-7])([',]*)(?::([\d.]+))?(?::(\d+))?$/.exec(token);
    if (!match) throw new Error(`Cannot read degree token "${token}". Use 1-7 with ' or , for octaves, then :steps and optionally :velocity.`);
    const steps = Number(match[3] ?? 1);
    if (!(steps > 0)) throw new Error(`Degree token "${token}" needs a positive length in steps`);
    if (match[1] === 'r') return { midi: null, steps };
    const octave = [...match[2]].reduce((sum, c) => sum + (c === "'" ? 1 : -1), 0);
    return { midi: fromDegree(Number(match[1]) - 1 + octave * 7 + 28, key), steps, ...(match[4] ? { velocity: Number(match[4]) } : {}) };
  });
}
export function readMotif(input, key, { stepsPerBar = 16 } = {}) {
  if (Array.isArray(input)) return fromNotes(input, stepsPerBar);
  // Scale degrees: every token is r or 1-7 (with octave marks), :steps and an optional :velocity.
  const tokens = String(input).trim().split(/\s+/);
  if (tokens.every(t => /^(r|[1-7])[',]*(:[\d.]+){0,2}$/.test(t)) && tokens.some(t => /^[1-7]/.test(t))) return parseDegrees(input, key);
  return parseLine(input);
}
export function formatLine(events, key) {
  return events.map(e => e.midi === null ? `r:${fmt(e.steps)}` : `${noteName(e.midi, key)}:${fmt(e.steps)}${e.velocity ? ':' + e.velocity : ''}`).join(' ');
}
export const totalSteps = events => events.reduce((sum, e) => sum + e.steps, 0);
export const pitches = events => events.filter(e => e.midi !== null).map(e => e.midi);
export function contour(events) {
  const p = pitches(events);
  return p.slice(1).map((m, i) => Math.sign(m - p[i]));
}
// Events to raw notes (ticks), starting at `offset` ticks.
export function toNotes(events, { stepsPerBar = 16, offset = 0, velocity = 88, gate = 0.92 } = {}) {
  const step = 192 / stepsPerBar;
  const notes = [];
  let at = 0;
  for (const e of events) {
    const length = e.steps * step;
    if (e.midi !== null) notes.push({ tick: Math.round(offset + at), midi: e.midi, length: Math.max(1, Math.round(length * gate)), velocity: e.velocity ?? velocity });
    at += length;
  }
  return notes;
}

// ---------- operations ----------
const map = (events, f) => events.map(e => e.midi === null ? { ...e } : { ...e, midi: f(e.midi) });
export function fitKey(events, key) {
  let snapped = 0;
  const out = map(events, midi => {
    if (inKey(midi, key)) return midi;
    snapped++;
    return fromDegree(degreeOf(midi, key), key);
  });
  return { events: out, snapped };
}
export function shift(events, key, steps) {
  return map(events, midi => fromDegree(degreeOf(midi, key) + steps, key));
}
export function repeat(events, times = 2) {
  return Array.from({ length: times }, () => events.map(e => ({ ...e }))).flat();
}
// The statement, then copies moved by `step` scale degrees each time.
export function sequence(events, key, { step = 1, count = 2 } = {}) {
  return Array.from({ length: count }, (_, i) => shift(events, key, step * i)).flat();
}
export function chordTones(symbol) {
  const chord = parseChord(symbol);
  return new Set(chord.intervals.map(i => mod(chord.root + i, 12)));
}
// Move the motif by the scale step (within a fourth) that puts the most weight on tones of `chord`.
// Weight favours long notes, notes on the beat, and the first and last notes.
export function fitToChord(events, key, chord) {
  const tones = chordTones(chord);
  let best = { cost: Infinity, steps: 0 };
  for (const steps of [0, 1, -1, 2, -2, 3, -3]) {
    let at = 0, cost = 0;
    const moved = shift(events, key, steps), notes = moved.filter(e => e.midi !== null);
    for (const e of moved) {
      if (e.midi !== null && !tones.has(mod(e.midi, 12))) {
        cost += e.steps + (at % 4 === 0 ? 2 : 0) + (e === notes[0] || e === notes.at(-1) ? 4 : 0);
      }
      at += e.steps;
    }
    if (cost < best.cost) best = { cost, steps, events: moved };
  }
  return { events: best.events, steps: best.steps };
}
// Mirror every interval around `axis` (default: the first note), in scale steps.
export function invert(events, key, axis) {
  const first = events.find(e => e.midi !== null);
  if (!first) return events.map(e => ({ ...e }));
  const centre = degreeOf(axis ?? first.midi, key);
  return map(events, midi => fromDegree(2 * centre - degreeOf(midi, key), key));
}
export function retrograde(events) {
  return events.map(e => ({ ...e })).reverse();
}
export function augment(events, factor = 2) {
  return events.map(e => ({ ...e, steps: e.steps * factor }));
}
export function diminish(events, factor = 2) {
  return events.map(e => ({ ...e, steps: e.steps / factor }));
}
// Change durations but keep the notes in order, so the contour and the total length stay the same.
// Works inside each run of notes between rests.
function runs(events) {
  const groups = [];
  let current = null;
  for (const e of events) {
    if (e.midi === null) { groups.push({ rest: e }); current = null; continue; }
    if (!current) groups.push(current = { notes: [] });
    current.notes.push(e);
  }
  return groups;
}
const rhythmStyles = {
  dotted: notes => {
    const out = notes.map(e => ({ ...e }));
    for (let i = 0; i + 1 < out.length; i += 2) {
      const sum = out[i].steps + out[i + 1].steps;
      if (sum < 2) continue;
      const first = Math.min(sum - 1, Math.max(1, Math.round(sum * 0.75)));
      out[i].steps = first; out[i + 1].steps = sum - first;
    }
    return out;
  },
  swap: notes => {
    const out = notes.map(e => ({ ...e }));
    for (let i = 0; i + 1 < out.length; i += 2) [out[i].steps, out[i + 1].steps] = [out[i + 1].steps, out[i].steps];
    return out;
  },
  // Equal whole steps where possible; the last note takes whatever is left, so the total never drifts.
  even: notes => {
    const sum = notes.reduce((s, e) => s + e.steps, 0), base = Math.floor(sum / notes.length);
    if (!base) return notes.map(e => ({ ...e }));
    let extra = Math.floor(sum - base * notes.length);
    const out = notes.map(e => ({ ...e, steps: base + (extra-- > 0 ? 1 : 0) }));
    out.at(-1).steps = sum - out.slice(0, -1).reduce((s, e) => s + e.steps, 0);
    return out;
  },
};
export const rhythmStyleNames = Object.keys(rhythmStyles);
export function varyRhythm(events, style) {
  const apply = name => runs(events).flatMap(g => g.rest ? [{ ...g.rest }] : rhythmStyles[name](g.notes));
  const same = out => out.every((e, i) => e.steps === events[i].steps);
  if (style) return apply(style);
  for (const name of rhythmStyleNames) { const out = apply(name); if (!same(out)) return out; }
  return apply('dotted');
}
const lastNote = events => events.findLastIndex(e => e.midi !== null);
// The first or last cell: the notes before or after the note boundary nearest half the length. Trailing rests are dropped.
export function fragment(events, which = 'first') {
  const total = totalSteps(events.slice(0, lastNote(events) + 1));
  let at = 0, cut = 1, bestDistance = Infinity;
  for (let i = 1; i < events.length; i++) {
    at += events[i - 1].steps;
    if (events[i].midi === null) continue;
    const distance = Math.abs(at - total / 2);
    if (distance < bestDistance) { bestDistance = distance; cut = i; }
  }
  let part = which === 'last' ? events.slice(cut) : events.slice(0, cut);
  if (!part.some(e => e.midi !== null)) part = events.slice(0, lastNote(events) + 1);
  while (part.length > 1 && part.at(-1).midi === null) part = part.slice(0, -1);
  return part.map(e => ({ ...e }));
}
// Move the note at `index` to the nearest note whose scale degree is in `degrees` (0 = tonic).
function landOn(events, key, index, degrees) {
  const out = events.map(e => ({ ...e }));
  const from = degreeOf(out[index].midi, key);
  let best = from, bestDistance = Infinity;
  for (let d = from - 7; d <= from + 7; d++) {
    if (degrees.includes(mod(d, 7)) && Math.abs(d - from) < bestDistance) { best = d; bestDistance = Math.abs(d - from); }
  }
  out[index].midi = fromDegree(best, key);
  return out;
}
// Statement then answer. The call ends open (on the 2nd or 5th). The answer keeps the opening,
// mirrors the second half, and ends on the tonic.
export function callAndResponse(events, key) {
  let call = events.map(e => ({ ...e }));
  if (mod(degreeOf(call[lastNote(call)].midi, key), 7) === 0) call = landOn(call, key, lastNote(call), [1, 4]);
  const head = fragment(events, 'first'), tail = events.slice(head.length);
  const firstTail = tail.find(e => e.midi !== null);
  let answer = [...head, ...(firstTail ? invert(tail, key, firstTail.midi) : tail.map(e => ({ ...e })))];
  answer = landOn(answer, key, lastNote(answer), [0]);
  return { call, answer, events: [...call, ...answer] };
}
// Rewrite the ending: the last note lands on the tonic (authentic) or the 5th (half), approached by step,
// and trailing rests are folded into the final note so it rings.
// With `chord` (the chord under the last note), the ending lands on a tone of that chord: the tonic (or 5th)
// when the chord has it, otherwise the most stable scale degree that the chord does have.
const cadenceDegrees = { authentic: [0, 2, 4, 5, 3, 1, 6], half: [4, 1, 6, 2, 0, 3, 5] };
export function cadence(events, key, type = 'authentic', { chord } = {}) {
  let out = events.map(e => ({ ...e }));
  const last = lastNote(out);
  if (last < 0) return out;
  const trailing = out.slice(last + 1).reduce((s, e) => s + e.steps, 0);
  out = out.slice(0, last + 1);
  out[last].steps += trailing;
  const before = out.findLastIndex((e, i) => i < last && e.midi !== null);
  // Pick the target nearest the last note, weighing the note before it too, so the ending does not leap away.
  const lastDegree = degreeOf(out[last].midi, key), beforeDegree = before >= 0 ? degreeOf(out[before].midi, key) : lastDegree;
  const order = cadenceDegrees[type === 'half' ? 'half' : 'authentic'];
  const tones = chord ? chordTones(chord) : null;
  const wanted = (tones && order.find(d => tones.has(mod(key.tonic + key.scale[d], 12)))) ?? order[0];
  let target = lastDegree, bestCost = Infinity;
  for (let d = lastDegree - 7; d <= lastDegree + 7; d++) {
    if (mod(d, 7) !== wanted) continue;
    const cost = Math.abs(d - lastDegree) + Math.abs(d - beforeDegree) / 2 + (d > lastDegree ? 0.25 : 0);
    if (cost < bestCost) { bestCost = cost; target = d; }
  }
  out[last].midi = fromDegree(target, key);
  if (before >= 0) {
    const current = degreeOf(out[before].midi, key);
    out[before].midi = fromDegree(current >= target ? target + 1 : target - 1, key);
  }
  return out;
}
// Shift by octaves so the lowest note is at or above `low` and the line sits as near the middle of [low, high] as it can.
export function fitRegister(events, low, high) {
  const p = pitches(events);
  if (!p.length) return events.map(e => ({ ...e }));
  const min = Math.min(...p), max = Math.max(...p);
  let best = 0, bestCost = Infinity;
  for (let k = -8; k <= 8; k++) {
    const lo = min + 12 * k, hi = max + 12 * k;
    if (lo < low) continue;
    const cost = Math.max(0, hi - high) * 4 + Math.abs((lo + hi) / 2 - (low + high) / 2);
    if (cost < bestCost) { bestCost = cost; best = k; }
  }
  return events.map(e => e.midi === null ? { ...e } : { ...e, midi: e.midi + 12 * best });
}
// Cut or pad to exactly `steps`: notes that cross the end are shortened, short lines are padded with a rest.
export function fitLength(events, steps) {
  const out = [];
  let at = 0;
  for (const e of events) {
    if (at >= steps) break;
    out.push({ ...e, steps: Math.min(e.steps, steps - at) });
    at += out.at(-1).steps;
  }
  if (at < steps) out.push({ midi: null, steps: steps - at });
  return out;
}

export const operations = {
  repeat: { about: 'The motif twice.', run: (m, k, o) => repeat(m, o.times ?? 2) },
  sequence_up: { about: 'Statement, then the same shape one scale step higher.', run: (m, k, o) => sequence(m, k, { step: o.step ?? 1, count: o.count ?? 2 }) },
  sequence_down: { about: 'Statement, then the same shape one scale step lower.', run: (m, k, o) => sequence(m, k, { step: -(o.step ?? 1), count: o.count ?? 2 }) },
  fit_chord: { about: 'Moved by scale steps so the long and strong notes are tones of the chord.', run: (m, k, o) => fitToChord(m, k, o.chord ?? defaultChord(k)).events },
  invert: { about: 'Every interval mirrored around the first note, in scale steps.', run: (m, k) => invert(m, k) },
  retrograde: { about: 'Notes and rhythm played backwards.', run: m => retrograde(m) },
  augment: { about: 'Every length doubled.', run: (m, k, o) => augment(m, o.factor ?? 2) },
  diminish: { about: 'Every length halved.', run: (m, k, o) => diminish(m, o.factor ?? 2) },
  rhythm: { about: 'Same notes and contour with a new rhythm in the same total length.', run: (m, k, o) => varyRhythm(m, o.rhythm) },
  fragment_first: { about: 'The first cell only.', run: m => fragment(m, 'first') },
  fragment_last: { about: 'The last cell only.', run: m => fragment(m, 'last') },
  call_response: { about: 'Statement that ends open, then an answer that ends on the tonic.', run: (m, k) => callAndResponse(m, k).events },
  cadence: { about: 'Ending rewritten to land on the tonic by step, with the last note held.', run: (m, k, o) => cadence(m, k, 'authentic', { chord: o.chord }) },
  half_cadence: { about: 'Ending rewritten to land on the 5th, leaving the phrase open.', run: (m, k, o) => cadence(m, k, 'half', { chord: o.chord }) },
};
export const operationNames = Object.keys(operations);
function defaultChord(key) {
  const third = key.scale[2] - key.scale[0] === 3 ? 'm' : '';
  return pitchClassName(key.tonic, key) + third;
}
// Apply operations to a motif and return melody lines. Everything stays in `key`; chromatic input notes are snapped first.
export function developMotif(input, keyInput, { operations: wanted = operationNames, stepsPerBar = 16, ...options } = {}) {
  const key = parseKey(keyInput);
  const { events: motif, snapped } = fitKey(readMotif(input, key, { stepsPerBar }), key);
  if (!pitches(motif).length) throw new Error('The motif needs at least one note');
  const describe = (events, extra = {}) => {
    const p = pitches(events);
    if (p.some(m => m < 12 || m > 119)) throw new Error('A variation went outside MIDI 12-119. Start the motif in a middle octave.');
    const steps = totalSteps(events);
    return { line: formatLine(events, key), steps, bars: Number((steps / stepsPerBar).toFixed(3)), lowest: noteName(Math.min(...p), key), highest: noteName(Math.max(...p), key), ...extra };
  };
  const variations = wanted.map(name => {
    const op = operations[name];
    if (!op) throw new Error(`Unknown operation "${name}". Use: ${operationNames.join(', ')}`);
    return { operation: name, about: op.about, ...describe(op.run(motif, key, options)) };
  });
  return { key: key.name, stepsPerBar, motif: describe(motif), ...(snapped ? { snappedToKey: snapped } : {}), variations };
}

export function register({ tool, z }) {
  tool('develop_motif', 'Develop one short motif instead of writing a new tune for every section. Takes a melody line (NOTE:steps, r:steps for rests) or raw notes plus a key, and returns diatonic variations as melody lines ready to paste into a pattern melody: repeat, sequence up or down, fit to a chord, inversion, retrograde, augmentation, diminution, a rhythm change that keeps the contour, first or last fragment, call and response, and cadence endings. Every result stays in the key.', {
    motif: z.union([z.string().min(1).max(2000), z.array(z.object({ tick: z.number().int().min(0), length: z.number().int().min(1), midi: z.number().int().min(12).max(119), velocity: z.number().int().min(1).max(200).optional() })).min(1).max(256)])
      .describe('A melody line such as "D5:2 F5:2 A5:4 G5:2 F5:2 E5:4", or raw notes in ticks (48 per beat).'),
    key: z.string().min(1).max(30).describe('Tonic and mode, for example "D minor", "F# dorian", "Bb major", "C harmonic minor".'),
    operations: z.array(z.enum(operationNames)).min(1).max(operationNames.length).optional().describe('Which variations to return. Default: all.'),
    chord: z.string().max(12).optional().describe('Chord for fit_chord, such as "Gm" or "F" (default: the tonic chord). For cadence and half_cadence, the chord under the last note: the ending then lands on one of its tones.'),
    step: z.number().int().min(1).max(4).optional().describe('Scale steps per sequence move. Default 1.'),
    count: z.number().int().min(2).max(4).optional().describe('Statements in a sequence. Default 2.'),
    rhythm: z.enum(rhythmStyleNames).optional().describe('Rhythm change style. Default: the first of dotted, swap, even that changes the motif.'),
    stepsPerBar: z.number().int().min(4).max(48).default(16),
  }, async ({ motif, key, operations: ops, ...options }) => developMotif(motif, key, { operations: ops, ...options }));
}
