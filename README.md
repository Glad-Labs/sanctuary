# Sanctuary

The one-minute experience. You open it, a sound is already fading in, and a
dim sphere breathes. Nothing on screen says how many people are here; you
hear it in how full the room sounds and see it in the points of light around
the sphere. The colour of the room follows the sun where you are. Put the
phone face down; the sound keeps going. Nothing to sign up for, nothing to
tap.

This is a prototype built to answer one question: do strangers want to sit
in a shared, synchronized ambient room, and do they feel less alone
afterward? Put it in front of twenty people with their eyes closed.

## What it does

- **Drone made of recorded instruments** (`src/audio/drone.ts`). Every
  device computes the same arrangement from wall-clock time, so nothing is
  streamed and nothing has to be synced. Seven voices of CC0 orchestral
  sustains (contrabass, cellos, violas, violins, flute) are played as
  overlapping, crossfaded instances on a shared schedule, pitched to a chord
  that drifts through four voicings around A every 48 seconds, under a slow
  warmth filter and a six-second hall. Bowed cymbals shimmer in as the room
  fills. The sea breathes with everyone. A singing bowl rings once in a
  while, more often the fuller the room, at a moment every device shares.
  Gongs are rare and soft. Samples and credits: `assets/samples/CREDITS.md`.
- **Presence is heard and seen, never counted.** Listener count sets how many
  voices are present, how much shimmer there is, how often bowls ring, and
  how many points of light orbit the sphere. Each arrival is a soft
  vibraphone ring.
- **One shared breath** (`src/breath.ts`). Five seconds in, five out, the
  pace of a resting breath, with a natural pause at each end, phased from
  the wall clock so the whole world inhales together. The orb swells, the
  sea swells, the phone pulses at each turn of the breath.
- **The sky is real, and live.** By day the orb is the sun as NASA's Solar
  Dynamics Observatory sees it right now, the red chromosphere near the
  horizon crossfading to the gold corona toward noon, its limb ragged with
  real prominences; refreshed every half hour. By night it is this hour's
  frame of NASA's 2026 moon, with the real phase, tilt and libration. Offline,
  bundled frames stand in and the phase is drawn on the device
  (`src/sky/live.ts`). Credits in `assets/sky/CREDITS.md`.
- **Time of day is yours, the music is everyone's.** The room is global and
  has no night of its own, so the score is written for the mixture of local
  hours of the people actually in it, never for a clock. On your device, your
  own hour sets the colour of the sphere and where you sit in the hall: at
  your night the sea comes forward and the top voices soften, at your dawn it
  opens. What is played never differs between devices, only the balance.

## The arranger

The engine plays a **score**: voicings, chord length, the shape of the tide,
warmth, density, sea, shimmer, bowls (`src/arranger/score.ts`). One score per
room, shared by every device, applied at `validFrom` so everyone changes
together.

Three writers, in order of preference:

1. **Claude**, in `server/index.ts`. Every ten minutes it reads the room and
   the sky (`src/arranger/inputs.ts`: season, where dawn is, moon phase,
   listeners, and what time it is for the people in the room as shares of
   night, morning, day and evening), takes the composer's draft, refines it,
   and the result is checked by `sanitize()` before anything reaches a
   speaker.
2. **The composer**, `src/arranger/compose.ts`, a deterministic arranger with
   no model. It is the draft Claude starts from and the server's answer when
   no key is set.
3. **The app itself**, when the server is unreachable: it runs the same
   composer on a ten-minute grid, so offline devices still agree.

The score also carries a **melody**: a sparse line in Strudel mini-notation
(lowercase note names with octave and `~` rests), played by Strudel in the
web build above the strings and aligned to the wall clock so every device is
at the same point of the line. The arranger never hands the app code, only
notes and rests; `sanitizeMelody()` rejects anything else and turns any note
outside the score's voicings into a rest. Strudel is Web Audio only, so the
native build plays without the melody for now.

Run the arranger on the same machine as the dev server. With a local model
through Ollama (the default when no Anthropic key is set):

```bash
ARRANGER_BACKEND=ollama OLLAMA_MODEL=qwen3.6:27b npx tsx server/index.ts
```

Or with Claude:

```bash
ANTHROPIC_API_KEY=... ARRANGER_BACKEND=anthropic npx tsx server/index.ts
```

It serves `GET /score` and `GET /history` on port 8091 and appends every
decision to `server/scores.jsonl`. The web build finds it on the same host;
a native build reads `EXPO_PUBLIC_SCORE_URL`. Knobs: `ARRANGER_BACKEND`
(`anthropic`, `ollama`, `none`), `ARRANGER_MODEL` (`claude-opus-5`),
`OLLAMA_MODEL`, `OLLAMA_URL`, `ARRANGER_INTERVAL_MIN` (10),
`ARRANGER_LEAD_S` (120, how far ahead a score is published before it applies).

Render any score to listen to it:

```bash
npx tsx scripts/render.ts 72 out.wav path/to/score.json
```

## What is stubbed

- `src/presence.ts` simulates the listener count. It is a pure function of
  time, so every device shows the same number and hears the same arrivals
  together. Swap its body for a Supabase Realtime presence channel; the
  callback contract stays the same.

## Running

Web, for a quick look (the browser needs one touch before it will play):

```bash
npx expo start --web
```

The dev server listens on every interface, so a phone on the same Tailscale
network can open `http://<tailscale-ip>:8090` and try it in a mobile browser.
Haptics do not work on the web and audio stops when the screen locks. Those
need the native build below.

Phone, which is the real thing. The audio engine is a native module, so
Expo Go will not work. Build a development client:

```bash
npx expo run:ios
npx expo run:android
```

Background audio and the media-playback foreground service are configured
through the `react-native-audio-api` plugin in `app.json`.

## Checks

```bash
npx tsc --noEmit
```

Render the drone offline to listen without a device, or to measure it:

```bash
npx tsx scripts/render.ts 48 drone.wav
```

`node scripts/manifest.mjs` regenerates the sample manifest after adding
files to `assets/samples`; `node scripts/pitch.mjs file.wav` estimates a
recording's fundamental.

In development the audio graph is exposed as `globalThis.__sanctuary`
(`ctx`, `drone`). `drone.level()` returns the RMS of what is reaching the
speaker, which is how the web build was verified to be producing sound.
