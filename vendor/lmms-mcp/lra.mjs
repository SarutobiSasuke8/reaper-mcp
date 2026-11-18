import { kWeight } from './k-weight.mjs';

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = 20;
const SUB_BLOCK_SEC = 0.1;
const MOMENTARY_BLOCKS = 4;
const SHORT_TERM_BLOCKS = 30;

function lufsFromMeanSquareSum(sum) {
  if (!(sum > 0) || !Number.isFinite(sum)) return -Infinity;
  return -0.691 + 10 * Math.log10(sum);
}

function round2(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function percentileLinear(sorted, p) {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function slidingMean(values, window) {
  const out = [];
  if (values.length < window) return out;
  let acc = 0;
  for (let i = 0; i < window; i++) acc += values[i];
  out.push(acc / window);
  for (let i = window; i < values.length; i++) {
    acc += values[i] - values[i - window];
    out.push(acc / window);
  }
  return out;
}

function maxFinite(values) {
  let max = -Infinity;
  for (const v of values) {
    if (Number.isFinite(v) && v > max) max = v;
  }
  return Number.isFinite(max) ? max : null;
}

function kWeightedSubBlockEnergies(sampleRate, channels) {
  const nSamples = channels.reduce((n, ch) => Math.min(n, ch.length), channels[0].length);
  const hop = Math.round(sampleRate * SUB_BLOCK_SEC);
  const nBlocks = hop > 0 ? Math.floor(nSamples / hop) : 0;
  if (nBlocks < 1) return [];

  const energies = new Float64Array(nBlocks);
  for (const channel of channels) {
    for (let block = 0; block < nBlocks; block++) {
      const start = block * hop;
      const end = start + hop;
      let sum = 0;
      for (let i = start; i < end; i++) sum += channel[i] * channel[i];
      energies[block] += sum / hop;
    }
  }
  return Array.from(energies);
}

export function loudnessRangeFromWeighted(sampleRate, channels) {
  const empty = {
    lraLu: null,
    shortTermMaxLufs: null,
    momentaryMaxLufs: null,
    shortTermCount: null,
  };

  if (!channels.length) return empty;
  const subEnergies = kWeightedSubBlockEnergies(sampleRate, channels);
  const momentaryE = slidingMean(subEnergies, MOMENTARY_BLOCKS);
  const shortTermE = slidingMean(subEnergies, SHORT_TERM_BLOCKS);

  const momentaryLufs = momentaryE.map(lufsFromMeanSquareSum);
  const shortTermLufs = shortTermE.map(lufsFromMeanSquareSum);
  const finiteShortTerm = shortTermLufs.filter(Number.isFinite);
  const finiteMomentary = momentaryLufs.filter(Number.isFinite);

  if (finiteShortTerm.length === 0 && finiteMomentary.length === 0) return empty;

  const absGatedE = [];
  const absGatedL = [];
  for (let i = 0; i < shortTermE.length; i++) {
    const l = shortTermLufs[i];
    if (l > ABSOLUTE_GATE_LUFS) {
      absGatedE.push(shortTermE[i]);
      absGatedL.push(l);
    }
  }

  let lraLu = null;
  if (absGatedE.length > 0) {
    let sumE = 0;
    for (const e of absGatedE) sumE += e;
    const relativeGate = lufsFromMeanSquareSum(sumE / absGatedE.length) - RELATIVE_GATE_LU;
    const kept = absGatedL.filter((l) => l > relativeGate);
    if (kept.length > 0) {
      kept.sort((a, b) => a - b);
      lraLu = round2(percentileLinear(kept, 0.95) - percentileLinear(kept, 0.1));
    }
  }

  return {
    lraLu,
    shortTermMaxLufs: round2(maxFinite(finiteShortTerm)),
    momentaryMaxLufs: round2(maxFinite(finiteMomentary)),
    shortTermCount: finiteShortTerm.length > 0 ? finiteShortTerm.length : null,
  };
}

export function loudnessRange({ sampleRate, channels }) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Array.isArray(channels)
    || channels.length === 0 || !channels.every(ch => ch?.length > 0)) {
    return loudnessRangeFromWeighted(sampleRate, []);
  }
  return loudnessRangeFromWeighted(sampleRate, channels.map(ch => kWeight(ch, sampleRate)));
}
