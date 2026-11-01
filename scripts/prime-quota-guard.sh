#!/bin/sh
# prime-quota-guard.sh - the project-owned quota guard for one Prime runner bridge run.
#
# Usage:
#   prime-quota-guard.sh --session FILE --log FILE --warn N --stop N \
#     --alert FILE --cgroup DIR -- <accounting command> [args...]
#   prime-quota-guard.sh --session FILE --log FILE --warn N --stop N \
#     --alert FILE --cgroup DIR --emergency
#
# The accounting command is run once and its output is parsed for the lines
# "tokens=N" and "scope=session|log|account". The script never falls back to a
# hardcoded session name and never reads a claim the agent made about its own
# usage; an unreadable accounting source fails closed.
#
# Exit codes:
#   0  usage is below the warning threshold
#   1  usage crossed the warning threshold, an alert was written
#   2  usage crossed the stop threshold, the run's cgroup was stopped
#   3  the accounting source could not be read, the run was stopped (fail closed)
#   4  the run's cgroup could not be stopped

set -u

SESSION=""
LOG=""
WARN=""
STOP=""
ALERT=""
CGROUP=""
TOKENS=""
SCOPE=""
EMERGENCY=0

die() {
  printf 'prime-quota-guard: %s\n' "$*" >&2
  exit 64
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --session) [ "$#" -ge 2 ] || die "--session needs a value"; SESSION="$2"; shift 2 ;;
    --log) [ "$#" -ge 2 ] || die "--log needs a value"; LOG="$2"; shift 2 ;;
    --warn) [ "$#" -ge 2 ] || die "--warn needs a value"; WARN="$2"; shift 2 ;;
    --stop) [ "$#" -ge 2 ] || die "--stop needs a value"; STOP="$2"; shift 2 ;;
    --alert) [ "$#" -ge 2 ] || die "--alert needs a value"; ALERT="$2"; shift 2 ;;
    --cgroup) [ "$#" -ge 2 ] || die "--cgroup needs a value"; CGROUP="$2"; shift 2 ;;
    --emergency) EMERGENCY=1; shift ;;
    --) shift; break ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$SESSION" ] || die "--session is required"
[ -n "$LOG" ] || die "--log is required"
[ -n "$WARN" ] || die "--warn is required"
[ -n "$STOP" ] || die "--stop is required"
[ -n "$ALERT" ] || die "--alert is required"
[ -n "$CGROUP" ] || die "--cgroup is required"
case "$WARN" in ''|*[!0-9]*) die "--warn must be a whole number of tokens" ;; esac
case "$STOP" in ''|*[!0-9]*) die "--stop must be a whole number of tokens" ;; esac
[ "$EMERGENCY" -eq 1 ] || [ "$#" -gt 0 ] || die "an accounting command is required after --"
if [ "$EMERGENCY" -eq 0 ]; then
  ACCOUNTING="$1"
  shift
fi

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

write_log() {
  [ -n "$LOG" ] || return 0
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  printf '%s status=%s reason=%s tokens=%s scope=%s session=%s\n' \
    "$(now)" "$1" "$2" "${TOKENS:-null}" "${SCOPE:-null}" "$SESSION" >> "$LOG" 2>/dev/null || true
}

write_alert() {
  [ -n "$ALERT" ] || return 0
  mkdir -p "$(dirname "$ALERT")" 2>/dev/null || true
  printf '{"schemaVersion":1,"at":"%s","status":"%s","reason":"%s","tokens":%s,"scope":"%s","warnTokens":%s,"stopTokens":%s,"sessionFile":"%s","cgroup":"%s"}\n' \
    "$(now)" "$1" "$2" "${TOKENS:-null}" "${SCOPE:-null}" "$WARN" "$STOP" \
    "$(json_escape "$SESSION")" "$(json_escape "$CGROUP")" >> "$ALERT" 2>/dev/null || true
}

stop_cgroup() {
  [ -n "$CGROUP" ] || return 1
  [ -d "$CGROUP" ] || return 1
  [ -f "$CGROUP/cgroup.kill" ] || return 1
  printf '1' > "$CGROUP/cgroup.kill" 2>/dev/null || return 1
  return 0
}

if [ "$EMERGENCY" -eq 1 ]; then
  write_alert stop "emergency-stop"
  write_log stop "emergency-stop"
  if stop_cgroup; then
    printf 'verdict=stop\nreason=emergency-stop\ncoverage=emergency-stop-of-this-run\n'
    exit 2
  fi
  write_alert stop "cgroup-stop-failed"
  write_log stop "cgroup-stop-failed"
  printf 'prime-quota-guard: the cgroup %s could not be stopped\n' "$CGROUP" >&2
  printf 'verdict=stop\nreason=cgroup-stop-failed\n'
  exit 4
fi

fail_closed() {
  reason="$1"
  TOKENS=""
  SCOPE=""
  write_alert stop "$reason"
  write_log stop "$reason"
  if ! stop_cgroup; then
    write_alert stop "cgroup-stop-failed"
    write_log stop "cgroup-stop-failed"
    printf 'prime-quota-guard: the cgroup %s could not be stopped\n' "$CGROUP" >&2
  fi
  printf 'verdict=stop\nreason=%s\ncoverage=unreadable-accounting\n' "$reason"
  exit 3
}

if ! OUTPUT=$("$ACCOUNTING" "$@" 2>&1); then
  fail_closed "accounting-unreadable"
fi

TOKENS=$(printf '%s\n' "$OUTPUT" | awk -F= '/^[[:space:]]*tokens=/{gsub(/[[:space:]]/,"",$2); print $2; exit}')
SCOPE=$(printf '%s\n' "$OUTPUT" | awk -F= '/^[[:space:]]*scope=/{gsub(/[[:space:]]/,"",$2); print $2; exit}')
case "$TOKENS" in ''|*[!0-9]*) fail_closed "accounting-unreadable" ;; esac
case "$SCOPE" in
  session|log|account) ;;
  *) fail_closed "accounting-scope-unknown" ;;
esac

if [ "$TOKENS" -ge "$STOP" ]; then
  write_alert stop "stop-threshold"
  write_log stop "stop-threshold"
  if stop_cgroup; then
    printf 'verdict=stop\ntokens=%s\nscope=%s\ncoverage=%s-tokens-not-a-billed-account-quota\n' "$TOKENS" "$SCOPE" "$SCOPE"
    exit 2
  fi
  write_alert stop "cgroup-stop-failed"
  write_log stop "cgroup-stop-failed"
  printf 'prime-quota-guard: the cgroup %s could not be stopped\n' "$CGROUP" >&2
  printf 'verdict=stop\nreason=cgroup-stop-failed\ntokens=%s\nscope=%s\n' "$TOKENS" "$SCOPE"
  exit 4
fi

if [ "$TOKENS" -ge "$WARN" ]; then
  write_alert warn "warn-threshold"
  write_log warn "warn-threshold"
  printf 'verdict=warn\ntokens=%s\nscope=%s\ncoverage=%s-tokens-not-a-billed-account-quota\n' "$TOKENS" "$SCOPE" "$SCOPE"
  exit 1
fi

write_log ok "below-thresholds"
printf 'verdict=ok\ntokens=%s\nscope=%s\ncoverage=%s-tokens-not-a-billed-account-quota\n' "$TOKENS" "$SCOPE" "$SCOPE"
exit 0
