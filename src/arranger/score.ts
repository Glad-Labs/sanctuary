// The score: what the arranger writes and the engine reads. One per room,
// shared by every device, applied at `validFrom` so everyone changes together.
import { z } from 'zod';

// Loose shape handed to the model as the output format. Constraints live in
// `sanitize`, because a strict local check is what keeps bad output out of the speakers.
export const ScoreShape = z.object({
  title: z.string().describe('A name for this passage. At most six words. No religion, no brand names.'),
  reasoning: z.string().describe('One sentence on why this passage fits the room right now.'),
  chords: z
    .array(z.array(z.number()))
    .describe('Three to eight voicings. Each is six ascending MIDI notes, low to high, between 33 and 84.'),
  chordSeconds: z.number().describe('Seconds each voicing lasts before drifting to the next. 32 to 180.'),
  tide: z.object({
    minutes: z.number().describe('Length of one build-and-recede arc. 6 to 60.'),
    floor: z.number().describe('Energy at low tide, 0 to 0.6. Near 0 leaves only the sea and one cello.'),
    peak: z.number().describe('Energy at high tide, 0.4 to 1.'),
  }),
  warmth: z.number().describe('0 dark and muffled, 1 open and bright.'),
  density: z.number().describe('0 sparse, 1 as many voices as the room allows.'),
  sea: z.number().describe('How present the sea is, 0 to 1.'),
  shimmer: z.number().describe('Bowed-metal shimmer near high tide, 0 to 1.'),
  bowls: z.number().describe('How often a singing bowl rings, 0 rare to 1 often.'),
  melody: z
    .object({
      notes: z
        .string()
        .describe(
          'A slow melody in Strudel mini-notation: lowercase note names with octave (a3 to b5) and ~ for rests, 8 to 16 steps, mostly rests, only tones of the voicings above. Example: "a4 ~ ~ e5 ~ c#5 ~ ~ b4 ~ ~ ~ e5 ~ ~ ~"',
        ),
      cycleSeconds: z.number().describe('Seconds for one pass through the melody. 24 to 64.'),
      sound: z.string().describe('sine or triangle.'),
      attack: z.number().describe('Seconds each note takes to bloom. 1 to 6.'),
      release: z.number().describe('Seconds each note takes to fade. 2 to 12.'),
      gain: z.number().describe('0 silent to 1 present. Usually 0.2 to 0.5.'),
    })
    .optional()
    .describe('A sparse melody floating above the strings. Omit for none.'),
});
export type ScoreBody = z.infer<typeof ScoreShape>;
export type Melody = NonNullable<ScoreBody['melody']> & { sound: 'sine' | 'triangle' };
/** A score that has been through sanitize(): the only kind the engine plays. */
export type CleanScore = Omit<ScoreBody, 'melody'> & { melody?: Melody };

export interface Score extends CleanScore {
  /** Unix seconds. Devices switch to this score at this moment, together. */
  validFrom: number;
  /** Seconds this score is meant to last. */
  ttl: number;
  source: 'model' | 'composer';
  model?: string;
}

export const DEFAULT_SCORE: CleanScore = {
  title: 'Still water',
  reasoning: 'The default passage: A major, wide and slow.',
  chords: [
    [45, 52, 57, 61, 64, 71], // A add9
    [42, 49, 54, 57, 64, 71], // F#m11
    [38, 45, 50, 54, 57, 64], // D add9
    [40, 47, 52, 56, 59, 66], // E add9
    [47, 54, 59, 62, 66, 69], // Bm7
    [49, 56, 61, 64, 68, 71], // C#m7
    [40, 45, 52, 57, 61, 64], // A/E
    [38, 45, 50, 54, 57, 61], // Dmaj7
  ],
  chordSeconds: 64,
  melody: { notes: 'a4 ~ ~ e5 ~ c#5 ~ ~ b4 ~ ~ ~ e5 ~ ~ ~', cycleSeconds: 48, sound: 'sine', attack: 2.5, release: 6, gain: 0.3 },
  tide: { minutes: 20, floor: 0.05, peak: 1 },
  warmth: 0.55,
  density: 0.7,
  sea: 0.5,
  shimmer: 0.5,
  bowls: 0.5,
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));

