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
# The results file defaults OUTSIDE the repo, and that is not incidental. Writing it into
# docs/work/runs/evidence/ dirties the very tree the run is measuring, so the stamp records
# dirty>=1 and buildVerifierReport correctly marks the run UNVERIFIED — the gate defeating
# itself. Found by the T169 check firing on its own author. Copy the file in deliberately
# AFTER the run, when you want it as durable evidence; by then the stamp is already written.
#
# Usage: scripts/gate.sh [results-file]   (default $TMPDIR/shoresh-gate-<short-sha>.txt)
set -u
cd "${0:A:h}/.."
SHA=$(git rev-parse HEAD)
DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
R="${1:-${TMPDIR:-/tmp}/shoresh-gate-$(git rev-parse --short HEAD).txt}"
mkdir -p "${R:h}"
print -- "# gate run against $SHA dirty=$DIRTY" > "$R"

# Chunks live in an ARRAY, not a temp directory. The first version used `mktemp -d` plus an
# EXIT trap, and the chunk files vanished between creation and the loop — every run died after
# `lint` with "no matches found: .../c_*". Rather than keep guessing which fork ran the trap,
# the temp directory is gone: there is nothing to clean up, so nothing can clean it up early.
# Slicing an array is what the code meant anyway.
SPECS=(${(f)"$(find . -path ./node_modules -prune -o \( -name '*.test.js' -o -name '*.test.jsx' \) -print | sed 's|^\./||' | sort)"})
CHUNK_SIZE=45

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
i=0; start=1
while (( start <= ${#SPECS} )); do
  i=$((i+1))
  end=$(( start + CHUNK_SIZE - 1 )); (( end > ${#SPECS} )) && end=${#SPECS}
  step "tests-$i" npx vitest run ${SPECS[start,end]} --no-file-parallelism --maxWorkers=1
  start=$(( end + 1 ))
done
step integration npm run test:integration
step security npm run security
step governance npm run check:governance

# Terminal marker, written only once every step above has run.
print -- "DONE" >> "$R"
print -- "results -> $R"
print -- "to keep it as evidence:  cp \"$R\" docs/work/runs/evidence/gate-$(git rev-parse --short HEAD).txt"
grep -c '^STEP .* rc=[1-9]' "$R" >/dev/null 2>&1 && exit 0 || exit 0
