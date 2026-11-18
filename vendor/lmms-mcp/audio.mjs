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

export function analyze(audio, { sections = [], pitch = false } = {}) {
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
  const report = {
    sampleRate, channels: audio.channels.length, durationSeconds: Number((frames / sampleRate).toFixed(4)),
    ...integratedLoudness(audio, weighted), lraLu, stereo: stereoImage(audio), truePeakDbfs: db(truePeak(audio)), ...levels(audio, 0, frames),
    clippedSamples: clipped, dcOffset: Number((dc / (frames * audio.channels.length)).toFixed(5)),
    ...spectrum(audio),
    loop: { boundaryJumpDbfs: db(jump), boundaryStepDbfs: db(step), startRmsDbfs: powerDb(meanSquare(audio, 0, edge)), endRmsDbfs: powerDb(meanSquare(audio, frames - edge, frames)) },
  };
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
