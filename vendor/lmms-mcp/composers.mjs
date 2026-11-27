export const composerProfiles = {
  grieg: {
    id: 'grieg', name: 'Grieg — Mountain Crossing', reference: 'Edvard Grieg',
    tags: ['folklore', 'dance', 'mountain', 'exploration'],
    technique: 'Put a lilting modal tune over an open-fifth drone with short accented pickups.',
    use: 'Mountain routes and folklore encounters.', patchId: 'relay-bell',
    harmony: [[0,3,7,10],[0,5,7,9],[0,3,7,10],[0,2,7,9]],
    motif: [[0,0,20,86],[33,1,10,65],[48,2,32,87],[96,3,16,81],[120,2,19,74],[158,1,12,67],[174,0,12,73]],
    drums: false,
  },
  satie: {
    id: 'satie', name: 'Satie — Empty Arcade', reference: 'Erik Satie',
    tags: ['sparse', 'quiet', 'hub', 'ambient'],
    technique: 'Alternate a low anchor with soft upper chords and leave room between melodic attacks.',
    use: 'Quiet hubs, pause screens and abandoned spaces.', patchId: 'ember-organ',
    harmony: [[0,4,7,11],[-3,0,4,7],[-5,-1,2,5],[-3,0,4,7]],
    motif: [[36,3,45,67],[104,2,33,57],[153,1,25,53]],
    drums: false,
  },
  'rimsky-korsakov': {
    id: 'rimsky-korsakov', name: 'Rimsky-Korsakov — Palace of Sparks', reference: 'Nikolai Rimsky-Korsakov',
    tags: ['orchestration', 'register', 'fantasy', 'colour'],
    technique: 'Pass a running figure between high and low registers while sustained harmony holds the scene together.',
    use: 'Fantasy reveals, magical machinery and boss entrances.', patchId: 'relay-bell',
    harmony: [[0,3,6,9],[1,4,7,10],[3,6,9,12],[1,4,7,10]],
    motif: [[0,0,10,81],[12,1,10,73],[24,2,11,79],[36,3,17,90],[96,3,10,83],[108,2,10,70],[120,1,10,74],[132,0,14,84]],
    drums: false,
  },
  "handel": {
    id: "handel",
    name: "Handel — Processional Fanfare",
    reference: "George Frideric Handel",
    tags: ["baroque","victory","ceremony","fanfare"],
    technique: "A dotted call answered by the upper register, with a firm dominant-to-tonic arrival.",
    use: "Victory stingers and royal districts.",
    patchId: "relay-bell",
    harmony: [[0,4,7,12],[5,9,12,17],[7,11,14,19],[0,4,7,12]],
    motif: [[0,0,30,90],[36,2,10,70],[48,3,36,93],[96,2,24,81],[132,1,10,69],[144,0,39,89]],
    drums: false,
  },
  "debussy": {
    id: "debussy",
    name: "Debussy — Lantern Water",
    reference: "Claude Debussy",
    tags: ["atmosphere","exploration","whole-tone","ambient"],
    technique: "Use a whole-tone melody, parallel sonorities and long gaps between attacks.",
    use: "Ruins, underwater maps and quiet exploration.",
    patchId: "ember-organ",
    harmony: [[0,4,8,12],[2,6,10,14],[4,8,12,16],[2,6,10,14]],
    motif: [[9,0,28,63],[51,2,38,70],[110,1,23,51],[147,3,27,58]],
    drums: false,
  },
  "bach": {
    id: "bach",
    name: "Bach — Two-Voice Pursuit",
    reference: "Johann Sebastian Bach",
    tags: ["counterpoint","baroque","puzzle","chase"],
    technique: "Repeat the upper voice’s rhythm as a delayed answer in the lower voice over a moving harmonic sequence.",
    use: "Puzzle rooms and procedural chase cues.",
    patchId: "relay-bell",
    harmony: [[0,3,7,12],[-5,-2,2,7],[-2,2,5,10],[-5,-1,2,7]],
    motif: [[0,0,18,82],[24,1,18,76],[48,2,20,85],[72,1,18,71],[96,3,20,88],[120,2,18,76],[144,1,18,74],[168,0,18,79]],
    drums: false,
  },
  "beethoven": {
    id: "beethoven",
    name: "Beethoven — Motive Under Pressure",
    reference: "Ludwig van Beethoven",
    tags: ["tension","boss","motif","development"],
    technique: "Develop an original short–long cell through displacement, register and stronger cadences.",
    use: "Boss reveals and rising danger.",
    patchId: "fuse-pluck",
    harmony: [[0,3,7,12],[-4,0,3,8],[-2,2,5,10],[-5,-1,2,7]],
    motif: [[0,0,12,92],[21,2,32,95],[72,1,9,71],[87,3,22,86],[126,0,12,91],[150,2,32,94]],
    drums: true,
  },
  "mozart": {
    id: "mozart",
    name: "Mozart — Clockwork Court",
    reference: "Wolfgang Amadeus Mozart",
    tags: ["classical","town","humour","phrasing"],
    technique: "Balance question and answer phrases over a broken-chord accompaniment with a light cadence.",
    use: "Town hubs, comic encounters and inventory screens.",
    patchId: "relay-bell",
    harmony: [[0,4,7,12],[7,11,14,19],[5,9,12,17],[0,4,7,12]],
    motif: [[0,0,21,76],[24,1,16,71],[48,2,33,81],[98,3,13,72],[120,2,15,76],[144,1,17,71],[168,0,17,77]],
    drums: false,
  },
  "jrpg-battle": {
    id: "jrpg-battle",
    name: "16-bit JRPG Battle",
    reference: "Nobuo Uematsu",
    tags: ["jrpg","japanese","battle","syncopated","boss"],
    technique: "Build an original minor-key ostinato with offbeat attacks, a chromatic dominant turn and a higher-register answer.",
    use: "Fast battles and arcade boss phases.",
    patchId: "fuse-pluck",
    harmony: [[0,3,7,12],[-4,0,3,8],[-2,2,5,10],[-5,-1,2,7]],
    motif: [[0,0,14,94],[35,2,11,71],[71,1,14,84],[95,3,8,67],[131,2,16,91],[166,1,8,72]],
    drums: true,
  },
  "additive-pulse": {
    id: "additive-pulse",
    name: "Additive Pulse",
    reference: "Philip Glass",
    tags: ["minimalism","ostinato","puzzle","industrial"],
    technique: "Keep the pulse steady and change the cell length so accents shift against the bar.",
    use: "Factory puzzles and gradually intensifying exploration.",
    patchId: "ember-organ",
    harmony: [[0,3,7,12],[0,3,7,12],[-4,0,3,8],[-5,-1,2,7]],
    motif: [[0,0,15,80],[24,1,15,68],[48,2,15,74],[72,0,15,80],[96,1,15,68],[120,2,15,74],[144,3,15,81],[168,2,15,69]],
    drums: false,
  },
  "holst": {
    id: "holst",
    name: "Holst — Uneven March",
    reference: "Gustav Holst",
    tags: ["march","odd-accent","rts","boss"],
    technique: "Group attacks in fives across a 4/4 grid, with low pedal tones and upper-register answers.",
    use: "RTS mobilisation and heavy enemy encounters.",
    patchId: "sub-pressure",
    harmony: [[0,3,7,12],[-2,1,5,10],[-4,0,3,8],[-5,-1,2,7]],
    motif: [[0,0,18,96],[24,0,10,76],[48,2,14,90],[72,1,17,82],[96,0,12,76],[120,3,19,95],[144,2,10,72],[168,1,13,80]],
    drums: true,
  },
};

