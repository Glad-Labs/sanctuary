import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { breathAt } from '../breath';

const DOTS = 24;

// Colour of the room follows the sun where you are: rose at dawn and dusk,
// pale at midday, deep indigo at night.
function skyColours(hour: number): { sphere: string; halo: string } {
  const near = (h: number, w: number) => Math.exp(-((hour - h) ** 2) / (2 * w * w));
  const warmth = Math.max(near(6.5, 1.2), near(19, 1.2));
  const daylight = Math.max(0, Math.cos(((hour - 13) / 24) * Math.PI * 2));
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const hex = (c: number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const night = [26, 25, 64], day = [38, 52, 84], dawn = [82, 44, 66];
  const base = mix(mix(night, day, daylight), dawn, warmth);
  return { sphere: hex(base), halo: hex(base.map((v) => Math.min(255, v + 70))) };
}

function Dot({ index, clock, density, size }: { index: number; clock: SharedValue<number>; density: SharedValue<number>; size: number }) {
  const angle0 = (index / DOTS) * Math.PI * 2 + (index % 5) * 0.37;
  const period = 70 + (index % 7) * 13; // seconds per orbit
  const radius = size * (0.62 + ((index * 7) % 10) / 40);
  const dir = index % 2 === 0 ? 1 : -1;
  const style = useAnimatedStyle(() => {
    const t = clock.value / 1000;
    const shown = index < Math.round(DOTS * density.value) ? 1 : 0;
    const a = angle0 + (dir * (t % period) * Math.PI * 2) / period;
    const breath = breathAt(clock.value).fill;
    const r = radius * (0.92 + 0.12 * breath);
    return {
      opacity: shown * (0.25 + 0.35 * breath),
      transform: [{ translateX: Math.cos(a) * r }, { translateY: Math.sin(a) * r }],
    };
  });
  return <Animated.View style={[styles.dot, style]} />;
}

// A dim sphere that swells and settles with the shared breath, ringed by
// points of light: more of them the more people are here.
export function Breath({ visible, density }: { visible: boolean; density: number }) {
  const { width, height } = useWindowDimensions();
  const size = Math.min(220, Math.round(Math.min(width, height) * 0.42));
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

  const [colours, setColours] = useState(() => skyColours(new Date().getHours() + new Date().getMinutes() / 60));
  useEffect(() => {
    const timer = setInterval(() => {
      const d = new Date();
      setColours(skyColours(d.getHours() + d.getMinutes() / 60));
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const sphere = useAnimatedStyle(() => ({
    transform: [{ scale: 0.72 + 0.28 * fill.value }],
    opacity: visible ? 0.55 + 0.45 * fill.value : 0,
  }));
  const halo = useAnimatedStyle(() => ({
    transform: [{ scale: 0.9 + 0.5 * fill.value }],
    opacity: visible ? (0.04 + 0.1 * fill.value) * (0.6 + 0.8 * densityValue.value) : 0,
  }));

  const round = { width: size, height: size, borderRadius: size / 2 };
  const dots = useMemo(() => Array.from({ length: DOTS }, (_, i) => i), []);
  return (
    <View style={[styles.wrap, { width: size * 2.2, height: size * 2.2 }]}>
      <Animated.View style={[styles.halo, round, { backgroundColor: colours.halo }, halo]} />
      <Animated.View style={[styles.sphere, round, { backgroundColor: colours.sphere }, sphere]} />
      {visible && dots.map((i) => <Dot key={i} index={i} clock={clock} density={densityValue} size={size} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    pointerEvents: 'none',
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: { position: 'absolute' },
  sphere: {},
  dot: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#c9c4ff',
  },
});
