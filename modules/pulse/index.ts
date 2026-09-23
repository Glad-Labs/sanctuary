import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

type PulseModule = {
  pulse(ms: number, amplitude: number): Promise<boolean>;
  startTicks(intervalMs: number): void;
  stopTicks(): void;
  addListener(event: 'tick', listener: (event: { t: number }) => void): { remove(): void };
};
const native = Platform.OS === 'android' ? requireOptionalNativeModule<PulseModule>('Pulse') : null;

/** A short vibration, sent as media vibration so it is not dropped as touch feedback. Fire and forget. */
export function pulse(ms: number, amplitude = 160): void {
  native?.pulse(Math.round(ms), Math.round(amplitude)).catch(() => {});
}

export type Every = (fn: () => void, ms: number) => () => void;

/**
 * A clock that keeps going with the screen off. React Native pauses its own
 * timers whenever the activity is paused, so on Android everything that must
 * keep time (the engine's scheduler, the breath, presence, the score poll)
 * runs off one native tick stream instead. Elsewhere it is setInterval.
 */
const TICK_MS = 100;
const jobs = new Set<{ fn: () => void; ms: number; next: number }>();
let ticking = false;
function ensureTicking() {
  if (ticking || !native) return;
  ticking = true;
  native.addListener('tick', ({ t }) => {
    for (const job of jobs) {
      if (t >= job.next) {
        job.next = t + job.ms;
        try {
          job.fn();
        } catch (e) {
          console.warn('clock job failed', e);
        }
      }
    }
  });
  native.startTicks(TICK_MS);
}

export const every: Every = (fn, ms) => {
  if (!native) {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }
  const job = { fn, ms, next: Date.now() + ms };
  jobs.add(job);
  ensureTicking();
  return () => {
    jobs.delete(job);
  };
};

/** True when the clock is native and keeps running with the screen off. */
export const clockIsNative = native !== null;
