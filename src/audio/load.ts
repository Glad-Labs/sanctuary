import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import { decodeAudioData } from 'react-native-audio-api';
import { SAMPLE_ASSETS } from './assets';
import { SAMPLES } from './manifest';
import type { Buffers } from './drone';

// Decode every bundled sample once. About five megabytes of MP3; a few seconds.
//
// The decoder is always given bytes in memory, never a path: on the phone its
// local-file path produced silent buffers from the app's bundled samples. In
// a release build the bytes are read from the file the asset system unpacked;
// in a development build they come over the wire from Metro, whose asset URLs
// Expo's own downloader rejects and whose "localhost" the phone cannot
// resolve, so the fallback fetches from the loopback address. A few at a
// time, so a phone on a USB link is not asked for thirty files at once.
async function bytesFor(asset: Asset): Promise<ArrayBuffer> {
  try {
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    if (Platform.OS === 'web' || uri.startsWith('http')) return await (await fetch(uri)).arrayBuffer();
    return await new File(uri).arrayBuffer();
  } catch {
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
      const bytes = await withTimeout(bytesFor(asset), 20_000, `read ${s.id}`);
      const t1 = Date.now();
      const buffer = await withTimeout(decodeAudioData(bytes, sampleRate), 20_000, `decode ${s.id}`);
      if (buffer.length === 0) throw new Error(`sample ${s.id} decoded to nothing`);
      buffers.set(s.id, buffer);
      if (__DEV__) console.log(`sample ${s.id}: ${bytes.byteLength} bytes read in ${t1 - t0} ms, decoded ${buffer.duration.toFixed(1)} s in ${Date.now() - t1} ms`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return buffers;
}
