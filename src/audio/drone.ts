// The planetary drone, made of recorded instruments.
//
// Deterministic and generative: every device computes the same arrangement
// from the same wall-clock time, so nothing is streamed and nothing has to be
// synced. Each voice is a recorded sustain (CC0 orchestral samples) played as
// overlapping, crossfaded instances on a shared schedule, pitched to a slowly
// drifting chord. Listener count sets how many voices are present and how
// often bowls ring. Breath is audible in the sea. Arrivals ring softly.
//
// Everything time-varying is a function of wall-clock seconds (`wall`) and is
// scheduled at an audio-context time (`now`), so the same code renders offline.

import type {
  AnalyserNode,
  AudioBuffer,
  AudioContext,
  AudioParam,
  BiquadFilterNode,
  GainNode,
} from 'react-native-audio-api';
import { breathAt } from '../breath';
import { DEFAULT_SCORE, type Score, type CleanScore } from '../arranger/score';
import { SAMPLES, type SampleDef, type SampleKind } from './manifest';
import { eventsForCycle } from './pattern';

export type Buffers = Map<string, AudioBuffer>;

const TAU = Math.PI * 2;

// ---- musical material -------------------------------------------------------

// Chords, chord length, tide and colour all come from the score (see
// src/arranger/score.ts). DEFAULT_SCORE plays until an arranger says otherwise.
// Voices in the order they join as the room fills. `tones` are chord-tone
// indices a voice may choose between (an octave up where marked), so the
// upper voices wander while staying inside the chord.
interface Role { kinds: ReadonlyArray<SampleKind>; tones: ReadonlyArray<[number, number]>; level: number }
const ROLES: ReadonlyArray<Role> = [
  { kinds: ['bass'], tones: [[0, -12]], level: 0.75 },
  { kinds: ['cello'], tones: [[0, 0]], level: 0.8 },
  { kinds: ['viola'], tones: [[2, 0]], level: 0.7 },
  { kinds: ['violin'], tones: [[3, 0], [4, 0], [5, 0]], level: 0.5 },
  { kinds: ['flute', 'violin'], tones: [[4, 0], [5, 0], [2, 12], [3, 12]], level: 0.38 },
  { kinds: ['cello', 'viola'], tones: [[1, 0]], level: 0.6 },
  { kinds: ['viola', 'violin'], tones: [[2, 0], [3, 0], [4, 0]], level: 0.45 },
];
// Where you sit in the hall: the same performance, balanced for your own hour.
// At your night the sea comes forward and the top voices soften; at your dawn
// it opens. Never changes what is played, only how much of each layer you hear.
export interface LocalBalance { warmth: number; top: number; sea: number; level: number }
const BALANCE: ReadonlyArray<readonly [number, LocalBalance]> = [
  [0, { warmth: 0.6, top: 0.45, sea: 1.8, level: 0.85 }],
  [6, { warmth: 1.05, top: 0.9, sea: 1.15, level: 1 }],
  [12, { warmth: 1, top: 1, sea: 1, level: 1 }],
  [19, { warmth: 0.9, top: 0.85, sea: 1.1, level: 0.97 }],
];
export function localBalance(hour: number): LocalBalance {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < BALANCE.length; i++) {
    const [h0, a] = BALANCE[i];
    const [h1raw, b] = BALANCE[(i + 1) % BALANCE.length];
    const h1 = h1raw <= h0 ? h1raw + 24 : h1raw;
    const hh = h < h0 ? h + 24 : h;
    if (hh >= h0 && hh < h1) {
      const t = 0.5 - 0.5 * Math.cos((Math.PI * (hh - h0)) / (h1 - h0));
      const mix = (x: number, y: number) => x + (y - x) * t;
      return { warmth: mix(a.warmth, b.warmth), top: mix(a.top, b.top), sea: mix(a.sea, b.sea), level: mix(a.level, b.level) };
    }
  }
  return BALANCE[0][1];
}

