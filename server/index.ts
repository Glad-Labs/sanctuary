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
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { compose } from '../src/arranger/compose';
import { roomInputs, type RoomInputs } from '../src/arranger/inputs';
import { sanitize, ScoreShape, type Score, type CleanScore } from '../src/arranger/score';

const PORT = Number(process.env.ARRANGER_PORT ?? 8091);
const INTERVAL_S = Number(process.env.ARRANGER_INTERVAL_MIN ?? 10) * 60;
const LEAD_S = Number(process.env.ARRANGER_LEAD_S ?? 120); // devices poll every minute; give them two to pick a score up before it applies
const MODEL = process.env.ARRANGER_MODEL ?? 'claude-opus-5';
const ROOM = process.env.ROOM ?? 'rest';
const LOG = process.env.ARRANGER_LOG ?? 'server/scores.jsonl';
const hasCredential = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// Backends: 'anthropic' (Claude), 'ollama' (a local model on this machine), 'none' (composer only).
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3.6:27b';
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

async function arrange() {
  const inputs = roomInputs();
  const draft = compose(inputs);
  const { body, source, usage, error } = await refine(inputs, draft);
  const validFrom = Math.floor(Date.now() / 1000) + LEAD_S;
  const score: Score = { ...body, validFrom, ttl: INTERVAL_S, source, model: source === 'model' ? MODEL_NAME ?? undefined : undefined };
  const entry: Entry = { at: Date.now(), inputs, draft, score, usage, error };
  history.push(entry);
  if (history.length > 200) history.shift();
  try { appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch {}
  current = score;
  console.log(`[${new Date().toISOString()}] "${score.title}" (${source}${error ? `, ${error}` : ''}) applies ${new Date(validFrom * 1000).toISOString()}${score.melody ? `  melody "${score.melody.notes}"` : ''}`);
}

createServer((req, res) => {
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (req.url?.startsWith('/score')) {
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
  console.log(`arranger on :${PORT}  backend ${BACKEND}  model ${MODEL_NAME ?? 'none (composer only)'}  every ${INTERVAL_S / 60} min`);
});

arrange();
setInterval(arrange, INTERVAL_S * 1000);
