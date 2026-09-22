// One shared breath. Phase is a function of wall-clock time so every device
// on Earth inhales and exhales together, within clock skew.

export const INHALE_MS = 4000;
export const EXHALE_MS = 4000;
export const CYCLE_MS = INHALE_MS + EXHALE_MS;

export type BreathPhase = 'in' | 'out';

export interface Breath {
  phase: BreathPhase;
  /** 0 = fully exhaled, 1 = fully inhaled. Smooth. */
  fill: number;
}

export function breathAt(ms: number): Breath {
  'worklet';
  const t = ((ms % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  const fill = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / CYCLE_MS);
  return { phase: t < INHALE_MS ? 'in' : 'out', fill };
}
