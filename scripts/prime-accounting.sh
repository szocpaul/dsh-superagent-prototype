#!/bin/sh
# prime-accounting.sh - the accounting command of the Prime Runner Bridge quota guard.
#
# Usage: prime-accounting.sh <session.jsonl>
#
# Prints two lines the guard parses:
#   tokens=N   the billed tokens of the session inside the trailing five hours
#   scope=session
#
# The scope is stated honestly: it counts one session file. It is not an
# account-wide quota, and the guard's own output says so. The command reads no
# credential and prints none.
set -u
SESSION="${1:-}"
[ -n "$SESSION" ] || { printf 'prime-accounting: a session file is required\n' >&2; exit 1; }
[ -r "$SESSION" ] || { printf 'prime-accounting: the session file cannot be read\n' >&2; exit 1; }
python3 - "$SESSION" <<'PY'
import json, sys, time
from datetime import datetime
cut = time.time() - 5 * 3600
total = 0
try:
    with open(sys.argv[1], errors='ignore') as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except Exception:
                continue
            message = record.get('message') or {}
            usage = message.get('usage')
            if not usage or message.get('role') != 'assistant':
                continue
            stamp = record.get('timestamp')
            if isinstance(stamp, str):
                try:
                    stamp = datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp()
                except Exception:
                    continue
            elif isinstance(stamp, (int, float)):
                stamp = stamp / 1000 if stamp > 1e12 else stamp
            else:
                continue
            if stamp < cut:
                continue
            total += (usage.get('input', 0) + usage.get('cacheRead', 0)
                      + usage.get('cacheWrite', 0) + usage.get('output', 0))
except OSError:
    print('prime-accounting: the session file cannot be read', file=sys.stderr)
    sys.exit(1)
print(f'tokens={total}')
print('scope=session')
PY
