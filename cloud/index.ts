// Sanctuary in the cloud: the web app, and the small API every device talks to.
//
// The PC composes; this serves. The arranger on the PC reads presence from
// here and pushes each finished score up with a publish key, so nothing on the
// home network listens. If the PC goes quiet for fifteen minutes, the Room
// writes composer-only scores itself, so the room never stalls.
//
//   GET  /api/score                      the current shared score
//   GET  /api/heartbeat?room&id&tz       "I am here" (every device, every 15-30 s)
//   GET  /api/presence                   who is here, their local hours, who is on stage
//   GET  /api/token?room&tz[&role=performer&key&name]   a LiveKit join token
//   POST /api/publish                    a new score, from the PC (Bearer PUBLISH_KEY)
//
// Everything else is the web app, from static assets.
import { DurableObject } from 'cloudflare:workers';
import { compose } from '../src/arranger/compose';
import { roomInputs } from '../src/arranger/inputs';
import { liveScore } from '../src/arranger/live';
import { sanitize, type Score } from '../src/arranger/score';

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  TOKEN_LIMIT: RateLimit;
  BEAT_LIMIT: RateLimit;
  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  PERFORMER_KEY: string;
  PUBLISH_KEY: string;
}

const DEFAULT_ROOM = 'rest';
const HEARTBEAT_TTL_MS = 90_000;
const MAX_HEARTBEATS = 50_000;
const LIVEKIT_CACHE_MS = 5_000;
const INTERVAL_S = 600; // a score lasts ten minutes
const LEAD_S = 120; // devices poll every minute; give them two to pick a score up
const PUBLISHER_QUIET_MS = 15 * 60_000; // after this long without the PC, compose here

type Presence = { count: number; hours: number[]; performer: { name: string } | null };
type Participant = { identity: string; metadata?: string; tracks?: { type?: string | number; muted?: boolean }[] };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
  });
const clean = (s: string | null, max = 40) => (s ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, max);
const offset = (s: string | null) => Math.max(-840, Math.min(840, Number(s) || 0));

// ---- LiveKit: tokens are HS256 JWTs signed with the API secret ----

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (s: string) => new TextEncoder().encode(s);

