import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet } from 'react-native';
import { AudioContext, AudioManager, PlaybackNotificationManager } from 'react-native-audio-api';
import { subscribeScore } from './src/arranger/client';
import { createDrone, energyAt, type Drone } from './src/audio/drone';
import { loadBuffers } from './src/audio/load';
import { breathAt, type BreathPhase } from './src/breath';
import { Breath } from './src/components/Breath';
import { presenceAt, subscribePresence } from './src/presence';
import { PerformerConsole, performerParams } from './src/performer/Console';
import { clockIsNative, every, pulse } from './modules/pulse';

const ROOM = 'rest';
if (Platform.OS !== 'web') {
  // LiveKit needs WebRTC globals on native; harmless if the room is never joined.
  // Its audio session defaults to a phone-call configuration (in-communication
  // mode, taking audio focus), which fights the room's own stream; tell it this
  // is media and to leave focus and mode alone. We never start its session.
  try {
    const lk = require('@livekit/react-native');
    lk.registerGlobals();
    lk.AudioSession.configureAudio({
      android: { audioTypeOptions: { ...lk.AndroidAudioTypePresets.media, manageAudioFocus: false, audioMode: 'normal' } },
    }).catch((e: unknown) => console.warn('livekit audio config', e));
  } catch (e) {
    console.warn('livekit globals', e);
  }
}
const NATIVE_ANIM = Platform.OS !== 'web';
// Where the shared score comes from. In the browser: the dev server on :8090
// talks to the arranger on the same host; anywhere else the page is served by
// the cloud Worker, whose API is on the same origin under /api.
const SCORE_URL =
  process.env.EXPO_PUBLIC_SCORE_URL ??
  (Platform.OS === 'web' && typeof location !== 'undefined'
    ? location.port === '8090'
      ? `${location.protocol}//${location.hostname}:8091/score`
      : `${location.origin}/api/score`
    : undefined);
// The real room lives on LiveKit; the arranger mints the join token. A phone
// reports presence with a heartbeat instead, keeping WebRTC out of its audio
// path until a performer is live (another audio engine in the process makes
// the output stream reopen and the engine's clock reset).
const ARRANGER = SCORE_URL?.replace(/\/score$/, '');
const TOKEN_URL = ARRANGER ? `${ARRANGER}/token?room=${ROOM}` : undefined;
const HEARTBEAT_URL = ARRANGER ? `${ARRANGER}/heartbeat?room=${ROOM}` : undefined;
// Everyone reports presence by heartbeat and joins LiveKit only while a
// performer is live, so the media server is in use only during a performance.
const PRESENCE = { tokenUrl: TOKEN_URL, heartbeatUrl: HEARTBEAT_URL, joinForPerformer: true };
const PERFORM = performerParams();

