// One shared breath. Phase is a function of wall-clock time so every device
// on Earth inhales and exhales together, within clock skew.
//
// Five seconds in, five out: the pace of a resting breath (six a minute), the
// rate slow-breathing practices settle on. The curve eases hard into both
// ends, so there is a natural pause at the top and at the bottom rather than
// a metronome turning around.

export const INHALE_MS = 5000;
export const EXHALE_MS = 5000;
export const CYCLE_MS = INHALE_MS + EXHALE_MS;

export type BreathPhase = 'in' | 'out';

export interface Breath {
  phase: BreathPhase;
  /** 0 = fully exhaled, 1 = fully inhaled. Smooth, with rests at both ends. */
  fill: number;
}

function ease(x: number): number {
  'worklet';
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10); // zero speed and acceleration at both ends
}

export function breathAt(ms: number): Breath {
  'worklet';
  const t = ((ms % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  if (t < INHALE_MS) return { phase: 'in', fill: ease(t / INHALE_MS) };
  return { phase: 'out', fill: 1 - ease((t - INHALE_MS) / EXHALE_MS) };
}
