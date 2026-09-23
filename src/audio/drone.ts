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
  BiquadFilterNode,
  GainNode,
} from 'react-native-audio-api';
import { breathAt } from '../breath';
import { DEFAULT_SCORE, type Score, type CleanScore } from '../arranger/score';
import { SAMPLES, type SampleDef, type SampleKind } from './manifest';

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
const rateFor = (from: number, to: number) => Math.pow(2, (to - from) / 12);

/** How present the room feels, 0..1, on a log scale of listeners. */
export function densityFor(listeners: number): number {
  return clamp01(Math.log10(Math.max(listeners, 40) / 40) / 2.5);
}
/** How many voices a room of this size can reach: two when nearly empty, all seven when packed. */
export function voicesFor(listeners: number): number {
  return 2 + Math.round(densityFor(listeners) * (ROLES.length - 2));
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
  status(): { listeners: number; density: number; voicesAllowed: number; voicesNow: number; energy: number; shimmer: number; bowlWindow: number; rings: number; bowls: number };
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

  // master ── analyser
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  const tideGain = ctx.createGain();
  tideGain.gain.value = 0.55;
  tideGain.connect(master);
  const breathGain = ctx.createGain();
  breathGain.gain.value = 1;
  breathGain.connect(tideGain);
  const analyser: AnalyserNode = ctx.createAnalyser();
  analyser.fftSize = 1024;
  master.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  // dry and wet buses
  const dry = ctx.createGain();
  dry.gain.value = 0.8;
  dry.connect(breathGain);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulseResponse(ctx, 6, seed + 11);
  reverb.normalize = true;
  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  reverb.connect(wet);
  wet.connect(breathGain);
  const toBoth = (node: { connect: (n: GainNode | typeof reverb) => unknown }) => {
    node.connect(dry);
    node.connect(reverb);
  };

  // the pad: a warmth filter on the whole string body
  const padFilter: BiquadFilterNode = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.value = 2400;
  padFilter.Q.value = 0.5;
  toBoth(padFilter);

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
  let last = { voicesNow: 0, energy: 0, shimmer: 0, bowlWindow: 0 };
  let running = false;
  let ticker: ReturnType<typeof setInterval> | undefined;

  function makeLayer(id: string, rate: number, period: number, fade: number, phase: number, dest: GainNode | BiquadFilterNode, pan: number): Layer {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    gain.connect(panner);
    panner.connect(dest);
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

  let lastBowlWindow = -1;
  let lastGongWindow = -1;
  let arrivals = 0;
  let lastRing = -Infinity;
  let lastRingListeners = 0;
  let rings = 0;
  let bowls = 0;

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
    const voicesNow = 1 + energy * (voices - 1);

    // voices: enter with the tide and the room, low to high
    slots.forEach((layer, s) => {
      advance(layer, wall, now, s < Math.ceil(voicesNow));
      const lfo = 0.8 + 0.2 * Math.sin((TAU * wall) / slotLfo[s].period + slotLfo[s].phase);
      const presence = clamp01(voicesNow - s); // the newest voice fades in with the tide
      const seat = s >= 2 ? here.top : 1; // viola and above soften at your night
      const crowd = s >= 3 ? 0.7 + 0.6 * density : 1; // violins and flute come forward as the room fills
      layer.gain.gain.setTargetAtTime(ROLES[s].level * lfo * presence * seat * crowd, now, 6);
    });
    // a full room is brighter and more open; an empty one is close and dark
    const warmth = (600 + 1800 * sc.warmth) * here.warmth * (0.55 + 0.75 * density);
    padFilter.frequency.setTargetAtTime(warmth * (0.6 + 0.5 * energy) + 300 * Math.sin((TAU * wall) / 151), now, 3);
    // a full room is a little louder than an empty one
    tideGain.gain.setTargetAtTime((0.55 + 0.45 * energy) * here.level * (0.5 + 0.5 * density), now, 8);

    // textures: shimmer that only appears as the room fills, near the peak
    const shimmer = (0.005 + 0.16 * clamp01((density - 0.25) / 0.75)) * energy * (0.3 + 1.4 * sc.shimmer);
    last = { ...last, voicesNow, energy, shimmer };
    textures.forEach((layer, i) => {
      advance(layer, wall, now, true);
      layer.gain.gain.setTargetAtTime(shimmer * (i === 0 ? 1 : 0.7), now, 6);
    });

    // beds: the sea breathes with everyone
    const { fill } = breathAt(wall * 1000);
    advance(sea, wall, now, true);
    // the sea is what remains when the tide is out
    sea.gain.gain.setTargetAtTime((0.04 + 0.05 * (1 - energy)) * (0.6 + 0.7 * fill) * (0.4 + 1.2 * sc.sea) * here.sea * (1.5 - 0.8 * density), now, 1.0);
    breathGain.gain.setTargetAtTime(0.96 + 0.04 * fill, now, 0.8);

    // bowls: the clock is cut into fixed 30 s slots (so the slot number never
    // jumps as the room changes), and each slot rings at most once, with a
    // probability set by how full the room is and where the tide stands.
    // Everyone shares the slot, the roll, and the moment within it.
    const bowlWindow = (110 - 80 * density) * (1.6 - 0.8 * energy) * (1.7 - 1.2 * sc.bowls);
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
      return { listeners, density: +density.toFixed(2), voicesAllowed: activeVoices, voicesNow: +last.voicesNow.toFixed(2), energy: +last.energy.toFixed(2), shimmer: +last.shimmer.toFixed(3), bowlWindow: Math.round(last.bowlWindow), rings, bowls };
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
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      return Math.sqrt(sum / samples.length);
    },
  };
}