// The tide: a slow arc of energy, shaped by a slower swell, so the room
// builds, peaks, and recedes. All from the wall clock, bounded by the score.
const SWELL_S = 90 * 60;
export function energyAt(wall: number, tide: CleanScore['tide'] = DEFAULT_SCORE.tide): number {
  const arc = 0.5 - 0.5 * Math.cos((TAU * wall) / (tide.minutes * 60));
  const swell = 0.5 - 0.5 * Math.cos((TAU * wall) / SWELL_S);
  const shape = Math.pow(arc, 1.4) * (0.55 + 0.45 * swell);
  return tide.floor + (tide.peak - tide.floor) * shape;
}
const BOWL_SLOT_S = 30;
const PERIOD_S = 9; // a new instance of each voice every PERIOD_S, crossfaded over FADE_S
const FADE_S = 4;
const MASTER = 1.0;
const MAKEUP = 4.5; // about +13 dB, before the soft limiter
const FADE_IN_S = 14;
// ---- helpers ----------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** A stable pseudo-random number in [0,1) for a given integer key. */
function unit(seed: number, key: number): number {
  return mulberry32((seed ^ Math.imul(key + 1, 2654435761)) >>> 0)();
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const rateFor = (from: number, to: number) => Math.pow(2, (to - from) / 12);

/** How present the room feels, 0..1, on a log scale of listeners. */
export function densityFor(listeners: number): number {
  return clamp01(Math.log10(Math.max(listeners, 40) / 40) / 2.5);
}
/** How many voices a room of this size can reach: two when nearly empty, all seven when packed. */
export function voicesFor(listeners: number): number {
  return 3 + Math.round(densityFor(listeners) * (ROLES.length - 3));
}

function pick(kinds: ReadonlyArray<SampleKind>, midi: number): SampleDef | undefined {
  let best: SampleDef | undefined;
  let bestD = Infinity;
  for (const s of SAMPLES) {
    if (s.midi === undefined || !kinds.includes(s.kind)) continue;
    const d = Math.abs(s.midi - midi);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}
function nearestChordTone(chord: ReadonlyArray<number>, midi: number, from = 0, octaveUp = 0): number {
  let best = chord[from] + octaveUp;
  for (let i = from; i < chord.length; i++) {
    const t = chord[i] + octaveUp;
    if (Math.abs(t - midi) < Math.abs(best - midi)) best = t;
  }
  return best;
}

// A long, dark hall: exponentially decaying noise that loses its highs as it decays.
function impulseResponse(ctx: AudioContext, seconds: number, seed: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const rand = mulberry32(seed + 7 * ch);
    const data = new Float32Array(len);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const p = i / len;
      lp += 0.7 * (1 - 0.8 * p) * (rand() * 2 - 1 - lp);
      data[i] = lp * Math.pow(1 - p, 2.4);
    }
    buffer.copyToChannel(data, ch);
  }
  return buffer;
}

// ---- engine -----------------------------------------------------------------

export interface DroneOptions {
  buffers: Buffers;
  /** Drive `tick` from a timer. Set false to drive it yourself (offline render). */
  autoTick?: boolean;
  /** The listener's local hour, for the balance envelope. Defaults to this device's clock. */
  localHour?: (wall: number) => number;
  /** True on a phone: a lighter hall, no level meter, no per-voice panning. */
  native?: boolean;
}

export interface Drone {
  start(audioNow?: number): void;
  stop(): void;
  /** Advance the arrangement. `wall` is wall-clock seconds, `now` audio-context time. */
  tick(wall: number, now: number): void;
  setListeners(count: number): void;
  /** Hand the engine a new score. It takes effect at score.validFrom, everywhere at once. */
  setScore(score: Score): void;
  /** The score in effect at this moment. */
  score(): CleanScore;
  /** Someone arrived; `count` is the room size now. Rings only for real growth, rarely. */
  join(audioNow?: number, count?: number): void;
  /** RMS of what is reaching the speaker, 0..1. For visuals and for proving sound is flowing. */
  level(): number;
  /** What the engine is doing right now, for the curious and for tests. */
  status(): { listeners: number; density: number; voicesAllowed: number; voicesNow: number; energy: number; shimmer: number; bowlWindow: number; rings: number; bowls: number; calm: number; melodyNotes: number };
}

interface Layer {
  id: string;
  rate: number;
  period: number;
  fade: number;
  phase: number;
  gain: GainNode;
  lastK: number;
  /** Which sample and pitch to use for instance `k` starting at `startWall`. */
  pickAt?: (startWall: number, k: number) => { id: string; rate: number } | undefined;
}

