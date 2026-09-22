import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, G, Image, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

// Real photographs, public domain: the sun from NASA's Solar Dynamics
// Observatory and the full moon from NASA's Scientific Visualization Studio.
// See assets/sky/CREDITS.md.
const SUN_TEXTURE = require('../../assets/sky/sun.jpg');
const MOON_TEXTURE = require('../../assets/sky/moon.jpg');
import { moonAt } from '../arranger/inputs';
import { breathAt } from '../breath';

const DOTS = 28;

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
function Dot({ index, clock, density, size, colour }: { index: number; clock: SharedValue<number>; density: SharedValue<number>; size: number; colour: string }) {
  const angle0 = (index / DOTS) * Math.PI * 2 + (index % 5) * 0.37;
  const period = 90 + (index % 7) * 17; // seconds per orbit
  const radius = size * (0.7 + ((index * 7) % 10) / 22);
  const dir = index % 2 === 0 ? 1 : -1;
  const twinkle = 0.6 + (index % 3) * 0.2;
  const style = useAnimatedStyle(() => {
    const t = clock.value / 1000;
    const shown = index < Math.round(DOTS * density.value) ? 1 : 0;
    const a = angle0 + (dir * (t % period) * Math.PI * 2) / period;
    const breath = breathAt(clock.value).fill;
    const r = radius * (0.94 + 0.1 * breath);
    const flicker = 0.75 + 0.25 * Math.sin(t * twinkle + index);
    return {
      opacity: shown * (0.3 + 0.5 * breath) * flicker,
      transform: [{ translateX: Math.cos(a) * r }, { translateY: Math.sin(a) * r }],
    };
  });
  const d = 10;
  return (
    <Animated.View style={[styles.dot, style]}>
      <Svg width={d} height={d}>
        <Defs>
          <RadialGradient id={`dot${index}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
            <Stop offset="0.35" stopColor={colour} stopOpacity="0.8" />
            <Stop offset="1" stopColor={colour} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx={d / 2} cy={d / 2} r={d / 2} fill={`url(#dot${index})`} />
      </Svg>
    </Animated.View>
  );
}

// ---- the bodies -------------------------------------------------------------
// The photographed sun, tinted by its height: deep ember at the horizon,
// washed toward white at noon, with a little extra limb darkening when low.
function SunDisc({ size, sky }: { size: number; sky: Sky }) {
  const r = size / 2;
  const low = 1 - Math.pow(sky.sun, 0.6);
  return (
    <Svg width={size} height={size}>
      <Defs>
        <ClipPath id="sunClip">
          <Circle cx={r} cy={r} r={r - 0.5} />
        </ClipPath>
        <RadialGradient id="limb" cx="50%" cy="50%" r="50%">
          <Stop offset="0.55" stopColor="#3a0c00" stopOpacity="0" />
          <Stop offset="1" stopColor="#3a0c00" stopOpacity={0.25 + 0.45 * low} />
        </RadialGradient>
      </Defs>
      <Image href={SUN_TEXTURE} x={0} y={0} width={size} height={size} preserveAspectRatio="xMidYMid slice" clipPath="url(#sunClip)" />
      <Circle cx={r} cy={r} r={r} fill={low > 0.5 ? '#ff2a00' : '#fff1bd'} fillOpacity={low > 0.5 ? 0.18 + 0.4 * (low - 0.5) : 0.3 * (1 - low * 2)} />
      <Circle cx={r} cy={r} r={r} fill="url(#limb)" />
    </Svg>
  );
}

// The photographed moon with tonight's phase. The night side is drawn three
// times with the terminator nudged, so its edge is soft rather than cut, and
// a little earthshine is left showing.
function MoonDisc({ size, phase }: { size: number; phase: number }) {
  const r = size / 2;
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
export function Breath({ visible, density }: { visible: boolean; density: number }) {
  const { width, height } = useWindowDimensions();
  const size = Math.min(240, Math.round(Math.min(width, height) * 0.44));
  const fill = useSharedValue(0);
  const clock = useSharedValue(Date.now());
  const densityValue = useSharedValue(density);
  useEffect(() => {
    densityValue.value = density;
  }, [density, densityValue]);

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
  const [phase, setPhase] = useState(() => moonAt(Date.now() / 1000).phase);
  useEffect(() => {
    const timer = setInterval(() => {
      setSky(skyAt(hourNow()));
      setPhase(moonAt(Date.now() / 1000).phase);
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  const orb = useAnimatedStyle(() => ({
    transform: [{ scale: 0.86 + 0.14 * fill.value }],
    opacity: visible ? 1 : 0,
  }));
  const glow = useAnimatedStyle(() => ({
    transform: [{ scale: 1.15 + 0.45 * fill.value }],
    opacity: visible ? (0.35 + 0.45 * fill.value) * (0.5 + 0.7 * densityValue.value) : 0,
  }));
  const ring = useAnimatedStyle(() => ({
    transform: [{ scale: 1.5 + 0.3 * fill.value }],
    opacity: visible ? 0.08 + 0.1 * fill.value : 0,
  }));

  const dots = useMemo(() => Array.from({ length: DOTS }, (_, i) => i), []);
  const box = size * 2.6;
  const { palette, daylight } = sky;
  return (
    <View style={[styles.wrap, { width: box, height: box }]}>
      <Svg style={StyleSheet.absoluteFill} width={box} height={box}>
        <Defs>
          <RadialGradient id="ground" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={palette.ground} stopOpacity="1" />
            <Stop offset="1" stopColor={palette.ground} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={box} height={box} fill="url(#ground)" />
      </Svg>

      <Animated.View style={[styles.layer, glow, { width: size, height: size }]}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={palette.glow} stopOpacity={daylight > 0.5 ? 0.6 : 0.4} />
              <Stop offset="0.45" stopColor={palette.glow} stopOpacity="0.18" />
              <Stop offset="1" stopColor={palette.glow} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#glow)" />
        </Svg>
      </Animated.View>

      <Animated.View style={[styles.layer, ring, { width: size, height: size }]}>
        <Svg width={size} height={size}>
          <Circle cx={size / 2} cy={size / 2} r={size / 2 - 1} stroke={palette.glow} strokeWidth={1} fill="none" />
        </Svg>
      </Animated.View>

      <Animated.View style={[styles.layer, orb, { width: size, height: size }]}>
        <View style={{ opacity: daylight }}>
          <SunDisc size={size} sky={sky} />
        </View>
        <View style={[StyleSheet.absoluteFill, { opacity: 1 - daylight }]}>
          <MoonDisc size={size} phase={phase} />
        </View>
      </Animated.View>

      {visible && dots.map((i) => <Dot key={i} index={i} clock={clock} density={densityValue} size={size} colour={palette.glow} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    pointerEvents: 'none',
    alignItems: 'center',
    justifyContent: 'center',
  },
  layer: { position: 'absolute' },
  dot: { position: 'absolute', width: 10, height: 10 },
});
