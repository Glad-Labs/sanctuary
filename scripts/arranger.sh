#!/usr/bin/env bash
# Start the arranger with the secrets in ~/.sanctuary/sanctuary.env.
# Extra environment on the command line wins, e.g. ARRANGER_BACKEND=none.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${SANCTUARY_ENV:-$HOME/.sanctuary/sanctuary.env}"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" == \#* ]] && continue
    [ -z "${!k:-}" ] && [ -n "$v" ] && export "$k=$v"
  done < "$ENV_FILE"
fi
exec npx tsx server/index.ts
