#!/bin/bash
# Build a signed, single-architecture release APK to hand to other people.
# Needs ~/.sanctuary/release.keystore and ~/.sanctuary/keystore.env (see README).
set -e
cd "$(dirname "$0")/.."
source scripts/android-env.sh
set -a; source ~/.sanctuary/keystore.env; set +a
export SANCTUARY_KEYSTORE="$HOME/.sanctuary/release.keystore"
export EXPO_PUBLIC_SCORE_URL="${EXPO_PUBLIC_SCORE_URL:-http://100.111.15.72:8091/score}"
export CI=1
npx expo prebuild --platform android --no-install >/dev/null
(cd android && ./gradlew assembleRelease -q 2>&1 | grep -vE "^Deprecated|warning|^$" || true)
APK=android/app/build/outputs/apk/release/app-release.apk
VERSION=$(node -p "require('./app.json').expo.version")
OUT="dist/sanctuary-$VERSION.apk"
mkdir -p dist && cp "$APK" "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1)), signed by: $("$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs "$OUT" | grep -oE 'CN=[^,]+' | head -1)"
