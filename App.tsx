import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet } from 'react-native';
import { AudioContext, AudioManager } from 'react-native-audio-api';
import { subscribeScore } from './src/arranger/client';
import { createDrone, densityFor, energyAt, localBalance, type Drone } from './src/audio/drone';
import { loadBuffers } from './src/audio/load';
import { initMelody, melodyLevel, playMelody, setMelodyLevel } from './src/melody';
import { breathAt, type BreathPhase } from './src/breath';
import { Breath } from './src/components/Breath';
import { presenceAt, subscribePresence } from './src/presence';

const ROOM = 'rest';
const NATIVE_ANIM = Platform.OS !== 'web';
// Where the shared score comes from. In the browser, default to the arranger on the same host.
const SCORE_URL =
  process.env.EXPO_PUBLIC_SCORE_URL ??
  (Platform.OS === 'web' && typeof location !== 'undefined' ? `${location.protocol}//${location.hostname}:8091/score` : undefined);

export default function App() {
  const ctxRef = useRef<AudioContext | null>(null);
  const droneRef = useRef<Drone | null>(null);
  const [density, setDensity] = useState(0);
  const [waitingForTouch, setWaitingForTouch] = useState(false);
  const [started, setStarted] = useState(false);
  const hint = useRef(new Animated.Value(0)).current;

  // Sound: begin as soon as the samples are decoded and the platform allows.
  // The browser needs a touch first.
  useEffect(() => {
    let cancelled = false;
    if (Platform.OS !== 'web') {
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playback',
        iosMode: 'default',
        iosOptions: [],
        iosAllowHaptics: true,
      });
      AudioManager.setAudioSessionActivity(true).catch(() => {});
    }
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    loadBuffers(ctx.sampleRate)
      .then((buffers) => {
        if (cancelled) return;
        droneRef.current = createDrone(ctx, ROOM, { buffers });
        if (__DEV__) (globalThis as any).__sanctuary = { ctx, drone: droneRef.current, presenceAt, breathAt, melodyLevel };
        if (ctx.state === 'suspended') {
          setWaitingForTouch(true);
          Animated.timing(hint, { toValue: 1, duration: 1500, delay: 400, useNativeDriver: NATIVE_ANIM }).start();
        } else {
          begin();
        }
      })
      .catch((e) => console.warn('samples failed to load', e));
    return () => {
      cancelled = true;
      droneRef.current?.stop();
      ctx.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function begin() {
    droneRef.current?.start();
    initMelody().catch(() => {});
    setStarted(true);
    setWaitingForTouch(false);
    Animated.timing(hint, { toValue: 0, duration: 600, useNativeDriver: NATIVE_ANIM }).start();
  }

  async function onTouch() {
    if (!waitingForTouch) return;
    try {
      await ctxRef.current?.resume();
    } catch {}
    begin();
  }

  // Presence and tide: the room is heard and seen, never counted on screen.
  useEffect(() => {
    if (!started) return;
    let listeners = 0;
    const show = () => {
      const tide = droneRef.current?.score().tide;
      setDensity(densityFor(listeners) * (0.35 + 0.65 * energyAt(Date.now() / 1000, tide)));
    };
    const unsubscribe = subscribePresence((n, event) => {
      listeners = n;
      show();
      droneRef.current?.setListeners(n);
      if (event === 'join') droneRef.current?.join();
    });
    const timer = setInterval(show, 5000);
    // the melody follows the tide and the listener's hour, like the upper strings
    const melodyLevelNow = () => {
      const d = new Date();
      const tide = droneRef.current?.score().tide;
      return energyAt(Date.now() / 1000, tide) * localBalance(d.getHours() + d.getMinutes() / 60).top;
    };
    let melodyTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribeScore = subscribeScore(SCORE_URL, (score) => {
      droneRef.current?.setScore(score);
      if (__DEV__) console.log(`score: "${score.title}" (${score.source}) from ${new Date(score.validFrom * 1000).toISOString()}`);
      if (melodyTimer) clearTimeout(melodyTimer);
      const wait = Math.max(0, score.validFrom * 1000 - Date.now());
      melodyTimer = setTimeout(() => playMelody(score.melody, melodyLevelNow()).catch(() => {}), wait);
    });
    const levelTimer = setInterval(() => setMelodyLevel(melodyLevelNow()), 15_000);
    return () => {
      unsubscribe();
      unsubscribeScore();
      clearInterval(timer);
      clearInterval(levelTimer);
      if (melodyTimer) clearTimeout(melodyTimer);
    };
  }, [started]);

  // Breath: pulse the phone at each turn of the breath.
  useEffect(() => {
    if (!started) return;
    let lastPhase: BreathPhase | null = null;
    const timer = setInterval(() => {
      const b = breathAt(Date.now());
      if (b.phase !== lastPhase) {
        lastPhase = b.phase;
        if (Platform.OS !== 'web') {
          const pulse =
            b.phase === 'in'
              ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
              : Haptics.selectionAsync();
          pulse.catch(() => {});
        }
      }
    }, 100);
    return () => clearInterval(timer);
  }, [started]);

  return (
    <Pressable style={styles.screen} onPress={onTouch}>
      <StatusBar hidden />
      <Breath visible={started} density={density} />
      <Animated.Text style={[styles.hint, { opacity: hint }]}>touch anywhere</Animated.Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#050508',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    position: 'absolute',
    top: '12%',
    color: '#8f8ca8',
    fontSize: 13,
    fontWeight: '300',
    letterSpacing: 3,
    textTransform: 'uppercase',
  },
});
