// Fetch the shared score from the arranger, falling back to the local composer.
import { composedScore } from './compose';
import { sanitize, type Score } from './score';

type Every = (fn: () => void, ms: number) => () => void;
const everyDefault: Every = (fn, ms) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

export function subscribeScore(url: string | undefined, onScore: (score: Score) => void, every: Every = everyDefault): () => void {
  let stopped = false;
  let lastKey = '';
  const emit = (score: Score) => {
    const key = `${score.source}:${score.validFrom}:${score.title}`;
    if (key === lastKey) return;
    lastKey = key;
    onScore(score);
  };
  const poll = async () => {
    if (stopped) return;
    let score: Score | null = null;
    if (url) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (res.ok) {
          const body = (await res.json()) as { score?: unknown };
          const raw = body.score as Partial<Score> | undefined;
          const clean = raw ? sanitize(raw) : null;
          if (clean && raw && typeof raw.validFrom === 'number') {
            score = { ...clean, validFrom: raw.validFrom, ttl: raw.ttl ?? 600, source: raw.source ?? 'model', model: raw.model };
          }
        }
      } catch {
        // offline or no server: the composer below
      }
    }
    if (!stopped) emit(score ?? composedScore());
  };
  poll();
  const stop = every(poll, 60_000);
  return () => {
    stopped = true;
    stop();
  };
}
