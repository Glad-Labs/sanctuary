import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, G, Image, Mask, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { SDO_DISC, SVS_DISC, moonLapseUris, subscribeLiveSky, type LiveSky } from '../sky/live';
import { SunVideo } from '../sky/SunVideo';

// Real photographs, public domain: the sun from NASA's Solar Dynamics
// Observatory (two wavelengths) and the full moon from NASA's Scientific
// Visualization Studio, as offline stand-ins for the live ones. See
// assets/sky/CREDITS.md.
const SUN_HOT = require('../../assets/sky/sun-hot.jpg');
const SUN_GOLD = require('../../assets/sky/sun-gold.jpg');
const MOON_TEXTURE = require('../../assets/sky/moon.jpg');
import { moonAt } from '../arranger/inputs';
import { breathAt, CYCLE_MS } from '../breath';

// The points of light: one pool across the whole screen, lit by how many
// people are here. One point per person while the room is small, never more
// points than people, easing into a full field of 240 as the room grows past
// a few hundred. The first points sit close to the orb and later ones reach
// the edges, so a room fills outward as it grows.
const DOTS = 240;
export function pointsFor(people: number): number {
  const n = Math.max(0, people);
  return Math.min(n, Math.round(DOTS * (1 - Math.exp(-n / DOTS))));
}

// ---- the sky where you are ------------------------------------------------
// By day the orb is the sun, coloured by how high it stands; by night it is
// the moon, lit as the real moon is tonight. Both breathe the same breath.
export interface Sky {
  sun: number; // 0 at the horizon, 1 at noon
  daylight: number; // 1 sun, 0 moon, blends across twilight
  palette: { core: string; mid: string; rim: string; glow: string; ground: string };
}
const hex = (c: number[]) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

const SUN_LOW = { core: '#ff7a33', mid: '#e8541f', rim: '#7a1f0a', glow: '#ff8c3a', ground: '#1a0906' };
const SUN_HIGH = { core: '#fff6d6', mid: '#ffcf6e', rim: '#c2731c', glow: '#ffd98c', ground: '#171008' };
const MOON = { core: '#f4f1e8', mid: '#c9cbd4', rim: '#7f8499', glow: '#b7c3ff', ground: '#07061b' };

export function skyAt(hour: number): Sky {
  const h = ((hour % 24) + 24) % 24;
  const rise = 6, set = 19;
  const sun = h > rise && h < set ? Math.sin((Math.PI * (h - rise)) / (set - rise)) : 0;
  const daylight = h < 12 ? smooth((h - (rise - 0.7)) / 1.4) : 1 - smooth((h - (set - 0.7)) / 1.4);
  const s = Math.pow(sun, 0.6);
  const sunPalette = {
    core: mix(SUN_LOW.core, SUN_HIGH.core, s), mid: mix(SUN_LOW.mid, SUN_HIGH.mid, s), rim: mix(SUN_LOW.rim, SUN_HIGH.rim, s),
    glow: mix(SUN_LOW.glow, SUN_HIGH.glow, s), ground: mix(SUN_LOW.ground, SUN_HIGH.ground, s),
  };
  const palette = daylight >= 0.5 ? sunPalette : MOON;
  return { sun, daylight, palette: { ...palette, ground: mix(MOON.ground, sunPalette.ground, daylight) } };
}

/** The dark part of the moon for a phase 0..1 (0 new, 0.5 full), centred at the origin. */
export function moonShadowPath(r: number, phase: number): string {
  const c = Math.cos(2 * Math.PI * phase);
  const rx = Math.max(0.01, Math.abs(c) * r);
  const waxing = phase <= 0.5;
  const semicircle = `M 0 ${-r} A ${r} ${r} 0 0 ${waxing ? 0 : 1} 0 ${r}`; // the dark limb
  const bulgeRight = waxing ? c > 0 : c < 0;
  return `${semicircle} A ${rx} ${r} 0 0 ${bulgeRight ? 0 : 1} 0 ${-r} Z`;
}

