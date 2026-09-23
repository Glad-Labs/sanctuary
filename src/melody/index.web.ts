// The melody layer: a sparse line written by the arranger as Strudel
// mini-notation and played by Strudel in the browser. The arranger never hands
// us code, only note names and rests, so nothing here evaluates a string.
//
// Strudel is loaded from its own bundle at runtime (the way its docs embed it)
// rather than through Metro, which cannot bundle its AudioWorklet loader.
import type { Melody } from '../arranger/score';
import type { StrudelRepl, StrudelWindow } from '../types/strudel-web';

const BUNDLE = 'https://unpkg.com/@strudel/web@1.3.0';
const ANALYSER = 'sanctuary-melody';

let loading: Promise<StrudelRepl | null> | null = null;
let repl: StrudelRepl | null = null;
let startedAt = 0; // wall-clock seconds when the scheduler's cycle 0 began
let current: Melody | undefined;
let currentLevel = 1;
let samples: Float32Array<ArrayBuffer> | null = null;

const strudel = () => globalThis as unknown as Partial<StrudelWindow>;

function loadBundle(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (strudel().initStrudel) return resolve();
    const tag = document.createElement('script');
    tag.src = BUNDLE;
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error('strudel bundle failed to load'));
    document.head.appendChild(tag);
  });
}

/** Load Strudel and its audio. Call from a user gesture on the web. Resolves false if unavailable. */
export async function initMelody(): Promise<boolean> {
  if (!loading) {
    loading = (async () => {
      try {
        await loadBundle();
        const w = strudel();
        const r = await w.initStrudel!({});
        await w.initAudio!({ disableWorklets: true });
        repl = r;
        return r;
      } catch (e) {
        console.warn('melody layer unavailable', e);
        return null;
      }
    })();
  }
  return (await loading) !== null;
}

function build(melody: Melody, level: number) {
  const w = strudel();
  // Align cycles to the wall clock so every device is at the same point of the melody.
  const phase = (startedAt % melody.cycleSeconds) / melody.cycleSeconds;
  return w
    .note!(melody.notes)
    .s(melody.sound)
    .attack(melody.attack)
    .release(melody.release)
    .lpf(1400)
    .room(0.9)
    .roomsize(7)
    .gain(melody.gain * level)
    .analyze(ANALYSER)
    .early(phase);
}

/** Play a melody (or stop, if none) at the given level 0..1. */
export async function playMelody(melody: Melody | undefined, level: number): Promise<void> {
  if (!(await initMelody()) || !repl) return;
  current = melody;
  currentLevel = level;
  if (!melody) {
    strudel().hush!();
    startedAt = 0;
    return;
  }
  repl.setCps(1 / melody.cycleSeconds);
  if (!repl.scheduler.started || !startedAt) startedAt = Date.now() / 1000;
  build(melody, level).play();
}

/** Follow the tide and the listener's hour without restarting the line. */
export function setMelodyLevel(level: number): void {
  if (!repl || !current || Math.abs(level - currentLevel) < 0.04) return;
  currentLevel = level;
  build(current, level).play();
}

/** What the melody scheduler is doing, for tests. */
export function melodyInfo(): { cps: number | null; cycleSeconds: number | null; started: boolean; notes: string | null } {
  const sch = (repl as unknown as { scheduler?: { cps?: number; started?: boolean } } | null)?.scheduler;
  return { cps: sch?.cps ?? null, cycleSeconds: sch?.cps ? +(1 / sch.cps).toFixed(1) : null, started: !!sch?.started, notes: current?.notes ?? null };
}

/** RMS of the melody layer's output, 0..1, for proving it is sounding. */
export function melodyLevel(): number {
  const w = strudel();
  if (!repl || !w.getAnalyserById) return 0;
  const analyser = w.getAnalyserById(ANALYSER, 1024);
  if (!samples || samples.length !== analyser.fftSize) samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
