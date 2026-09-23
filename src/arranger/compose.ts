// The composer: a deterministic arranger with no model behind it. It is the
// draft the model refines, and the whole arranger when the server is away.
// Pure function of the inputs, so every offline device writes the same score.
import { roomInputs, type RoomInputs } from './inputs';
import { DEFAULT_SCORE, type Score, type CleanScore } from './score';

const NIGHT_CHORDS = [
  [42, 49, 54, 57, 61, 64], // F#m add9   low and dark
  [38, 45, 50, 54, 57, 64], // D add9
  [45, 52, 57, 61, 64, 71], // A add9
  [40, 47, 52, 56, 59, 66], // E add9
  [47, 54, 59, 62, 66, 69], // Bm7
  [42, 49, 54, 59, 61, 66], // F#m9
];
const BRIGHT_CHORDS = [
  [45, 52, 57, 61, 64, 71], // A add9
  [47, 54, 59, 62, 66, 73], // Bm7 add9
  [40, 47, 52, 56, 59, 66], // E add9
  [38, 45, 50, 54, 57, 61], // Dmaj7
  [49, 56, 61, 64, 68, 71], // C#m7
  [40, 45, 52, 57, 61, 64], // A/E
  [45, 52, 57, 61, 64, 68], // Amaj7
];

export const SCORE_INTERVAL_S = 600;
const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));
const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const noteName = (midi: number) => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** A sparse melody from the upper tones of the first voicing: sixteen steps, mostly rests. */
function composeMelody(chords: number[][], slot: number, quiet: number, crowd: number): CleanScore['melody'] {
  const upper = chords[0].slice(2).map((n) => (n < 64 ? n + 12 : n)); // lift above middle C
  const order = [0, 3, 1, 2].map((i) => upper[(i + slot) % upper.length]);
  const steps = new Array<string>(16).fill('~');
  [0, 5, 9, 13].forEach((pos, i) => { steps[pos] = noteName(order[i]); });
  return {
    notes: steps.join(' '),
    cycleSeconds: Math.round(lerp(40, 60, quiet) * lerp(1.5, 1, crowd)),
    sound: quiet > 0.5 ? 'sine' : 'triangle',
    attack: lerp(2, 4, quiet),
    release: lerp(6, 9, quiet),
    gain: lerp(0.32, 0.22, quiet),
  };
}

export function compose(inputs: RoomInputs): CleanScore {
  // The room has no night of its own. What it has is people, each in their own
  // hour: `quiet` is how much of the room is in its night or early morning.
  const { night, morning, evening } = inputs.room;
  const quiet = Math.min(1, night + 0.5 * morning);
  const full = inputs.moon.illumination;
  const crowd = Math.min(1, Math.log10(Math.max(inputs.listeners, 40) / 40) / 2.5);
  const chords = quiet > 0.45 ? NIGHT_CHORDS : evening > 0.5 ? BRIGHT_CHORDS : DEFAULT_SCORE.chords;
  const mood = quiet > 0.45 ? 'Night' : evening > 0.5 ? 'Open' : 'Still';
  return {
    title: `${mood} water over ${inputs.dawnCity}`,
    reasoning: `Composed without a model: ${Math.round(night * 100)}% of the room in its night, ${Math.round(evening * 100)}% in evening, ${inputs.moon.name}, dawn over ${inputs.dawnCity}.`,
    chords,
    // a small room moves slowly; a full one a little faster
    chordSeconds: Math.round(lerp(56, 96, quiet) * lerp(1.6, 1, crowd)),
    tide: { minutes: Math.round(lerp(18, 30, quiet)), floor: lerp(0.08, 0.02, quiet), peak: lerp(1, 0.75, quiet) },
    warmth: lerp(0.65, 0.35, quiet),
    density: lerp(0.5, 0.9, crowd),
    sea: lerp(0.4, 0.75, quiet),
    shimmer: lerp(0.3, 0.8, full),
    bowls: lerp(0.35, 0.75, full),
    melody: composeMelody(chords, Math.floor(inputs.at / SCORE_INTERVAL_S), quiet, crowd),
  };
}

/** The score every offline device agrees on for this ten-minute slot. */
export function composedScore(nowMs: number = Date.now()): Score {
  const slot = Math.floor(nowMs / 1000 / SCORE_INTERVAL_S) * SCORE_INTERVAL_S;
  return { ...compose(roomInputs(slot * 1000)), validFrom: slot, ttl: SCORE_INTERVAL_S, source: 'composer' };
}