// ---- points of light -------------------------------------------------------
// Each point circles the orb very slowly while wandering on a path of its
// own: a few slow sines in random directions with periods that never line
// up, so it drifts, turns, and doubles back. Two guarantees, enforced every
// frame: a point never leaves the screen, and never crosses the orb. Each
// pulses to its own private rhythm over a faint share of the room's breath.
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function Dot({ index, clock, lit, energy, size, field, colour }: { index: number; clock: SharedValue<number>; lit: SharedValue<number>; energy: SharedValue<number>; size: number; field: { w: number; h: number }; colour: string }) {
  const halfW = field.w / 2;
  const halfH = field.h / 2;
  // home: near the orb for the first points, out toward the edges for the last
  const angle0 = hash01(index) * Math.PI * 2;
  const dir = hash01(index + 150) < 0.5 ? 1 : -1;
  const orbit = 1500 + hash01(index + 50) * 2400; // 25 to 65 minutes per turn
  const reach = Math.min(1, Math.pow(index / DOTS, 0.7) + hash01(index + 25) * 0.12);
  const inner = size * 0.62 + 30;
  const keepOut = size * 0.62 + 10; // never closer to the centre than this
  // the wander: two slow motions per axis, larger for points far from the orb
  const leash = 0.35 + 0.65 * reach;
  const a1 = (22 + hash01(index + 60) * 40) * leash;
  const a2 = (8 + hash01(index + 70) * 18) * leash;
  const P = [0, 1, 2, 3].map((k) => 45 + hash01(index + 80 + k * 10) * 150); // seconds
  const F = [0, 1, 2, 3].map((k) => hash01(index + 130 + k * 10) * Math.PI * 2);
  const d = 5 + Math.round(hash01(index + 400) * 7); // 5 to 12 px, glow included
  const p1 = 6 + hash01(index + 200) * 10; // pulse, seconds
  const p2 = 17 + hash01(index + 250) * 26;
  const f1 = hash01(index + 300) * Math.PI * 2;
  const f2 = hash01(index + 350) * Math.PI * 2;
  const style = useAnimatedStyle(() => {
    const t = clock.value / 1000;
    const shown = index < lit.value ? 1 : 0;
    const breath = breathAt(clock.value).fill;
    const own = (0.5 + 0.5 * Math.sin((Math.PI * 2 * t) / p1 + f1)) * (0.5 + 0.5 * Math.sin((Math.PI * 2 * t) / p2 + f2));
    // a few people are big soft lights; a crowd is fine stars
    const crowd = Math.min(1, lit.value / DOTS);
    const grow = 1 + 2.4 * Math.pow(1 - crowd, 1.6);
    const edge = (d * grow) / 2 + 4;
    // the home circles the orb, its radius bounded by the screen in that direction
    const ang = angle0 + (dir * Math.PI * 2 * t) / orbit;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    const rMax = Math.min(halfW / Math.max(0.001, Math.abs(c)), halfH / Math.max(0.001, Math.abs(sn))) - edge - a1 - a2;
    const radius = inner + Math.max(0, rMax - inner) * reach;
    let x = c * radius + a1 * Math.sin((Math.PI * 2 * t) / P[0] + F[0]) + a2 * Math.sin((Math.PI * 2 * t) / P[1] + F[1]);
    let y = sn * radius + a1 * Math.cos((Math.PI * 2 * t) / P[2] + F[2]) + a2 * Math.sin((Math.PI * 2 * t) / P[3] + F[3]);
    // never off the screen
    x = Math.min(halfW - edge, Math.max(-halfW + edge, x));
    y = Math.min(halfH - edge, Math.max(-halfH + edge, y));
    // never across the orb
    const dist = Math.hypot(x, y);
    if (dist < keepOut) {
      x = (x / Math.max(1, dist)) * keepOut;
      y = (y / Math.max(1, dist)) * keepOut;
    }
    return {
      opacity: shown * (0.6 + 0.12 * breath + 0.28 * own) * (0.8 + 0.2 * energy.value),
      transform: [{ translateX: x }, { translateY: y }, { scale: grow }],
    };
  });
  return (
    <Animated.View style={[styles.dot, { width: d, height: d }, style]}>
      <Svg width={d} height={d}>
        <Defs>
          <RadialGradient id={`dot${index}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#ffffff" stopOpacity="1" />
            <Stop offset="0.45" stopColor="#ffffff" stopOpacity="0.95" />
            <Stop offset="0.7" stopColor={colour} stopOpacity="0.75" />
            <Stop offset="1" stopColor={colour} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx={d / 2} cy={d / 2} r={d / 2} fill={`url(#dot${index})`} />
      </Svg>
    </Animated.View>
  );
}

// ---- the bodies -------------------------------------------------------------
// A whole NASA frame, scaled so its disc matches the orb, shown through a
// soft radial mask: the limb keeps its real ragged edge (prominences, loops,
// mountains) while the frame's corners and caption vanish.
function Frame({ id, size, disc, caption, hard, children }: { id: string; size: number; disc: number; caption?: boolean; hard?: boolean; children: React.ReactNode }) {
  const box = size / disc;
  const off = -(box - size) / 2;
  // soft: the limb keeps whatever stands off it (prominences, loops) and the
  // frame's corners fade away; hard: cut exactly at the limb, for the moon,
  // so none of the frame's black sky shows around it
  const fadeFrom = hard ? disc - 0.004 : Math.min(0.99, disc + 0.012);
  const fadeTo = hard ? disc + 0.006 : 1;
  return (
    <Svg width={box} height={box} style={{ position: 'absolute', left: off, top: off }}>
      <Defs>
        <RadialGradient id={`${id}Fade`} cx="50%" cy="50%" r="50%">
          <Stop offset={String(fadeFrom)} stopColor="#ffffff" stopOpacity="1" />
          <Stop offset={String(fadeTo)} stopColor="#ffffff" stopOpacity="0" />
        </RadialGradient>
        <Mask id={`${id}Mask`}>
          <Rect x="0" y="0" width={box} height={box} fill={`url(#${id}Fade)`} />
          {caption && <Rect x="0" y={box * 0.945} width={box * 0.55} height={box * 0.06} fill="#000000" />}
        </Mask>
      </Defs>
      <G mask={`url(#${id}Mask)`}>{children}</G>
    </Svg>
  );
}

// The photographed sun: the red chromosphere near the horizon, the gold
// corona toward noon, crossfaded by its height where you are, with a tint on
// top. Live from SDO when online, yesterday's frames when not.
function SunDisc({ size, sky, live, breathStyle }: { size: number; sky: Sky; live: LiveSky; breathStyle: ReturnType<typeof useAnimatedStyle> }) {
  const r = size / 2;
  const box = size / SDO_DISC;
  const high = Math.pow(sky.sun, 0.7);
  const low = 1 - high;
  return (
    <>
      <Frame id="sun" size={size} disc={SDO_DISC} caption>
        <Image href={live.sunHot ? { uri: live.sunHot } : SUN_HOT} x={0} y={0} width={box} height={box} preserveAspectRatio="xMidYMid slice" />
        <Image href={live.sunGold ? { uri: live.sunGold } : SUN_GOLD} x={0} y={0} width={box} height={box} preserveAspectRatio="xMidYMid slice" opacity={high} />
      </Frame>
      <SunVideo size={size} disc={SDO_DISC} high={high} nowMs={live.at ?? 0} />
      <Svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0 }}>
        <Circle cx={r} cy={r} r={r} fill={low > 0.5 ? '#ff2a00' : '#fff1bd'} fillOpacity={low > 0.5 ? 0.1 + 0.3 * (low - 0.5) : 0.22 * (1 - low * 2)} />
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, breathStyle]}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="sunBreath" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#fff6e0" stopOpacity="1" />
              <Stop offset="0.8" stopColor="#fff6e0" stopOpacity="0.6" />
              <Stop offset="1" stopColor="#fff6e0" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={r} cy={r} r={r} fill="url(#sunBreath)" />
        </Svg>
      </Animated.View>
    </>
  );
}

