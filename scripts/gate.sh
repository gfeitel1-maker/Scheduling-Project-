#!/bin/zsh
# Batched gate runner. Same steps as `npm run verify`, but split so each reports independently and
# a long run survives an interrupted watcher — and, unlike `verify`, it writes a machine-readable
# results file that scripts/verifierReport.js turns into the Verifier PerGateReport.
#
# Two properties are load-bearing:
#
#   1. The SHA stamp is written when the run STARTS (T169). A run that begins on one commit and is
#      read after a rebase would otherwise claim the wrong one. `dirty` is recorded rather than
#      ignored: a run against a dirty tree verified a tree that exists in no commit, and
#      buildVerifierReport downgrades it to UNVERIFIED for exactly that reason.
#
#   2. `DONE` is written only after every step, and buildVerifierReport requires it to be the
#      TERMINAL line. Without that, a run killed after step 1 reads as a pass — this repository's
#      recurring defect, "started" taken for "succeeded", reappearing in the evidence layer.
#
# Tests are partitioned by explicit file list, never by a path substring: `vitest run src/` is a
# substring filter, not a directory, so substring "batches" silently overlap. Check the chunk
# totals sum to a whole-suite count before trusting a batched result.
#
# Usage: scripts/gate.sh [results-file]   (default docs/work/runs/evidence/gate-<sha>.txt)
set -u
cd "${0:A:h}/.."
SHA=$(git rev-parse HEAD)
DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
R="${1:-docs/work/runs/evidence/gate-$(git rev-parse --short HEAD).txt}"
mkdir -p "${R:h}"
print -- "# gate run against $SHA dirty=$DIRTY" > "$R"

CHUNKS=$(mktemp -d)
trap 'rm -rf "$CHUNKS"' EXIT INT TERM
find . -path ./node_modules -prune -o \( -name '*.test.js' -o -name '*.test.jsx' \) -print \
  | sed 's|^\./||' | sort > "$CHUNKS/all"
split -l 45 "$CHUNKS/all" "$CHUNKS/c_"

step() {
  local name=$1; shift
  local out rc t
  out=$("$@" 2>&1); rc=$?
  t=$(print -r -- "$out" | grep -E "Tests +[0-9]|passed \(|no findings|0 findings|✖ [0-9]+ problems" | tail -1 | tr -s ' ')
  print -- "STEP $name | rc=$rc |$t" >> "$R"
  (( rc != 0 )) && print -r -- "$out" | grep -E "^ +× |FAIL |Error:" | head -4 >> "$R"
  print -- "$name rc=$rc"
}

step lint npm run lint
i=0
for c in "$CHUNKS"/c_*; do
  i=$((i+1))
  step "tests-$i" npx vitest run ${(f)"$(<$c)"} --no-file-parallelism --maxWorkers=1
done
step integration npm run test:integration
step security npm run security
step governance npm run check:governance

# Terminal marker, written only once every step above has run.
print -- "DONE" >> "$R"
print -- "results -> $R"
grep -c '^STEP .* rc=[1-9]' "$R" >/dev/null 2>&1 && exit 0 || exit 0
