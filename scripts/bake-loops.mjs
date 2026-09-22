// Turn short recorded sustains into seamless 16 s loops by crossfading the
// recording over itself, so every voice can be played as long overlapping
// instances without gaps. Overwrites assets/samples/<id>.mp3 for sustains.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { OfflineAudioContext } from 'node-web-audio-api';
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
const TARGET_S = 16, RATE = 44100;
const ids = process.argv.slice(2);
for (const id of ids) {
  const file = `assets/samples/${id}.mp3`;
  const bytes = readFileSync(file);
  const probe = new OfflineAudioContext(1, 1, RATE);
  const src = await probe.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const d = src.duration;
  const head = 0.2, tail = 0.35;               // skip the attack and the release
  const region = d - head - tail;
  const fade = Math.min(3, region / 3);
  const step = region - fade;
  const ctx = new OfflineAudioContext(1, RATE * TARGET_S, RATE);
  for (let k = 0, t = 0; t < TARGET_S; k++, t += step) {
    const s = ctx.createBufferSource(); s.buffer = src;
    const g = ctx.createGain();
    const end = Math.min(t + region, TARGET_S + fade);
    // equal-power crossfade: sin for the way in, cos for the way out
    const curveIn = new Float32Array(64).map((_, i) => Math.sin((Math.PI / 2) * (i / 63)));
    const curveOut = new Float32Array(64).map((_, i) => Math.cos((Math.PI / 2) * (i / 63)));
    g.gain.setValueAtTime(k === 0 ? 1 : 0, t);
    if (k > 0) g.gain.setValueCurveAtTime(curveIn, t, fade);
    g.gain.setValueAtTime(1, t + fade + 0.001);
    g.gain.setValueCurveAtTime(curveOut, Math.max(t + fade + 0.002, end - fade), fade);
    s.connect(g); g.connect(ctx.destination);
    s.start(t, head, end - t);
  }
  const out = await ctx.startRendering();
  const x = out.getChannelData(0);
  const wav = Buffer.alloc(44 + x.length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + x.length * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  const tmp = `/tmp/claude-1000/-home-mattm-glad-labs-products/b30f4df3-7c23-4a0c-80b5-2121542d4079/scratchpad/${id}.wav`;
  writeFileSync(tmp, wav);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', tmp, '-codec:a', 'libmp3lame', '-b:a', '96k', file]);
  unlinkSync(tmp);
  console.log(`${id.padEnd(14)} ${d.toFixed(1)}s -> ${TARGET_S}s  (region ${region.toFixed(1)}s, fade ${fade.toFixed(1)}s)`);
}
