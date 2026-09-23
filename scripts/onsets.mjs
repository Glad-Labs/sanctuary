import { readFileSync } from 'node:fs';
import { OfflineAudioContext } from 'node-web-audio-api';
for (const f of process.argv.slice(2)) {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const b = readFileSync(f); const buf = await ctx.decodeAudioData(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const x = buf.getChannelData(0), win = 2205; const env = [];
  for (let i = 0; i + win <= x.length; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += x[j] * x[j]; env.push(Math.sqrt(s / win)); }
  let onsets = 0; for (let i = 2; i < env.length; i++) if (env[i] > env[i - 2] * 2.5 && env[i] > 0.02) onsets++;
  console.log(f.split('/').pop().padEnd(18), buf.duration.toFixed(1) + 's', 'onsets', onsets);
}
