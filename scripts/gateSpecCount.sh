#!/bin/zsh
# Pure predicate: are there any test files under $1? Extracted from scripts/gate.sh (T168) so it
# is testable against a fixture directory, never a real checkout.
#
# Red Hat, 2026-09-15: a gate that ran ZERO test chunks still satisfied lint + integration +
# security + governance, so it reported PASS. This must abort loudly, and BEFORE any evidence
# file is written — the caller (gate.sh) relies on that ordering to leave no results file behind.
#
# Usage: gateSpecCount.sh <dir>
#   stdout: one test file path per line (relative-ish, mirrors `find`'s own paths)
#   exit 0 — at least one test file found
#   exit 2 — none found; caller must abort without writing evidence
set -u
DIR="${1:-.}"
SPECS=(${(f)"$(find "$DIR" -path "$DIR/node_modules" -prune -o \( -name '*.test.js' -o -name '*.test.jsx' \) -print | sort)"})
if (( ${#SPECS} == 0 )); then
  print -u2 -- "gate ABORTED: found no test files under $DIR. Refusing to write evidence for a run with nothing to run."
  exit 2
fi
print -l -- "${SPECS[@]}"
exit 0
