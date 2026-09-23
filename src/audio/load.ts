import { Asset } from 'expo-asset';
import { Platform } from 'react-native';
import { decodeAudioData } from 'react-native-audio-api';
import { SAMPLE_ASSETS } from './assets';
import { SAMPLES } from './manifest';
import type { Buffers } from './drone';

// Decode every bundled sample once. About five megabytes of MP3; a few seconds.
//
// In a development build the samples come over the wire from Metro. Expo's
// asset download rejects some of those URLs on Android (a stray second "?"),
// so we fall back to fetching the bytes ourselves. In a release build the
// samples are in the app and the download step is a no-op. A few at a time,
// so a phone on a USB link is not asked for thirty files at once.
async function bytesFor(asset: Asset): Promise<ArrayBuffer | string> {
  try {
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    if (Platform.OS === 'web') return await (await fetch(uri)).arrayBuffer();
    return uri;
  } catch {
    // Android cannot resolve "localhost" for the USB dev tunnel, but the loopback address works.
    const uri = Platform.OS === 'android' ? asset.uri.replace('://localhost:', '://127.0.0.1:') : asset.uri;
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`sample ${asset.name}: ${res.status}`);
    return await res.arrayBuffer();
  }
}

export async function loadBuffers(sampleRate?: number): Promise<Buffers> {
  const buffers: Buffers = new Map();
  const queue = [...SAMPLES];
  const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))]);
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const t0 = Date.now();
      const asset = Asset.fromModule(SAMPLE_ASSETS[s.id]);
      const source = await withTimeout(bytesFor(asset), 20_000, `fetch ${s.id}`);
      const t1 = Date.now();
      const buffer = await withTimeout(decodeAudioData(source, sampleRate), 20_000, `decode ${s.id}`);
      buffers.set(s.id, buffer);
      if (__DEV__) console.log(`sample ${s.id}: ${typeof source === 'string' ? source.slice(0, 40) : 'bytes'} fetched in ${t1 - t0} ms, decoded in ${Date.now() - t1} ms`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return buffers;
}
