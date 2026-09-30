#!/bin/zsh
# Pure predicate: is a mkdir-style lock directory stale? Extracted from
# scripts/consolidation/mineFromPacket.sh (T169) so the exit-code contract is testable
# against a fixture directory, never against a real `claude -p` run.
#
# THE DEFECT THIS EXISTS TO PREVENT. mineFromPacket.sh takes its lock with
# `mkdir "$LOCK"` (atomic, POSIX) and releases it via `rmdir`/`rm -rf` on every exit path,
# including a `trap ... EXIT INT TERM`. A `kill -9` bypasses the trap. The lock directory
# is then left on disk forever, and every future run for that day reads the `mkdir` failure
# as "another recovery is already running" and SKIPs — permanently, silently. Nothing ever
# mines that day again.
#
# Following gateResultCode.sh's lesson (T168): a predicate over a filesystem path must
# answer three ways, not two — yes, no, and CANNOT TELL — because folding "cannot tell"
# into either yes or no is exactly how absence gets read as an answer it isn't.
#
# Usage: lockIsStale.sh <lock-dir> [<max-age-seconds>]
#   max-age-seconds defaults to 86400 (24h).
#
#   exit 0 — the lock directory exists and is older than max-age-seconds: STALE.
#   exit 1 — NOT STALE. This covers two different situations on purpose:
#              - the lock directory exists and is fresher than max-age-seconds (a real
#                holder is plausibly still working), and
#              - the lock directory does NOT exist at all. A missing lock is not "old" or
#                "new" — there is nothing to break, so the caller should just proceed to
#                take it normally. Folding "missing" into "stale" would make a caller that
#                merely raced past an already-released lock `rm -rf` a path nothing owns;
#                folding it into "cannot tell" would make an ordinary, expected state (no
#                lock exists) require the same caution as a permissions failure. Neither
#                is proportionate, so "missing" gets the same answer as "fresh": there is
#                no stale lock to clear.
#   exit 2 — CANNOT TELL. No lock-dir argument was given, the path exists but `stat` failed
#             on it (permission denied, path changed out from under us, unreadable), or
#             max-age-seconds was given but is not a positive integer. An unreadable lock is
#             not a licence to delete it — the caller must SKIP and say why, not guess.
set -u

if (( $# < 1 )); then
  print -u2 -- "lockIsStale: no lock directory given — cannot determine staleness"
  exit 2
fi

LOCK="$1"
MAX_AGE="${2:-86400}"

if [[ ! "$MAX_AGE" =~ ^[0-9]+$ ]]; then
  print -u2 -- "lockIsStale: max-age-seconds must be a positive integer, got: $MAX_AGE"
  exit 2
fi

if [[ ! -e "$LOCK" ]]; then
  # Missing is not stale — see the exit-1 contract above.
  exit 1
fi

MTIME="$(stat -f %m "$LOCK" 2>/dev/null)"
if [[ -z "$MTIME" ]]; then
  MTIME="$(stat -c %Y "$LOCK" 2>/dev/null)"
fi
if [[ -z "$MTIME" || ! "$MTIME" =~ ^[0-9]+$ ]]; then
  print -u2 -- "lockIsStale: stat failed on $LOCK — cannot determine staleness"
  exit 2
fi

NOW=$(date +%s)
AGE=$(( NOW - MTIME ))

if (( AGE > MAX_AGE )); then
  exit 0
fi

exit 1
