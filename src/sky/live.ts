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
}

export function sunUris(nowMs: number): { hot: string; gold: string } {
  const bucket = Math.floor(nowMs / SUN_REFRESH_MS);
  return { hot: `${SDO}/latest_512_0304.jpg?t=${bucket}`, gold: `${SDO}/latest_512_0171.jpg?t=${bucket}` };
}

export function moonUri(nowMs: number): string | null {
  const start = Date.UTC(2026, 0, 1);
  if (nowMs < start || nowMs >= Date.UTC(2027, 0, 1)) return null; // the 2026 set only
  const frame = Math.floor((nowMs - start) / 3_600_000) + 1;
  return `${SVS_2026}/moon.${String(frame).padStart(4, '0')}.jpg`;
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
      current = next;
      onChange(current);
    }
  };
  poll();
  const timer = setInterval(poll, 5 * 60 * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
