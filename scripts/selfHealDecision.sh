#!/bin/zsh
# Pure predicate: given yesterday's memory-pending directory and the consolidation run.log, what
# should the 06:30 self-heal do? Extracted from scripts/integration.sh (T168).
#
# The predicate is the point. This used to ask "is there a `=== run <day>` header in run.log" —
# but run.sh writes that header as its FIRST action, before it does any work. The header is
# therefore present on a night that started and failed, so "started" read as "succeeded" and
# eight consecutive authentication failures (2026-09-06..13) produced no morning signal at all.
# Four outcomes, not two, checked in this order:
#   1. proposal-<day>.md exists                          -> SUCCESS (nothing to say)
#   2. run.log says "no signal for <day>"                 -> QUIET (genuinely nothing that night)
#   3. a NEEDS-AUTH-/FAILED- marker exists for <day>       -> FAILED-AUTH or FAILED-MINE (report,
#                                                             do NOT re-run — it already retried)
#   4. no "=== run <day> " header in run.log at all        -> SELFHEAL (never started; safe to run)
#   (else: started, no marker either way yet — NONE, nothing to report)
#
# Usage: selfHealDecision.sh <pend_dir> <run_log> <day>
#   stdout: SUCCESS | QUIET | FAILED-AUTH | FAILED-MINE | SELFHEAL | NONE
set -u
PEND="$1" LOG="$2" DAY="$3"

if [[ -f "$PEND/proposal-$DAY.md" ]]; then
  print -- "SUCCESS"
elif grep -q "no signal for $DAY" "$LOG" 2>/dev/null; then
  print -- "QUIET"
elif [[ -f "$PEND/NEEDS-AUTH-proposal-$DAY.md" || -f "$PEND/FAILED-proposal-$DAY.md" ]]; then
  if [[ -f "$PEND/NEEDS-AUTH-proposal-$DAY.md" ]]; then
    print -- "FAILED-AUTH"
  else
    print -- "FAILED-MINE"
  fi
elif ! grep -q "=== run $DAY " "$LOG" 2>/dev/null; then
  print -- "SELFHEAL"
else
  print -- "NONE"
fi
