#!/bin/zsh
# Pure predicate: does a gate results file say every step passed? Extracted from scripts/gate.sh
# (T168) so the exit-code contract is testable against a fixture file, never a real gate run.
#
# THE DEFECT CLASS THIS KEEPS REPRODUCING. The original line here was
#   grep -c ... >/dev/null 2>&1 && exit 0 || exit 0
# which exits 0 on BOTH branches — the gate reported success no matter what the results file said.
# T171 fixed that. Writing the test it owed then found the SAME defect twice more, wearing
# different clothes (measured 2026-09-15, see test/gateResultCode.test.js):
#
#   - a MISSING results file exited 0. `grep -q` on a nonexistent path returns 2, the `if` read
#     false, and "I could not find the results" became "everything passed".
#   - an EMPTY results file exited 0. No STEP lines means no FAILING step lines, so a gate that
#     died before writing anything reported success.
#
# Both are absence read as success — "started" taken for "succeeded" — which is the one thing this
# whole program exists to remove, sitting in the tool built to detect it. A predicate over a file
# must therefore answer three ways, not two: passed, failed, and CANNOT TELL.
#
# Usage: gateResultCode.sh <results-file>
#   exit 0 — every STEP line says rc=0, and there was at least one
#   exit 1 — at least one STEP line says rc!=0
#   exit 2 — no usable results (missing, unreadable, or no STEP lines at all)
#
# Callers treat any non-zero as failure; 2 is distinguished so a log can tell "the gate failed"
# from "the gate never reported", which need different responses from a human.
set -u

if (( $# < 1 )); then
  print -u2 -- "gateResultCode: no results file given — cannot determine a verdict"
  exit 2
fi

R="$1"

if [[ ! -f "$R" || ! -r "$R" ]]; then
  print -u2 -- "gate INCONCLUSIVE — results file missing or unreadable: $R"
  print -u2 -- "  This is not a pass. The gate did not report."
  exit 2
fi

if ! grep -q '^STEP ' "$R"; then
  print -u2 -- "gate INCONCLUSIVE — no STEP lines in: $R"
  print -u2 -- "  The gate produced no step results, so there is nothing to pass. Most likely it"
  print -u2 -- "  died before its first step. This is not a pass."
  exit 2
fi

if grep -q '^STEP .* rc=[1-9]' "$R"; then
  print -u2 -- "gate FAILED — failing steps:"
  grep '^STEP .* rc=[1-9]' "$R" >&2
  exit 1
fi

exit 0
