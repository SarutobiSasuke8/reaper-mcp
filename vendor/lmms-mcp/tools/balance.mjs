// Mix balancing by measurement: auto_balance renders stems, sets track volumes from role targets and protects the master,
// and compare_to_reference measures how a render differs from a reference track.
// The decisions live in plain-data functions below so they can be unit tested without LMMS.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as dsp from '../audio.mjs';

const hasOwn = (object, key) => object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
const toGain = decibels => 10 ** (decibels / 20);
const toDb = gain => 20 * Math.log10(gain);
const round = (value, places = 2) => value === null || value === undefined ? value : Number(value.toFixed(places));
const maxVolume = 200;

// ---------- targets ----------

// Starting points from a 15-track, 90-second game theme measured over its loudest 8 bars.
// Drums are peak targets (they are transients); pitched parts are RMS targets over the time they sound.
export const defaultTargets = {
  kick: { measure: 'peak', db: -7 },
  snare: { measure: 'peak', db: -8.5 },
  clap: { measure: 'peak', db: -15 },
  hat: { measure: 'peak', db: -19 },
  crash: { measure: 'peak', db: -13 },
  tom: { measure: 'peak', db: -9 },
  perc: { measure: 'peak', db: -15 },
  drums: { measure: 'peak', db: -8 },
  bass: { measure: 'rms', db: -18 },
  lead: { measure: 'rms', db: -17 },
  counter: { measure: 'rms', db: -22 },
  harmony: { measure: 'rms', db: -22.5 },
  texture: { measure: 'rms', db: -26 },
  fx: { measure: 'rms', db: -24 },
};
export const drumKinds = ['kick', 'snare', 'clap', 'hat', 'crash', 'tom', 'perc'];
export const pitchedRoles = ['bass', 'harmony', 'lead', 'counter', 'texture'];

// Reject override keys that would be silently ignored or that collide with object internals.
export function validateTargets(targets = {}, trackNames = []) {
  const unknownRoles = Object.keys(targets.roles ?? {}).filter(key => !hasOwn(defaultTargets, key));
  if (unknownRoles.length) throw new Error(`Unknown target roles: ${unknownRoles.join(', ')}. Use ${Object.keys(defaultTargets).join(', ')}.`);
  const unknownTracks = Object.keys(targets.tracks ?? {}).filter(key => !trackNames.includes(key));
  if (unknownTracks.length) throw new Error(`Target tracks not found among the balanced tracks: ${unknownTracks.join(', ')}`);
}

// The target for one track: a per-track override, else a per-kind or per-role override, else the defaults.
export function targetFor({ role, kind }, trackName, overrides = {}) {
  const key = role === 'drums' ? kind ?? 'drums' : role;
  const base = hasOwn(defaultTargets, key) ? defaultTargets[key] : hasOwn(defaultTargets, role) ? defaultTargets[role] : defaultTargets.harmony;
  const pick = value => typeof value === 'number' ? { measure: base.measure, db: value } : { measure: value.measure ?? base.measure, db: value.db };
  if (hasOwn(overrides.tracks, trackName)) return { ...pick(overrides.tracks[trackName]), from: 'track override' };
  if (hasOwn(overrides.roles, key)) return { ...pick(overrides.roles[key]), from: 'role override' };
  if (key !== role && hasOwn(overrides.roles, role)) return { ...pick(overrides.roles[role]), from: 'role override' };
  return { ...base, from: 'default ' + key };
}

// ---------- roles ----------

