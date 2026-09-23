import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = Platform.OS === 'android' ? requireOptionalNativeModule<{ pulse(ms: number, amplitude: number): boolean }>('Pulse') : null;

/** A short vibration, sent as media vibration so it is not dropped as touch feedback. */
export function pulse(ms: number, amplitude = 160): boolean {
  return native?.pulse(Math.round(ms), Math.round(amplitude)) ?? false;
}