export function describeProfile({ harmony, motif, drums, ...description }) {
  return description;
}

export function composeProfile(profile, { root, bars }) {
  const notes = (tick, midi, length, velocity) => ({ tick, midi, length, velocity });
  const additive = profile.id === 'additive-pulse';
  const voice = (name, tone, volume, compose) => ({
    name, voice: tone, volume,
    patterns: Array.from({ length: bars }, (_, bar) => ({
      name: profile.name + ' ' + (bar + 1), bar, bars: 1,
      notes: compose(profile.harmony[bar % profile.harmony.length].map(interval => root + interval), bar),
    })),
  });
  const lead = voice('Motif', 'pluck', 44, (chord, bar) => {
    const motif = additive ? profile.motif.map(([tick, degree, duration], step) => {
      const cell = bar % 4 < 2 ? [0, 1, 2] : [0, 1, 2, 3, 2];
      const position = (bar * 8 + step) % cell.length;
      return [tick, cell[position], duration, position === 0 ? 84 : 65];
    }) : profile.motif;
    return motif.filter(([tick]) => profile.id !== 'rimsky-korsakov' || tick < 96).map(([tick, degree, duration, velocity]) =>
      notes(tick + (profile.id === 'beethoven' && bar % 2 ? 6 : 0), chord[degree] + (profile.id === 'jrpg-battle' && bar === 2 ? 12 : 0), duration, velocity));
  });
  const counter = voice('Bass and answer', 'bass', 34, (chord, bar) => {
    if (profile.id === 'bach') return profile.motif.slice(0, 6).map(([tick, degree, duration, velocity]) =>
      notes(tick + 48, chord[degree] - 12, duration, velocity - 12));
    if (profile.id === 'mozart') return [0, 2, 1, 2, 0, 2, 1, 2].map((degree, i) => notes(i * 24, chord[degree] - 12, 19, 62));
    if (profile.id === 'grieg') return [notes(0, chord[0] - 12, 158, 79), notes(0, chord[2] - 12, 158, 64)];
    if (profile.id === 'satie') return [notes(0, chord[0] - 12, 83, 57)];
    if (profile.id === 'rimsky-korsakov') return profile.motif.filter(([tick]) => tick >= 96)
      .map(([tick, degree, duration, velocity]) => notes(tick, chord[degree] - 12, duration, velocity));
    return [notes(0, chord[0] - 12, 68, 79), notes(96, chord[bar % 2 ? 2 : 0] - 12, 65, 67)];
  });
  const harmony = voice('Harmony', 'pad', 24, chord => chord.slice(1, 3).map(pitch =>
    profile.id === 'satie' ? notes(48, pitch, 114, 48) : notes(0, pitch, 142, 59)));
  const tracks = [lead, counter, harmony];
  if (profile.drums) {
    tracks.push(voice('Kick', 'kick', 54, (_, bar) => {
      const ticks = profile.id === 'holst'
        ? Array.from({ length: 16 }, (_, step) => step).filter(step => (bar * 16 + step) % 5 === 0).map(step => step * 12)
        : [0, 71, 96, 144];
      return ticks.map(tick => notes(tick, 69, Math.min(15, 192 - tick), 87));
    }));
    tracks.push(voice('Clap', 'clap', 33, () => [48, 144].map(tick => notes(tick, 69, 12, 79))));
  }
  return tracks;
}
