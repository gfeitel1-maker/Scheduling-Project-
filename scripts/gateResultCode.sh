#!/bin/zsh
# Pure predicate: does a gate results file contain any failing STEP line? Extracted from
# scripts/gate.sh (T168) so the exit-code contract is testable against a fixture file, never a
# real gate run. Historical defect (found 2026-09-15): this line used to be
#   grep -c ... >/dev/null 2>&1 && exit 0 || exit 0
# which exits 0 on BOTH branches — the gate reported success no matter what the results file
# said. See T168 / T171.
#
# Usage: gateResultCode.sh <results-file>   — exit 0 if every STEP passed, 1 if any failed.
set -u
R="$1"
if grep -q '^STEP .* rc=[1-9]' "$R"; then
  print -u2 -- "gate FAILED — failing steps:"
  grep '^STEP .* rc=[1-9]' "$R" >&2
  exit 1
fi
exit 0
