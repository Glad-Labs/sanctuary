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
  how many points of light fill the screen: one per person while the room is
  small, easing into a full field past a few hundred. Each arrival is a soft
  vibraphone ring.
- **One shared breath** (`src/breath.ts`). Five seconds in, five out, the
  pace of a resting breath, with a natural pause at each end, phased from
  the wall clock so the whole world inhales together. The sun brightens,
  the moon steps a frame, the ring around them swells, the sea swells, and
  the phone pulses at each turn of the breath. The bodies never change size.
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

The score also carries a **melody**: a sparse line in a small notation
(note names with octave, `~` rests, `[]` to subdivide, `<>` to alternate
between cycles, `@n`, `*n`, `!`), played by the engine itself with the flute
or a violin on the shared clock, so every device plays the same note at the
same moment, on the web and native alike. The arranger never hands the app
code, only notes and rests; `sanitizeMelody()` rejects anything else, turns
any note outside the score's voicings into a rest, and checks the pattern
reads (`src/audio/pattern.ts`).

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

## The stage

A performer is one more layer in the weave, arriving over the network. Open
the web build with `?perform=1&key=<performer key>&name=<your name>` for the
performer console: it shows the voicing sounding now and the next one with
its countdown, the tide, the calm, and who is here, and a go-live control
that publishes the microphone (or a soft test tone with `&tone=1`) into the
LiveKit room as high-quality stereo with echo cancellation, noise suppression
and gain control off. The arranger mints performer tokens only against
`PERFORMER_KEY` (default `sanctuary-stage-dev`; change it).

Every listener already subscribes. On the web the track plays through an
audio element; a phone joins the room only while someone is on stage, so
WebRTC stays out of its audio path the rest of the time (another audio
engine in the process makes the output stream reopen and the engine's clock
reset, which the engine now survives by rescheduling from the wall clock).
Within fifteen seconds of someone going live the arranger publishes a live
score: harmony held for minutes at a time, few voices, no melody, the sea and
shimmer back, titled with the performer's name; the previous kind of score
returns when they leave.

## Trying the room at any size

Add `?people=40` (or any number) to the web URL, or set
`globalThis.__listenersOverride = 4000` in a console, and the room becomes
that size: voices, shimmer, bowls, and the points of light all follow.
`__sanctuary.drone.status()` in a dev console shows what the engine is
doing with it. Offline, `LISTENERS=40 npx tsx scripts/render.ts 30 out.wav`.

## Presence: the real room

Presence is a LiveKit room, one per Sanctuary room, self-hosted on this
machine in Docker and reached over Tailscale. Every device joins as a silent
participant (subscribe only, no microphone) carrying its UTC offset as
metadata, so the count is real and the arranger gets a true histogram of
the listeners' local hours. The same connection will carry a performer's
audio later.

```bash
docker run -d --name sanctuary-livekit --restart unless-stopped \
  --network host \
  -v "$PWD/server/livekit.yaml:/etc/livekit.yaml:ro" \
  livekit/livekit-server:latest --config /etc/livekit.yaml
```

Host networking matters: behind Docker's port mapping, WebRTC's media
connection completes only for clients on this machine, and a phone on the
Tailscale network is dropped a few seconds after joining.

The arranger mints join tokens (`GET /token?room=rest&tz=<minutes east of
UTC>`) and reports the room (`GET /presence`). `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` configure it; the defaults match
`server/livekit.yaml`, which holds development keys for a private network
and must change before anyone else uses this. The arranger and LiveKit are plain HTTP and WebSocket on the private
network, so the Android build allows cleartext traffic (`expo-build-
properties` in `app.json`); a public deployment puts both behind TLS and
drops that. Without a token endpoint, or
when the room is unreachable, the app falls back to the simulated presence
in `src/presence.ts`, and `?people=N` overrides either.

## On the phone

Three things learned the hard way on a Pixel 9, all handled in the code:

- **React Native stops delivering JavaScript timers while the activity is
  paused, and a locked screen pauses it.** The engine's scheduler used to
  die within seconds of the screen locking and the sound ran out. On
  Android everything that keeps time (the engine tick, the breath, presence,
  the score poll) now runs off a native 100 ms clock in `modules/pulse`,
  which keeps ticking with the screen off. Verify with
  `adb logcat | grep "diag ctx"` while the phone is locked.
- **Android 17 mutes background audio without a foreground service.** About
  five seconds after the app leaves the screen the system silences it, and
  `adb shell dumpsys audio | grep AudioHardening` records the decision. The
  audio library's playback notification is a media-playback foreground
  service, so the app shows it the moment the room begins, while visible; it
  is also the lock-screen card, with a single stop control.
- **Haptics.** Every haptics library sends its pulses as touch feedback,
  which Android drops when the user has touch feedback switched off. The
  same module sends the breath as media vibration.
- **Judge audio only on a release build.** A debug build compiles the audio
  library's DSP unoptimized; its render thread pins a core and the sound
  chops. `npx expo run:android --variant release`.

The samples are always handed to the decoder as bytes: on the phone its
file-path route produced silent buffers from the app's bundled assets.

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
Expo Go will not work. Build a development client. On this machine a JDK
and the Android SDK are installed under the home directory; load them,
plug in a phone with USB debugging on, and build:

```bash
source scripts/android-env.sh && npx expo run:android
```

To hand the app to someone else, build a signed release for 64-bit ARM
only (a fraction of the size of the development build, which carries
every architecture):

```bash
scripts/release.sh
```

It writes `dist/sanctuary-<version>.apk`, signed with the Glad Labs key.
The key lives outside the repo: `~/.sanctuary/release.keystore` and
`~/.sanctuary/keystore.env` (the passwords), created once with `keytool`
and never committed. The same key must sign every future build or Android
refuses the update, so back those two files up. The arranger address is
baked in from `EXPO_PUBLIC_SCORE_URL` at build time, so a recipient must be
on the Tailscale network for presence and the arranger; the room itself
plays without them.

iOS needs a Mac or an EAS cloud build:

```bash
npx expo run:ios
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
recording's fundamental; `node scripts/onsets.mjs file.mp3` counts the
strikes inside a sample.

In development the audio graph is exposed as `globalThis.__sanctuary`
(`ctx`, `drone`). `drone.level()` returns the RMS of what is reaching the
speaker, which is how the web build was verified to be producing sound.
