function nzero(x) {
  return x === 0 ? 0 : x;
}

function round2(x) {
  if (x === null) return null;
  const r = Math.round(x * 100) / 100;
  return nzero(Number.isFinite(r) ? r : null);
}

function channelDr(samples, blockLength) {
  const n = samples.length;
  if (n === 0 || blockLength <= 0) return null;

  const peaks = [];
  const rmses = [];

  for (let start = 0; start < n; start += blockLength) {
    const end = Math.min(start + blockLength, n);
    const len = end - start;
    let sumSq = 0;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const x = samples[i];
      sumSq += x * x;
      const ax = Math.abs(x);
      if (ax > peak) peak = ax;
    }
    peaks.push(peak);
    rmses.push(Math.sqrt((2 * sumSq) / len));
  }

  if (peaks.length === 0) return null;

  const sortedPeaks = peaks.slice().sort((a, b) => b - a);
  const pk2 = sortedPeaks.length === 1 ? sortedPeaks[0] : sortedPeaks[1];

  const k = Math.max(1, Math.round(peaks.length * 0.2));
  const sortedRms = rmses.slice().sort((a, b) => b - a);
  let meanRmsSq = 0;
  for (let i = 0; i < k; i++) {
    const r = sortedRms[i];
    meanRmsSq += r * r;
  }
  meanRmsSq /= k;
  const rms20 = Math.sqrt(meanRmsSq);

  if (pk2 === 0 || rms20 === 0) return null;

  const dr = 20 * Math.log10(pk2 / rms20);
  if (!Number.isFinite(dr)) return null;
  return nzero(dr);
}

export function dynamicRange({ sampleRate, channels }) {
  const chans = Array.isArray(channels) ? channels : [];
  const blockLength = Math.round(Number(sampleRate) * 3);
  const firstLen = chans.length > 0 && chans[0] != null ? chans[0].length : 0;
  const blockCount =
    firstLen === 0 || !(blockLength > 0) ? 0 : Math.ceil(firstLen / blockLength);

  const unrounded = chans.map((ch) =>
    ch == null ? null : channelDr(ch, blockLength),
  );
  const drPerChannel = unrounded.map((v) => (v === null ? null : round2(v)));

  const valid = unrounded.filter((v) => v !== null);
  if (valid.length === 0) {
    return {
      drPerChannel,
      drMean: null,
      dr: null,
      blockCount,
    };
  }

  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const drMean = round2(mean);
  const dr = nzero(Math.round(mean));

  return {
    drPerChannel,
    drMean: drMean === null || !Number.isFinite(drMean) ? null : drMean,
    dr: Number.isFinite(dr) ? dr : null,
    blockCount,
  };
}

// WAV I/O, measurement and offline mastering helpers. Pure JavaScript, no native dependencies.
import { deflateSync } from 'node:zlib';
import { kWeight } from './k-weight.mjs';
import { loudnessRangeFromWeighted } from './lra.mjs';
import { stereoImage } from './stereo.mjs';

export const db = value => value > 0 ? Number((20 * Math.log10(value)).toFixed(2)) : null;
const powerDb = value => value > 0 ? Number((10 * Math.log10(value)).toFixed(2)) : null;

export function decodeWav(wav) {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a RIFF WAV file');
  }
  let format, data;
  for (let start = 12; start + 8 <= wav.length;) {
    const id = wav.toString('ascii', start, start + 4);
    const bytes = wav.readUInt32LE(start + 4);
    const end = Math.min(wav.length, start + 8 + bytes);
    if (id === 'fmt ') format = wav.subarray(start + 8, end);
    if (id === 'data') data = wav.subarray(start + 8, end);
    start = end + (bytes % 2);
  }
  if (!format || format.length < 16 || !data) throw new Error('WAV is missing its format or data chunk');
  let tag = format.readUInt16LE(0);
  if (tag === 0xfffe && format.length >= 26) tag = format.readUInt16LE(24);
  const count = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4);
  const bits = format.readUInt16LE(14);
  const width = bits / 8;
  const read = tag === 3 && bits === 32 ? offset => data.readFloatLE(offset) :
    tag === 1 && bits === 16 ? offset => data.readInt16LE(offset) / 32768 :
    tag === 1 && bits === 24 ? offset => data.readIntLE(offset, 3) / 8388608 :
    tag === 1 && bits === 32 ? offset => data.readInt32LE(offset) / 2147483648 : null;
  if (!read || !count || count > 2 || !sampleRate) throw new Error('Expected mono or stereo PCM (16, 24 or 32-bit) or 32-bit float WAV');
  const frames = Math.floor(data.length / (width * count));
  if (!frames) throw new Error('WAV has no audio frames');
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  for (let frame = 0, offset = 0; frame < frames; frame++) {
    for (let ch = 0; ch < count; ch++, offset += width) channels[ch][frame] = read(offset);
  }
  return { sampleRate, channels, frames };
}

export function encodeWav({ sampleRate, channels }) {
  const frames = channels[0].length;
  const count = channels.length;
  const wav = Buffer.alloc(44 + frames * count * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(count, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * count * 2, 28);
  wav.writeUInt16LE(count * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * count * 2, 40);
  for (let frame = 0, offset = 44; frame < frames; frame++) {
    for (let ch = 0; ch < count; ch++, offset += 2) {
      wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[ch][frame] * 32768))), offset);
    }
  }
  return wav;
}

