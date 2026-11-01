#!/bin/sh
# prime-backend-smoke.sh - the minimal real model call the bridge's preflight runs.
#
# It asks the provider's models endpoint with the provider's own key and prints
# only the HTTP status code. It never prints the key, and it fails when the
# backend does not answer with a success, so the preflight blocks the launch
# instead of pretending the backend works.
set -u
PROVIDER="${DSH_PRIME_SMOKE_PROVIDER:-minimax}"
CONFIG="${DSH_PRIME_SMOKE_CONFIG:-$HOME/.prime/agent/models.json}"
[ -r "$CONFIG" ] || { printf 'no model configuration at %s\n' "$CONFIG" >&2; exit 1; }
URL=$(python3 - "$CONFIG" "$PROVIDER" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
provider = (config.get('providers') or {}).get(sys.argv[2]) or {}
print(provider.get('baseUrl') or '')
PY
)
[ -n "$URL" ] || { printf 'the provider %s has no base URL\n' "$PROVIDER" >&2; exit 1; }
CODE=$(python3 - "$CONFIG" "$PROVIDER" <<'PY'
import json, sys, urllib.request
config = json.load(open(sys.argv[1]))
provider = (config.get('providers') or {}).get(sys.argv[2]) or {}
key = provider.get('apiKey') or ''
request = urllib.request.Request((provider.get('baseUrl') or '').rstrip('/') + '/models',
                                 headers={'Authorization': 'Bearer ' + key})
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        print(response.status)
except Exception as error:
    print(getattr(error, 'code', 0) or 0)
PY
)
printf '%s\n' "$CODE"
case "$CODE" in
  2??) exit 0 ;;
  *) printf 'the model backend answered with %s\n' "$CODE" >&2; exit 1 ;;
esac
