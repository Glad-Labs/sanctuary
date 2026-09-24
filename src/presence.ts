// Presence: how many people are in the room right now, and what time it is for them.
//
// STUB. This simulates a global audience so the one-minute experience can be
// tested without a server. It is a pure function of time, so every device
// shows the same room and hears the same arrivals at the same moment. Replace
// the bodies of presenceAt / presenceHoursAt with a Supabase Realtime presence
// channel that reports each device's UTC offset; the contracts stay.

export type PresenceEvent = 'join' | 'leave';
export type PresenceListener = (count: number, event?: PresenceEvent) => void;

import { presenceAt, presenceHoursAt } from './presenceSim';
export { presenceAt, presenceHoursAt };

/**
 * A way to try the room at any size: `?people=40` on the web URL, or
 * `globalThis.__listenersOverride = 40` from a console. Null means the real
 * (for now, simulated) room.
 */
export function presenceOverride(): number | null {
  const g = globalThis as { __listenersOverride?: unknown; location?: { search?: string } };
  if (typeof g.__listenersOverride === 'number' && g.__listenersOverride >= 0) return Math.round(g.__listenersOverride);
  const search = g.location?.search;
  if (search) {
    const p = Number(new URLSearchParams(search).get('people'));
    if (Number.isFinite(p) && p >= 0 && search.includes('people=')) return Math.round(p);
  }
  return null;
}

export type Every = (fn: () => void, ms: number) => () => void;
const everyDefault: Every = (fn, ms) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

/**
 * Where the real room is. `tokenUrl` joins the LiveKit room (web, and any
 * device that is listening to a performer). `heartbeatUrl` reports presence
 * to the arranger without WebRTC, which phones use when no performer is live,
 * so nothing else touches their audio path.
 */
export interface LiveOptions {
  tokenUrl?: string;
  heartbeatUrl?: string;
  /** Called when someone steps on or off the stage. */
  onPerformer?: (name: string | null) => void;
  /** On a phone: join the room only while someone is on stage, to hear them. */
  joinForPerformer?: boolean;
}

/**
 * Presence. With `live`, the count is the real LiveKit room: this device
 * joins as a silent participant carrying its UTC offset, and every arrival
 * and departure arrives as an event. Without it, or if the connection fails,
 * the simulated room stands in. `?people=N` overrides either, for trying sizes.
 */
