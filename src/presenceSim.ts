// The simulated audience: a pure function of time, so every device shows the
// same room when there is no real one. Kept apart from presence.ts, which
// talks to the network, so the cloud Worker can use it too.

// Where the simulated audience lives, by UTC offset, and how likely someone
// there is to be in the room at a given local hour (early morning and evening).
const AUDIENCE: ReadonlyArray<readonly [number, number]> = [
  [-8, 0.12], [-7, 0.05], [-6, 0.08], [-5, 0.18], [-3, 0.05], [0, 0.12], [1, 0.14],
  [2, 0.05], [3, 0.03], [5.5, 0.06], [8, 0.05], [9, 0.04], [10, 0.03],
];
function propensity(localHour: number): number {
  const bump = (centre: number, width: number) => Math.exp(-(((localHour - centre + 36) % 24 - 12) ** 2) / (2 * width * width));
  return 0.04 + 0.35 * bump(7, 1.6) + 1.0 * bump(21, 2.2);
}

function noise1(key: number): number {
  let h = Math.imul(key ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5;
}
function valueNoise(x: number): number {
  const k = Math.floor(x);
  const f = x - k;
  const s = f * f * (3 - 2 * f);
  return noise1(k) * (1 - s) + noise1(k + 1) * s;
}

/** How many people are in the room, by the hour it is where they are. 24 bins, counts. */
export function presenceHoursAt(ms: number): number[] {
  const utcHour = (ms / 3_600_000) % 24;
  const bins = new Array<number>(24).fill(0);
  for (const [offset, weight] of AUDIENCE) {
    const local = (((utcHour + offset) % 24) + 24) % 24;
    bins[Math.floor(local)] += 5200 * weight * propensity(local);
  }
  return bins.map((b) => Math.round(b));
}

export function presenceAt(ms: number): number {
  const base = presenceHoursAt(ms).reduce((a, b) => a + b, 0);
  // people come and go in slow waves, not every second
  const wander = 36 * valueNoise(ms / 25_000) + 14 * valueNoise(ms / 7_000 + 100);
  return base + Math.round(wander);
}
