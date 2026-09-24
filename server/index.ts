// The arranger. Every ARRANGER_INTERVAL_MIN minutes it reads the room and the
// sky, drafts a score with the deterministic composer, asks Claude to refine
// it, checks the result, and serves it to every device. Devices switch at the
// same moment because the score carries `validFrom`.
//
//   ANTHROPIC_API_KEY=...  npx tsx server/index.ts
//
// Without a key it serves the composer's draft, which is the same score the
// app composes for itself when the server is unreachable.
import Anthropic from '@anthropic-ai/sdk';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { randomBytes } from 'node:crypto';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { compose } from '../src/arranger/compose';
import { roomInputs, type RoomInputs } from '../src/arranger/inputs';
import { sanitize, ScoreShape, type Score, type CleanScore } from '../src/arranger/score';
import { liveScore } from '../src/arranger/live';

const PORT = Number(process.env.ARRANGER_PORT ?? 8091);
const INTERVAL_S = Number(process.env.ARRANGER_INTERVAL_MIN ?? 10) * 60;
const LEAD_S = Number(process.env.ARRANGER_LEAD_S ?? 120); // devices poll every minute; give them two to pick a score up before it applies
const MODEL = process.env.ARRANGER_MODEL ?? 'claude-opus-5';
const ROOM = process.env.ROOM ?? 'rest';
const LOG = process.env.ARRANGER_LOG ?? 'server/scores.jsonl';
const hasCredential = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// LiveKit: presence is who is in the room. The server mints join tokens for
// listeners (subscribe only, carrying their UTC offset as metadata) and reads
// the participant list for the arranger's inputs. Unset, the simulated room is used.
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? 'ws://100.111.15.72:7880';
const LIVEKIT_KEY = process.env.LIVEKIT_API_KEY ?? 'sanctuary-dev';
const LIVEKIT_SECRET = process.env.LIVEKIT_API_SECRET ?? 'sanctuary-dev-secret-change-before-anyone-else-uses-this';
const livekit = process.env.LIVEKIT_DISABLED ? null : new RoomServiceClient(LIVEKIT_URL.replace(/^ws/, 'http'), LIVEKIT_KEY, LIVEKIT_SECRET);
// A performer joins with this key and may publish audio. Development value; change it.
const PERFORMER_KEY = process.env.PERFORMER_KEY ?? 'sanctuary-stage-dev';
// The cloud (cloud/index.ts): when set, presence comes from there and every
// score is pushed there with the publish key. Nothing on this machine needs to
// be reachable from outside; the PC only makes outbound requests.
const CLOUD_URL = (process.env.CLOUD_URL ?? '').replace(/\/$/, '');
const PUBLISH_KEY = process.env.PUBLISH_KEY ?? '';
if (CLOUD_URL && !PUBLISH_KEY) {
  console.error(`refusing to publish to ${CLOUD_URL} without PUBLISH_KEY (see scripts/arranger.sh)`);
  process.exit(1);
}
// Development keys are fine on a private network and never anywhere else.
if (/^wss:|^https:/.test(LIVEKIT_URL) && !process.env.LIVEKIT_DISABLED) {
  const missing = ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'PERFORMER_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`refusing to start against ${LIVEKIT_URL} without ${missing.join(', ')} (see scripts/arranger.sh)`);
    process.exit(1);
  }
}

// Listeners that are not in the LiveKit room (phones, which keep WebRTC out of
// their audio path until a performer is live) report themselves with a
// heartbeat instead: an id and a UTC offset every 30 s, forgotten after 90 s.
const HEARTBEAT_TTL_MS = 90_000;
const heartbeats = new Map<string, { tz: number; seen: number; room: string }>();

type PresenceReport = { count: number; hours: number[]; performer: { name: string } | null };