export const slice = (audio, start, end) => ({
  sampleRate: audio.sampleRate, frames: end - start, channels: audio.channels.map(ch => ch.slice(start, end)),
});
export function applyGain(audio, gain) {
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
  return audio;
}
export function samplePeak(audio, start = 0, end = audio.frames) {
  let peak = 0;
  for (const ch of audio.channels) for (let i = start; i < end; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
  return peak;
}
function meanSquare(audio, start = 0, end = audio.frames) {
  let sum = 0;
  for (const ch of audio.channels) for (let i = start; i < end; i++) sum += ch[i] * ch[i];
  return sum / Math.max(1, (end - start) * audio.channels.length);
}

export function loudness(audio) {
  return integratedLoudness(audio, audio.channels.map(ch => kWeight(ch, audio.sampleRate)));
}

function integratedLoudness(audio, weighted) {
  const block = Math.round(audio.sampleRate * 0.4), hop = Math.round(audio.sampleRate * 0.1);
  const energies = [];
  for (let start = 0; start + block <= audio.frames; start += hop) {
    let sum = 0;
    for (const ch of weighted) { let s = 0; for (let i = start; i < start + block; i++) s += ch[i] * ch[i]; sum += s / block; }
    energies.push(sum);
  }
  if (!energies.length) { // shorter than one gating block: ungated measurement
    let sum = 0;
    for (const ch of weighted) { let s = 0; for (const v of ch) s += v * v; sum += s / ch.length; }
    return { integratedLufs: sum > 0 ? Number((-0.691 + 10 * Math.log10(sum)).toFixed(2)) : null, gated: false };
  }
  const lufs = e => -0.691 + 10 * Math.log10(e);
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  const audible = energies.filter(e => e > 0 && lufs(e) > -70);
  if (!audible.length) return { integratedLufs: null, gated: true };
  const relative = lufs(mean(audible)) - 10;
  const kept = audible.filter(e => lufs(e) > relative);
  // Short-term (3 s) maximum gives a feel for the loudest passage.
  const window = 30;
  let shortMax = null;
  for (let i = 0; i + window <= energies.length; i += 5) {
    const e = mean(energies.slice(i, i + window));
    if (e > 0 && (shortMax === null || lufs(e) > shortMax)) shortMax = lufs(e);
  }
  return { integratedLufs: Number(lufs(mean(kept)).toFixed(2)), gated: true,
    shortTermMaxLufs: shortMax === null ? null : Number(shortMax.toFixed(2)) };
}

// 4x oversampled peak estimate (windowed-sinc interpolation), evaluated near the loudest samples only.
export function truePeak(audio) {
  const taps = 12, phases = [0.25, 0.5, 0.75];
  const kernels = phases.map(phase => Array.from({ length: taps * 2 }, (_, i) => {
    const x = i - taps + 1 - phase;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    return sinc * (0.5 + 0.5 * Math.cos(Math.PI * x / taps));
  }));
  let peak = samplePeak(audio);
  const floor = peak * 0.7;
  for (const ch of audio.channels) {
    for (let i = taps; i < ch.length - taps; i++) {
      if (Math.abs(ch[i]) < floor && Math.abs(ch[i + 1]) < floor) continue;
      for (const kernel of kernels) {
        let v = 0;
        for (let t = 0; t < taps * 2; t++) v += ch[i - taps + 1 + t] * kernel[t];
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
  }
  return peak;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}
const fftSize = 4096;
const hann = Float64Array.from({ length: fftSize }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / fftSize));
const hannPower = hann.reduce((sum, v) => sum + v * v, 0);
function mono(audio) {
  if (audio.channels.length === 1) return audio.channels[0];
  const [left, right] = audio.channels, out = new Float32Array(audio.frames);
  for (let i = 0; i < out.length; i++) out[i] = (left[i] + right[i]) / 2;
  return out;
}
// Power spectrum of one Hann-windowed frame starting at `start` (zero padded at the edges).
function framePower(signal, start, re, im) {
  for (let i = 0; i < fftSize; i++) {
    const index = start + i;
    re[i] = index >= 0 && index < signal.length ? signal[index] * hann[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
}
export const bandEdges = { sub: [20, 60], bass: [60, 150], lowMid: [150, 500], mid: [500, 2000], highMid: [2000, 6000], air: [6000, 20000] };
export function spectrum(audio, start = 0, end = audio.frames) {
  const signal = mono(audio), re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  const power = new Float64Array(fftSize / 2);
  let frames = 0;
  for (let at = start; at + fftSize <= end || frames === 0; at += fftSize / 2) {
    framePower(signal, at, re, im);
    for (let k = 0; k < power.length; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
    if (at + fftSize > end) break;
  }
  const scale = 2 / (hannPower * fftSize * frames), hz = audio.sampleRate / fftSize;
  const bands = {};
  let total = 0, weighted = 0;
  for (let k = 1; k < power.length; k++) { total += power[k]; weighted += power[k] * k * hz; }
  for (const [name, [low, high]] of Object.entries(bandEdges)) {
    let sum = 0;
    for (let k = Math.max(1, Math.ceil(low / hz)); k < Math.min(power.length, Math.ceil(high / hz)); k++) sum += power[k];
    bands[name] = powerDb(sum * scale);
  }
  return { bandsDbfs: bands, centroidHz: total > 0 ? Math.round(weighted / total) : null };
}

// Fundamental estimate by normalised autocorrelation; returns null for unpitched or silent material.
export function detectPitch(signal, sampleRate, start, length) {
  const low = Math.floor(sampleRate / 2500), high = Math.min(Math.floor(sampleRate / 28), Math.floor(length / 2));
  const end = Math.min(signal.length, start + length);
  let energy = 0;
  for (let i = start; i < end; i++) energy += signal[i] * signal[i];
  if (energy / Math.max(1, end - start) < 1e-7 || high <= low) return null;
  const scores = new Float64Array(high + 1);
  let best = 0;
  for (let lag = low; lag <= high; lag++) {
    let sum = 0, a = 0, b = 0;
    for (let i = start; i < end - lag; i += 2) { sum += signal[i] * signal[i + lag]; a += signal[i] * signal[i]; b += signal[i + lag] * signal[i + lag]; }
    scores[lag] = a > 0 && b > 0 ? sum / Math.sqrt(a * b) : 0;
    if (scores[lag] > best) best = scores[lag];
  }
  if (best < 0.6) return null;
  let lag = low + 1;
  while (lag < high && !(scores[lag] > 0.92 * best && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1])) lag++;
  if (lag >= high) return null;
  const [l, c, r] = [scores[lag - 1], scores[lag], scores[lag + 1]];
  const refined = lag + (l - r) / (2 * (l - 2 * c + r) || 1);
  const hz = sampleRate / refined;
  return { hz: Number(hz.toFixed(2)), midi: Number((69 + 12 * Math.log2(hz / 440)).toFixed(2)), confidence: Number(best.toFixed(2)) };
}

const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = midi => noteNames[((Math.round(midi) % 12) + 12) % 12] + (Math.floor(Math.round(midi) / 12) - 1);

function levels(audio, start, end) {
  const result = { peakDbfs: db(samplePeak(audio, start, end)), rmsDbfs: powerDb(meanSquare(audio, start, end)) };
  if (audio.channels.length === 2) {
    const [left, right] = audio.channels;
    let lr = 0, ll = 0, rr = 0;
    for (let i = start; i < end; i++) { lr += left[i] * right[i]; ll += left[i] * left[i]; rr += right[i] * right[i]; }
    result.stereoCorrelation = ll > 0 && rr > 0 ? Number((lr / Math.sqrt(ll * rr)).toFixed(2)) : null;
  }
  return result;
}

export function analyze(audio, { sections = [], pitch = false, expectedBpm, expectedKey, expectedSwing, reference } = {}) {
  const requestedSwing = expectedSwing === undefined ? undefined : parseExpectedSwing(expectedSwing);
  const expectedCamelot = expectedKey === undefined ? undefined : parseExpectedKey(expectedKey);
  const { sampleRate, frames } = audio;
  let clipped = 0, dc = 0;
  for (const ch of audio.channels) for (const v of ch) { dc += v; if (v >= 32767 / 32768 || v <= -1) clipped++; }
  let jump = 0;
  for (const ch of audio.channels) jump = Math.max(jump, Math.abs(ch[0] - ch[frames - 1]));
  const edge = Math.min(frames, Math.round(sampleRate * 0.05));
  // How fast the waveform itself moves at the two ends: the largest sample-to-sample step in the first and last millisecond.
  // A join that jumps no more than the audio does by itself is a continuation, not a click (a loop that starts on a drum hit).
  let step = 0;
  const near = Math.min(frames - 1, Math.max(8, Math.round(sampleRate * 0.001)));
  for (const ch of audio.channels) for (let i = 1; i <= near; i++) step = Math.max(step, Math.abs(ch[i] - ch[i - 1]), Math.abs(ch[frames - i] - ch[frames - i - 1]));
  const weighted = audio.channels.map(ch => kWeight(ch, sampleRate));
  const { lraLu } = loudnessRangeFromWeighted(sampleRate, weighted);
  const estimate = estimateTempo(audio);
  const tempo = { bpm: estimate.bpm, confidence: estimate.confidence };
  if (expectedBpm !== undefined) {
    tempo.expectedBpm = expectedBpm;
    tempo.match = tempo.bpm === null ? null : [expectedBpm, expectedBpm * 2, expectedBpm / 2]
      .some(bpm => Math.abs(tempo.bpm - bpm) <= 1);
  }
  const estimatedKey = estimateKey(audio);
  const key = Object.fromEntries(['key', 'tonic', 'mode', 'camelot', 'confidence', 'margin'].map(field => [field, estimatedKey[field]]));
  if (expectedCamelot !== undefined) {
    key.expectedCamelot = expectedCamelot;
    key.match = key.key === null ? null : key.camelot === expectedCamelot;
    const actualNumber = Number.parseInt(key.camelot, 10);
    const expectedNumber = Number.parseInt(expectedCamelot, 10);
    const distance = Math.abs(actualNumber - expectedNumber);
    key.compatible = key.key === null ? null : actualNumber === expectedNumber ||
      (key.camelot.at(-1) === expectedCamelot.at(-1) && (distance === 1 || distance === 11));
  }
  const onset = detectOnsets(audio);
  const swing = swingRatio(onset.onsets, expectedBpm === undefined ? tempo.bpm : expectedBpm);
  const rhythm = { onsetCount: onset.count, density: onset.density, meanIoi: onset.meanIoi,
    swing: swing.ratio, offbeats: swing.offbeats };
  if (requestedSwing !== undefined) {
    rhythm.expectedSwing = requestedSwing;
    rhythm.swingMatch = swing.ratio === null ? null : Math.abs(swing.ratio - requestedSwing) <= 0.25;
  }
  const arrangementBpm = expectedBpm === undefined ? tempo.bpm : expectedBpm;
  const energy = Number.isFinite(arrangementBpm) && arrangementBpm > 0
    ? barEnergy(audio, { bpm: arrangementBpm, beatsPerBar: 4 }) : null;
  const arrangement = energy === null ? null : { ...energy, drops: findDrops(energy.bars) };
  const report = {
    arrangement,
    rhythm,
    key,
    tempo,
    sampleRate, channels: audio.channels.length, durationSeconds: Number((frames / sampleRate).toFixed(4)),
    ...integratedLoudness(audio, weighted), lraLu, stereo: stereoImage(audio), dynamicRange: dynamicRange(audio), truePeakDbfs: db(truePeak(audio)), ...levels(audio, 0, frames),
    clippedSamples: clipped, dcOffset: Number((dc / (frames * audio.channels.length)).toFixed(5)),
    ...spectrum(audio),
    loop: { boundaryJumpDbfs: db(jump), boundaryStepDbfs: db(step), startRmsDbfs: powerDb(meanSquare(audio, 0, edge)), endRmsDbfs: powerDb(meanSquare(audio, frames - edge, frames)) },
  };
  if (reference !== undefined) report.referenceMatch = compareToReference(bandProfile(audio), bandProfile(reference));
  if (report.rmsDbfs !== null && report.peakDbfs !== null) report.crestDb = Number((report.peakDbfs - report.rmsDbfs).toFixed(2));
  const signal = pitch || sections.some(s => s.pitch) ? mono(audio) : null;
  const pitchOf = (start, end) => {
    const found = detectPitch(signal, sampleRate, start, Math.min(end - start, Math.round(sampleRate * 0.25)));
    return found ? { ...found, note: midiName(found.midi) } : null;
  };
  if (pitch) report.pitch = pitchOf(Math.round(frames * 0.1), frames);
  report.sections = sections.map(({ name, startSeconds, endSeconds }) => {
    const start = Math.max(0, Math.min(frames - 1, Math.round(startSeconds * sampleRate)));
    const end = Math.max(start + 1, Math.min(frames, Math.round(endSeconds * sampleRate)));
    const part = slice(audio, start, end);
    return { name, startSeconds, endSeconds, ...levels(audio, start, end), integratedLufs: loudness(part).integratedLufs,
      ...spectrum(audio, start, end), ...(pitch ? { pitch: pitchOf(start, end) } : {}) };
  });
  return report;
}

// A loop join clicks when the first and last samples differ by more than -30 dBFS AND by clearly more than the waveform
// moves between neighbouring samples at the ends. Loops that start on a drum hit differ by a lot but only as much as the
// hit itself rises, so they are not flagged. Reports without boundaryStepDbfs fall back to the plain -30 dBFS rule.
export function loopJoinClicks(loop) {
  if (loop.boundaryJumpDbfs === null || loop.boundaryJumpDbfs === undefined || loop.boundaryJumpDbfs <= -30) return false;
  if (loop.boundaryStepDbfs === null || loop.boundaryStepDbfs === undefined) return true; // flat ends (step 0) or an older report
  return loop.boundaryJumpDbfs > loop.boundaryStepDbfs + 6;
}

// Plain-language warnings an agent can act on without listening.
export function advise(report, { loop = false, targetLufs } = {}) {
  const notes = [];
  const arrangement = report.arrangement;
  if (arrangement) {
    if (arrangement.bars.length >= 16 && arrangement.drops.length === 0) notes.push('No drop found: no bar rises 6 dB over the previous four. Add a build and a clear drop if this is a dance track.');
    if (arrangement.rangeDb !== null && arrangement.rangeDb < 3 && arrangement.bars.length >= 8) notes.push('Bar-to-bar energy varies by under 3 dB: the arrangement may feel flat.');
  }
  const ref = report.referenceMatch;
  if (ref) {
    if (ref.gainDb != null && Math.abs(ref.gainDb) >= 3) notes.push(`The mix is ${Math.abs(ref.gainDb).toFixed(1)} dB ${ref.gainDb > 0 ? 'quieter' : 'louder'} than the reference: match levels before comparing tone.`);
    const delta = ref.worst == null ? null : ref.bandDeltas[ref.worst];
    if (delta != null && Math.abs(delta) >= 3) notes.push(`The ${ref.worst} band is ${Math.abs(delta).toFixed(1)} dB ${delta > 0 ? 'above' : 'below'} the reference: adjust EQ or the instrument level in that range.`);
  }
  if (report.rhythm?.swingMatch === false) notes.push(`Detected swing ratio (${report.rhythm.swing}) does not match the requested ${report.rhythm.expectedSwing}: check the groove swing setting and the humanise amount.`);
  if (report.key?.compatible === false) notes.push(`Detected key (${report.key.key}, Camelot ${report.key.camelot}) does not match the requested ${report.key.expectedCamelot}: check the project key, the bass line and the chord pattern.`);
  if (report.tempo?.match === false) notes.push(`Detected tempo (${report.tempo.bpm} BPM) does not match the requested ${report.tempo.expectedBpm} BPM: check the project tempo and the drum pattern grid.`);
  if (report.dynamicRange?.dr != null && report.dynamicRange.dr < 6) notes.push("Dynamic range is under DR6: the master is likely over-compressed or over-limited; ease the limiter or bus compression.");
  if (report.clippedSamples > 0) notes.push(`${report.clippedSamples} samples are at full scale: lower track or master volume, or add a limiter.`);
  if (report.truePeakDbfs !== null && report.truePeakDbfs > -1 && !report.clippedSamples) notes.push('True peak is above -1 dBFS: lossy encoders may clip it.');
  if (report.integratedLufs !== null && targetLufs !== undefined && Math.abs(report.integratedLufs - targetLufs) > 1.5) {
    notes.push(`Loudness is ${report.integratedLufs} LUFS against a ${targetLufs} LUFS target.`);
  }
  if (report.stereoCorrelation !== undefined && report.stereoCorrelation !== null && report.stereoCorrelation < 0.2) notes.push('Left and right are weakly correlated: the mix will thin out in mono.');
  if (report.stereo?.monoCancels || report.stereo?.monoFoldDropDb > 6) {
    notes.push('The mix loses substantial level when folded to mono: check stereo widening and polarity.');
  }
  if (report.stereo?.minWindowCorrelation < -0.3) {
    notes.push('At least one passage has opposing left and right phase: check channel polarity and timing.');
  }
  if (Math.abs(report.dcOffset) > 0.01) notes.push('There is a DC offset.');
  const bands = report.bandsDbfs;
  if (bands.lowMid !== null && bands.highMid !== null && bands.lowMid - bands.highMid > 18) notes.push('Low mids dominate the upper mids by more than 18 dB: the mix may sound muddy or dull.');
  if (bands.bass !== null && bands.mid !== null && bands.mid - bands.bass > 15) notes.push('Bass is more than 15 dB under the mids: the mix may sound thin.');
  if (loop && loopJoinClicks(report.loop)) notes.push('The first and last samples differ by more than -30 dBFS and by more than the audio moves at either end: expect a click at the loop point.');
  for (const section of report.sections ?? []) {
    if (section.rmsDbfs === null) notes.push(`Section "${section.name}" is silent.`);
    else if (section.stereoCorrelation !== undefined && section.stereoCorrelation !== null && section.stereoCorrelation < 0.2) {
      notes.push(`Section "${section.name}" has weakly correlated left and right channels (${section.stereoCorrelation}): it will thin out in mono.`);
    }
  }
  return notes;
}

// Fold audio after `loopFrames` back onto the start so reverb and delay tails survive the loop point.
export function foldTail(audio, loopFrames) {
  const channels = audio.channels.map(ch => {
    const out = ch.slice(0, loopFrames);
    for (let i = loopFrames; i < ch.length; i++) out[(i - loopFrames) % loopFrames] += ch[i];
    return out;
  });
  return { sampleRate: audio.sampleRate, frames: loopFrames, channels };
}
export function fitLength(audio, frames) {
  return { sampleRate: audio.sampleRate, frames, channels: audio.channels.map(ch => {
    const out = new Float32Array(frames);
    out.set(ch.subarray(0, Math.min(frames, ch.length)));
    return out;
  }) };
}
export function fade(audio, inFrames, outFrames) {
  for (const ch of audio.channels) {
    for (let i = 0; i < Math.min(inFrames, ch.length); i++) ch[i] *= i / inFrames;
    for (let i = 0; i < Math.min(outFrames, ch.length); i++) ch[ch.length - 1 - i] *= i / outFrames;
  }
  return audio;
}

// Look-ahead peak limiter. `wrap` treats the audio as a loop so the gain curve is continuous at the seam.
export function limit(audio, ceilingDb = -1, { wrap = false } = {}) {
  const ceiling = 10 ** (ceilingDb / 20), n = audio.frames;
  const look = Math.max(1, Math.round(audio.sampleRate * 0.005));
  const release = Math.exp(-1 / (audio.sampleRate * 0.12));
  const need = new Float32Array(n);
  let reduced = 0;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const ch of audio.channels) peak = Math.max(peak, Math.abs(ch[i]));
    need[i] = peak > ceiling ? ceiling / peak : 1;
    if (need[i] < 1) reduced++;
  }
  if (!reduced) return { audio, limitedSamples: 0, maxReductionDb: 0 };
  // Each needed reduction is reached `look` samples early, held, then released smoothly.
  const index = i => wrap ? ((i % n) + n) % n : i;
  const ahead = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    if (need[i] === 1) continue;
    for (let j = i - look; j <= i; j++) {
      const at = index(j);
      if (at >= 0 && at < n && need[i] < ahead[at]) ahead[at] = need[i];
    }
  }
  const held = new Float32Array(n);
  let gain = 1;
  for (let pass = 0; pass < (wrap ? 2 : 1); pass++) { // the second pass carries the release across the loop seam
    for (let i = 0; i < n; i++) { gain = Math.min(ahead[i], 1 - (1 - gain) * release); held[i] = gain; }
  }
  // A trailing average over the look-ahead window turns steps into ramps without rising above the held value at a peak.
  const value = i => { const at = index(i); return at >= 0 && at < n ? held[at] : 1; };
  let sum = 0, lowest = 1;
  for (let j = -look; j <= 0; j++) sum += value(j);
  for (let i = 0; i < n; i++) {
    const g = Math.min(need[i], sum / (look + 1));
    if (g < lowest) lowest = g;
    for (const ch of audio.channels) ch[i] *= g;
    sum += value(i + 1) - value(i - look);
  }
  return { audio, limitedSamples: reduced, maxReductionDb: Number((20 * Math.log10(lowest)).toFixed(2)) };
}

// Limit so that the 4x oversampled true peak, not just the sample peak, stays under the ceiling.
// A sample-peak limiter at -1 dB leaves inter-sample peaks near -0.3 dBTP. Each pass lowers the sample ceiling by the overshoot.
export function limitTruePeak(audio, ceilingDb = -1, { wrap = false, passes = 4 } = {}) {
  const tolerance = 0.005; // dB
  let sampleCeiling = ceilingDb;
  let result = limit(audio, sampleCeiling, { wrap });
  let truePeakDb = db(truePeak(audio));
  let limitedSamples = result.limitedSamples, maxReductionDb = result.maxReductionDb;
  for (let pass = 0; pass < passes && truePeakDb !== null && truePeakDb > ceilingDb + tolerance; pass++) {
    sampleCeiling -= truePeakDb - ceilingDb + 0.01;
    result = limit(audio, sampleCeiling, { wrap });
    limitedSamples = Math.max(limitedSamples, result.limitedSamples);
    maxReductionDb = Math.min(maxReductionDb, result.maxReductionDb);
    truePeakDb = db(truePeak(audio));
  }
  return { audio, limitedSamples, maxReductionDb, truePeakDb, sampleCeilingDb: Number(sampleCeiling.toFixed(2)) };
}

// --- spectrogram PNG ---
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < body.length + 8; i++) crc = crcTable[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 8);
  return out;
}
const palette = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
export function spectrogramPng(audio, { width = 960, height = 360, lowHz = 40, highHz = 16000, floorDb = -96 } = {}) {
  const signal = mono(audio), re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  const rows = Array.from({ length: height }, () => Buffer.alloc(1 + width * 3));
  const top = Math.min(highHz, audio.sampleRate / 2 - 1), hz = audio.sampleRate / fftSize;
  const edges = Array.from({ length: height + 1 }, (_, y) => lowHz * (top / lowHz) ** (1 - y / height) / hz);
  const scale = 4 / (hannPower * fftSize);
  for (let x = 0; x < width; x++) {
    framePower(signal, Math.round((x + 0.5) * audio.frames / width) - fftSize / 2, re, im);
    for (let y = 0; y < height; y++) {
      const from = Math.max(1, Math.floor(edges[y + 1])), to = Math.max(from + 1, Math.ceil(edges[y]));
      let peak = 0;
      for (let k = from; k < to && k < fftSize / 2; k++) peak = Math.max(peak, re[k] * re[k] + im[k] * im[k]);
      const level = peak > 0 ? 10 * Math.log10(peak * scale) : floorDb;
      const t = Math.max(0, Math.min(0.9999, (level - floorDb) / -floorDb)) * (palette.length - 1);
      const a = palette[Math.floor(t)], b = palette[Math.floor(t) + 1], f = t - Math.floor(t);
      for (let c = 0; c < 3; c++) rows[y][1 + x * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * f);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// GBV tempo estimator: maths preserved from lingxi-gbv-20261119-01.
export function estimateTempo(
  { sampleRate, channels },
  { minBpm = 70, maxBpm = 180, hop = 256 } = {},
) {
  const n = channels && channels.length > 0 ? channels[0].length : 0;
  const frames = Math.floor(n / hop);
  const fr = sampleRate / hop;
  const out = {
    bpm: null,
    confidence: 0,
    frameRate: Number(fr.toFixed(4)),
    onsetFrames: frames,
  };
  if (frames < 2) return out;

  const nCh = channels.length;
  const e = new Float64Array(frames);
  for (let k = 0; k < frames; k++) {
    const start = k * hop;
    const end = start + hop;
    let sum = 0;
    for (let i = start; i < end; i++) {
      const m =
        nCh === 1
          ? channels[0][i]
          : (channels[0][i] + channels[1][i]) * 0.5;
      sum += m * m;
    }
    e[k] = sum;
  }

  const d = new Float64Array(frames);
  d[0] = 0;
  for (let k = 1; k < frames; k++) {
    d[k] = e[k] > 1.1 * e[k - 1] ? e[k] - e[k - 1] : 0;
  }

  const o = new Float64Array(frames);
  for (let k = 0; k < frames; k++) {
    const prev = k > 0 ? d[k - 1] : 0;
    const next = k + 1 < frames ? d[k + 1] : 0;
    o[k] = 0.5 * d[k] + 0.25 * prev + 0.25 * next;
  }

  const lo = Math.max(1, Math.floor((fr * 60) / maxBpm));
  const hi = Math.min(frames - 1, Math.ceil((fr * 60) / minBpm));
  let ac0 = 0;
  for (let k = 0; k < frames; k++) ac0 += o[k] * o[k];
  if (ac0 === 0 || hi <= lo) return out;

  function ac(L) {
    if (L <= 0 || L >= frames) return 0;
    const count = frames - L;
    let sum = 0;
    for (let k = 0; k < count; k++) sum += o[k] * o[k + L];
    return sum / count;
  }

  let best = lo;
  let bestV = ac(lo);
  for (let L = lo + 1; L <= hi; L++) {
    const v = ac(L);
    if (v > bestV) {
      best = L;
      bestV = v;
    }
  }
  if (!(bestV > 0)) return out;

  const half = Math.round(best / 2);
  if (half - 1 >= lo) {
    let oct = half;
    let octV = ac(half);
    const left = ac(half - 1);
    if (left > octV) {
      oct = half - 1;
      octV = left;
    }
    const right = ac(half + 1);
    if (right > octV) {
      oct = half + 1;
      octV = right;
    }
    if (octV >= 0.5 * bestV) {
      best = oct;
      bestV = octV;
    }
  }

  let lag = best;
  if (lo < best && best < hi) {
    const a = ac(best - 1);
    const b = bestV;
    const c = ac(best + 1);
    const den = a - 2 * b + c;
    if (den < 0) {
      const refined = best + 0.5 * (a - c) / den;
      if (Number.isFinite(refined) && refined > 0) lag = refined;
    }
  }

  if (!(lag > 0) || !Number.isFinite(lag)) return out;

  const bpm = 60 * fr / lag;
  const confidence = Math.min(1, bestV / (ac0 / frames));
  const bpmOut = Number(bpm.toFixed(1));
  const confOut = Number(confidence.toFixed(3));
  out.bpm = Number.isFinite(bpmOut) ? bpmOut : null;
  out.confidence = Number.isFinite(confOut) ? confOut : 0;
  return out;
}

// GBV key estimator: maths preserved from lingxi-gbv-20261120-01.
export function camelot(tonic, mode) {
  const t = mode === 'minor' ? (tonic + 3) % 12 : tonic;
  return String(((7 * t) % 12 + 7) % 12 + 1) + (mode === 'minor' ? 'A' : 'B');
}

function pearson(x, y) {
  const n = 12;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return 0;
  const r = num / Math.sqrt(dx2 * dy2);
  return Number.isFinite(r) ? r : 0;
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export function estimateKey(
  { sampleRate, channels },
  { frame = 4096, hop = 2048, minMidi = 36, maxMidi = 95 } = {},
) {
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const chroma = new Float64Array(12);
  const out = {
    key: null,
    tonic: null,
    mode: null,
    camelot: null,
    confidence: 0,
    margin: 0,
    frames: 0,
    chroma: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  const nch = channels && channels.length ? channels.length : 0;
  const n = nch ? channels[0].length : 0;
  if (n === 0 || frame < 2) return out;

  const w = new Float64Array(frame);
  const denom = frame - 1;
  for (let i = 0; i < frame; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  }
  const x = new Float64Array(frame);
  const nyquist = sampleRate / 2;
  let frames = 0;
  for (let s = 0; s + frame <= n; s += hop) {
    frames += 1;
    for (let i = 0; i < frame; i++) {
      let acc = 0;
      for (let c = 0; c < nch; c++) acc += channels[c][s + i];
      x[i] = (acc / nch) * w[i];
    }
    for (let midi = minMidi; midi <= maxMidi; midi++) {
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      if (f >= nyquist) continue;
      const coeff = 2 * Math.cos((2 * Math.PI * f) / sampleRate);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < frame; i++) {
        const s0 = x[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const p = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      chroma[midi % 12] += Math.sqrt(Math.max(0, p));
    }
  }
  out.frames = frames;

  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (!(total > 1e-9)) return out;

  const norm = new Float64Array(12);
  for (let i = 0; i < 12; i++) norm[i] = chroma[i] / total;
  out.chroma = Array.from(norm, (v) => Number(v.toFixed(4)));

  let bestR = -Infinity;
  let secondR = -Infinity;
  let bestT = 0;
  let bestMode = 'major';
  const rot = new Float64Array(12);
  const modes = ['major', 'minor'];
  for (let mi = 0; mi < modes.length; mi++) {
    const mode = modes[mi];
    const profile = mode === 'major' ? MAJ : MIN;
    for (let t = 0; t < 12; t++) {
      for (let i = 0; i < 12; i++) rot[i] = norm[(t + i) % 12];
      const r = pearson(rot, profile);
      if (r > bestR) {
        secondR = bestR;
        bestR = r;
        bestT = t;
        bestMode = mode;
      } else if (r > secondR) {
        secondR = r;
      }
    }
  }

  const tonicName = NAMES[bestT];
  out.tonic = tonicName;
  out.mode = bestMode;
  out.key = tonicName + ' ' + bestMode;
  out.camelot = camelot(bestT, bestMode);
  out.confidence = Number(clamp01(bestR).toFixed(3));
  let margin = bestR - secondR;
  if (!Number.isFinite(margin)) margin = 0;
  out.margin = Number(margin.toFixed(3));
  if (!Number.isFinite(out.confidence)) out.confidence = 0;
  if (!Number.isFinite(out.margin)) out.margin = 0;
  return out;
}

function parseExpectedKey(value) {
  if (typeof value === 'string') {
    const code = /^(1[0-2]|[1-9])([ab])$/i.exec(value.trim());
    if (code) return code[1] + code[2].toUpperCase();
    const name = /^([a-g])([#b]?)\s+(major|minor)$/i.exec(value.trim());
    if (name) {
      const natural = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[name[1].toLowerCase()];
      const accidental = name[2] === '#' ? 1 : name[2].toLowerCase() === 'b' ? -1 : 0;
      return camelot((natural + accidental + 12) % 12, name[3].toLowerCase());
    }
  }
  throw new RangeError('expectedKey must be a tonic and major/minor mode (for example F# minor) or Camelot code (1A to 12B)');
}

// GBV SuperFlux-style detector: maths preserved from lingxi-gbv-20261123-01.
function isPowerOfTwo(n) {
  return Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;
}

function fftRadix2(re, im) {
  const n = re.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const i0 = i + k;
        const i1 = i0 + half;
        const vr = re[i1] * wRe - im[i1] * wIm;
        const vi = re[i1] * wIm + im[i1] * wRe;
        const ur = re[i0];
        const ui = im[i0];
        re[i0] = ur + vr;
        im[i0] = ui + vi;
        re[i1] = ur - vr;
        im[i1] = ui - vi;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
}

function median(values) {
  const a = values.slice().sort((x, y) => x - y);
  const n = a.length;
  const mid = n >> 1;
  if (n % 2 === 1) return a[mid];
  return (a[mid - 1] + a[mid]) / 2;
}

export function detectOnsets({ sampleRate, channels }, { frame = 1024, hop = 256, delta = 0.1 } = {}) {
  if (!isPowerOfTwo(frame)) throw new RangeError('frame must be a power of two');

  const out = { onsets: [], count: 0, density: 0, meanIoi: null, frames: 0 };
  const n = channels && channels.length ? channels[0].length : 0;
  const nCh = channels && channels.length ? channels.length : 0;
  const nBins = (frame >> 1) + 1;

  const w = new Float64Array(frame);
  const denom = frame - 1;
  for (let i = 0; i < frame; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);

  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  const L = new Float64Array(nBins);
  const Lprev = new Float64Array(nBins);
  const flux = [];
  let hasPrev = false;

  for (let s = 0; s + frame <= n; s += hop) {
    im.fill(0);
    for (let i = 0; i < frame; i++) {
      let acc = 0;
      for (let c = 0; c < nCh; c++) acc += channels[c][s + i];
      re[i] = (acc / nCh) * w[i];
    }
    fftRadix2(re, im);
    for (let k = 0; k < nBins; k++) L[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));

    let f = 0;
    if (hasPrev) {
      for (let k = 0; k < nBins; k++) {
        let mx = Lprev[k];
        if (k > 0) mx = mx > Lprev[k - 1] ? mx : Lprev[k - 1];
        if (k + 1 < nBins) mx = mx > Lprev[k + 1] ? mx : Lprev[k + 1];
        const d = L[k] - mx;
        if (d > 0) f += d;
      }
    }
    flux.push(f);
    Lprev.set(L);
    hasPrev = true;
  }

  out.frames = flux.length;
  let maxFlux = 0;
  for (let t = 0; t < flux.length; t++) if (flux[t] > maxFlux) maxFlux = flux[t];
  if (!(maxFlux > 1e-9)) return out;

  const nf = new Float64Array(flux.length);
  for (let t = 0; t < flux.length; t++) nf[t] = flux[t] / maxFlux;

  let lastOnsetFrame = -1e9;
  for (let t = 1; t < nf.length; t++) {
    if (!(nf[t] > 0)) continue;
    if (t - lastOnsetFrame < 3) continue;

    const loP = t - 3 < 0 ? 0 : t - 3;
    const hiP = t + 3 > nf.length - 1 ? nf.length - 1 : t + 3;
    let isPeak = true;
    for (let j = loP; j <= hiP; j++) {
      if (nf[j] > nf[t]) { isPeak = false; break; }
    }
    if (!isPeak) continue;

    const loM = t - 10 < 0 ? 0 : t - 10;
    const hiM = t + 10 > nf.length - 1 ? nf.length - 1 : t + 10;
    let sum = 0;
    for (let j = loM; j <= hiM; j++) sum += nf[j];
    const mean = sum / (hiM - loM + 1);
    if (!(nf[t] >= mean + delta)) continue;

    lastOnsetFrame = t;
    out.onsets.push(Number(((t * hop + frame / 2) / sampleRate).toFixed(4)));
  }

  out.count = out.onsets.length;
  const duration = n / sampleRate;
  out.density = Number((out.count / duration).toFixed(3));
  if (out.count >= 2) {
    out.meanIoi = Number(((out.onsets[out.count - 1] - out.onsets[0]) / (out.count - 1)).toFixed(4));
  }
  return out;
}

export function swingRatio(times, bpm) {
  const out = { ratio: null, offbeats: 0 };
  if (!Array.isArray(times) || times.length < 2 || !(bpm > 0)) return out;

  const beat = 60 / bpm;
  const t0 = times[0];
  const kept = [];
  for (let i = 0; i < times.length; i++) {
    const p = (times[i] - t0) / beat;
    const f = p - Math.floor(p);
    if (f > 0.2 && f < 0.8) kept.push(f);
  }
  if (kept.length === 0) return out;

  const m = median(kept);
  out.offbeats = kept.length;
  out.ratio = Number((m / (1 - m)).toFixed(3));
  return out;
}

function parseExpectedSwing(value) {
  if (value === 'straight') return 1;
  if (value === 'triplet') return 2;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  throw new RangeError('expectedSwing must be a finite number > 0, "straight" or "triplet"');
}

// Reference profiling ported from lingxi-gbv-20261124-01; FFT maths retained.
const BANDS = Object.entries(bandEdges).map(([name, [lo, hi]]) => [name, lo, hi]);
function roundN(x, n) {
  return Number(x.toFixed(n));
}

function isPositivePowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function delta(a, b) {
  if (a == null || b == null) return null;
  return a - b;
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang0 = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const ang = ang0 * j;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        const p = i + j;
        const q = p + half;
        const vRe = re[q] * wRe - im[q] * wIm;
        const vIm = re[q] * wIm + im[q] * wRe;
        re[q] = re[p] - vRe;
        im[q] = im[p] - vIm;
        re[p] += vRe;
        im[p] += vIm;
      }
    }
  }
}

function lsSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    sx += x;
    sy += y;
    sxy += x * y;
    sx2 += x * x;
  }
  const den = n * sx2 - sx * sx;
  if (!(Math.abs(den) > 0) || !Number.isFinite(den)) return null;
  const slope = (n * sxy - sx * sy) / den;
  return Number.isFinite(slope) ? slope : null;
}

function bandForHz(f) {
  for (let i = 0; i < BANDS.length; i++) {
    const lo = BANDS[i][1], hi = BANDS[i][2];
    if (f >= lo && f < hi) return i;
  }
  return -1;
}

export function bandProfile({ sampleRate, channels } = {}, { frame = 4096, hop = 2048 } = {}) {
  if (!Number.isInteger(hop) || hop <= 0) throw new RangeError('hop must be a positive integer');
  if (!isPositivePowerOfTwo(frame)) throw new RangeError('frame must be a positive power of two');

  const out = {
    rmsDb: null,
    bands: { sub: null, bass: null, lowMid: null, mid: null, highMid: null, air: null },
    slope: null,
    width: null,
    frames: 0,
  };

  const ch0 = channels && channels[0];
  const n = ch0 && ch0.length ? ch0.length : 0;
  const ch1 = channels && channels.length >= 2 ? channels[1] : null;
  const stereo = ch1 != null;

  const m = new Float64Array(n);
  let ss = 0;
  let Pm = 0;
  let Ps = 0;

  if (stereo) {
    for (let i = 0; i < n; i++) {
      const L = ch0[i];
      const R = ch1[i];
      const mid = (L + R) / 2;
      const side = (L - R) / 2;
      m[i] = mid;
      const mid2 = mid * mid;
      ss += mid2;
      Pm += mid2;
      Ps += side * side;
    }
    if (Pm + Ps > 1e-12) out.width = roundN(Ps / (Pm + Ps), 3);
  } else if (n > 0) {
    for (let i = 0; i < n; i++) {
      const v = ch0[i];
      m[i] = v;
      ss += v * v;
    }
    if (ss > 1e-12) out.width = 0;
  }

  if (n > 0 && ss / n > 1e-12) out.rmsDb = roundN(10 * Math.log10(ss / n), 2);

  const nyquist = sampleRate / 2;
  const power = new Float64Array(BANDS.length);
  const window = new Float64Array(frame);
  if (frame > 1) {
    const denom = frame - 1;
    for (let i = 0; i < frame; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  } else {
    window[0] = 1;
  }

  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  const binHz = sampleRate / frame;
  const kMax = frame / 2;

  for (let s = 0; s + frame <= n; s += hop) {
    out.frames++;
    for (let i = 0; i < frame; i++) {
      re[i] = m[s + i] * window[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 1; k <= kMax; k++) {
      const f = k * binHz;
      const bi = bandForHz(f);
      if (bi < 0) continue;
      const rv = re[k], iv = im[k];
      power[bi] += rv * rv + iv * iv;
    }
  }

  let total = 0;
  for (let i = 0; i < power.length; i++) total += power[i];

  if (out.frames === 0 || out.rmsDb === null || total <= 1e-12) return out;

  const xs = [];
  const ys = [];
  for (let i = 0; i < BANDS.length; i++) {
    const name = BANDS[i][0];
    const lower = BANDS[i][1];
    const upper = BANDS[i][2];
    const Pb = power[i];
    if (!(lower < nyquist) || !(Pb > 0)) continue;
    const top = Math.min(upper, nyquist);
    const rel = Pb / total;
    const db = 10 * Math.log10(rel);
    if (Number.isFinite(db)) out.bands[name] = roundN(db, 1);
    const oct = Math.log2(top / lower);
    if (oct > 0 && rel > 0) {
      const y = 10 * Math.log10(rel / oct);
      const x = Math.log2(Math.sqrt(lower * top));
      if (Number.isFinite(x) && Number.isFinite(y)) {
        xs.push(x);
        ys.push(y);
      }
    }
  }

  const slope = lsSlope(xs, ys);
  if (slope != null) out.slope = roundN(slope, 2);
  return out;
}

export function compareToReference(mix, ref) {
  const bandDeltas = { sub: null, bass: null, lowMid: null, mid: null, highMid: null, air: null };
  let worst = null;
  let worstAbs = 0;
  for (let i = 0; i < BANDS.length; i++) {
    const name = BANDS[i][0];
    const unrounded = delta(mix && mix.bands ? mix.bands[name] : null, ref && ref.bands ? ref.bands[name] : null);
    if (unrounded == null) {
      bandDeltas[name] = null;
      continue;
    }
    bandDeltas[name] = roundN(unrounded, 1);
    const a = Math.abs(unrounded);
    if (a >= 0.5 && (worst === null || a > worstAbs)) {
      worst = name;
      worstAbs = a;
    }
  }

  const gainRaw = delta(ref && ref.rmsDb, mix && mix.rmsDb);
  const slopeRaw = delta(mix && mix.slope, ref && ref.slope);
  const widthRaw = delta(mix && mix.width, ref && ref.width);

  return {
    gainDb: gainRaw == null ? null : roundN(gainRaw, 2),
    bandDeltas,
    worst,
    slopeDelta: slopeRaw == null ? null : roundN(slopeRaw, 2),
    widthDelta: widthRaw == null ? null : roundN(widthRaw, 3),
    levelMatch: 'rms',
  };
}

// Bar-energy maths ported from lingxi-gbv-20261125-01.
function energyRound1(x) {
  return Number(x.toFixed(1));
}

function energyRound4(x) {
  return Number(x.toFixed(4));
}

export function barEnergy({ sampleRate, channels }, { bpm, beatsPerBar = 4, offset = 0 } = {}) {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError('bpm must be a finite number greater than 0');
  }
  if (!Number.isInteger(beatsPerBar) || beatsPerBar <= 0) {
    throw new RangeError('beatsPerBar must be a positive integer');
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new RangeError('offset must be a finite number greater than or equal to 0');
  }

  const n = channels && channels.length > 0 ? channels[0].length : 0;
  const nCh = channels && channels.length > 0 ? channels.length : 0;
  const barLen = Math.round(sampleRate * 60 * beatsPerBar / bpm);
  if (!Number.isSafeInteger(barLen) || barLen < 1) throw new RangeError('bar length must be a positive safe integer');
  const start = Math.round(offset * sampleRate);
  const floorRms = 10 ** -4.5;
  const bars = [];

  for (let s = start; s + barLen <= n; s += barLen) {
    let sumSq = 0;
    for (let i = s; i < s + barLen; i++) {
      let mix = 0;
      for (let c = 0; c < nCh; c++) {
        mix += channels[c][i];
      }
      mix /= nCh;
      sumSq += mix * mix;
    }
    const rms = Math.sqrt(sumSq / barLen);
    bars.push(energyRound1(20 * Math.log10(Math.max(rms, floorRms))));
  }

  let peakBar = null;
  let rangeDb = null;
  if (bars.length > 0) {
    let maxVal = bars[0];
    let minVal = bars[0];
    peakBar = 0;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i] > maxVal) {
        maxVal = bars[i];
        peakBar = i;
      }
      if (bars[i] < minVal) {
        minVal = bars[i];
      }
    }
    rangeDb = energyRound1(maxVal - minVal);
  }

  return { barSeconds: energyRound4(barLen / sampleRate), bars, peakBar, rangeDb };
}

export function findDrops(bars, { rise = 6, window = 4, minGap = 8 } = {}) {
  const drops = [];
  let lastDrop = null;
  for (let i = 1; i < bars.length; i++) {
    const from = Math.max(0, i - window);
    let sum = 0;
    for (let j = from; j < i; j++) {
      sum += bars[j];
    }
    const base = sum / (i - from);
    const jump = bars[i] - base;
    if (jump >= rise && (lastDrop === null || i - lastDrop >= minGap)) {
      drops.push({ bar: i, jumpDb: energyRound1(jump) });
      lastDrop = i;
    }
  }
  return drops;
}