// The moon over the last two days, as a slow time-lapse of NASA's hourly
// frames: it librates and the terminator creeps. Every step is one breath.
// The next frame fades in as you inhale and holds through the exhale, and
// the sequence plays forward then back so it never jumps.
function lapseIndex(cycle: number, n: number): number {
  const span = 2 * n - 2;
  const m = ((cycle % span) + span) % span;
  return m < n ? m : span - m;
}
function MoonLapse({ size, frames, clock }: { size: number; frames: string[]; clock: SharedValue<number> }) {
  const box = size / SVS_DISC;
  const n = frames.length;
  const at = (cycle: number) => frames[lapseIndex(cycle, n)];
  const [pair, setPair] = useState(() => {
    const k = Math.floor(Date.now() / CYCLE_MS);
    return { cycle: k, a: at(k), b: at(k + 1) };
  });
  // which cycle the pair belongs to, so the top frame keeps showing until the
  // bottom one has actually been swapped (no flash of the old frame)
  const pairCycle = useSharedValue(pair.cycle);
  useEffect(() => {
    pairCycle.value = pair.cycle;
  }, [pair.cycle, pairCycle]);
  useEffect(() => {
    let last = Math.floor(Date.now() / CYCLE_MS);
    const timer = setInterval(() => {
      const k = Math.floor(Date.now() / CYCLE_MS);
      if (k !== last) {
        last = k;
        setPair({ cycle: k, a: at(k), b: at(k + 1) });
      }
    }, 100);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames]);
  const bStyle = useAnimatedStyle(() => {
    const k = Math.floor(clock.value / CYCLE_MS);
    if (k !== pairCycle.value) return { opacity: 1 }; // hold until the swap lands
    const b = breathAt(clock.value);
    return { opacity: b.phase === 'in' ? b.fill : 1 };
  });
  const r = size / 2;
  return (
    <>
      <View style={StyleSheet.absoluteFill}>
        <Frame id="moonA" size={size} disc={SVS_DISC} hard>
          <Image href={{ uri: pair.a }} x={0} y={0} width={box} height={box} preserveAspectRatio="xMidYMid slice" />
        </Frame>
      </View>
      <Animated.View style={[StyleSheet.absoluteFill, bStyle]}>
        <Frame id="moonB" size={size} disc={SVS_DISC} hard>
          <Image href={{ uri: pair.b }} x={0} y={0} width={box} height={box} preserveAspectRatio="xMidYMid slice" />
        </Frame>
      </Animated.View>
      <MoonNight size={size} r={r} />
    </>
  );
}

