/**
 * Stereo image and mono-compatibility meter.
 * Pure ES module; Float64 accumulators; silent input never throws.
 */

function roundTo(value, decimals) {
  if (!Number.isFinite(value)) return value;
  if (Object.is(value, -0) || value === 0) return 0;
  const factor = 10 ** decimals;
  let rounded = Math.round(value * factor) / factor;
  if (Object.is(rounded, -0)) rounded = 0;
  return rounded;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function stereoImage({ sampleRate, channels }) {
  const left = channels[0] ?? new Float32Array(0);
  const right = channels.length >= 2 ? channels[1] : left;
  const n = Math.min(left.length, right.length);

  let sumL2 = 0;
  let sumR2 = 0;
  let sumLR = 0;

  const subSize = Math.round(sampleRate * 0.1);
  const nBlocks = subSize > 0 ? Math.floor(n / subSize) : 0;
  const blockL2 = new Float64Array(nBlocks);
  const blockR2 = new Float64Array(nBlocks);
  const blockLR = new Float64Array(nBlocks);

  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    const l2 = l * l;
    const r2 = r * r;
    const lr = l * r;
    sumL2 += l2;
    sumR2 += r2;
    sumLR += lr;
    if (subSize > 0) {
      const b = Math.floor(i / subSize);
      if (b < nBlocks) {
        blockL2[b] += l2;
        blockR2[b] += r2;
        blockLR[b] += lr;
      }
    }
  }

  const energyDenom = Math.sqrt(sumL2 * sumR2);
  let correlation = null;
  if (sumL2 > 0 && sumR2 > 0 && energyDenom > 0) {
    correlation = finiteOrNull(roundTo(sumLR / energyDenom, 3));
  }

  const windowBlocks = 4;
  const windowSamples = windowBlocks * subSize;
  const gate = 1e-7 * windowSamples;
  let windowCount = 0;
  let minCorr = Infinity;

  if (nBlocks >= windowBlocks && windowSamples > 0) {
    for (let w = 0; w + windowBlocks <= nBlocks; w++) {
      let wL2 = 0;
      let wR2 = 0;
      let wLR = 0;
      for (let k = 0; k < windowBlocks; k++) {
        wL2 += blockL2[w + k];
        wR2 += blockR2[w + k];
        wLR += blockLR[w + k];
      }
      // −70 dBFS mean-square gate: both channels must exceed 1e-7 × windowSamples.
      if (wL2 > gate && wR2 > gate) {
        const denom = Math.sqrt(wL2 * wR2);
        if (denom > 0) {
          const c = wLR / denom;
          if (Number.isFinite(c) && c < minCorr) minCorr = c;
          windowCount += 1;
        }
      }
    }
  }

  const minWindowCorrelation =
    windowCount === 0 ? null : finiteOrNull(roundTo(minCorr, 3));

  const em = (sumL2 + sumR2 + 2 * sumLR) / 4;
  const es = (sumL2 + sumR2 - 2 * sumLR) / 4;
  const avg = (sumL2 + sumR2) / 2;

  let sideToMidDb = null;
  if (em > 0 && es > 1e-12 * avg) {
    sideToMidDb = finiteOrNull(roundTo(10 * Math.log10(es / em), 2));
  }

  let widthPct = null;
  if (avg > 0) {
    const sumMS = em + es;
    if (sumMS > 0) {
      widthPct = finiteOrNull(roundTo((100 * es) / sumMS, 1));
    }
  }

  const monoCancels = avg > 0 && em < 1e-6 * avg;

  let monoFoldDropDb = null;
  if (avg > 0 && !monoCancels && em > 0) {
    monoFoldDropDb = finiteOrNull(roundTo(10 * Math.log10(avg / em), 2));
  }

  return {
    correlation,
    minWindowCorrelation,
    sideToMidDb,
    widthPct,
    monoCancels,
    monoFoldDropDb,
    windowCount,
  };
}