export function subscribePresence(listener: PresenceListener, every: Every = everyDefault, live?: LiveOptions): () => void {
  // With a real room to report to, start as a room of one (this device) and
  // grow as the server answers. Starting from the simulated crowd made the room
  // swell for a second and then thin out, which sounds like the sound cutting out.
  let liveCount: number | null = live?.heartbeatUrl || live?.tokenUrl ? 1 : null;
  const now = () => presenceOverride() ?? liveCount ?? presenceAt(Date.now());
  let last = now();
  listener(last);
  const stopPolling = every(() => {
    const next = now();
    if (next !== last) listener(next, next > last ? 'join' : 'leave');
    last = next;
  }, 1000);

  let disconnect: (() => Promise<void>) | null = null;
  let connecting = false;
  let stopped = false;
  let stopHeartbeat: (() => void) | null = null;
  let performerName: string | null = null;
  const setPerformer = (name: string | null) => {
    if (name === performerName) return;
    performerName = name;
    live?.onPerformer?.(name);
  };
  const join = (tokenUrl: string) => {
    if (connecting || disconnect) return;
    connecting = true;
    // with heartbeats the count comes from the server; LiveKit is only the stage
    connectLive(tokenUrl, live?.heartbeatUrl ? () => {} : (count) => { liveCount = count; }, setPerformer)
      .then((d) => {
        connecting = false;
        if (stopped) d();
        else disconnect = d;
      })
      .catch((e) => {
        connecting = false;
        console.warn('presence: live room unavailable', e instanceof Error ? e.message : e);
      });
  };
  const leave = () => {
    const d = disconnect;
    disconnect = null;
    d?.().catch(() => {});
  };

  if (live?.tokenUrl && !live.joinForPerformer) {
    join(live.tokenUrl);
  } else if (live?.heartbeatUrl) {
    const url = live.heartbeatUrl;
    const id = `d${Math.random().toString(36).slice(2, 12)}`;
    const tz = -new Date().getTimezoneOffset();
    const beat = () => {
      fetch(`${url}${url.includes('?') ? '&' : '?'}id=${id}&tz=${tz}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((p: { count: number; performer?: { name: string } | null }) => {
          liveCount = p.count;
          const name = p.performer?.name ?? null;
          setPerformer(name);
          // a phone joins the room only while someone is on stage, to hear them
          if (live.joinForPerformer && live.tokenUrl) {
            if (name && !disconnect) join(live.tokenUrl);
            else if (!name && disconnect) leave();
          }
        })
        .catch((e) => { if (liveCount !== null) console.warn('presence: heartbeat failed', e instanceof Error ? e.message : e); });
    };
    beat();
    stopHeartbeat = every(beat, live.joinForPerformer ? 15_000 : 30_000);
  }
  return () => {
    stopped = true;
    stopPolling();
    stopHeartbeat?.();
    leave();
  };
}

function performerOf(participants: Iterable<{ metadata?: string; audioTrackPublications: Map<string, { isMuted: boolean; isSubscribed?: boolean }> }>): string | null {
  for (const p of participants) {
    try {
      const m = JSON.parse(p.metadata || '{}');
      if (m.role === 'performer' && [...p.audioTrackPublications.values()].some((t) => !t.isMuted)) return String(m.name || 'a performer');
    } catch {}
  }
  return null;
}

async function connectLive(tokenUrl: string, onCount: (count: number) => void, onPerformer: (name: string | null) => void): Promise<() => Promise<void>> {
  const { Room, RoomEvent, Track, setLogLevel } = await import('livekit-client');
  if (process.env.EXPO_PUBLIC_LK_DEBUG === '1') setLogLevel('debug'); // ICE and signaling detail, for chasing a phone that will not connect
  const tz = -new Date().getTimezoneOffset(); // minutes east of UTC
  const res = await fetch(`${tokenUrl}${tokenUrl.includes('?') ? '&' : '?'}tz=${tz}`);
  if (!res.ok) throw new Error(`token ${res.status}`);
  const { url, token } = (await res.json()) as { url: string; token: string };
  const room = new Room();
  const elements = new Map<string, HTMLMediaElement>();
  const report = () => {
    onCount(room.remoteParticipants.size + 1); // everyone else, plus this device
    onPerformer(performerOf(room.remoteParticipants.values()));
  };
  room.on(RoomEvent.ParticipantConnected, report);
  room.on(RoomEvent.ParticipantDisconnected, report);
  room.on(RoomEvent.ParticipantMetadataChanged, report);
  room.on(RoomEvent.TrackMuted, report);
  room.on(RoomEvent.TrackUnmuted, report);
  room.on(RoomEvent.Reconnected, report);
  room.on(RoomEvent.Disconnected, () => { onCount(0); onPerformer(null); });
  // the stage: a performer's audio, heard as it arrives. On the web a track
  // must be attached to an element; a phone plays remote audio on its own.
  room.on(RoomEvent.TrackSubscribed, (track, pub) => {
    if (track.kind !== Track.Kind.Audio) return;
    // the stage sits with the bed, not over it; the performer's own gain does the rest
    if ('setVolume' in track) (track as { setVolume(v: number): void }).setVolume(0.7);
    if (typeof document !== 'undefined') {
      const el = track.attach();
      el.volume = 1;
      el.setAttribute('data-stage', pub.trackSid);
      document.body.appendChild(el); // attach() only creates the element; it must be in the page
      elements.set(pub.trackSid, el);
    }
    report();
  });
  room.on(RoomEvent.TrackUnsubscribed, (track, pub) => {
    if (track.kind !== Track.Kind.Audio) return;
    // LiveKit may have detached the element already, so remove the one we added too
    track.detach().forEach((el) => el.remove());
    elements.get(pub.trackSid)?.remove();
    elements.delete(pub.trackSid);
    report();
  });
  await room.connect(url, token, { autoSubscribe: true });
  if (__DEV__) (globalThis as { __lkRoom?: unknown }).__lkRoom = room;
  report();
  return async () => {
    for (const el of elements.values()) el.remove();
    await room.disconnect();
  };
}
