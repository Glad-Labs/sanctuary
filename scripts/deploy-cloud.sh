#!/usr/bin/env bash
# Build the web app and deploy it, with the API and the room, to Cloudflare.
# Secrets come from ~/.sanctuary/sanctuary.env and go straight to Cloudflare
# over stdin; they are never written to disk or printed.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${SANCTUARY_ENV:-$HOME/.sanctuary/sanctuary.env}"

# the web app, served from the same origin as its API
rm -rf web-dist
env -u EXPO_PUBLIC_SCORE_URL npx expo export -p web --output-dir web-dist >/dev/null
echo "web app exported ($(du -sh web-dist | cut -f1))"

npx wrangler deploy -c cloud/wrangler.jsonc

python3 - "$ENV_FILE" <<'EOF' | npx wrangler secret bulk -c cloud/wrangler.jsonc >/dev/null
import json, sys
env = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1)
        env[k] = v
need = ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'PERFORMER_KEY', 'PUBLISH_KEY']
missing = [k for k in need if not env.get(k)]
if missing:
    sys.exit(f"missing in {sys.argv[1]}: {', '.join(missing)}")
print(json.dumps({k: env[k] for k in need}))
EOF
echo "secrets set: LIVEKIT_API_KEY LIVEKIT_API_SECRET PERFORMER_KEY PUBLISH_KEY"
