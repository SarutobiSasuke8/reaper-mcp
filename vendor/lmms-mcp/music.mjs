// Turn chord symbols, drum grids and melody strings into LMMS piano-roll notes.
// One bar is 192 ticks; the default grid is sixteenth notes (12 ticks).
const letters = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const qualities = {
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8],
  5: [0, 7], sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
  7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], mMaj7: [0, 3, 7, 11],
  dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], '7sus4': [0, 5, 7, 10], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], 11: [0, 4, 7, 10, 14, 17], 13: [0, 4, 7, 10, 14, 21],
};
function pitchClass(name) {
  const match = /^([A-Ga-g])([#b]*)$/.exec(name);
  if (!match) throw new Error(`Unknown note name "${name}"`);
  let value = letters[match[1].toUpperCase()];
  for (const accidental of match[2]) value += accidental === '#' ? 1 : -1;
  return ((value % 12) + 12) % 12;
}
// "D5" -> 74 (C4 is MIDI 60). Plain MIDI numbers pass through.
export function noteNumber(token) {
  if (/^\d+$/.test(String(token))) return Number(token);
  const match = /^([A-Ga-g][#b]*)(-?\d)$/.exec(String(token));
  if (!match) throw new Error(`Unknown note "${token}". Use names like D5, F#3, Bb4 or a MIDI number.`);
  return pitchClass(match[1]) + (Number(match[2]) + 1) * 12;
}
export function parseChord(symbol) {
  const match = /^([A-G][#b]*)([^/]*)(?:\/([A-G][#b]*))?$/.exec(symbol);
  if (!match || !(match[2] in qualities)) {
    throw new Error(`Unknown chord "${symbol}". Supported qualities: ${Object.keys(qualities).filter(Boolean).join(', ')}`);
  }
  return { symbol, root: pitchClass(match[1]), intervals: qualities[match[2]], bass: match[3] === undefined ? null : pitchClass(match[3]) };
}
// Build a voicing with the root in `octave`. With `previous`, pick the inversion that moves the least.
export function voiceChord(chord, { octave = 4, voicing = 'close', previous } = {}) {
  const base = chord.root + (octave + 1) * 12;
  let notes = chord.intervals.map(interval => base + interval);
  if (voicing === 'open' && notes.length >= 3) notes = [notes[0], notes[2], notes[1] + 12, ...notes.slice(3).map(n => n + 12)];
  if (voicing === 'spread' && notes.length >= 3) notes = [notes[0] - 12, notes[2], notes[1] + 12, ...notes.slice(3)];
  if (previous?.length && voicing === 'close') {
    const centre = previous.reduce((a, b) => a + b, 0) / previous.length;
    let best = notes, bestCost = Infinity;
    for (let shift = -2; shift <= 2; shift++) {
      for (let inversion = 0; inversion < notes.length; inversion++) {
        const candidate = notes.map((n, i) => n + (i < inversion ? 12 : 0) + shift * 12).sort((a, b) => a - b);
        const cost = Math.abs(candidate.reduce((a, b) => a + b, 0) / candidate.length - centre);
        if (cost < bestCost) { bestCost = cost; best = candidate; }
      }
    }
    notes = best;
  }
  return notes.sort((a, b) => a - b);
}
export function bassNote(chord, octave = 2) {
  return (chord.bass ?? chord.root) + (octave + 1) * 12;
}

// Small deterministic generator so `humanize` gives the same result on every call.
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
const gridVelocity = { X: 100, x: 82, o: 60, g: 34 };

function fromSteps(spec, ticks, step) {
  const grid = spec.grid.replace(/[\s|]/g, '');
  if (!grid || /[^Xxog.\-_]/.test(grid)) throw new Error('Step grids use X (accent), x (hit), o (soft), g (ghost) and - or . (rest)');
  const midi = noteNumber(spec.midi ?? 69);
  const notes = [];
  for (let index = 0; index * step < ticks; index++) {
    const char = grid[index % grid.length];
    if (!(char in gridVelocity)) continue;
    notes.push({ tick: index * step, midi, length: Math.min(spec.length ?? step, ticks - index * step), velocity: gridVelocity[char] });
  }
  return notes;
}
function fromMelody(spec, ticks, step) {
  const tokens = spec.line.replace(/\|/g, ' ').trim().split(/\s+/).filter(Boolean);
  const gate = spec.gate ?? 0.95;
  const phrase = [];
  let at = 0;
  for (const token of tokens) {
    const match = /^(\[[^\]]+\]|[^:]+)(?::([\d.]+))?(?::(\d+))?$/.exec(token);
    if (!match) throw new Error(`Cannot read melody token "${token}". Use NOTE:steps or NOTE:steps:velocity, r:steps for a rest.`);
    const length = Number(match[2] ?? 1) * step;
    if (!(length > 0)) throw new Error(`Melody token "${token}" needs a positive length in steps`);
    if (!/^[rR_]$/.test(match[1])) {
      const pitches = match[1].startsWith('[') ? match[1].slice(1, -1).split(/[,+]/) : [match[1]];
      for (const pitch of pitches) {
        phrase.push({ tick: at, midi: noteNumber(pitch.trim()), length: Math.max(1, Math.round(length * gate)), velocity: Number(match[3] ?? spec.velocity ?? 88) });
      }
    }
    at += length;
  }
  if (!at) throw new Error('Melody line is empty');
  const notes = [];
  const repeats = spec.repeat === false ? 1 : Math.ceil(ticks / at);
  for (let r = 0; r < repeats; r++) {
    for (const n of phrase) {
      const tick = Math.round(n.tick + r * at);
      if (tick < ticks) notes.push({ ...n, tick, length: Math.min(n.length, ticks - tick) });
    }
  }
  return notes;
}
const arpOrders = {
  up: n => Array.from({ length: n }, (_, i) => i),
  down: n => Array.from({ length: n }, (_, i) => n - 1 - i),
  updown: n => n < 3 ? [0, 1].slice(0, n) : [...Array.from({ length: n }, (_, i) => i), ...Array.from({ length: n - 2 }, (_, i) => n - 2 - i)],
  alberti: () => [0, 2, 1, 2],
  broken: () => [0, 1, 2, 1, 3, 2, 1, 2],
};
function fromChords(spec, ticks, step) {
  const symbols = Array.isArray(spec.progression) ? spec.progression : spec.progression.trim().split(/[\s|]+/).filter(Boolean);
  if (!symbols.length) throw new Error('Chord progression is empty');
  const style = spec.style ?? 'block', velocity = spec.velocity ?? (style === 'block' ? 70 : 84), gate = spec.gate ?? (style === 'block' ? 0.98 : 0.8);
  const notes = [];
  let at = 0, previous, index = 0;
  while (at < ticks) {
    const [symbol, bars] = symbols[index++ % symbols.length].split(':');
    const chord = parseChord(symbol);
    const span = Math.min(ticks - at, Math.round(Number(bars ?? spec.barsPerChord ?? 1) * 192));
    if (!(span > 0)) throw new Error(`Chord "${symbol}" needs a positive length in bars`);
    const voiced = voiceChord(chord, { octave: spec.octave ?? 4, voicing: spec.voicing ?? 'close', previous: spec.voiceLead === false ? undefined : previous });
    previous = voiced;
    const put = (tick, midi, length, vel) => {
      if (tick < at + span) notes.push({ tick, midi, length: Math.max(1, Math.min(Math.round(length), at + span - tick)), velocity: Math.round(vel) });
    };
    if (style === 'block') {
      voiced.forEach((midi, i) => put(at, midi, span * gate, velocity - (voiced.length - 1 - i) * 2));
    } else if (style === 'pulse') {
      const rate = (spec.rate ?? 4) * step;
      for (let t = 0; t < span; t += rate) voiced.forEach(midi => put(at + t, midi, rate * gate, t % 192 === 0 ? velocity : velocity - 10));
    } else if (style === 'arp') {
      const rate = (spec.rate ?? 1) * step;
      const tones = [...voiced, ...(spec.octaves === 2 ? voiced.map(n => n + 12) : [])];
      const order = (arpOrders[spec.order ?? 'up'] ?? arpOrders.up)(tones.length);
      for (let t = 0, i = 0; t < span; t += rate, i++) {
        const accent = (t / step) % 4 === 0;
        put(at + t, tones[order[i % order.length] % tones.length], rate * gate, accent ? velocity : velocity - 22);
      }
    } else if (style === 'bass') {
      const root = bassNote(chord, spec.octave ?? 2);
      const figure = spec.figure ?? 'eighths';
      if (figure === 'whole') put(at, root, span * 0.97, velocity);
      else if (figure === 'octaves') for (let t = 0, i = 0; t < span; t += 2 * step, i++) put(at + t, root + (i % 2 ? 12 : 0), 2 * step * gate, i % 2 ? velocity - 12 : velocity);
      else if (figure === 'syncopated') [[0, 2.5, 0], [3, 1.5, 0], [6, 2, 12], [8, 2.5, 0], [11, 1.5, 0], [14, 2, 12]].forEach(([s, l, o], i) => {
        for (let bar = 0; bar * 192 < span; bar++) put(at + bar * 192 + s * 12, root + o, l * 12 - 2, i % 3 === 0 ? velocity : velocity - 14);
      });
      else for (let t = 0, i = 0; t < span; t += 2 * step, i++) put(at + t, root, 2 * step * gate, i % 4 === 0 ? velocity : velocity - 16);
    } else throw new Error(`Unknown chord style "${style}"`);
    at += span;
  }
  return notes;
}

export function swingTick(tick, step, amount) {
  return tick % (step * 2) === step ? tick + Math.round(step * amount) : tick;
}

// Resolve a pattern spec to plain notes. Exactly one of notes, steps, melody or chords must be present.
export function expandPattern(spec) {
  const sources = ['notes', 'steps', 'melody', 'chords'].filter(key => spec[key] !== undefined);
  if (sources.length !== 1) throw new Error('Give each pattern exactly one of: notes, steps, melody or chords');
  const ticks = spec.bars * 192;
  let notes;
  if (spec.notes) notes = spec.notes.map(n => ({ ...n }));
  else {
    const source = spec[sources[0]];
    const perBar = source.stepsPerBar ?? 16;
    if (192 % perBar) throw new Error('stepsPerBar must divide 192 (for example 4, 8, 12, 16, 24, 32)');
    const step = 192 / perBar;
    notes = sources[0] === 'steps' ? fromSteps(source, ticks, step) : sources[0] === 'melody' ? fromMelody(source, ticks, step) : fromChords(source, ticks, step);
    const swing = source.swing ?? 0;
    if (swing) for (const n of notes) n.tick = swingTick(n.tick, step, swing);
    if (source.humanize) {
      const next = random(source.seed ?? 1);
      for (const n of notes) n.velocity += Math.round((next() - 0.5) * 2 * source.humanize);
    }
  }
  const transpose = spec.transpose ?? 0;
  notes = notes.map(n => ({ tick: Math.round(n.tick), length: Math.max(1, Math.round(n.length)), midi: n.midi + transpose,
    velocity: Math.max(1, Math.min(200, Math.round(n.velocity))) }))
    .filter(n => n.tick < ticks).map(n => ({ ...n, length: Math.min(n.length, ticks - n.tick) }));
  if (!notes.length) throw new Error(`Pattern "${spec.name}" has no notes`);
  if (notes.some(n => n.midi < 12 || n.midi > 119)) throw new Error(`Pattern "${spec.name}" has notes outside MIDI 12-119`);
  return notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
}
export const chordQualities = Object.keys(qualities).filter(Boolean);
