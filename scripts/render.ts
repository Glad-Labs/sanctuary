// Render the drone offline to a WAV so it can be listened to and measured
// without a device. Usage: npx tsx scripts/render.ts [seconds] [out.wav]
import { readFileSync, writeFileSync } from 'node:fs';
import { OfflineAudioContext } from 'node-web-audio-api';
import { createDrone, energyAt, type Buffers } from '../src/audio/drone';
import { SAMPLES } from '../src/audio/manifest';
import { DEFAULT_SCORE, sanitize, type Score } from '../src/arranger/score';

async function main() {
  const SECONDS = Number(process.argv[2] ?? 72);
  const OUT = process.argv[3] ?? 'drone.wav';
  // Optional: render a specific score. Usage: render.ts 72 out.wav score.json
  const body = process.argv[4] ? sanitize(JSON.parse(readFileSync(process.argv[4], 'utf8'))) : null;
  if (process.argv[4] && !body) throw new Error('score file failed sanitize()');
  const scoreBody = body ?? DEFAULT_SCORE;
  console.log(`score: "${scoreBody.title}"  chords ${scoreBody.chords.length}  tide ${scoreBody.tide.minutes} min`);
  const RATE = 44100;

  const ctx = new OfflineAudioContext(2, RATE * SECONDS, RATE);
  const buffers: Buffers = new Map();
  for (const s of SAMPLES) {
    const bytes = readFileSync(`assets/samples/${s.file}`);
    const decoded = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    buffers.set(s.id, decoded as never);
  }
  // Any audio-context-shaped object works; the drone only uses the standard API.
  // Optional: hear the room from a listener's hour. LOCAL_HOUR=2 for 2am.
  const localHour = process.env.LOCAL_HOUR !== undefined ? Number(process.env.LOCAL_HOUR) : undefined;
  const drone = createDrone(ctx as never, 'rest', { autoTick: false, buffers, native: process.env.NATIVE === '1', localHour: localHour !== undefined ? () => localHour : undefined });

  // Start on the rising tide, a few minutes in, so the room builds over the render.
  const TIDE_S = scoreBody.tide.minutes * 60;
  // TIDE_OFFSET=<seconds into the tide> to start elsewhere, e.g. the peak.
  const wall0 = Math.floor(Date.now() / 1000 / TIDE_S) * TIDE_S + Number(process.env.TIDE_OFFSET ?? 200);
  console.log(`energy ${energyAt(wall0, scoreBody.tide).toFixed(2)} -> ${energyAt(wall0 + SECONDS, scoreBody.tide).toFixed(2)}`);
  const score: Score = { ...scoreBody, validFrom: 0, ttl: 600, source: 'composer' };
  drone.setScore(score);
  // LISTENERS=<n> to hear the room at a given size (default 2400).
  drone.setListeners(Number(process.env.LISTENERS ?? 2400));
  drone.start(0);
  for (let s = 0; s < SECONDS; s += 0.2) {
    drone.tick(wall0 + s, s);
    if (Math.abs(s - 15) < 0.01 || Math.abs(s - 40) < 0.01) for (let i = 0; i < 4; i++) drone.join(s);
  }

  console.log(`melody notes scheduled: ${drone.status().melodyNotes}`);
  const rendered = await ctx.startRendering();
  const L = rendered.getChannelData(0);
  const R = rendered.getChannelData(1);
  let peak = 0, sumSq = 0;
  for (let i = 0; i < L.length; i++) {
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    sumSq += L[i] * L[i] + R[i] * R[i];
  }
  const rms = Math.sqrt(sumSq / (2 * L.length));
  console.log(`peak ${peak.toFixed(3)}  rms ${rms.toFixed(3)}  (${(20 * Math.log10(rms)).toFixed(1)} dBFS)`);

  const frames = L.length;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0, o = 44; i < frames; i++, o += 4) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), o);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), o + 2);
  }
  writeFileSync(OUT, buf);
  console.log(`wrote ${OUT} (${SECONDS}s stereo)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
