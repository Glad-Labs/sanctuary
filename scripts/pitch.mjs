// Estimate the fundamental of a recording (for bowls and gongs whose pitch we don't know).
// Usage: node scripts/pitch.mjs file [file...]
import { readFileSync } from 'node:fs';
import { OfflineAudioContext } from 'node-web-audio-api';
const midiName = (m) => ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][Math.round(m) % 12] + (Math.floor(Math.round(m) / 12) - 1);
for (const file of process.argv.slice(2)) {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await ctx.decodeAudioData(readFileSync(file).buffer.slice(0));
  const x = buf.getChannelData(0), rate = buf.sampleRate;
  // analyse 0.3 s after the attack, 2^16 window, hann
  const N = 1 << 16, start = Math.min(Math.floor(rate * 0.3), Math.max(0, x.length - N));
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  fft(re, im);
  const mag = new Float64Array(N / 2); for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  // harmonic product spectrum for a robust fundamental
  const hps = new Float64Array(N / 8);
  for (let k = 1; k < N / 8; k++) hps[k] = mag[k] * mag[2 * k] * mag[3 * k];
  let best = 1; for (let k = Math.floor(40 * N / rate); k < N / 8; k++) if (hps[k] > hps[best]) best = k;
  let peak = 1; for (let k = Math.floor(40 * N / rate); k < N / 4; k++) if (mag[k] > mag[peak]) peak = k;
  const hz = best * rate / N, peakHz = peak * rate / N;
  const midi = 69 + 12 * Math.log2(hz / 440);
  console.log(`${file.split('/').pop().padEnd(22)} hps ${hz.toFixed(1).padStart(7)} Hz ≈ ${midiName(midi)} (${midi.toFixed(2)})   loudest partial ${peakHz.toFixed(1)} Hz   ${buf.duration.toFixed(1)}s`);
}
function fft(re, im) { const n = re.length; for (let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
  for (let len=2;len<=n;len<<=1){const ang=-2*Math.PI/len,wr=Math.cos(ang),wi=Math.sin(ang);for(let i=0;i<n;i+=len){let cr=1,ci=0;for(let k=0;k<len/2;k++){const a=i+k,b=a+len/2;const tr=re[b]*cr-im[b]*ci,ti=re[b]*ci+im[b]*cr;re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;const nr=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=nr;}}}}