export default function App() {
  const ctxRef = useRef<AudioContext | null>(null);
  const droneRef = useRef<Drone | null>(null);
  const stopTickRef = useRef<(() => void) | null>(null);
  const [room, setRoom] = useState({ people: 0, energy: 0 });
  const [performer, setPerformer] = useState<string | null>(null);
  void performer; // felt in the sound (the live score), not shown
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
        if (__DEV__) console.log(`sanctuary: ${buffers.size} samples decoded, audio context ${ctx.state}, sample rate ${ctx.sampleRate}`);
        // On Android the engine is driven by the native clock (see modules/pulse), which keeps
        // ticking with the screen off; React Native's own timers stop when the activity pauses.
        droneRef.current = createDrone(ctx, ROOM, { buffers, native: Platform.OS !== 'web', autoTick: !clockIsNative });
        if (__DEV__) console.log('sanctuary: engine built');
        if (__DEV__) (globalThis as any).__sanctuary = { ctx, drone: droneRef.current, presenceAt, breathAt };
        if (ctx.state === 'suspended' && Platform.OS !== 'web') {
          // native needs no gesture; the context simply starts suspended
          ctx.resume().then(begin, begin);
        } else if (ctx.state === 'suspended') {
          setWaitingForTouch(true);
          Animated.timing(hint, { toValue: 1, duration: 1500, delay: 400, useNativeDriver: NATIVE_ANIM }).start();
        } else {
          begin();
        }
      })
      .catch((e) => console.warn('samples failed to load', e));
    return () => {
      cancelled = true;
      stopTickRef.current?.();
      droneRef.current?.stop();
      if (Platform.OS !== 'web') PlaybackNotificationManager.hide().catch(() => {});
      ctx.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function begin() {
    if (__DEV__) console.log('sanctuary: samples ready, beginning');
    droneRef.current?.start();
    if (Platform.OS !== 'web') {
      // Android 17 mutes an app's audio a few seconds after it leaves the
      // screen unless it runs a media-playback foreground service, and the
      // service must start while the app is visible. The playback notification
      // is that service (and the lock-screen card). Its only control is stop.
      AudioManager.requestNotificationPermissions().catch(() => {});
      PlaybackNotificationManager.show({ title: 'Sanctuary', artist: 'Breathing with the world', state: 'playing' }).catch((e) => console.warn('notification failed', e));
      for (const control of ['play', 'pause', 'nextTrack', 'previousTrack', 'skipForward', 'skipBackward', 'seekTo'] as const) {
        PlaybackNotificationManager.enableControl(control, false).catch(() => {});
      }
    }
    if (clockIsNative) {
      const drone = droneRef.current;
      const ctx = ctxRef.current;
      if (drone && ctx) {
        const tick = () => drone.tick(Date.now() / 1000, ctx.currentTime);
        tick();
        stopTickRef.current = every(tick, 200);
      }
    }
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
      setRoom({ people: listeners, energy: energyAt(Date.now() / 1000, tide) });
    };
    const unsubscribe = subscribePresence((n, event) => {
      listeners = n;
      show();
      droneRef.current?.setListeners(n);
      if (event === 'join') droneRef.current?.join(undefined, n);
    }, every, ARRANGER ? { ...PRESENCE, onPerformer: (name) => { setPerformer(name); if (__DEV__) console.log(`stage: ${name ?? 'empty'}`); } } : undefined);
    const stopShow = every(show, 5000);
    const unsubscribeScore = subscribeScore(SCORE_URL, (score) => {
      droneRef.current?.setScore(score);
      if (__DEV__) console.log(`score: "${score.title}" (${score.source}) from ${new Date(score.validFrom * 1000).toISOString()}`);
      if (Platform.OS !== 'web') PlaybackNotificationManager.show({ title: 'Sanctuary', artist: score.title, state: 'playing' }).catch(() => {});
    }, every);
    return () => {
      unsubscribe();
      unsubscribeScore();
      stopShow();
    };
  }, [started]);

  // The notification's stop button ends the room.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = PlaybackNotificationManager.addEventListener('playbackNotificationStop', () => {
      stopTickRef.current?.();
      droneRef.current?.stop();
      PlaybackNotificationManager.hide().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  // Breath: pulse the phone at each turn of the breath.
  useEffect(() => {
    if (!started) return;
    let lastPhase: BreathPhase | null = null;
    const stop = every(() => {
      const b = breathAt(Date.now());
      if (b.phase !== lastPhase) {
        lastPhase = b.phase;
        if (Platform.OS === 'android') {
          // sent as media vibration by our own module; every haptics library
          // files pulses as touch feedback, which phones often have switched off
          pulse(b.phase === 'in' ? 30 : 14, b.phase === 'in' ? 170 : 110);
        } else if (Platform.OS === 'ios') {
          const pulse =
            b.phase === 'in'
              ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
              : Haptics.selectionAsync();
          pulse.catch(() => {});
        }
      }
    }, 100);
    return stop;
  }, [started]);


  return (
    <Pressable style={styles.screen} onPress={onTouch}>
      <StatusBar hidden />
      <Breath visible={started} people={room.people} energy={room.energy} />
      <Animated.Text style={[styles.hint, { opacity: hint }]}>touch anywhere</Animated.Text>
      {PERFORM && ARRANGER && started && <PerformerConsole drone={droneRef.current} arranger={ARRANGER} room={ROOM} people={room.people} params={PERFORM} />}
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
