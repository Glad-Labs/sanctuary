import { Asset } from 'expo-asset';
import { Platform } from 'react-native';
import { decodeAudioData } from 'react-native-audio-api';
import { SAMPLE_ASSETS } from './assets';
import { SAMPLES } from './manifest';
import type { Buffers } from './drone';

// Decode every bundled sample once. About four megabytes of MP3; a second or two.
export async function loadBuffers(sampleRate?: number): Promise<Buffers> {
  const entries = await Promise.all(
    SAMPLES.map(async (s) => {
      const asset = Asset.fromModule(SAMPLE_ASSETS[s.id]);
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      const input = Platform.OS === 'web' ? await (await fetch(uri)).arrayBuffer() : uri;
      return [s.id, await decodeAudioData(input, sampleRate)] as const;
    }),
  );
  return new Map(entries);
}