// A little night-sky light on the moon's dark side, so it reads as a sphere
// in a blue night rather than a cut-out against black.
function MoonNight({ size, r }: { size: number; r: number }) {
  return (
    <Svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0 }}>
      <Defs>
        <RadialGradient id="moonNight" cx="50%" cy="50%" r="50%">
          <Stop offset="0.6" stopColor="#7d8fe0" stopOpacity="0.14" />
          <Stop offset="0.985" stopColor="#7d8fe0" stopOpacity="0.2" />
          <Stop offset="1" stopColor="#7d8fe0" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Circle cx={r} cy={r} r={r} fill="url(#moonNight)" />
    </Svg>
  );
}

// The photographed moon. Online, this hour's NASA frame: real phase, tilt and
// libration, nothing drawn. Offline, the bundled full moon with tonight's
// phase drawn as a night side, three times with the terminator nudged so its
// edge is soft, and a little earthshine left showing.
function MoonDisc({ size, phase, live, clock }: { size: number; phase: number; live: LiveSky; clock: SharedValue<number> }) {
  const r = size / 2;
  if (live.moonLapse && live.moonLapse.length >= 2) return <MoonLapse size={size} frames={live.moonLapse} clock={clock} />;
  if (live.moon) {
    const box = size / SVS_DISC;
    return (
      <>
        <Frame id="moon" size={size} disc={SVS_DISC} hard>
          <Image href={{ uri: live.moon }} x={0} y={0} width={box} height={box} preserveAspectRatio="xMidYMid slice" />
        </Frame>
        <MoonNight size={size} r={r} />
      </>
    );
  }
  const shifted = (d: number) => {
    // move the terminator toward the lit side by d of the radius, for a soft edge
    const c = Math.cos(2 * Math.PI * phase);
    const p = phase <= 0.5 ? Math.acos(Math.max(-1, Math.min(1, c - d))) / (2 * Math.PI) : 1 - Math.acos(Math.max(-1, Math.min(1, c - d))) / (2 * Math.PI);
    return moonShadowPath(r - 0.5, p);
  };
  return (
    <Svg width={size} height={size}>
      <Defs>
        <ClipPath id="moonClip">
          <Circle cx={r} cy={r} r={r - 0.5} />
        </ClipPath>
        <RadialGradient id="moonLimb" cx="50%" cy="50%" r="50%">
          <Stop offset="0.7" stopColor="#000010" stopOpacity="0" />
          <Stop offset="1" stopColor="#000010" stopOpacity="0.35" />
        </RadialGradient>
      </Defs>
      <Image href={MOON_TEXTURE} x={0} y={0} width={size} height={size} preserveAspectRatio="xMidYMid slice" clipPath="url(#moonClip)" />
      <Circle cx={r} cy={r} r={r} fill="url(#moonLimb)" />
      <G transform={`translate(${r}, ${r})`}>
        <Path d={shifted(-0.05)} fill="#05051a" fillOpacity="0.32" />
        <Path d={shifted(0)} fill="#05051a" fillOpacity="0.45" />
        <Path d={shifted(0.05)} fill="#05051a" fillOpacity="0.5" />
      </G>
    </Svg>
  );
}

