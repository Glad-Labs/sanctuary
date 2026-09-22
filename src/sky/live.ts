// Live sky: NASA publishes the sun every fifteen minutes and a moon frame for
// every hour of the year at stable URLs. When the device is online we show the
// real one for this moment; otherwise the bundled textures stand in.
import { Image, Platform } from 'react-native';

const SDO = 'https://sdo.gsfc.nasa.gov/assets/img/latest';
const SVS_2026 = 'https://svs.gsfc.nasa.gov/vis/a000000/a005500/a005587/frames/730x730_1x1_30p';
export const SUN_REFRESH_MS = 30 * 60 * 1000;
/** Fraction of the frame the disc spans, so the disc can be scaled to the orb. */
export const SDO_DISC = 0.926;
export const SVS_DISC = 0.918;

export interface LiveSky {
  /** SDO/AIA 304 Å: the chromosphere, red, prominences standing off the limb. */
  sunHot?: string;
  /** SDO/AIA 171 Å: the corona, gold, loops at the limb. */
  sunGold?: string;
  /** This hour's frame of the 2026 moon, with real phase, tilt and libration. */
  moon?: string;
  /** The last two days of frames, oldest first, once they are all loaded. */
  moonLapse?: string[];
  /** When the sun was last refreshed (ms), so movies can share the bucket. */
  at?: number;
}

export function sunUris(nowMs: number): { hot: string; gold: string } {
  const bucket = Math.floor(nowMs / SUN_REFRESH_MS);
  return { hot: `${SDO}/latest_512_0304.jpg?t=${bucket}`, gold: `${SDO}/latest_512_0171.jpg?t=${bucket}` };
}

const YEAR_START = Date.UTC(2026, 0, 1);
const YEAR_END = Date.UTC(2027, 0, 1);
const frameUri = (frame: number) => `${SVS_2026}/moon.${String(frame).padStart(4, '0')}.jpg`;

export function moonUri(nowMs: number): string | null {
  if (nowMs < YEAR_START || nowMs >= YEAR_END) return null; // the 2026 set only
  return frameUri(Math.floor((nowMs - YEAR_START) / 3_600_000) + 1);
}

/** The last `count` frames, `stepHours` apart, ending at this hour: a time-lapse of the moon. */
export function moonLapseUris(nowMs: number, count = 24, stepHours = 2): string[] {
  if (nowMs < YEAR_START || nowMs >= YEAR_END) return [];
  const last = Math.floor((nowMs - YEAR_START) / 3_600_000) + 1;
  const frames: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const f = last - i * stepHours;
    if (f >= 1) frames.push(frameUri(f));
  }
  return frames;
}

/** SDO's 48-hour time-lapse movies, refreshed every three hours. */
export const SUN_MOVIE_REFRESH_MS = 3 * 60 * 60 * 1000;
export function sunMovieUris(nowMs: number): { hot: string; gold: string } {
  const bucket = Math.floor(nowMs / SUN_MOVIE_REFRESH_MS);
  return { hot: `${SDO}/mpeg/latest_512_0304.mp4?t=${bucket}`, gold: `${SDO}/mpeg/latest_512_0171.mp4?t=${bucket}` };
}

/** Load an image fully before we point the sky at it, so it never flashes empty. */
async function ready(uri: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    return new Promise((resolve) => {
      const img = new (globalThis as unknown as { Image: new () => HTMLImageElement }).Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = uri;
    });
  }
  try {
    return await Image.prefetch(uri);
  } catch {
    return false;
  }
}

/** Keep the live sky current. Calls back only when something is confirmed loaded. */
export function subscribeLiveSky(onChange: (sky: LiveSky) => void): () => void {
  let stopped = false;
  let current: LiveSky = {};
  let lastSunBucket = -1;
  let lastMoon = '';
  let loadingLapse = false;
  const poll = async () => {
    if (stopped) return;
    const now = Date.now();
    const next: LiveSky = { ...current };
    const bucket = Math.floor(now / SUN_REFRESH_MS);
    if (bucket !== lastSunBucket) {
      const { hot, gold } = sunUris(now);
      const [h, g] = await Promise.all([ready(hot), ready(gold)]);
      if (h && g) { next.sunHot = hot; next.sunGold = gold; lastSunBucket = bucket; }
    }
    const moon = moonUri(now);
    if (moon && moon !== lastMoon && (await ready(moon))) { next.moon = moon; lastMoon = moon; }
    if (stopped) return;
    if (next.sunHot !== current.sunHot || next.moon !== current.moon) {
      next.at = now;
      current = next;
      onChange(current);
    }
    // then, in the background, the time-lapse frames, one at a time
    if (next.moon && !loadingLapse && (!current.moonLapse || current.moonLapse[current.moonLapse.length - 1] !== next.moon)) {
      loadingLapse = true;
      const uris = moonLapseUris(now);
      const loaded: string[] = [];
      for (const uri of uris) {
        if (stopped) return;
        if (await ready(uri)) loaded.push(uri);
      }
      loadingLapse = false;
      if (!stopped && loaded.length >= 2) {
        current = { ...current, moonLapse: loaded };
        onChange(current);
      }
    }
  };
  poll();
  const timer = setInterval(poll, 5 * 60 * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