async function signJwt(secret: string, claims: Record<string, unknown>): Promise<string> {
  const head = b64url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(utf8(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function joinToken(env: Env, room: string, tz: number, performer?: { name: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const identity = performer ? `performer-${randomHex(4)}` : `listener-${randomHex(6)}`;
  return signJwt(env.LIVEKIT_API_SECRET, {
    iss: env.LIVEKIT_API_KEY,
    sub: identity,
    nbf: now - 10,
    exp: now + 12 * 3600,
    metadata: JSON.stringify(performer ? { tz, role: 'performer', name: performer.name } : { tz }),
    video: { roomJoin: true, room, canPublish: Boolean(performer), canSubscribe: true, canPublishData: false },
  });
}

async function listParticipants(env: Env, room: string): Promise<Participant[]> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(env.LIVEKIT_API_SECRET, { iss: env.LIVEKIT_API_KEY, sub: 'sanctuary-cloud', nbf: now - 10, exp: now + 60, video: { roomAdmin: true, room } });
  const res = await fetch(`${env.LIVEKIT_URL.replace(/^ws/, 'http')}/twirp/livekit.RoomService/ListParticipants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ room }),
  });
  if (res.status === 404) return []; // nobody has joined: the room does not exist yet
  if (!res.ok) throw new Error(`livekit ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { participants?: Participant[] }).participants ?? [];
}

// ---- the room ----

export class Room extends DurableObject<Env> {
  private beats = new Map<string, { tz: number; seen: number }>();
  private livekit: { at: number; participants: Participant[] } | null = null;
  private lastPerformer: string | null = null;

  async beat(id: string, tz: number): Promise<Presence> {
    if (id && (this.beats.has(id) || this.beats.size < MAX_HEARTBEATS)) this.beats.set(id, { tz, seen: Date.now() });
    return this.presence();
  }

  async presence(): Promise<Presence> {
    const room = DEFAULT_ROOM;
    const hours = new Array<number>(24).fill(0);
    const nowUtcHour = (Date.now() / 3_600_000) % 24;
    const add = (tz: number) => { hours[Math.floor((((nowUtcHour + tz / 60) % 24) + 24) % 24)] += 1; };
    let count = 0;
    let performer: { name: string } | null = null;
    const seen = new Set<string>();

    if (!this.livekit || Date.now() - this.livekit.at > LIVEKIT_CACHE_MS) {
      try {
        this.livekit = { at: Date.now(), participants: await listParticipants(this.env, room) };
      } catch (e) {
        console.warn('livekit presence failed:', e instanceof Error ? e.message : e);
        this.livekit = { at: Date.now(), participants: this.livekit?.participants ?? [] };
      }
    }
    for (const p of this.livekit.participants) {
      let tz = 0, id = p.identity, role = '', name = '';
      try { const m = JSON.parse(p.metadata || '{}'); tz = Number(m.tz) || 0; if (m.id) id = String(m.id); role = String(m.role ?? ''); name = String(m.name ?? ''); } catch {}
      // on stage: a performer with a live, unmuted audio track
      if (role === 'performer' && (p.tracks ?? []).some((t) => (t.type === 'AUDIO' || t.type === 0) && !t.muted)) performer = { name: name || p.identity };
      if (role === 'performer' || seen.has(id)) continue; // the performer is on stage, not in the audience
      seen.add(id); count += 1; add(tz);
    }
    // A listener hearing the stage is in LiveKit and also sends heartbeats under
    // another id; count LiveKit listeners only when nobody sends heartbeats.
    const cutoff = Date.now() - HEARTBEAT_TTL_MS;
    let beating = 0;
    for (const [id, h] of this.beats) {
      if (h.seen < cutoff) { this.beats.delete(id); continue; }
      beating += 1;
    }
    if (beating > 0) {
      count = 0; hours.fill(0);
      for (const h of this.beats.values()) { count += 1; add(h.tz); }
    }
    return { count, hours, performer };
  }

  async score(): Promise<{ score: Score | null; now: number }> {
    return { score: (await this.ctx.storage.get<Score>('score')) ?? null, now: Math.floor(Date.now() / 1000) };
  }

  async publish(score: Score): Promise<void> {
    await this.ctx.storage.put({ score, publishedAt: Date.now() });
  }

  /** Every minute, from the cron trigger: stand in for the PC when it has gone quiet. */
  async tick(): Promise<string> {
    const publishedAt = (await this.ctx.storage.get<number>('publishedAt')) ?? 0;
    const presence = await this.presence();
    const performer = presence.performer?.name ?? null;
    const stageChanged = performer !== this.lastPerformer;
    this.lastPerformer = performer;
    if (Date.now() - publishedAt < PUBLISHER_QUIET_MS) return 'publisher active';

    const current = await this.ctx.storage.get<Score>('score');
    const now = Math.floor(Date.now() / 1000);
    const expiring = !current || now >= current.validFrom + current.ttl - LEAD_S;
    if (!stageChanged && !expiring) return 'holding';

    const inputs = roomInputs(Date.now(), presence);
    const draft = compose(inputs);
    const body = performer ? liveScore(draft, performer) : draft;
    const score: Score = { ...body, validFrom: now + (stageChanged ? 20 : LEAD_S), ttl: INTERVAL_S, source: 'composer' };
    await this.ctx.storage.put('score', score);
    return `composed "${score.title}"`;
  }
}

// ---- the edge ----

const room = (env: Env) => env.ROOM.get(env.ROOM.idFromName(DEFAULT_ROOM));

async function api(request: Request, env: Env, path: string): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';

  if (path === '/api/score') return json(await room(env).score());

  if (path === '/api/presence') return json(await room(env).presence());

  if (path === '/api/heartbeat') {
    if (!(await env.BEAT_LIMIT.limit({ key: ip })).success) return json({ error: 'slow down' }, 429);
    return json(await room(env).beat(clean(q.get('id')), offset(q.get('tz'))));
  }

  if (path === '/api/token') {
    if (!(await env.TOKEN_LIMIT.limit({ key: ip })).success) return json({ error: 'slow down' }, 429);
    const wantsStage = q.get('role') === 'performer';
    if (wantsStage && q.get('key') !== env.PERFORMER_KEY) return json({ error: 'not a performer key' }, 403);
    const name = (q.get('name') ?? 'a performer').replace(/[^\w .'-]/g, '').slice(0, 40) || 'a performer';
    const token = await joinToken(env, DEFAULT_ROOM, offset(q.get('tz')), wantsStage ? { name } : undefined);
    return json({ url: env.LIVEKIT_URL, token, room: DEFAULT_ROOM });
  }

  if (path === '/api/publish' && request.method === 'POST') {
    if (request.headers.get('authorization') !== `Bearer ${env.PUBLISH_KEY}`) return json({ error: 'not the publish key' }, 403);
    const raw = (await request.json().catch(() => null)) as Partial<Score> | null;
    const body = raw ? sanitize(raw) : null;
    if (!raw || !body || typeof raw.validFrom !== 'number') return json({ error: 'not a score' }, 400);
    await room(env).publish({ ...body, validFrom: raw.validFrom, ttl: raw.ttl ?? INTERVAL_S, source: raw.source ?? 'model', model: raw.model });
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && url.hostname !== 'localhost') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' } });
    if (path.startsWith('/api/')) {
      try {
        return await api(request, env, path);
      } catch (e) {
        console.error(e);
        return json({ error: 'server error' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env): Promise<void> {
    console.log(await room(env).tick());
  },
} satisfies ExportedHandler<Env>;