// Lower-case words of a name, splitting camelCase, digits and punctuation: "LeadSynth_2" -> lead synth 2.
export function words(name = '') {
  return String(name).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([a-zA-Z])(\d)/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
const phrase = (list, ...seq) => list.some((_, i) => seq.every((word, k) => list[i + k] === word));
const kindWords = {
  kick: ['kick', 'kicks', 'bd', 'kickdrum', 'bassdrum'],
  snare: ['snare', 'snares', 'sd', 'rim', 'rimshot'],
  clap: ['clap', 'claps', 'snap', 'snaps'],
  hat: ['hat', 'hats', 'hihat', 'hihats', 'hh', 'shaker', 'tambourine', 'tamb'],
  crash: ['crash', 'cymbal', 'cymbals', 'ride', 'splash', 'china'],
  tom: ['tom', 'toms', 'floortom'],
  perc: ['perc', 'percussion', 'conga', 'congas', 'bongo', 'bongos', 'cowbell', 'clave', 'claves', 'triangle', 'woodblock'],
};
const roleWords = [
  ['drums', ['drum', 'drums', 'kit', 'breakbeat', 'drumloop']],
  ['bass', ['bass', 'bassline', 'sub', '808']],
  ['counter', ['counter', 'countermelody', 'answer', 'response', 'obbligato']],
  ['lead', ['lead', 'melody', 'solo', 'hook', 'motif', 'vocal']],
  ['texture', ['pad', 'pads', 'texture', 'ambience', 'ambient', 'atmos', 'atmosphere', 'drone', 'noise', 'wash']],
  ['harmony', ['chord', 'chords', 'harmony', 'keys', 'piano', 'organ', 'strings', 'string', 'comp', 'arp', 'arps', 'arpeggio', 'pluck', 'plucks', 'guitar', 'harp', 'rhythm', 'stabs']],
  ['fx', ['fx', 'sfx', 'riser', 'sweep', 'impact', 'whoosh', 'swell', 'reverse', 'uplifter', 'downlifter']],
];

// Which drum a track or sample name points at, by whole words only, or null.
export function drumKind(...names) {
  for (const name of names.filter(Boolean)) {
    const list = words(name);
    if (phrase(list, 'bass', 'drum')) return 'kick';
    if (phrase(list, 'hi', 'hat')) return 'hat';
    if (phrase(list, 'floor', 'tom')) return 'tom';
    for (const [kind, set] of Object.entries(kindWords)) if (list.some(word => set.includes(word))) return kind;
  }
  return null;
}
function roleFromName(name) {
  const list = words(name);
  if (phrase(list, 'second', 'lead') || phrase(list, 'lead', '2')) return 'counter';
  for (const [role, set] of roleWords) if (list.some(word => set.includes(word))) return role;
  return null;
}

// What the notes say: count, median pitch, how many sound at once and how long they last.
export function noteFacts(notes) {
  if (!notes?.length) return null;
  const pitches = notes.map(n => n.midi).sort((a, b) => a - b);
  const events = notes.flatMap(n => [[n.tick, 1], [n.tick + Math.max(1, n.length), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let sounding = 0, polyphony = 0;
  for (const [, change] of events) { sounding += change; polyphony = Math.max(polyphony, sounding); }
  return { count: notes.length, medianMidi: pitches[Math.floor(pitches.length / 2)], maxPolyphony: polyphony,
    meanLengthBeats: round(notes.reduce((sum, n) => sum + n.length, 0) / notes.length / 48, 2) };
}
function roleFromNotes(facts) {
  if (!facts || facts.count < 2) return null;
  if (facts.medianMidi < 48 && facts.maxPolyphony <= 2) return 'bass';
  if (facts.maxPolyphony >= 3) return facts.meanLengthBeats >= 4 ? 'texture' : 'harmony';
  return 'lead';
}

// Decide a track's role. A declared role wins. Otherwise: whole-word name match, checked against the measured sound;
// then the instrument; then the notes; then the spectrum. Every guess says where it came from.
// `facts` is plain data: { name, declared, plugin, sample, notes (noteFacts), centroidHz, lowShare, crestDb, activeShare }.
export function guessRole(facts) {
  const { name = '', declared, plugin, sample, notes } = facts;
  const kindFromText = () => drumKind(name, sample && path.basename(sample));
  if (declared) return { role: declared, kind: declared === 'drums' ? kindFromText() ?? spectrumKind(facts) : null, source: 'declared' };
  // Sustained or chordal material is not a drum, whatever it is called.
  const sustained = (facts.crestDb !== undefined && facts.crestDb < 9) || (notes && notes.maxPolyphony >= 3);
  const nameKind = drumKind(name);
  const nameRole = nameKind ? 'drums' : roleFromName(name);
  let overruled = null;
  if (nameRole === 'drums' && sustained) overruled = 'drums';
  else if (nameRole) return { role: nameRole, kind: nameRole === 'drums' ? nameKind ?? kindFromText() ?? spectrumKind(facts) : null, source: 'guess from name' };
  const note = overruled ? ` (the name suggests ${overruled}, the sound does not)` : '';
  if (plugin === 'kicker') return { role: 'drums', kind: 'kick', source: 'guess from instrument' + note };
  if (sample) {
    const lower = sample.toLowerCase().replaceAll('\\', '/');
    const sampleKind = drumKind(path.basename(lower).replace(/\.\w+$/, ''));
    if (lower.includes('drums/') || sampleKind) return { role: 'drums', kind: sampleKind ?? spectrumKind(facts), source: 'guess from instrument' + note };
    if (lower.includes('basses/') || words(path.basename(lower)).includes('bass')) return { role: 'bass', kind: null, source: 'guess from instrument' + note };
  }
  const fromNotes = roleFromNotes(notes);
  if (fromNotes) return { role: fromNotes, kind: null, source: 'guess from notes' + note };
  return { ...spectrumRole(facts), source: 'guess from spectrum' + note };
}
function spectrumKind({ centroidHz }) {
  if (!centroidHz) return null;
  if (centroidHz < 250) return 'kick';
  if (centroidHz > 5000) return 'hat';
  return null;
}
function spectrumRole({ centroidHz = 1000, lowShare = 0, crestDb = 10, activeShare = 1 }) {
  const percussive = crestDb > 18;
  if (lowShare > 0.6 && centroidHz < 300) return percussive ? { role: 'drums', kind: 'kick' } : { role: 'bass', kind: null };
  if (percussive) return { role: 'drums', kind: spectrumKind({ centroidHz }) };
  if (crestDb < 11 && activeShare > 0.6) return { role: centroidHz > 2500 ? 'texture' : 'harmony', kind: null };
  return { role: centroidHz > 700 ? 'lead' : 'harmony', kind: null };
}

// ---------- which tracks ----------

// Pick the tracks to balance from plain facts ({ name, control, muted, solo }). Solo changes what the mix is,
// so rather than balance a partial mix and set the master from it, refuse.
export function selectTracks(list) {
  const soloed = list.filter(t => !t.control && t.solo).map(t => t.name);
  if (soloed.length) throw new Error(`Solo is on for ${soloed.join(', ')}. auto_balance balances the whole mix: clear solo (set_track_mix solo false) and mute what should stay out.`);
  const picked = list.map((t, index) => ({ ...t, index })).filter(t => !t.control && !t.muted);
  if (!picked.length) throw new Error('No unmuted audio tracks to balance');
  return picked.map(t => t.index);
}

// Effects whose output depends on level break both the gain maths and the summed prediction. Linear ones do not.
const levelDependent = /sc4|compress|limit|dynamics|waveshap|bitcrush|bassboost|distort|clip|gate|expand|satur/i;
export function effectNote(where, effects) {
  const dynamic = effects.filter(name => levelDependent.test(name) || name.startsWith('ladspa'));
  if (!dynamic.length) return null;
  return `${where} has level-dependent effects (${dynamic.join(', ')}): gains do not add up exactly and the prediction is approximate. Render the mix and check it.`;
}

// ---------- automation ----------

// Mean and maximum of an automated control over [fromTick, toTick), from its clips and base value.
// clips: [{ pos, len, prog (0 step, 1 linear, 2 smooth), points: [{ pos, value }] }] with point positions relative to the clip.
export function automationLevel(clips, baseValue, fromTick, toTick, { step = 6 } = {}) {
  const sorted = clips.filter(c => c.points.length).sort((a, b) => a.pos - b.pos);
  const valueAt = tick => {
    let held = baseValue;
    for (const clip of sorted) {
      if (clip.pos > tick) break;
      const local = tick - clip.pos, points = clip.points;
      if (local >= clip.len) { held = points[points.length - 1].value; continue; }
      let i = 0;
      while (i + 1 < points.length && points[i + 1].pos <= local) i++;
      if (local < points[0].pos) return points[0].value;
      const [a, b] = [points[i], points[i + 1]];
      return !b || clip.prog === 0 ? a.value : a.value + (b.value - a.value) * (local - a.pos) / (b.pos - a.pos);
    }
    return held;
  };
  let sum = 0, count = 0;
  for (let tick = fromTick; tick < toTick; tick += step) { sum += valueAt(tick); count++; }
  const max = Math.max(baseValue, ...sorted.flatMap(clip => clip.points.map(p => p.value)));
  return { mean: count ? sum / count : baseValue, max };
}

// Scale automation point values by a linear factor, clamped to the control range. Returns the scaled values.
export function scaleAutomation(values, factor, { max = maxVolume } = {}) {
  return values.map(value => round(Math.min(max, Math.max(0, value * factor)), 3));
}

// ---------- gain plan ----------

// Plan every track's gain. rows: [{ track, measuredDb, targetDb, control }], where control is null (no volume),
// { kind: 'static', volume } or { kind: 'automated', level (mean in the window), max (highest point) }.
// Targets are stem levels at master volume 100; masterOffsetDb says where the master sat during the measurement.
// Volume stops at 200. When a track cannot reach its target, every target comes down together (up to maxShiftDb)
// so the balance between tracks holds; the result says so.
export function planBalance(rows, { masterOffsetDb = 0, maxShiftDb = 12 } = {}) {
  const plans = rows.map(row => {
    if (row.measuredDb === null || row.measuredDb === undefined) return { skipped: 'silent' };
    if (!row.control) return { skipped: 'no volume control (Beat/Bassline track); balance the tracks inside it' };
    const base = row.control.kind === 'static' ? row.control.volume : row.control.max;
    if (!(base > 0)) return { skipped: 'volume is 0 everywhere; raise it first' };
    const wantedDb = row.targetDb - (row.measuredDb - masterOffsetDb);
    const headroomDb = toDb(maxVolume / base);
    return { wantedDb, headroomDb, shortfallDb: wantedDb - headroomDb, base };
  });
  const worst = Math.max(0, ...plans.filter(p => !p.skipped).map(p => p.shortfallDb));
  const shift = worst > 0.05 ? Math.min(worst, maxShiftDb) : 0;
  const results = rows.map((row, k) => {
    const plan = plans[k];
    if (plan.skipped) return { skipped: plan.skipped, factor: 1 };
    const wanted = plan.wantedDb - shift;
    const ideal = toGain(wanted), ceiling = maxVolume / plan.base;
    let factor = Math.min(ideal, ceiling);
    const out = { wantedDb: round(wanted) };
    if (row.control.kind === 'static') {
      const volume = Math.max(0.001, round(row.control.volume * factor, 3));
      factor = volume / row.control.volume;
      Object.assign(out, { volumeBefore: row.control.volume, volumeAfter: volume });
    } else {
      Object.assign(out, { volumeBefore: round(row.control.level), volumeAfter: round(row.control.level * factor), automated: true, highestPoint: row.control.max });
    }
    out.factor = factor;
    out.gainDb = round(toDb(factor));
    if (ideal > ceiling * (1 + 1e-9)) {
      out.limited = true;
      out.warning = `Needs ${round(wanted, 1)} dB but volume stops at 200 (${row.control.kind === 'automated' ? 'highest automation point ' + row.control.max : 'volume ' + row.control.volume}); ${round(wanted - toDb(ceiling), 1)} dB short. Raise the instrument or preset level.`;
    }
    if (shift && plan.shortfallDb >= worst - 0.05) out.setsShift = true;
    return out;
  });
  return { rows: results, targetShiftDb: round(-shift) };
}

// Master change that keeps a predicted peak at or under -headroomDb. maxFactor is how far the master may rise (200 cap).
// protect: only lower when needed; fit: set exactly; keep: leave alone.
export function masterFor(predictedPeak, headroomDb, mode = 'protect', maxFactor = 2) {
  if (mode === 'keep' || !(predictedPeak > 0)) return { factor: 1, changeDb: 0 };
  const ceiling = toGain(-headroomDb);
  if (mode === 'protect' && predictedPeak <= ceiling) return { factor: 1, changeDb: 0 };
  const factor = Math.min(maxFactor, ceiling / predictedPeak);
  return { factor, changeDb: round(toDb(factor)) };
}

// ---------- block statistics ----------
const bandNames = Object.keys(dsp.bandEdges);
const gateSeconds = 0.4, gateDb = -30;

// Per-block peak, energy and band power (linear) of one stem. Blocks are usually one bar long.
// Each block is also split into 400 ms pieces; pieces more than 30 dB under the stem's loudest piece count as silence,
// so `activeSumSq` and `activeFrames` describe only the time the part is sounding.
export function blockStats(audio, blockFrames, { bands: withBands = true } = {}) {
  const pieceFrames = Math.max(1, Math.min(blockFrames, Math.round(gateSeconds * audio.sampleRate)));
  const channels = audio.channels.length;
  const blocks = [];
  let loudestPiece = 0;
  for (let start = 0; start < audio.frames; start += blockFrames) {
    const end = Math.min(audio.frames, start + blockFrames);
    let peak = 0, sumSq = 0;
    const pieces = [];
    for (let from = start; from < end; from += pieceFrames) {
      const to = Math.min(end, from + pieceFrames);
      let piece = 0;
      for (const ch of audio.channels) {
        for (let i = from; i < to; i++) { const v = ch[i]; piece += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
      }
      sumSq += piece;
      pieces.push([piece, (to - from) * channels]);
      loudestPiece = Math.max(loudestPiece, piece / ((to - from) * channels));
    }
    const frames = (end - start) * channels;
    let bands = null;
    if (withBands && sumSq / frames > 1e-9) {
      const { bandsDbfs } = dsp.spectrum(dsp.slice(audio, start, end));
      bands = bandNames.map(name => bandsDbfs[name] === null ? 0 : 10 ** (bandsDbfs[name] / 10));
    }
    blocks.push({ peak, sumSq, frames, bands, pieces });
  }
  const gate = Math.max(1e-8, loudestPiece * 10 ** (gateDb / 10));
  for (const block of blocks) {
    block.activeSumSq = 0; block.activeFrames = 0;
    for (const [piece, n] of block.pieces) if (piece / n > gate) { block.activeSumSq += piece; block.activeFrames += n; }
    delete block.pieces;
  }
  return blocks;
}
// Peak, RMS over the whole span and RMS over the sounding time (dBFS), for blocks [from, to).
export function windowLevels(blocks, from, to) {
  let peak = 0, sumSq = 0, frames = 0, activeSumSq = 0, activeFrames = 0;
  for (const block of blocks.slice(from, to)) {
    peak = Math.max(peak, block.peak); sumSq += block.sumSq; frames += block.frames;
    activeSumSq += block.activeSumSq ?? 0; activeFrames += block.activeFrames ?? 0;
  }
  return { peakDbfs: peak > 0 ? round(toDb(peak)) : null, rmsDbfs: sumSq > 0 ? round(10 * Math.log10(sumSq / frames)) : null,
    activeRmsDbfs: activeSumSq > 0 ? round(10 * Math.log10(activeSumSq / activeFrames)) : null,
    soundingShare: frames ? round(activeFrames / frames) : 0 };
}
// Index of the loudest run of `length` blocks by energy.
export function loudestWindow(blocks, length) {
  const span = Math.max(1, Math.min(length, blocks.length));
  let best = 0, bestEnergy = -1;
  for (let start = 0; start + span <= blocks.length; start++) {
    let energy = 0;
    for (let i = start; i < start + span; i++) energy += blocks[i].sumSq;
    if (energy > bestEnergy) { bestEnergy = energy; best = start; }
  }
  return { start: best, length: span };
}

// Sum gain-scaled stems into one buffer. Stems must share length and rate (mono stems are spread to both sides).
export function sumStems(stems, gains, masterGain = 1) {
  const { sampleRate, frames } = stems[0];
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  stems.forEach((stem, index) => {
    const gain = gains[index] * masterGain;
    if (!gain) return;
    for (let ch = 0; ch < 2; ch++) {
      const source = stem.channels[Math.min(ch, stem.channels.length - 1)], out = channels[ch];
      for (let i = 0; i < frames; i++) out[i] += source[i] * gain;
    }
  });
  return { sampleRate, frames, channels };
}
export function correlation(audio) {
  if (audio.channels.length < 2) return 1;
  const [left, right] = audio.channels;
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < left.length; i++) { lr += left[i] * right[i]; ll += left[i] * left[i]; rr += right[i] * right[i]; }
  return ll > 0 && rr > 0 ? round(lr / Math.sqrt(ll * rr)) : null;
}

// ---------- masking ----------
const bandLabels = { sub: '20 to 60 Hz', bass: '60 to 150 Hz', lowMid: '150 to 500 Hz', mid: '500 Hz to 2 kHz', highMid: '2 to 6 kHz', air: '6 to 20 kHz' };
const priority = { lead: 0, bass: 1, counter: 2, harmony: 3, texture: 4 };

// For each pair of pitched stems, find bars where both put most of their energy in the same band at similar level
// (within maxGapDb: a part far below the other is not competing). `stems` are { track, role, gainDb, blocks }.
// Returns at most `limit` findings, the most widespread first, each with a suggested fix.
export function maskingReport(stems, { secondsPerBlock, minShare = 0.5, minBlocks = 2, maxGapDb = 10, limit = 8 } = {}) {
  const pitched = stems.filter(stem => pitchedRoles.includes(stem.role));
  const findings = [];
  const activeOf = stem => {
    const loudest = Math.max(...stem.blocks.map(block => block.sumSq / block.frames));
    return stem.blocks.map(block => block.bands && block.sumSq / block.frames > Math.max(1e-6, loudest / 1000));
  };
  const active = new Map(pitched.map(stem => [stem, activeOf(stem)]));
  for (let a = 0; a < pitched.length; a++) {
    for (let b = a + 1; b < pitched.length; b++) {
      const [one, two] = [pitched[a], pitched[b]];
      const shared = [], perBand = {};
      let both = 0;
      for (let i = 0; i < Math.min(one.blocks.length, two.blocks.length); i++) {
        if (!active.get(one)[i] || !active.get(two)[i]) continue;
        both++;
        const scaled = stem => stem.blocks[i].bands.map(power => power * toGain(stem.gainDb ?? 0) ** 2);
        const [p1, p2] = [scaled(one), scaled(two)];
        const d1 = p1.indexOf(Math.max(...p1)), d2 = p2.indexOf(Math.max(...p2));
        if (d1 !== d2) continue;
        const gap = 10 * Math.log10(p1[d1] / p2[d1]);
        if (Math.abs(gap) > maxGapDb) continue;
        shared.push(i);
        (perBand[d1] ??= []).push(gap);
      }
      if (shared.length < minBlocks || shared.length / Math.max(1, both) < minShare) continue;
      const [bandIndex, gaps] = Object.entries(perBand).sort((x, y) => y[1].length - x[1].length)[0];
      const band = bandNames[bandIndex];
      const [keep, change] = (priority[one.role] ?? 5) <= (priority[two.role] ?? 5) ? [one, two] : [two, one];
      findings.push({
        tracks: [one.track, two.track], band, range: bandLabels[band], sharedBars: shared.length, ofBarsTogether: both,
        bars: [shared[0], shared[shared.length - 1] + 1], ...(secondsPerBlock ? { seconds: [round(shared[0] * secondsPerBlock, 1), round((shared[shared.length - 1] + 1) * secondsPerBlock, 1)] } : {}),
        levelDifferenceDb: round(gaps.reduce((sum, v) => sum + v, 0) / gaps.length, 1), suggestion: maskingFix(keep, change, band),
      });
    }
  }
  return findings.sort((x, y) => y.sharedBars - x.sharedBars).slice(0, limit);
}
function maskingFix(keep, change, band) {
  const low = band === 'sub' || band === 'bass';
  const move = low ? 'move it up an octave or cut its low end with an EQ' : band === 'air' || band === 'highMid' ? 'move it down an octave or darken its filter' : 'move it an octave away';
  const shorten = ['harmony', 'texture'].includes(change.role) ? ', or shorten its notes so the gaps leave room' : '';
  return `${change.track} (${change.role}) and ${keep.track} (${keep.role}) both centre on ${bandLabels[band]} at similar level. Keep ${keep.track} clear: lower ${change.track} by 2 to 3 dB, ${move}${shorten}.`;
}

// ---------- reference comparison ----------
// Each band relative to the file's own total, so a level difference does not swamp the balance.
export function relativeBands(bandsDbfs) {
  const total = Object.values(bandsDbfs).reduce((sum, v) => sum + (v === null ? 0 : 10 ** (v / 10)), 0);
  if (!total) return Object.fromEntries(bandNames.map(name => [name, null]));
  return Object.fromEntries(bandNames.map(name => [name, bandsDbfs[name] === null ? null : round(bandsDbfs[name] - 10 * Math.log10(total))]));
}
const bandAdvice = {
  sub: ['add weight under the bass: drop the bass an octave or raise the kick', 'high-pass the parts that are not bass or kick, or lower the bass'],
  bass: ['raise the bass or the kick', 'lower the bass, or high-pass pads and harmony'],
  lowMid: ['give the harmony and pads more body', 'it may sound muddy: lower pads and harmony, or move them up an octave'],
  mid: ['raise the lead or the harmony', 'lower pads and harmony so the lead has room'],
  highMid: ['brighten the lead or raise the hats', 'it may sound harsh: lower the hats or darken the lead'],
  air: ['raise the hats and cymbals, or open filter cutoffs', 'lower the hats and cymbals'],
};
// Compare two measurement summaries ({ integratedLufs, peakDbfs, rmsDbfs, crestDb, stereoCorrelation, centroidHz, bandsDbfs }).
// Differences are audio minus reference. Silence is an error, not a match.
export function compareMeasurements(audio, reference, { label = '' } = {}) {
  const prefix = label ? `${label}: ` : '';
  for (const [name, m] of [['audio', audio], ['reference', reference]]) {
    if (m.rmsDbfs === null || m.rmsDbfs === undefined || m.peakDbfs === null) throw new Error(`${prefix}the ${name} is silent, so there is nothing to compare`);
  }
  const diff = (a, b) => a === null || a === undefined || b === null || b === undefined ? null : round(a - b);
  const crest = m => m.crestDb ?? (m.peakDbfs !== null && m.rmsDbfs !== null ? m.peakDbfs - m.rmsDbfs : null);
  const ours = relativeBands(audio.bandsDbfs), theirs = relativeBands(reference.bandsDbfs);
  const differences = {
    loudnessLu: diff(audio.integratedLufs, reference.integratedLufs),
    crestDb: diff(crest(audio), crest(reference)),
    stereoCorrelation: diff(audio.stereoCorrelation, reference.stereoCorrelation),
    centroidHz: diff(audio.centroidHz, reference.centroidHz),
    centroidRatio: audio.centroidHz && reference.centroidHz ? round(audio.centroidHz / reference.centroidHz) : null,
    bandsDb: Object.fromEntries(bandNames.map(name => [name, diff(ours[name], theirs[name])])),
  };
  const suggestions = [];
  for (const name of bandNames) {
    const d = differences.bandsDb[name];
    if (d === null || Math.abs(d) < 2) continue;
    suggestions.push({ size: Math.abs(d), text: `${prefix}${round(Math.abs(d), 1)} dB ${d < 0 ? 'less' : 'more'} energy in ${bandLabels[name]} than the reference: ${bandAdvice[name][d < 0 ? 0 : 1]}.` });
  }
  const { loudnessLu, crestDb, stereoCorrelation, centroidRatio } = differences;
  if (loudnessLu !== null && Math.abs(loudnessLu) >= 1) {
    suggestions.push({ size: Math.abs(loudnessLu), text: `${prefix}${round(Math.abs(loudnessLu), 1)} LU ${loudnessLu < 0 ? 'quieter' : 'louder'} than the reference: ${loudnessLu < 0 ? 'raise it with render_mix targetLufs' : 'lower the loudness target'}.` });
  }
  if (crestDb !== null && Math.abs(crestDb) >= 3) {
    suggestions.push({ size: Math.abs(crestDb) * 0.8, text: crestDb > 0 ?
      `${prefix}Crest factor is ${round(crestDb, 1)} dB higher than the reference: the peaks stand further out. Lower the loudest drums or compress the drum bus.` :
      `${prefix}Crest factor is ${round(-crestDb, 1)} dB lower than the reference: it is more squashed. Ease the limiter or compressor, or let the drums hit harder.` });
  }
  if (stereoCorrelation !== null && Math.abs(stereoCorrelation) >= 0.2) {
    suggestions.push({ size: Math.abs(stereoCorrelation) * 10, text: stereoCorrelation < 0 ?
      `${prefix}Left and right are less alike than in the reference (correlation ${round(stereoCorrelation, 2)} lower): it is wider and may thin out in mono. Narrow the widest parts.` :
      `${prefix}Left and right are more alike than in the reference: it is narrower. Pan the harmony and texture parts apart or add stereo width.` });
  }
  if (centroidRatio !== null && (centroidRatio >= 1.2 || centroidRatio <= 1 / 1.2)) {
    // The centroid summarises the band balance, so it ranks below the band findings it explains.
    suggestions.push({ size: Math.abs(Math.log2(centroidRatio)) * 4, text: centroidRatio < 1 ?
      `${prefix}The spectral centre is ${Math.round((1 - centroidRatio) * 100)}% lower than the reference: it sounds darker overall.` :
      `${prefix}The spectral centre is ${Math.round((centroidRatio - 1) * 100)}% higher than the reference: it sounds brighter overall.` });
  }
  return { differences, relativeBandsDb: { audio: ours, reference: theirs }, suggestions: suggestions.sort((a, b) => b.size - a.size).map(s => s.text) };
}
// A section must lie inside the file it describes.
export function checkSpan(name, startSeconds, endSeconds, durationSeconds, which) {
  if (endSeconds <= startSeconds) throw new Error(`Section "${name}" must end after it starts in the ${which}`);
  if (endSeconds > durationSeconds + 0.01) throw new Error(`Section "${name}" ends at ${endSeconds} s but the ${which} is ${round(durationSeconds, 2)} s long`);
}

// ---------- registration ----------
export function register({ tool, z, schemas, project, render, moduleGuidance, root }) {
  moduleGuidance.push('Run auto_balance after the parts are written and before mastering: it renders stems, sets every track volume from its role target, keeps the master under the headroom and reports masking. Set track roles first so it does not have to guess.');
  moduleGuidance.push('Use compare_to_reference to measure how a render differs from a reference WAV in loudness, band balance, crest factor, width and brightness.');

  const { children } = project;
  const effectName = effect => {
    const name = effect.getAttribute('name');
    if (name !== 'ladspaeffect') return name;
    const plugin = children(children(effect, 'key')[0], 'attribute').find(a => a.getAttribute('name') === 'plugin')?.getAttribute('value');
    return 'ladspa:' + (plugin ?? 'unknown');
  };
  const activeEffects = owner => {
    const chain = children(owner, 'fxchain')[0];
    if (!chain || chain.getAttribute('enabled') === '0') return [];
    return children(chain, 'effect').filter(effect => effect.getAttribute('on') !== '0').map(effectName);
  };
  // Clips of the automation tracks that drive a control with this id.
  const clipsFor = (all, id) => all.flatMap(t => children(t, 'automationpattern')
    .filter(clip => children(clip, 'object').some(object => object.getAttribute('id') === id)))
    .map(clip => ({ node: clip, pos: Number(clip.getAttribute('pos')), len: Number(clip.getAttribute('len')), prog: Number(clip.getAttribute('prog') ?? 1),
      points: children(clip, 'time').map(point => ({ node: point, pos: Number(point.getAttribute('pos')), value: Number(point.getAttribute('value')) })) }));

  const target = z.union([z.number().min(-60).max(0), z.object({ measure: z.enum(['peak', 'rms']).optional(), db: z.number().min(-60).max(0) })]);
  tool('auto_balance', 'Balance a mix by measurement in one call. Renders one stem per audio track, measures each over the loudest stretch of the song (or measureBars), decides each track\'s role (declared mcp-role, else a reported guess), sets track volumes so drums hit peak targets and pitched parts hit RMS targets over the time they sound, predicts the summed mix and lowers the master if the predicted peak would break the headroom. Scales volume automation instead of failing. If a track cannot reach its target, all targets come down together to keep the balance. Returns a per-track table, the predicted mix peak and loudness, a masking report and mono warnings. Refuses while any track is soloed. Targets are starting points, stated as stem levels at master volume 100; override them per role, drum kind or track.', {
    project: schemas.projectName,
    output: schemas.projectName.optional().describe('Where to write the balanced project. Required unless dryRun.'),
    overwrite: z.boolean().default(false),
    dryRun: z.boolean().default(false).describe('Measure and plan without writing a project.'),
    measureBars: z.object({ startBar: z.number().int().min(0), bars: z.number().int().min(1) }).optional()
      .describe('Bars to measure (zero-based). Default: the loudest 8 bars of the mix.'),
    targets: z.object({
      roles: z.record(z.string(), target).optional().describe('By role (bass, lead, counter, harmony, texture, fx, drums) or drum kind (kick, snare, clap, hat, crash, tom, perc). Numbers use the role\'s own measure.'),
      tracks: z.record(z.string(), target).optional().describe('By track name.'),
    }).optional(),
    headroomDb: z.number().min(0).max(12).default(2).describe('Keep the predicted mix peak this far under full scale.'),
    master: z.enum(['protect', 'fit', 'keep']).default('protect').describe('protect: lower the master only when the predicted peak breaks the headroom (default). fit: set the master so the peak lands exactly on the headroom. keep: never touch it.'),
  }, async ({ project: name, output, overwrite, dryRun, measureBars, targets = {}, headroomDb, master: masterMode }) => {
    if (!dryRun && !output) throw new Error('Pass output, or set dryRun');
    if (!dryRun && !overwrite && existsSync(path.join(root, output))) throw new Error('Output already exists. Pass overwrite to replace it.');
    const doc = await project.load(name);
    const info = project.songInfo(doc);
    const all = project.tracks(doc);
    const picked = selectTracks(all.map(t => ({ name: t.getAttribute('name'), control: project.isControl(t),
      muted: t.getAttribute('muted') === '1', solo: t.getAttribute('solo') === '1' })));
    const wanted = picked.map(index => ({ t: all[index], index }));
    validateTargets(targets, wanted.map(({ t }) => t.getAttribute('name')));
    const frames = Math.round(info.lengthSeconds * 48000);
    if (!frames) throw new Error('The song is empty');
    const stems = await render.pool(wanted, render.parallelRenders, async ({ index }) =>
      dsp.fitLength(dsp.decodeWav(await render.renderDoc(render.isolate(doc, new Set([index])), { loop: true, prepared: true })), frames));
    const blockFrames = Math.max(1, Math.round(info.secondsPerBar * stems[0].sampleRate));
    const blocks = stems.map(stem => blockStats(stem, blockFrames));
    const before = sumStems(stems, stems.map(() => 1));
    const mixBlocks = blockStats(before, blockFrames, { bands: false });

    let window;
    if (measureBars) {
      if (measureBars.startBar + measureBars.bars > mixBlocks.length) throw new Error(`measureBars runs past the end of the song (${mixBlocks.length} bars)`);
      window = { start: measureBars.startBar, length: measureBars.bars, chosen: 'given' };
    } else window = { ...loudestWindow(mixBlocks, 8), chosen: 'loudest stretch of the mix' };
    const windowTicks = [window.start * info.ticksPerBar, (window.start + window.length) * info.ticksPerBar];

    const notes = [];
    const { head } = info;
    const mixer = children(children(doc.documentElement, 'song')[0], 'fxmixer')[0];
    const channels = new Map(children(mixer, 'fxchannel').map(channel => [channel.getAttribute('num'), channel]));
    const masterEffects = channels.get('0') ? activeEffects(channels.get('0')) : [];
    const masterEffectNote = effectNote('Master', masterEffects);
    if (masterEffectNote) notes.push(masterEffectNote);

    const tracks = wanted.map(({ t }, i) => {
      const trackName = t.getAttribute('name');
      const type = t.getAttribute('type');
      const instrumentTrack = children(t, 'instrumenttrack')[0];
      const instrument = children(instrumentTrack, 'instrument')[0];
      const plugin = instrument?.getAttribute('name');
      const sample = type === '2' ? children(t, 'sampletco').map(clip => clip.getAttribute('src')).find(Boolean) :
        children(instrument, 'audiofileprocessor')[0]?.getAttribute('src');
      const trackNotes = type === '0' ? children(t, 'pattern').flatMap(clip => children(clip, 'note').map(n => ({
        tick: Number(clip.getAttribute('pos')) + Number(n.getAttribute('pos')), length: Math.max(1, Number(n.getAttribute('len'))), midi: Number(n.getAttribute('key')) + 12 }))) : [];
      const whole = dsp.spectrum(stems[i]);
      const powers = Object.values(whole.bandsDbfs).map(v => v === null ? 0 : 10 ** (v / 10));
      const total = powers.reduce((a, b) => a + b, 0);
      const overall = windowLevels(blocks[i], 0, blocks[i].length);
      const decision = guessRole({
        name: trackName, declared: project.trackRole(t), plugin, sample, notes: noteFacts(trackNotes), centroidHz: whole.centroidHz,
        lowShare: total ? (powers[0] + powers[1]) / total : 0,
        crestDb: overall.peakDbfs !== null && overall.activeRmsDbfs !== null ? overall.peakDbfs - overall.activeRmsDbfs : 10,
        activeShare: overall.soundingShare,
      });
      const goal = targetFor(decision, trackName, targets);
      let span = { start: window.start, length: window.length }, measuredOver = `bars ${span.start}-${span.start + span.length}`;
      let measured = windowLevels(blocks[i], span.start, span.start + span.length);
      if (measured.activeRmsDbfs === null) {
        span = loudestWindow(blocks[i], window.length);
        measured = windowLevels(blocks[i], span.start, span.start + span.length);
        measuredOver = `bars ${span.start}-${span.start + span.length}, its own loudest (silent in the window)`;
      }
      // Volume control: instrument tracks and sample tracks have one; Beat/Bassline tracks do not.
      const holder = type === '0' ? instrumentTrack : type === '2' ? children(t, 'sampletrack')[0] : null;
      const model = holder && children(holder, 'vol')[0];
      let control = null, clips = [];
      if (model) {
        clips = clipsFor(all, model.getAttribute('id'));
        const level = automationLevel(clips, Number(model.getAttribute('value') ?? 100), ...windowTicks);
        control = { kind: 'automated', level: level.mean, max: level.max };
      } else if (holder) control = { kind: 'static', volume: Number(holder.getAttribute('vol') ?? 100) };
      const effectNotes = [effectNote(`${trackName}'s own effect chain`, instrumentTrack ? activeEffects(instrumentTrack) : [])];
      const bus = instrumentTrack?.getAttribute('fxch');
      if (bus && bus !== '0' && channels.get(bus)) effectNotes.push(effectNote(`Mixer bus "${channels.get(bus).getAttribute('name')}"`, activeEffects(channels.get(bus))));
      return {
        row: { track: trackName, role: decision.role, ...(decision.kind ? { kind: decision.kind } : {}), roleSource: decision.source,
          measure: goal.measure, targetDb: goal.db, targetFrom: goal.from,
          measuredDb: goal.measure === 'peak' ? measured.peakDbfs : measured.activeRmsDbfs,
          ...(goal.measure === 'rms' ? { soundingShare: measured.soundingShare } : {}), measuredOver,
          stereoCorrelation: correlation(stems[i]), ...(effectNotes.some(Boolean) ? { note: effectNotes.filter(Boolean).join(' ') } : {}) },
        holder, model, clips, control,
      };
    });

    // Targets are stem levels at master volume 100, so the balance does not depend on where the master sits
    // and a second pass over a balanced project asks for nothing. The master then moves the whole mix.
    const masterModel = children(head, 'mastervol')[0];
    const masterClips = masterModel ? clipsFor(all, masterModel.getAttribute('id')) : [];
    const masterStatic = Number(head.getAttribute('mastervol') ?? 100);
    const masterLevel = masterModel ? automationLevel(masterClips, Number(masterModel.getAttribute('value') ?? 100), ...windowTicks) : { mean: masterStatic, max: masterStatic };
    if (!(masterLevel.mean > 0)) throw new Error('Master volume is 0 in the measured bars; raise it first');
    const plan = planBalance(tracks.map(({ row, control }) => ({ measuredDb: row.measuredDb, targetDb: row.targetDb, control })),
      { masterOffsetDb: toDb(masterLevel.mean / 100) });
    const gains = plan.rows.map(p => p.factor);
    tracks.forEach(({ row }, k) => {
      const { factor, setsShift, ...rest } = plan.rows[k];
      Object.assign(row, rest);
      if (setsShift) row.setsTargetShift = true;
    });
    if (plan.targetShiftDb) {
      const limiting = tracks.filter((_, k) => plan.rows[k].setsShift).map(({ row }) => row.track);
      notes.push(`${limiting.join(', ')} cannot reach ${limiting.length > 1 ? 'their targets' : 'its target'} at volume 200, so every target came down ${-plan.targetShiftDb} dB to keep the balance between tracks. Raise ${limiting.length > 1 ? 'their' : 'its'} instrument or preset level and run again to restore the level.`);
    }

    const unprotected = sumStems(stems, gains);
    const masterPlan = masterFor(dsp.samplePeak(unprotected), headroomDb, masterMode, maxVolume / masterLevel.max);
    let masterFactor = masterPlan.factor, masterAfter = round(masterLevel.mean);
    if (masterFactor !== 1 && !masterModel) {
      masterAfter = round(masterStatic * masterFactor);
      masterFactor = masterAfter / masterStatic;
    } else if (masterFactor !== 1) masterAfter = round(masterLevel.mean * masterFactor);
    const masterChangeDb = round(toDb(masterFactor));
    const after = masterFactor === 1 ? unprotected : sumStems(stems, gains, masterFactor);
    tracks.forEach(({ row }, k) => { if (row.measuredDb !== null && row.measuredDb !== undefined) row.predictedDb = round(row.measuredDb + toDb(gains[k]) + masterChangeDb); });

    const summary = audio => {
      const peak = dsp.samplePeak(audio);
      return { peakDbfs: peak > 0 ? round(toDb(peak)) : null, truePeakDbfs: dsp.db(dsp.truePeak(audio)), integratedLufs: dsp.loudness(audio).integratedLufs,
        windowRmsDbfs: windowLevels(blockStats(audio, blockFrames, { bands: false }), window.start, window.start + window.length).rmsDbfs };
    };
    const predicted = { before: summary(before), after: summary(after) };
    if (predicted.after.peakDbfs !== null && predicted.after.peakDbfs > -headroomDb + 0.01) {
      notes.push(`Predicted peak ${predicted.after.peakDbfs} dBFS is above -${headroomDb} dBFS${masterMode === 'keep' ? ' and master was kept' : ' because the master volume is at its limit'}.`);
    }

    const masking = maskingReport(tracks.map(({ row }, k) => ({ track: row.track, role: row.role, gainDb: toDb(gains[k]), blocks: blocks[k] })),
      { secondsPerBlock: info.secondsPerBar });
    const mono = tracks.filter(({ row }) => row.stereoCorrelation !== null && row.stereoCorrelation < 0.2 && row.measuredDb !== null)
      .map(({ row }) => `${row.track}: left and right are weakly correlated (${row.stereoCorrelation}); it will thin out in mono. Narrow its stereo effect or chorus.`);
    const guessed = tracks.filter(({ row }) => row.roleSource !== 'declared').map(({ row }) => row.track);
    if (guessed.length) notes.push(`Roles were guessed for ${guessed.join(', ')}. Check them and set them with set_track_role.`);
    const stemOffsetDb = round(toDb(masterAfter / 100));
    if (masterChangeDb) notes.push(`Master moved ${masterChangeDb} dB to ${masterAfter}${masterModel ? ' (mean over the measured bars; its automation was scaled)' : ''}.`);
    if (stemOffsetDb) notes.push(`Targets are levels at master volume 100. At master ${masterAfter} every stem renders ${stemOffsetDb} dB from its target (see predictedDb); the balance between tracks is what matters.`);

    // Write everything in one save.
    const changes = [];
    const scaleModel = (model, clips, factor, label) => {
      model.setAttribute('value', String(scaleAutomation([Number(model.getAttribute('value'))], factor)[0]));
      let points = 0;
      for (const clip of clips) {
        scaleAutomation(clip.points.map(p => p.value), factor).forEach((value, k) => clip.points[k].node.setAttribute('value', String(value)));
        points += clip.points.length;
      }
      changes.push(`${label}: scaled ${points} automation points by ${round(toDb(factor))} dB`);
    };
    tracks.forEach(({ row, holder, model, clips }, k) => {
      if (row.volumeAfter === undefined || gains[k] === 1) return;
      if (model) scaleModel(model, clips, gains[k], row.track);
      else holder.setAttribute('vol', String(row.volumeAfter));
    });
    if (masterFactor !== 1) {
      if (masterModel) scaleModel(masterModel, masterClips, masterFactor, 'Master');
      else head.setAttribute('mastervol', String(masterAfter));
    }
    if (!dryRun) await project.save(doc, output, overwrite);
    return {
      ...(dryRun ? { dryRun: true } : { project: output }),
      window: { startBar: window.start, bars: window.length, chosen: window.chosen,
        seconds: [round(window.start * info.secondsPerBar, 2), round((window.start + window.length) * info.secondsPerBar, 2)] },
      headroomDb, targetShiftDb: plan.targetShiftDb,
      master: { before: round(masterLevel.mean), after: masterAfter, changeDb: masterChangeDb, stemOffsetDb, ...(masterModel ? { automated: true } : {}) },
      tracks: tracks.map(({ row }) => row), predictedMix: predicted, masking, mono,
      ...(changes.length ? { automation: changes } : {}), notes,
    };
  });

  const span = z.object({ name: z.string().min(1).max(60), startSeconds: z.number().min(0), endSeconds: z.number().min(0),
    referenceStartSeconds: z.number().min(0).optional(), referenceEndSeconds: z.number().min(0).optional() });
  tool('compare_to_reference', 'Measure how a render differs from a reference track: integrated loudness, band balance (each band relative to the file\'s own total, so overall level does not swamp it), crest factor, stereo correlation and spectral centroid, with the largest differences turned into plain suggestions. Optional sections compare matching passages; reference times default to the same as the audio.', {
    audio: schemas.workspaceWav, reference: schemas.workspaceWav, sections: z.array(span).max(32).default([]),
  }, async ({ audio: file, reference: referenceFile, sections }) => {
    const [ours, theirs] = await Promise.all([file, referenceFile].map(async name => dsp.decodeWav(await readFile(path.join(root, name)))));
    const spans = sections.map(s => ({ name: s.name, audio: [s.startSeconds, s.endSeconds],
      reference: [s.referenceStartSeconds ?? s.startSeconds, s.referenceEndSeconds ?? s.endSeconds] }));
    for (const s of spans) {
      checkSpan(s.name, ...s.audio, ours.frames / ours.sampleRate, 'audio');
      checkSpan(s.name, ...s.reference, theirs.frames / theirs.sampleRate, 'reference');
    }
    const a = dsp.analyze(ours, { sections: spans.map(s => ({ name: s.name, startSeconds: s.audio[0], endSeconds: s.audio[1] })) });
    const b = dsp.analyze(theirs, { sections: spans.map(s => ({ name: s.name, startSeconds: s.reference[0], endSeconds: s.reference[1] })) });
    const keep = m => ({ integratedLufs: m.integratedLufs, peakDbfs: m.peakDbfs, rmsDbfs: m.rmsDbfs, crestDb: m.crestDb ?? (m.peakDbfs !== null && m.rmsDbfs !== null ? round(m.peakDbfs - m.rmsDbfs) : null),
      stereoCorrelation: m.stereoCorrelation ?? null, centroidHz: m.centroidHz, bandsDbfs: m.bandsDbfs });
    const whole = compareMeasurements(keep(a), keep(b));
    return {
      audio: { file, ...keep(a) }, reference: { file: referenceFile, ...keep(b) },
      differences: whole.differences, relativeBandsDb: whole.relativeBandsDb, suggestions: whole.suggestions,
      sections: a.sections.map((section, i) => {
        const result = compareMeasurements(keep(section), keep(b.sections[i]), { label: section.name });
        return { name: section.name, differences: result.differences, suggestions: result.suggestions };
      }),
    };
  });
}
