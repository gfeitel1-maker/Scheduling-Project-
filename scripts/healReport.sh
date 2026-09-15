#!/bin/zsh
# Pure predicate: given a self-heal outcome, what should the morning report SAY about it?
#
# Extracted because this is where the bug was. selfHealDecision.sh correctly distinguishes
# "started, no evidence either way" (NONE) from "succeeded" (SUCCESS) — and integration.sh then
# bucketed them together as `SUCCESS|QUIET|NONE) :;;`, a silent no-op. The predicate was tested;
# the caller was not; the distinction the predicate exists to draw was thrown away one line later.
# That is the original defect of this whole program — "started" read as "succeeded" — reproduced
# by its own fix. (Red Hat, 2026-09-15.)
#
# NONE is not benign. The 03:00 job retries at most 3x over roughly a minute, so by 06:30 a run
# that wrote its header and left no proposal and no marker did not stall — it died. Nothing else
# catches it either: the backlog scan globs only NEEDS-AUTH-/FAILED- markers, and a killed run
# never wrote one.
#
# Usage: healReport.sh <outcome>
#   stdout: <severity>|<headline>     severity: silent | alert | heal
#   exit 0 always; an unknown outcome is an ALERT, never silence.
set -u
case "${1:-}" in
  SUCCESS|QUIET)
    print -- "silent|" ;;
  NONE)
    print -- "alert|🔴 Nightly memory pass STARTED BUT DID NOT FINISH — no proposal and no marker; it was killed or the machine slept mid-run. Nothing else reports this: the backlog only scans for markers, and a killed run never wrote one." ;;
  FAILED-AUTH)
    print -- "alert|🔴 Nightly memory pass FAILED — not authenticated. Sign in once with \`claude /login\`, then recover the backlog." ;;
  FAILED-MINE)
    print -- "alert|🔴 Nightly memory pass FAILED — mining failed after retries." ;;
  SELFHEAL)
    print -- "heal|🩹 Nightly memory pass never started (machine likely asleep) — running it now." ;;
  *)
    print -- "alert|🔴 Self-heal predicate returned an unrecognised outcome '${1:-}' — treating as a failure rather than assuming it is fine." ;;
esac
exit 0
