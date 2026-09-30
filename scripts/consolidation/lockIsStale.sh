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
#
# ROUND 2 (Red Hat HIGH finding): age alone is not staleness. A `claude -p` mine that
# legitimately runs past max-age-seconds looked identical, by mtime, to a lock abandoned by
# a `kill -9` — a second invocation would `rm -rf` the first one's still-live lock and
# retake it, and whichever process's `mv` to $PROPOSAL landed second would silently
# overwrite the first's correct output. Age is now only a PRECONDITION for asking about
# liveness, never the answer by itself:
#
#   - age NOT exceeded            -> exit 1 (not stale), full stop. Liveness is never
#                                     consulted — a fresh lock is not stale regardless of
#                                     who holds it or whether that holder is alive.
#   - age exceeded, no holder.pid -> exit 0 (stale). Backward compatibility: a lock taken
#                                     before this change recorded no holder, and an
#                                     age-exceeded lock with nothing to check liveness
#                                     against must stay removable, or the original
#                                     kill-9-orphan bug this file exists to fix comes
#                                     straight back.
#   - age exceeded, holder.pid present and the recorded PID answers `kill -0` -> exit 1
#                                     (not stale) — the process that took the lock is
#                                     still running, however long it has taken.
#   - age exceeded, holder.pid present and the recorded PID does NOT answer `kill -0`
#                                     -> exit 0 (stale) — the holder died without cleaning
#                                     up (the original bug), so the lock is reclaimable.
#   - age exceeded, holder.pid present but malformed (empty, non-numeric, negative)
#                                     -> exit 2 (cannot tell), lock left untouched. A
#                                     malformed pid file is "cannot tell", never a licence
#                                     to delete — same three-valued discipline as an
#                                     unreadable `stat`.
#
# RESIDUAL RISK THIS PREDICATE CANNOT SEE: PID reuse. `kill -0 $pid` only proves SOME
# process currently holds that pid, not that it is the same process that wrote holder.pid.
# After a reboot, or on a long-lived machine that has cycled through the ~4 million pid
# space, a dead holder's pid can be reassigned to an unrelated live process, which would
# make a genuinely abandoned lock look alive forever — reintroducing the original
# kill-9-orphan hang in a rarer, harder-to-diagnose form. Recording and checking the
# holder's process start time (`ps -o lstart=`) alongside the pid would narrow this, but
# was deliberately not built: its output format is locale- and OS-dependent, it adds
# parsing surface with no test able to safely force a real pid-reuse collision to prove it
# correct, and the failure mode it would close is a rare edge case on top of an already
# rare edge case (a day-scale nightly job on one dev machine). If this predicate is ever
# reused somewhere pids cycle fast or reboots are frequent, that tradeoff should be
# revisited.
#
# A SECOND, DISTINCT BLIND SPOT: `kill -0 $pid` also fails non-zero when the pid is alive
# but owned by another user (EPERM), and that failure is indistinguishable from ESRCH (no
# such process) at this predicate's exit-code granularity — so a live holder owned by
# someone else reads as exit 0 (stale), the lock becomes stealable out from under it. This
# is the opposite failure direction from PID reuse above: that one makes a dead lock look
# alive; this one makes a live lock look dead. It is currently unreachable because the
# miner runs as a single user on one developer machine, so every holder.pid it ever writes
# is owned by that same user. It would become reachable the moment this predicate, or a
# lock directory it checks, is shared across users — a multi-user host, a service account
# distinct from the interactive user, or a lock path on shared/networked storage.
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

if (( AGE <= MAX_AGE )); then
  # Not old enough to question yet — liveness is irrelevant at this point.
  exit 1
fi

PIDFILE="$LOCK/holder.pid"
if [[ ! -f "$PIDFILE" ]]; then
  # Age-exceeded, nothing recorded to check liveness against: backward-compat stale path.
  exit 0
fi

PID="$(<"$PIDFILE")"
if [[ ! "$PID" =~ ^[1-9][0-9]*$ ]]; then
  print -u2 -- "lockIsStale: malformed pid in $PIDFILE — cannot determine staleness"
  exit 2
fi

if kill -0 "$PID" 2>/dev/null; then
  exit 1
fi

exit 0
