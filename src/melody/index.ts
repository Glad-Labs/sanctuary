// The melody layer on native: not yet. Strudel is Web Audio only, so the
// native build plays the strings, the sea and the bowls without it.
import type { Melody } from '../arranger/score';

export async function initMelody(): Promise<boolean> {
  return false;
}
export async function playMelody(_melody: Melody | undefined, _level: number): Promise<void> {}
export function setMelodyLevel(_level: number): void {}
export function melodyLevel(): number {
  return 0;
}
export function melodyInfo(): { cps: number | null; cycleSeconds: number | null; started: boolean; notes: string | null } {
  return { cps: null, cycleSeconds: null, started: false, notes: null };
}