/** Make one voicing playable: six ascending notes in range, no clusters. Null if it cannot be. */
export function sanitizeChord(notes: unknown): number[] | null {
  if (!Array.isArray(notes)) return null;
  const clean = [...new Set(notes.map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n)))]
    .filter((n) => n >= 33 && n <= 84)
    .sort((a, b) => a - b);
  // drop any note within two semitones of the one below it (a cluster, not a chord)
  const spaced: number[] = [];
  for (const n of clean) if (spaced.length === 0 || n - spaced[spaced.length - 1] >= 3) spaced.push(n);
  if (spaced.length < 4) return null;
  // fill to six by doubling notes an octave up, keeping the spacing rule
  while (spaced.length < 6) {
    const candidate = spaced.map((n) => n + 12).find((c) => c <= 84 && spaced.every((x) => Math.abs(x - c) >= 3));
    if (candidate === undefined) return null;
    spaced.push(candidate);
    spaced.sort((a, b) => a - b);
  }
  return spaced.slice(0, 6);
}

const NOTE_NAME = /[a-g][#b]?[2-6]/g;
const TOKEN = /^(~|[a-g][#b]?[2-6])([*/@]\d+(\.\d+)?|!|\?)*$/;
const PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
function pitchClass(name: string): number {
  const base = PITCH[name[0]];
  const acc = name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0;
  return (base + acc + 12) % 12;
}

/**
 * Make a melody safe and consonant: mini-notation only (never code), balanced
 * brackets, and every note a tone of one of the score's voicings. Notes outside
 * the voicings become rests. Null if nothing playable is left.
 */
export function sanitizeMelody(input: unknown, chords: number[][]): Melody | null {
  if (!input || typeof input !== 'object') return null;
  const m = input as Record<string, unknown>;
  let notes = String(m.notes ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!notes || notes.length > 240) return null;
  if (!/^[a-g#b0-9~ [\]<>*/@!?.,]*$/.test(notes)) return null;
  const depth = (open: string, close: string) => {
    let d = 0;
    for (const ch of notes) { if (ch === open) d++; else if (ch === close && --d < 0) return -1; }
    return d;
  };
  if (depth('[', ']') !== 0 || depth('<', '>') !== 0) return null;
  const tokens = notes.replace(/[[\]<>,]/g, ' ').split(' ').filter(Boolean);
  if (tokens.length === 0 || tokens.length > 32 || !tokens.every((t) => TOKEN.test(t))) return null;
  const allowed = new Set(chords.flat().map((n) => n % 12));
  notes = notes.replace(NOTE_NAME, (name) => (allowed.has(pitchClass(name)) ? name : '~'));
  if ((notes.match(NOTE_NAME) ?? []).length < 2) return null;
  const sound = m.sound === 'triangle' ? 'triangle' : 'sine';
  return {
    notes,
    cycleSeconds: clamp(Number(m.cycleSeconds), 24, 64),
    sound,
    attack: clamp(Number(m.attack), 1, 6),
    release: clamp(Number(m.release), 2, 12),
    gain: clamp(Number(m.gain), 0, 1),
  };
}

/** Validate and clamp anything claiming to be a score. Returns null if it is unusable. */
export function sanitize(input: unknown): CleanScore | null {
  const parsed = ScoreShape.safeParse(input);
  if (!parsed.success) return null;
  const b = parsed.data;
  const chords = b.chords.map(sanitizeChord).filter((c): c is number[] => c !== null);
  if (chords.length < 3) return null;
  return {
    title: b.title.trim().split(/\s+/).slice(0, 8).join(' ').slice(0, 60) || DEFAULT_SCORE.title,
    reasoning: b.reasoning.trim().slice(0, 300),
    chords: chords.slice(0, 8),
    chordSeconds: clamp(b.chordSeconds, 32, 180),
    tide: {
      minutes: clamp(b.tide.minutes, 6, 60),
      floor: clamp(b.tide.floor, 0, 0.6),
      peak: clamp(b.tide.peak, Math.max(0.4, clamp(b.tide.floor, 0, 0.6) + 0.2), 1),
    },
    warmth: clamp(b.warmth, 0, 1),
    density: clamp(b.density, 0, 1),
    sea: clamp(b.sea, 0, 1),
    shimmer: clamp(b.shimmer, 0, 1),
    bowls: clamp(b.bowls, 0, 1),
    melody: sanitizeMelody(b.melody, chords) ?? undefined,
  };
}