export function createDrone(ctx: AudioContext, room = 'rest', options: DroneOptions): Drone {
  const { buffers } = options;
  const autoTick = options.autoTick ?? true;
  const localHour = options.localHour ?? ((wall: number) => { const d = new Date(wall * 1000); return d.getHours() + d.getMinutes() / 60; });
  const seed = hash(room);
  const rand = mulberry32(seed);

  // The weave: every layer has its own slow, seeded tide of presence, so
  // things drift in and out over minutes instead of all sounding at once.
  // Smooth value noise on the wall clock, identical on every device.
  const weave = (layer: number, wall: number, period: number): number => {
    const x = wall / period + unit(seed, layer) * 1000;
    const i = Math.floor(x);
    const f = x - i;
    const t = f * f * (3 - 2 * f);
    return unit(seed, layer * 7919 + i) * (1 - t) + unit(seed, layer * 7919 + i + 1) * t;
  };

  // master ── analyser
  const master = ctx.createGain();
  master.gain.value = 0;
  // Loudness. The mix is gentle by design, which left it nearly inaudible on
  // a phone speaker. Makeup gain lifts it about ten decibels into a soft
  // limiter (a tanh curve), so the loudest moments round off instead of
  // clipping and the quiet ones simply get louder.
  const makeup = ctx.createGain();
  makeup.gain.value = MAKEUP;
  const limiter = ctx.createWaveShaper();
  const curve = new Float32Array(4096);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.4) / Math.tanh(1.4);
  }
  limiter.curve = curve;
  master.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(ctx.destination);
  const tideGain = ctx.createGain();
  tideGain.gain.value = 0.55;
  tideGain.connect(master);
  const breathGain = ctx.createGain();
  breathGain.gain.value = 1;
  breathGain.connect(tideGain);
  // the level meter is for the web build and tests; on a phone every node
  // costs audio-thread time, so native does without it
  const NATIVE = options.native === true;

  // Smoothly steer a parameter toward a target. Each call would add an
  // automation event that the audio thread must scan every sample, so the
  // previous events are cancelled first and nothing is scheduled at all when
  // the target has barely moved. Keeps the audio thread's work flat over hours.
  const aimed = new Map<AudioParam, number>();
  const aim = (param: AudioParam, target: number, now: number, tau: number) => {
    const last = aimed.get(param);
    if (last !== undefined && Math.abs(target - last) <= Math.max(0.004, Math.abs(last) * 0.015)) return;
    aimed.set(param, target);
    param.cancelScheduledValues(now);
    param.setTargetAtTime(target, now, tau);
  };
  const analyser: AnalyserNode | null = NATIVE ? null : ctx.createAnalyser();
  const samples = new Float32Array(1024);
  if (analyser) {
    analyser.fftSize = 1024;
    master.connect(analyser);
  }

  // dry and wet buses
  const dry = ctx.createGain();
  dry.gain.value = 0.8;
  dry.connect(breathGain);
  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  wet.connect(breathGain);
  // The hall. In a browser or offline it is a convolution with a six-second
  // synthesized impulse. On a phone that convolution starves the audio thread
  // (the sound chops), so native gets a light algorithmic hall instead: four
  // feedback delay lines through a darkening filter, cross-coupled.
  const reverbIn: GainNode = ctx.createGain();
  if (!NATIVE) {
    const conv = ctx.createConvolver();
    conv.buffer = impulseResponse(ctx, 6, seed + 11);
    conv.normalize = true;
    reverbIn.connect(conv);
    conv.connect(wet);
  } else {
    const lines = [0.0297, 0.0371, 0.0411, 0.0437].map((base, i) => {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = base * 3.1 + unit(seed, 900 + i) * 0.01; // 90 to 140 ms
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 2600;
      const fb = ctx.createGain();
      fb.gain.value = 0.86; // a long tail, still stable with the damping
      delay.connect(damp);
      damp.connect(fb);
      fb.connect(delay);
      reverbIn.connect(delay);
      return { delay, damp };
    });
    // cross-couple so the tail turns diffuse rather than metallic
    lines.forEach((l, i) => {
      const x = ctx.createGain();
      x.gain.value = -0.18;
      l.damp.connect(x);
      x.connect(lines[(i + 1) % lines.length].delay);
    });
    const sum = ctx.createGain();
    sum.gain.value = 0.28;
    lines.forEach((l) => l.damp.connect(sum));
    sum.connect(wet);
  }
  const toBoth = (node: { connect: (n: GainNode) => unknown }) => {
    node.connect(dry);
    node.connect(reverbIn);
  };

  // the pad: a warmth filter on the whole string body
  const padFilter: BiquadFilterNode = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.value = 2400;
  padFilter.Q.value = 0.5;
  toBoth(padFilter);

  // the melody: a sparse line above the strings, played by the flute or a
  // violin, in its own soft light and the same hall
  const melodyFilter = ctx.createBiquadFilter();
  melodyFilter.type = 'lowpass';
  melodyFilter.frequency.value = 2600;
  const melodyBus = ctx.createGain();
  melodyBus.gain.value = 0;
  melodyBus.connect(melodyFilter);
  toBoth(melodyFilter);

  // bed: the sea, softened
  const bedFilter = ctx.createBiquadFilter();
  bedFilter.type = 'lowpass';
  bedFilter.frequency.value = 3000;
  toBoth(bedFilter);

  let current: CleanScore = DEFAULT_SCORE;
  let pending: Score | null = null;
  const scoreAt = (wall: number): CleanScore => (pending && wall >= pending.validFrom ? pending : current);

  // A seeded walk through the voicings that never repeats one back to back.
  const chordAt = (wall: number): ReadonlyArray<number> => {
    const sc = scoreAt(wall);
    const n = sc.chords.length;
    const w = Math.floor(wall / sc.chordSeconds);
    const f = (k: number) => Math.floor(unit(seed, k * 3) * n);
    const idx = f(w);
    return sc.chords[idx === f(w - 1) ? (idx + 1) % n : idx];
  };

  let activeVoices = 3;
  let density = 0.5;
  let listeners = 0;
  const voiceState: number[] = ROLES.map(() => 0);
  let last = { voicesNow: 0, energy: 0, shimmer: 0, bowlWindow: 0, calm: 0 };
  let running = false;
  let ticker: ReturnType<typeof setInterval> | undefined;

  function makeLayer(id: string, rate: number, period: number, fade: number, phase: number, dest: GainNode | BiquadFilterNode, pan: number): Layer {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    if (NATIVE) {
      gain.connect(dest); // no per-voice panning on a phone: the hall gives the width
    } else {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner);
      panner.connect(dest);
    }
    return { id, rate, period, fade, phase, gain, lastK: -1 };
  }

  // voice slots
  const slots: Layer[] = ROLES.map((role, s) => {
    const layer = makeLayer(`slot${s}`, 1, PERIOD_S, FADE_S, (s / ROLES.length) * PERIOD_S, padFilter, (rand() - 0.5) * 1.1);
    layer.pickAt = (startWall, k) => {
      const chord = chordAt(startWall);
      // choose a chord tone for this pass, never the same one twice running
      const choice = (n: number) => Math.floor(unit(seed, n * 11 + s) * role.tones.length);
      let c = choice(k);
      if (role.tones.length > 1 && c === choice(k - 1)) c = (c + 1) % role.tones.length;
      const [index, octave] = role.tones[c];
      const target = chord[index] + octave;
      const def = pick(role.kinds, target);
      return def && def.midi !== undefined ? { id: def.id, rate: rateFor(def.midi, target) } : undefined;
    };
    return layer;
  });
  const slotLfo = slots.map(() => ({ period: 31 + rand() * 40, phase: rand() * TAU }));

  // textures and beds
  const textures = [
    makeLayer('cymbal_bow_1', 0.5, 9, 4, 0, padFilter, -0.6),
    makeLayer('cymbal_bow_2', 0.75, 9, 4, 4.5, padFilter, 0.6),
  ];
  const sea = makeLayer('ocean', 1, 22, 5, 0, bedFilter, 0);
  const air = makeLayer('breeze', 1, 22, 5, 11, bedFilter, 0.2); // a breeze with birds, now and then

  /** Schedule instance k of a layer; `at` is audio time, `offset` how far in (wall s) it already is. */
  function scheduleInstance(layer: Layer, k: number, startWall: number, at: number, offset: number) {
    const choice = layer.pickAt ? layer.pickAt(startWall, k) : { id: layer.id, rate: layer.rate };
    if (!choice) return;
    const buffer = buffers.get(choice.id);
    if (!buffer) return;
    const rate = choice.rate;
    const dur = Math.min(layer.period + layer.fade, buffer.duration / rate - 0.05);
    if (offset >= dur) return;
    const fade = Math.min(layer.fade, dur / 2);
    const t0 = at - offset;
    const curve = (x: number) => Math.sin((Math.PI / 2) * Math.min(1, Math.max(0, x)));
    const envAt = (t: number) => (t < fade ? curve(t / fade) : t > dur - fade ? curve((dur - t) / fade) : 1);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const env = ctx.createGain();
    env.gain.setValueAtTime(envAt(offset), at);
    if (offset < fade / 2) env.gain.linearRampToValueAtTime(curve(0.5), t0 + fade / 2);
    if (offset < fade) env.gain.linearRampToValueAtTime(1, t0 + fade);
    if (offset < dur - fade) env.gain.setValueAtTime(1, t0 + dur - fade);
    if (offset < dur - fade / 2) env.gain.linearRampToValueAtTime(curve(0.5), t0 + dur - fade / 2);
    env.gain.linearRampToValueAtTime(0, t0 + dur);
    src.connect(env);
    env.connect(layer.gain);
    src.start(at, offset * rate, (dur - offset) * rate);
  }

  /** Keep a layer's instance schedule running just ahead of `wall`. */
  function advance(layer: Layer, wall: number, now: number, active: boolean) {
    const k = Math.floor((wall - layer.phase) / layer.period);
    for (let kk = Math.max(layer.lastK + 1, k); kk <= k + 1; kk++) {
      const startWall = kk * layer.period + layer.phase;
      if (startWall - wall > 1.5) break;
      layer.lastK = kk;
      if (!active) continue;
      const offset = Math.max(0, wall - startWall);
      scheduleInstance(layer, kk, startWall, now + Math.max(0, startWall - wall), offset);
    }
  }

  function strike(id: string, targetMidi: number | undefined, at: number, level: number, pan: number) {
    const def = SAMPLES.find((s) => s.id === id);
    const buffer = buffers.get(id);
    if (!def || !buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = targetMidi !== undefined && def.midi !== undefined ? rateFor(def.midi, targetMidi) : 1;
    const g = ctx.createGain();
    g.gain.value = level;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    src.connect(g);
    g.connect(panner);
    toBoth(panner);
    src.start(at);
  }

  function melodyNote(midi: number, at: number, seconds: number, m: NonNullable<CleanScore['melody']>) {
    const def = pick(m.sound === 'triangle' ? ['violin'] : ['flute'], midi);
    const buffer = def && buffers.get(def.id);
    if (!def || !buffer || def.midi === undefined) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true; // the sustains are baked loops, so a note can be as long as the pattern says
    src.playbackRate.value = rateFor(def.midi, midi);
    const attack = Math.max(0.3, m.attack);
    const release = Math.max(1, m.release);
    const hold = Math.max(0.2, seconds - attack * 0.5);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(m.gain * 0.9, at + attack);
    env.gain.setValueAtTime(m.gain * 0.9, at + attack + hold);
    env.gain.setTargetAtTime(0, at + attack + hold, release / 3);
    const panner = ctx.createStereoPanner();
    panner.pan.value = 0.5 * Math.sin(midi * 1.7);
    src.connect(env);
    env.connect(panner);
    panner.connect(melodyBus);
    src.start(at);
    src.stop(at + attack + hold + release * 1.5);
    melodyNotes += 1;
  }

  /** Keep the melody scheduled a little ahead of `wall`, on the shared clock. */
  function advanceMelody(sc: CleanScore, wall: number, now: number) {
    const m = sc.melody;
    if (!m) return;
    const cyc = m.cycleSeconds;
    const k0 = Math.floor(wall / cyc);
    for (const k of [k0, k0 + 1]) {
      let events;
      try { events = eventsForCycle(m.notes, k); } catch { return; }
      events.forEach((e, i) => {
        const startWall = (k + e.start) * cyc;
        if (startWall < wall - 0.25 || startWall > wall + 1.5) return;
        const key = `${m.notes}|${k}|${i}`;
        if (scheduledNotes.has(key)) return;
        scheduledNotes.add(key);
        if (scheduledNotes.size > 400) scheduledNotes.delete(scheduledNotes.values().next().value as string);
        melodyNote(e.midi, now + Math.max(0, startWall - wall), e.duration * cyc, m);
      });
    }
  }

  let lastBowlWindow = -1;
  let lastGongWindow = -1;
  let arrivals = 0;
  let lastRing = -Infinity;
  let lastRingListeners = 0;
  let rings = 0;
  let bowls = 0;
  let melodyNotes = 0;
  const scheduledNotes = new Set<string>();

  function tick(wall: number, now: number) {
    if (pending && wall >= pending.validFrom) {
      current = pending;
      pending = null;
    }
    const sc = current;
    const here = localBalance(localHour(wall));
    // the tide sets how much of the room is present right now
    const energy = energyAt(wall, sc.tide);
    const voices = Math.max(2, Math.round(activeVoices * (0.6 + 0.4 * sc.density)));
    // how many voices may sound at once: fewer when the room is small or the
    // tide is out, and fewer still during a spell of calm. Calm spells come
    // around every several minutes; they run deep in a small room and shallow
    // in a full one, so a full room overlaps and flows while a small one rests.
    const calm = 1 - smoothstep(0.3, 0.6, weave(500, wall, 480)); // 1 = a spell of calm
    const restDepth = 0.1 + 0.35 * (1 - density);
    const voicesNow = (1 + energy * (voices - 1) * 0.85) * (1 - restDepth * calm);
    const threshold = 1 - voicesNow / ROLES.length;

    // voices: the floor is always there; every other voice has its own slow
    // tide of presence, and the room and the tide set how many can be above
    // water at once. The cello is favoured a little so the floor is rarely alone.
    slots.forEach((layer, s) => {
      const own = s === 1 ? 0.25 + 0.75 * weave(101, wall, 260) : weave(100 + s, wall, 220 + 50 * s);
      const presence = s === 0 ? 1 : smoothstep(threshold, threshold + 0.3, own);
      advance(layer, wall, now, presence > 0.001);
      const lfo = 0.8 + 0.2 * Math.sin((TAU * wall) / slotLfo[s].period + slotLfo[s].phase);
      const seat = s >= 2 ? here.top : 1; // viola and above soften at your night
      const crowd = s >= 3 ? 0.7 + 0.6 * density : 1; // violins and flute come forward as the room fills
      aim(layer.gain.gain, ROLES[s].level * lfo * presence * seat * crowd, now, 12);
      voiceState[s] = presence;
    });
    last = { ...last, voicesNow: voiceState.reduce((a, b) => a + b, 0), calm };
    // a full room is brighter and more open; an empty one is close and dark
    const warmth = (600 + 1800 * sc.warmth) * here.warmth * (0.55 + 0.75 * density);
    aim(padFilter.frequency, warmth * (0.6 + 0.5 * energy) + 300 * Math.sin((TAU * wall) / 151), now, 3);
    // a full room is a little louder than an empty one
    aim(tideGain.gain, (0.55 + 0.45 * energy) * here.level * (0.6 + 0.4 * density), now, 8);

    // textures: shimmer that only appears as the room fills, near the peak
    const shimmerIn = smoothstep(0.5, 0.8, weave(300, wall, 320)) * (1 - 0.8 * calm);
    const shimmer = (0.005 + 0.16 * clamp01((density - 0.25) / 0.75)) * energy * (0.3 + 1.4 * sc.shimmer) * shimmerIn;
    last = { ...last, energy, shimmer };
    textures.forEach((layer, i) => {
      advance(layer, wall, now, true);
      aim(layer.gain.gain, shimmer * (i === 0 ? 1 : 0.7), now, 6);
    });

    // the melody follows the tide, the listener's hour, the size of the room,
    // and its own tide of presence, like the upper strings
    const melodyIn = smoothstep(0.45, 0.75, weave(400, wall, 330)) * (1 - 0.7 * calm);
    aim(melodyBus.gain, energy * here.top * (0.25 + 0.75 * density) * melodyIn, now, 4);
    advanceMelody(sc, wall, now);

    // beds: the sea breathes with everyone
    const { fill } = breathAt(wall * 1000);
    advance(sea, wall, now, true);
    // the sea is what remains when the tide is out
    // the breeze and its birds drift in now and then, never during calm
    const airIn = smoothstep(0.55, 0.8, weave(600, wall, 400)) * (1 - calm);
    advance(air, wall, now, airIn > 0.001);
    aim(air.gain.gain, 0.022 * airIn, now, 15);
    // the sea is always there
    aim(sea.gain.gain, (0.04 + 0.05 * (1 - energy)) * (0.6 + 0.7 * fill) * (0.4 + 1.2 * sc.sea) * here.sea * (1.5 - 0.8 * density), now, 1.0);
    aim(breathGain.gain, 0.96 + 0.04 * fill, now, 0.8);

    // bowls: the clock is cut into fixed 30 s slots (so the slot number never
    // jumps as the room changes), and each slot rings at most once, with a
    // probability set by how full the room is and where the tide stands.
    // Everyone shares the slot, the roll, and the moment within it.
    const bowlWindow = (95 - 65 * density) * (1.6 - 0.8 * energy) * (1.7 - 1.2 * sc.bowls);
    last.bowlWindow = bowlWindow;
    const slot = Math.floor(wall / BOWL_SLOT_S);
    if (slot !== lastBowlWindow) {
      const rings = unit(seed, slot * 5) < BOWL_SLOT_S / bowlWindow;
      const at = unit(seed, slot * 5 + 1) * (BOWL_SLOT_S - 8);
      if (rings && wall - slot * BOWL_SLOT_S >= at) {
        lastBowlWindow = slot;
        bowls += 1;
        const chord = chordAt(wall);
        const target = nearestChordTone(chord, 62 + (unit(seed, slot * 5 + 2) - 0.5) * 6, 2);
        strike('bowl_1', target, now, (0.1 + 0.08 * unit(seed, slot * 5 + 3)) * (0.5 + 0.5 * density), unit(seed, slot * 5 + 4) * 1.2 - 0.6);
      } else if (!rings || wall - slot * BOWL_SLOT_S >= at) {
        lastBowlWindow = slot; // this slot is settled: silent, or already past its moment
      }
    }
    // gongs: rare, very soft, on the root
    const gw = Math.floor(wall / 240);
    if (gw !== lastGongWindow && wall - gw * 240 >= unit(seed, gw * 7) * 200) {
      lastGongWindow = gw;
      const chord = chordAt(wall);
      const id = gw % 2 === 0 ? 'gong_soft' : 'gong_55';
      const root = id === 'gong_soft' ? nearestChordTone(chord, 49.6) : chord[0];
      strike(id, root, now, 0.12, unit(seed, gw * 7 + 1) * 0.8 - 0.4);
    }
  }

  return {
    start(audioNow = ctx.currentTime) {
      if (running) return;
      running = true;
      master.gain.setValueAtTime(0, audioNow);
      master.gain.linearRampToValueAtTime(MASTER, audioNow + FADE_IN_S);
      if (autoTick) {
        tick(Date.now() / 1000, ctx.currentTime);
        ticker = setInterval(() => tick(Date.now() / 1000, ctx.currentTime), 200);
      }
    },
    stop() {
      if (!running) return;
      running = false;
      if (ticker) clearInterval(ticker);
      master.gain.setTargetAtTime(0, ctx.currentTime, 1.5);
    },
    tick,
    setListeners(count) {
      listeners = count;
      activeVoices = voicesFor(count);
      density = densityFor(count);
    },
    status() {
      return { listeners, density: +density.toFixed(2), voicesAllowed: activeVoices, voicesNow: +last.voicesNow.toFixed(2), energy: +last.energy.toFixed(2), shimmer: +last.shimmer.toFixed(3), bowlWindow: Math.round(last.bowlWindow), rings, bowls, calm: +last.calm.toFixed(2), melodyNotes };
    },
    setScore(score) {
      if (score.validFrom <= Date.now() / 1000 && autoTick) current = score;
      else pending = score;
    },
    score() {
      return current;
    },
    join(audioNow = ctx.currentTime, count = listeners) {
      if (!running) return;
      // A chime marks the room actually growing, not the count wobbling: the
      // room must be larger than it was at the last chime, by a person or two
      // percent, and chimes are at least 30 s apart when full, 90 s when empty.
      arrivals += 1;
      const grown = count >= lastRingListeners + Math.max(1, Math.ceil(lastRingListeners * 0.02));
      if (!grown || audioNow - lastRing < 30 + 60 * (1 - density)) return;
      lastRing = audioNow;
      lastRingListeners = count;
      rings += 1;
      const chord = chordAt(Date.now() / 1000);
      const target = nearestChordTone(chord, 64 + (Math.random() - 0.5) * 8, 2, 12);
      strike('vibra_ring', target, audioNow, (0.035 + Math.random() * 0.03) * (0.4 + 0.6 * density), Math.random() * 1.2 - 0.6);
    },
    level() {
      if (!analyser) return 0;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      return Math.sqrt(sum / samples.length);
    },
  };
}
