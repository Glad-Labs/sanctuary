// The stage, for whoever is on it. Web only for now. Reached with
// ?perform=1&key=<performer key>&name=<name> (and &tone=1 to publish a soft
// test tone instead of a microphone, for line checks). Shows what a performer
// needs and nothing else: the voicing sounding now, the next one and when,
// the tide, who is here, and one button.
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Drone } from '../audio/drone';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

let params: { key: string; name: string; tone: boolean } | null | undefined;

/**
 * The performer's link, read once. The key is then taken out of the address
 * bar, so it does not sit in browser history, a screenshot, or a shared tab.
 */
export function performerParams(): { key: string; name: string; tone: boolean } | null {
  if (params !== undefined) return params;
  if (Platform.OS !== 'web' || typeof location === 'undefined') return (params = null);
  const q = new URLSearchParams(location.search);
  if (!q.get('perform')) return (params = null);
  params = { key: q.get('key') ?? '', name: q.get('name') ?? 'a performer', tone: q.get('tone') === '1' };
  if (q.has('key')) {
    q.delete('key');
    history.replaceState(history.state, '', `${location.pathname}?${q.toString()}${location.hash}`);
  }
  return params;
}

export function PerformerConsole({ drone, arranger, room, people, params }: { drone: Drone | null; arranger: string; room: string; people: number; params: { key: string; name: string; tone: boolean } }) {
  const [state, setState] = useState<'off' | 'connecting' | 'live' | 'error'>('off');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => () => { stopRef.current?.().catch(() => {}); }, []);

  async function goLive() {
    setState('connecting');
    setError('');
    try {
      const { Room, LocalAudioTrack, AudioPresets, Track, createLocalAudioTrack } = await import('livekit-client');
      const tz = -new Date().getTimezoneOffset();
      const res = await fetch(`${arranger}/token?room=${room}&role=performer&key=${encodeURIComponent(params.key)}&name=${encodeURIComponent(params.name)}&tz=${tz}`);
      if (!res.ok) throw new Error(res.status === 403 ? 'that is not the performer key' : `token ${res.status}`);
      const { url, token } = (await res.json()) as { url: string; token: string };
      const lk = new Room();
      await lk.connect(url, token, { autoSubscribe: false });
      let track;
      let toneCtx: AudioContext | null = null;
      if (params.tone) {
        // a line check: a soft A3 sine, no microphone needed
        toneCtx = new AudioContext();
        const osc = toneCtx.createOscillator();
        osc.frequency.value = 220;
        const g = toneCtx.createGain();
        g.gain.value = 0.02; // a line check, well under the bed
        const dest = toneCtx.createMediaStreamDestination();
        osc.connect(g);
        g.connect(dest);
        osc.start();
        track = new LocalAudioTrack(dest.stream.getAudioTracks()[0], undefined, false);
      } else {
        // the instrument as it is: no echo cancellation, no noise suppression, no gain riding, stereo
        track = await createLocalAudioTrack({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 });
      }
      await lk.localParticipant.publishTrack(track, { audioPreset: AudioPresets.musicHighQualityStereo, dtx: false, red: false, source: Track.Source.Microphone });
      stopRef.current = async () => {
        await lk.disconnect();
        track.stop();
        await toneCtx?.close();
      };
      setState('live');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }
  async function stop() {
    await stopRef.current?.();
    stopRef.current = null;
    setState('off');
  }

  const h = drone?.harmony(now / 1000);
  const score = drone?.score();
  const status = drone?.status();
  return (
    <View style={styles.panel} pointerEvents="box-none">
      <Text style={styles.line}>{params.name} · {state === 'live' ? 'LIVE' : state}{error ? ` · ${error}` : ''}</Text>
      <Text style={styles.line}>{score ? `"${score.title}"` : ''}  ·  {people} here</Text>
      <Text style={styles.line}>now {h ? h.chord.map(noteName).join(' ') : ''}</Text>
      <Text style={styles.line}>next {h ? h.next.map(noteName).join(' ') : ''}  in {h ? Math.ceil(h.nextIn) : ''} s  (every {h?.chordSeconds} s)</Text>
      <Text style={styles.line}>tide {status ? Math.round(status.energy * 100) : ''}%  ·  calm {status ? Math.round(status.calm * 100) : ''}%  ·  voices {status ? status.voicesNow.toFixed(1) : ''}</Text>
      <Pressable onPress={state === 'live' ? stop : goLive} disabled={state === 'connecting'} style={styles.button}>
        <Text style={styles.buttonText}>{state === 'live' ? 'leave the stage' : state === 'connecting' ? 'connecting' : params.tone ? 'go live (test tone)' : 'go live'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { position: 'absolute', top: 24, left: 24, right: 24, gap: 6 },
  line: { color: '#a9a6c4', fontSize: 13, fontFamily: Platform.select({ web: 'ui-monospace, monospace', default: undefined }) },
  button: { alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#5b56b8', borderRadius: 6 },
  buttonText: { color: '#c9c4ff', fontSize: 13, letterSpacing: 1 },
});