/** The real room: how many are here, what hour it is for each of them, and whether someone is on stage. */
async function livePresence(room: string): Promise<PresenceReport> {
  if (CLOUD_URL) {
    try {
      const res = await fetch(`${CLOUD_URL}/api/presence`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return (await res.json()) as PresenceReport;
      console.warn(`cloud presence failed: ${res.status}`);
    } catch (e) {
      console.warn('cloud presence failed:', e instanceof Error ? e.message : e);
    }
    // the cloud is unreachable: keep the last stage state rather than guess
    return { count: 0, hours: new Array<number>(24).fill(0), performer: lastPerformer ? { name: lastPerformer } : null };
  }
  const hours = new Array<number>(24).fill(0);
  const nowUtcHour = (Date.now() / 3_600_000) % 24;
  const add = (tz: number) => { hours[Math.floor((((nowUtcHour + tz / 60) % 24) + 24) % 24)] += 1; };
  let count = 0;
  let performer: { name: string } | null = null;
  const seen = new Set<string>();
  if (livekit) {
    try {
      for (const p of await livekit.listParticipants(room)) {
        let tz = 0, id = p.identity, role = '', name = '';
        try { const m = JSON.parse(p.metadata || '{}'); tz = Number(m.tz) || 0; if (m.id) id = String(m.id); role = String(m.role ?? ''); name = String(m.name ?? ''); } catch {}
        // on stage: a performer with a live, unmuted audio track
        if (role === 'performer' && p.tracks.some((t) => t.type === 0 && !t.muted)) performer = { name: name || p.identity };
        if (seen.has(id)) continue;
        seen.add(id); count += 1; add(tz);
      }
    } catch (e) {
      if (!(e instanceof Error && /not found|does not exist/i.test(e.message))) console.warn('livekit presence failed:', e instanceof Error ? e.message : e);
    }
  }
  const cutoff = Date.now() - HEARTBEAT_TTL_MS;
  for (const [id, h] of heartbeats) {
    if (h.seen < cutoff) { heartbeats.delete(id); continue; }
    if (h.room !== room || seen.has(id)) continue;
    seen.add(id); count += 1; add(h.tz);
  }
  return { count, hours, performer };
}

async function joinToken(room: string, tz: number, performer?: { name: string }): Promise<string> {
  const identity = performer ? `performer-${randomBytes(4).toString('hex')}` : `listener-${randomBytes(6).toString('hex')}`;
  const metadata = performer ? { tz, role: 'performer', name: performer.name } : { tz };
  const at = new AccessToken(LIVEKIT_KEY, LIVEKIT_SECRET, { identity, metadata: JSON.stringify(metadata), ttl: '12h' });
  at.addGrant({ roomJoin: true, room, canPublish: Boolean(performer), canSubscribe: true, canPublishData: false });
  return at.toJwt();
}

// Backends: 'anthropic' (Claude), 'ollama' (a local model on this machine), 'none' (composer only).
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11435';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3-vl:30b-a3b-instruct';
const BACKEND = (process.env.ARRANGER_BACKEND ?? (hasCredential ? 'anthropic' : 'ollama')) as 'anthropic' | 'ollama' | 'none';
const client = BACKEND === 'anthropic' && hasCredential ? new Anthropic() : null;
const MODEL_NAME = BACKEND === 'anthropic' ? MODEL : BACKEND === 'ollama' ? OLLAMA_MODEL : null;

const SYSTEM = `You are the arranger for Sanctuary, a wordless ambient room that thousands of people around the world sit in at once, eyes closed, breathing together. You do not make sound. You write a score for an engine made of recorded instruments: contrabass, cellos, violas, violins, a flute, bowed cymbals, a singing bowl, gongs, and the sea.

How the engine plays a score:
- Voices enter low to high with a tide of energy that builds and recedes over tide.minutes. At low tide only the sea and one cello remain. The first chord note is doubled an octave down by the contrabass.
- Every voicing is six ascending MIDI notes, low to high, between 33 and 84, no two closer than three semitones. The engine walks through the voicings in a seeded order, one every chordSeconds, crossfading voice by voice over about nine seconds. Upper voices choose different chord tones each pass, so a voicing with rich upper tones gives more movement.
- warmth opens or closes a filter over the whole string body. density is how many voices the room may reach. sea, shimmer and bowls scale those layers. Arrivals ring softly on their own.

The melody: a sparse line floating above the strings, written in melody.notes as a small notation: lowercase note names with octave, a3 to b5, ~ for rests, [] to subdivide a step, <> to alternate between cycles, and @n to lengthen a step. Eight to sixteen steps, mostly rests, never two notes in a row without a rest between them, and only tones of the voicings you chose. One pass takes melody.cycleSeconds. Example: "a4 ~ ~ e5 ~ c#5 ~ ~ b4 ~ ~ ~ e5 ~ ~ ~". Notes outside the voicings are silently turned into rests, so stay inside them.

Tempo follows the room: when few people are here, longer chordSeconds and a longer melody cycle, fewer bowls, less shimmer; a full room may move a little faster and brighter. Never fast: this is a place to breathe.

When inputs.performer is present a human is playing live over this bed; the server holds the harmony and thins the bed after you, so keep to the same key as the recent scores and change nothing abruptly.

What people asked for, in their words: harmonious, slow, not constant, not synthetic, a little more variation in the notes, no headaches. Consonance matters more than surprise. Wide low voicings, sparse highs. Prefer pitch sets that share most notes with the previous score so the change feels like weather, not a cut. A major and its relatives are home; you may lean to F# minor, D lydian colour, or A mixolydian when most of the room is in its night, or on a new moon. Never a minor second inside an octave.

The room is global, so it has no time of day of its own. inputs.room tells you what time it is for the people actually in it: the share in their night, morning, day and evening, and a 24-bin histogram of their local hours. Write for that mixture. inputs.dawnCity and inputs.moon are physically shared by everyone and are fair material for the title and the mood.

You receive the room inputs, a draft from a simple composer, and the recent scores. Refine the draft rather than reinvent it. Keep continuity with the recent scores and never repeat a title. Title: at most six words, plain and physical, no religion, no brands. Reasoning: one sentence. Return the score only.`;

interface Entry { at: number; inputs: RoomInputs; draft: CleanScore; score: Score; usage?: unknown; error?: string }
const history: Entry[] = [];
let current: Score = { ...compose(roomInputs()), validFrom: Math.floor(Date.now() / 1000), ttl: INTERVAL_S, source: 'composer' };

async function refineOllama(inputs: RoomInputs, draft: CleanScore, recent: unknown): Promise<{ body: CleanScore; source: Score['source']; usage?: unknown; error?: string }> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000), // a cold model load can take a minute or two; never hang a score on it
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        think: false,
        options: { temperature: 0.7 },
        format: z.toJSONSchema(ScoreShape),
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify({ room: ROOM, inputs, draft, recent }, null, 1) },
        ],
      }),
    });
    if (!res.ok) return { body: draft, source: 'composer', error: `ollama ${res.status}` };
    const data = (await res.json()) as { message?: { content?: string }; eval_count?: number; eval_duration?: number; load_duration?: number };
    const usage = { eval_count: data.eval_count, eval_seconds: (data.eval_duration ?? 0) / 1e9, load_seconds: (data.load_duration ?? 0) / 1e9 };
    let parsed: unknown;
    try { parsed = JSON.parse(data.message?.content ?? ''); } catch { return { body: draft, source: 'composer', usage, error: 'ollama returned non-JSON' }; }
    const body = sanitize(parsed);
    if (!body) return { body: draft, source: 'composer', usage, error: 'model output failed sanitize()' };
    return { body, source: 'model', usage };
  } catch (e) {
    return { body: draft, source: 'composer', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

async function refine(inputs: RoomInputs, draft: CleanScore): Promise<{ body: CleanScore; source: Score['source']; usage?: unknown; error?: string }> {
  const recent = history.slice(-3).map((e) => ({ title: e.score.title, chords: e.score.chords, reasoning: e.score.reasoning }));
  if (BACKEND === 'ollama') return refineOllama(inputs, draft, recent);
  if (!client) return { body: draft, source: 'composer' };
  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ room: ROOM, inputs, draft, recent }, null, 1),
        },
      ],
      output_config: { format: zodOutputFormat(ScoreShape), effort: 'medium' },
    });
    if (response.stop_reason === 'refusal') return { body: draft, source: 'composer', error: 'refusal' };
    const body = sanitize(response.parsed_output);
    if (!body) return { body: draft, source: 'composer', usage: response.usage, error: 'model output failed sanitize()' };
    return { body, source: 'model', usage: response.usage };
  } catch (e) {
    return { body: draft, source: 'composer', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

let lastPerformer: string | null = null;
// Bumped whenever someone steps on or off the stage. A score begun before the
// change (a slow model call, say) is stale when it lands and is dropped.
let stageEpoch = 0;

async function publishToCloud(score: Score) {
  try {
    const res = await fetch(`${CLOUD_URL}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PUBLISH_KEY}` },
      body: JSON.stringify(score),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.warn(`publish failed: ${res.status} ${await res.text()}`);
  } catch (e) {
    console.warn('publish failed:', e instanceof Error ? e.message : e);
  }
}

async function arrange(lead = LEAD_S) {
  const epoch = stageEpoch;
  const live = await livePresence(ROOM);
  const inputs = roomInputs(Date.now(), livekit ? live : undefined);
  const draft = compose(inputs);
  // With someone on stage the bed is held still and the model has nothing to
  // decide, so the live score comes straight from the composer, at once.
  const refined = inputs.performer ? { body: draft, source: 'composer' as const } : await refine(inputs, draft);
  const body = inputs.performer ? liveScore(refined.body, inputs.performer.name) : refined.body;
  const { source, usage, error } = refined as { body: CleanScore; source: Score['source']; usage?: unknown; error?: string };
  if (epoch !== stageEpoch) {
    console.log(`[${new Date().toISOString()}] dropped "${body.title}": the stage changed while it was being written`);
    return;
  }
  const validFrom = Math.floor(Date.now() / 1000) + lead;
  const score: Score = { ...body, validFrom, ttl: INTERVAL_S, source, model: source === 'model' ? MODEL_NAME ?? undefined : undefined };
  const entry: Entry = { at: Date.now(), inputs, draft, score, usage, error };
  history.push(entry);
  if (history.length > 200) history.shift();
  try { appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch {}
  current = score;
  if (CLOUD_URL) await publishToCloud(score);
  console.log(`[${new Date().toISOString()}] "${score.title}" (${source}${error ? `, ${error}` : ''}) applies ${new Date(validFrom * 1000).toISOString()}${score.melody ? `  melody "${score.melody.notes}"` : ''}`);
}

createServer(async (req, res) => {
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (req.url?.startsWith('/token')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const tz = Math.max(-840, Math.min(840, Number(q.get('tz')) || 0));
    const room = (q.get('room') ?? ROOM).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || ROOM;
    const wantsStage = q.get('role') === 'performer';
    if (wantsStage && q.get('key') !== PERFORMER_KEY) {
      res.writeHead(403, headers);
      res.end(JSON.stringify({ error: 'not a performer key' }));
      return;
    }
    const name = (q.get('name') ?? 'a performer').replace(/[^\w .'-]/g, '').slice(0, 40) || 'a performer';
    try {
      const token = await joinToken(room, tz, wantsStage ? { name } : undefined);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ url: LIVEKIT_URL, token, room }));
    } catch (e) {
      res.writeHead(500, headers);
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  } else if (req.url?.startsWith('/heartbeat')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const id = (q.get('id') ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    const tz = Math.max(-840, Math.min(840, Number(q.get('tz')) || 0));
    const room = (q.get('room') ?? ROOM).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || ROOM;
    if (id) heartbeats.set(id, { tz, seen: Date.now(), room });
    res.writeHead(200, headers);
    res.end(JSON.stringify(await livePresence(room)));
  } else if (req.url?.startsWith('/presence')) {
    res.writeHead(200, headers);
    res.end(JSON.stringify(await livePresence(ROOM)));
  } else if (req.url?.startsWith('/score')) {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ score: current, now: Math.floor(Date.now() / 1000), model: MODEL_NAME }));
  } else if (req.url?.startsWith('/history')) {
    res.writeHead(200, headers);
    res.end(JSON.stringify(history.slice(-24)));
  } else {
    res.writeHead(404, headers);
    res.end('{}');
  }
}).listen(PORT, () => {
  console.log(`arranger on :${PORT}  backend ${BACKEND}  model ${MODEL_NAME ?? 'none (composer only)'}  every ${INTERVAL_S / 60} min${CLOUD_URL ? `  publishing to ${CLOUD_URL}` : ''}`);
});

arrange();
setInterval(() => arrange(), INTERVAL_S * 1000);
// someone stepping on or off the stage changes the score within half a minute
setInterval(async () => {
  const p = (await livePresence(ROOM)).performer?.name ?? null;
  if (p !== lastPerformer) {
    lastPerformer = p;
    stageEpoch++;
    console.log(`[${new Date().toISOString()}] stage: ${p ? `${p} is live` : 'empty'}`);
    arrange(20);
  }
}, 15_000);
