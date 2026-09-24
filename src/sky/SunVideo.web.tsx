// The sun, cooking: NASA's 48-hour SDO time-lapse movies, played through the
// same radial mask as the stills, the red chromosphere crossfading to the
// gold corona by the sun's height. Web only; the browser streams the files.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { sunMovieUris } from './live';

const RATE = 0.6; // a little slower than NASA's cut, calmer

export function SunVideo({ size, disc, high, nowMs }: { size: number; disc: number; high: number; nowMs: number }) {
  const [failed, setFailed] = useState(false);
  const uris = useMemo(() => sunMovieUris(nowMs), [nowMs]);
  const hot = useRef<HTMLVideoElement>(null);
  const gold = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const v of [hot.current, gold.current]) {
      if (!v) continue;
      v.playbackRate = RATE;
      v.play().catch(() => {});
    }
  }, [uris]);
  // One clock for both films, and no hard loop. The red film is the master
  // and the gold one is held to it, so the two never drift apart into a
  // double image. Near the end the films dissolve out to the still beneath
  // (NASA's latest frame, which is where the films end), restart, and
  // dissolve back in: a soft return to two days ago instead of a jump.
  // Styles are written only when they change: the films sit in a masked,
  // screen-blended layer, and rewriting a filter on them every frame (the
  // breath used to brighten them here) made the page choppy. The breath
  // brightens the sun through the glow drawn over it instead.
  useEffect(() => {
    let raf = 0;
    let shown = -1;
    const FADE = 3; // seconds, in film time
    const tick = () => {
      const h = hot.current;
      const g = gold.current;
      if (h && g) {
        const len = Math.min(h.duration || Infinity, g.duration || Infinity);
        if (Number.isFinite(len) && len > 2 * FADE) {
          if (Math.abs(g.currentTime - h.currentTime) > 0.12) g.currentTime = h.currentTime;
          const t = h.currentTime;
          let fade = 1;
          if (t >= len - 0.08) {
            h.currentTime = 0;
            g.currentTime = 0;
            fade = 0;
          } else if (t > len - FADE) fade = (len - t) / FADE;
          else if (t < FADE) fade = t / FADE;
          const opacity = Math.round(Math.max(0, Math.min(1, fade)) * 100) / 100;
          if (frame.current && opacity !== shown) {
            frame.current.style.opacity = String(opacity);
            shown = opacity;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  if (failed) return null;

  const video = size / disc; // the frame, scaled so the disc matches the orb
  const crop = 0.94; // show the middle 94%: keeps the ragged limb, loses NASA's caption
  const box = video * crop;
  const inset = -(video - box) / 2;
  // The movie is composited with a screen blend, so its black sky adds
  // nothing to the ground behind it and only the sun's own light shows:
  // prominences and corona glow past the limb with no edge. A soft circular
  // mask still removes the frame's corners and caption.
  const mask = `radial-gradient(circle closest-side at center, #000 0%, #000 88%, transparent 100%)`;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: -(box - size) / 2,
    top: -(box - size) / 2,
    width: box,
    height: box,
    overflow: 'hidden',
    WebkitMaskImage: mask,
    maskImage: mask,
    mixBlendMode: 'screen',
    pointerEvents: 'none',
  };
  const layer = (uri: string, opacity: number, ref: React.RefObject<HTMLVideoElement | null>): React.ReactElement =>
    React.createElement('video', {
      ref,
      src: uri,
      autoPlay: true,
      muted: true,
      loop: false,
      playsInline: true,
      preload: 'auto',
      onError: () => setFailed(true),
      style: { position: 'absolute', left: inset, top: inset, width: video, height: video, opacity, filter: 'brightness(1.17) saturate(1.05)', transition: 'opacity 2s linear' },
    });
  return React.createElement('div', { ref: frame, style }, layer(uris.hot, 1, hot), layer(uris.gold, high, gold));
}
