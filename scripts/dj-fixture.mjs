// Synthetic DJ test tracks: a kick on every beat, a hat on the off-beats and a bass line
// that states the key. A quiet intro is followed by a drop at a known bar.
import { encodeWav } from "../vendor/lmms-mcp/audio.mjs";

const midiHz = (midi) => 440 * 2 ** ((midi - 69) / 12);
// Chord roots as semitones above the tonic, with each chord's third: i iv i V in minor, I IV I V in major.
const progressions = { minor: [[0, 3], [5, 3], [0, 3], [7, 4]], major: [[0, 4], [5, 4], [0, 4], [7, 4]] };

export function synthTrack({ bpm, tonicMidi, mode = "minor", bars = 32, dropBar = 8, leadSeconds = 0, sampleRate = 44100, level = 0.5 }) {
  const beat = 60 / bpm;
  const lead = Math.round(leadSeconds * sampleRate);
  const frames = lead + Math.round(bars * 4 * beat * sampleRate);
  const out = new Float32Array(frames);
  const add = (start, length, fn) => {
    const from = Math.max(0, Math.round(start * sampleRate));
    const to = Math.min(frames, from + Math.round(length * sampleRate));
    for (let i = from; i < to; i++) out[i] += fn((i - from) / sampleRate);
  };
  for (let bar = 0; bar < bars; bar++) {
    const loud = bar >= dropBar;
    const gain = loud ? 1 : 0.22;
    const [degree, third] = progressions[mode][bar % 4];
    const root = tonicMidi + degree;
    for (let b = 0; b < 4; b++) {
      const t = leadSeconds + (bar * 4 + b) * beat;
      // Kick: a falling sine with a click. The first beat of each bar is accented.
      const accent = b === 0 ? 1.25 : 1;
      add(t, 0.22, (x) => gain * accent * 0.9 * Math.sin(2 * Math.PI * (48 * x + 70 * (1 - Math.exp(-x * 30)) / 30)) * Math.exp(-x * 14));
      // Off-beat hat: decaying noise, only after the drop.
      if (loud) add(t + beat / 2, 0.05, (x) => 0.18 * (Math.random() * 2 - 1) * Math.exp(-x * 90));
      // Bass and a chord tone state the harmony.
      add(t, beat * 0.9, (x) => gain * 0.35 * Math.sin(2 * Math.PI * midiHz(root - 24) * x) * Math.min(1, x * 200) * Math.exp(-x * 2));
      for (const interval of [0, third, 7])
        add(t, beat * 0.9, (x) => gain * 0.14 * Math.sin(2 * Math.PI * midiHz(root + interval) * x) * Math.min(1, x * 200));
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < frames; i++) out[i] = (out[i] / peak) * level;
  return encodeWav({ sampleRate, channels: [out, Float32Array.from(out)] });
}
