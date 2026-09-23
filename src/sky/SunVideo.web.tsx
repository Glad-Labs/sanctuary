// The sun, cooking: NASA's 48-hour SDO time-lapse movies, played through the
// same radial mask as the stills, the red chromosphere crossfading to the
// gold corona by the sun's height. Web only; the browser streams the files.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { breathAt } from '../breath';
import { sunMovieUris } from './live';

const RATE = 0.6; // a little slower than NASA's cut, calmer

export function SunVideo({ size, disc, high, nowMs }: { size: number; disc: number; high: number; nowMs: number }) {
  const [failed, setFailed] = useState(false);
  const uris = useMemo(() => sunMovieUris(nowMs), [nowMs]);
  const hot = useRef<HTMLVideoElement>(null);
  const gold = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    for (const v of [hot.current, gold.current]) {
      if (!v) continue;
      v.playbackRate = RATE;
      v.play().catch(() => {});
    }
  }, [uris]);
  // The sun breathes in light: its brightness rises with every inhale.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const { fill } = breathAt(Date.now());
      const filter = `brightness(${(1.02 + 0.3 * fill).toFixed(3)}) saturate(1.05)`;
      for (const v of [hot.current, gold.current]) if (v) v.style.filter = filter;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  if (failed) return null;

  const video = size / disc; // the frame, scaled so the disc matches the orb
  const crop = 0.94; // show the middle 94%: keeps the ragged limb, loses NASA's caption
  const box = video * crop;
  const inset = -(video - box) / 2;
  // The mask is opaque out to the disc's edge and fades over the last sliver
  // beyond it, so the limb stays bright, prominences show, and the frame's
  // black corners never do.
  const edge = Math.round((disc / crop) * 100) - 1;
  // closest-side: 100% is the box's half-width, not its corner
  const mask = `radial-gradient(circle closest-side at center, #000 0%, #000 ${edge}%, transparent 100%)`;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: -(box - size) / 2,
    top: -(box - size) / 2,
    width: box,
    height: box,
    overflow: 'hidden',
    WebkitMaskImage: mask,
    maskImage: mask,
    pointerEvents: 'none',
  };
  const layer = (uri: string, opacity: number, ref: React.RefObject<HTMLVideoElement | null>): React.ReactElement =>
    React.createElement('video', {
      ref,
      src: uri,
      autoPlay: true,
      muted: true,
      loop: true,
      playsInline: true,
      preload: 'auto',
      onError: () => setFailed(true),
      style: { position: 'absolute', left: inset, top: inset, width: video, height: video, opacity, transition: 'opacity 2s linear' },
    });
  return React.createElement('div', { style }, layer(uris.hot, 1, hot), layer(uris.gold, high, gold));
}
