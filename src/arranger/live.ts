// With someone on stage the bed steps back: harmony held, few voices, no
// melody, room for a human. Shared by the arranger on the PC and the cloud
// Worker's fallback composer.
import type { CleanScore } from './score';

export function liveScore(body: CleanScore, name: string): CleanScore {
  return {
    ...body,
    title: `With ${name}`,
    reasoning: `${name} is on stage; the bed holds still beneath them.`,
    chordSeconds: Math.max(body.chordSeconds, 150),
    density: Math.min(body.density, 0.3),
    sea: Math.min(body.sea, 0.5),
    shimmer: Math.min(body.shimmer, 0.15),
    bowls: Math.min(body.bowls, 0.1),
    melody: undefined,
  };
}