// ---- the orb ---------------------------------------------------------------
// The sun or the moon, breathing with everyone, in a soft glow, ringed by
// points of light: more of them the more people are here.
export function Breath({ visible, people, energy }: { visible: boolean; people: number; energy: number }) {
  const { width, height } = useWindowDimensions();
  const size = Math.min(240, Math.round(Math.min(width, height) * 0.44));
  const fill = useSharedValue(0);
  const clock = useSharedValue(Date.now());
  const lit = useSharedValue(pointsFor(people));
  const energyValue = useSharedValue(energy);
  useEffect(() => {
    lit.value = pointsFor(people);
    energyValue.value = energy;
  }, [people, energy, lit, energyValue]);

  useFrameCallback(() => {
    const now = Date.now();
    clock.value = now;
    fill.value = breathAt(now).fill;
  });

  const hourNow = () => {
    const override = __DEV__ ? (globalThis as { __hourOverride?: number }).__hourOverride : undefined;
    if (typeof override === 'number') return override;
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  };
  const [sky, setSky] = useState(() => skyAt(hourNow()));
  if (__DEV__) (globalThis as any).__sky = { sky, hour: hourNow() };
  const [phase, setPhase] = useState(() => moonAt(Date.now() / 1000).phase);
  const [live, setLive] = useState<LiveSky>({});
  useEffect(() => subscribeLiveSky(setLive), []);
  useEffect(() => {
    const timer = setInterval(() => {
      setSky(skyAt(hourNow()));
      setPhase(moonAt(Date.now() / 1000).phase);
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  // The bodies never change size; the breath shows in their light and in the
  // ring around them.
  const orb = useAnimatedStyle(() => ({ opacity: visible ? 1 : 0 }));
  const sunBreath = useAnimatedStyle(() => ({ opacity: 0.02 + 0.16 * fill.value }));
  const glow = useAnimatedStyle(() => ({
    transform: [{ scale: 1.15 + 0.45 * fill.value }],
    opacity: visible ? (0.35 + 0.45 * fill.value) * (0.6 + 0.5 * Math.min(1, lit.value / DOTS) + 0.2 * energyValue.value) : 0,
  }));
  const ring = useAnimatedStyle(() => ({
    transform: [{ scale: 1.5 + 0.3 * fill.value }],
    opacity: visible ? 0.08 + 0.1 * fill.value : 0,
  }));

  const dots = useMemo(() => Array.from({ length: DOTS }, (_, i) => i), []);
  const box = Math.max(width, height) * 1.2; // the ground covers the whole page
  const field = { w: width, h: height };
  const { palette, daylight } = sky;
  // The aura is a ring just outside the body that breathes outward: the sun's
  // colour by day, moonlight white by night.
  const aura = daylight > 0.5 ? palette.glow : '#eef2ff';
  // Hand over from sun to moon with a short dissolve rather than a long
  // blend, so neither body shows through the other for more than minutes.
  const sunOpacity = Math.min(1, Math.max(0, (daylight - 0.4) / 0.2));
  const moonOpacity = Math.min(1, Math.max(0, (0.6 - daylight) / 0.2));
  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <Svg style={{ position: 'absolute', left: (width - box) / 2, top: (height - box) / 2 }} width={box} height={box}>
        <Defs>
          <RadialGradient id="ground" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={palette.ground} stopOpacity="1" />
            <Stop offset="0.5" stopColor={palette.ground} stopOpacity="0.5" />
            <Stop offset="1" stopColor={palette.ground} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={box} height={box} fill="url(#ground)" />
      </Svg>

      <Animated.View style={[styles.layer, glow, { width: size, height: size }]}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
              <Stop offset="0.8" stopColor={aura} stopOpacity="0" />
              <Stop offset="0.88" stopColor={aura} stopOpacity={daylight > 0.5 ? 0.55 : 0.45} />
              <Stop offset="0.95" stopColor={aura} stopOpacity="0.18" />
              <Stop offset="1" stopColor={aura} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#glow)" />
        </Svg>
      </Animated.View>

      <Animated.View style={[styles.layer, ring, { width: size, height: size }]}>
        <Svg width={size} height={size}>
          <Circle cx={size / 2} cy={size / 2} r={size / 2 - 1} stroke={aura} strokeWidth={1} fill="none" />
        </Svg>
      </Animated.View>

      <Animated.View style={[styles.layer, styles.body, orb, { width: size, height: size }]}>
        {sunOpacity > 0 && (
          <View style={[StyleSheet.absoluteFill, styles.body, { opacity: sunOpacity }]}>
            <SunDisc size={size} sky={sky} live={live} breathStyle={sunBreath} />
          </View>
        )}
        {moonOpacity > 0 && (
          <View style={[StyleSheet.absoluteFill, styles.body, { opacity: moonOpacity }]}>
            <MoonDisc size={size} phase={phase} live={live} clock={clock} />
          </View>
        )}
      </Animated.View>

      {visible && dots.map((i) => <Dot key={i} index={i} clock={clock} lit={lit} energy={energyValue} size={size} field={field} colour={aura} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    pointerEvents: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  layer: { position: 'absolute' },
  body: { overflow: 'visible' },
  dot: { position: 'absolute' },
});
