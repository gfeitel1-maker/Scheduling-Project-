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
# substring filter, not a directory, so substring "batches" silently overlap. The chunk count is
# declared in the stamp and CHECKED by verifierReport.js — it used to say "check this before
# trusting a batched result", which was a rule stated and never enforced.
#
# The results file defaults OUTSIDE the repo, and that is not incidental. Writing it into
# docs/work/runs/evidence/ dirties the very tree the run is measuring, so the stamp records
# dirty>=1 and buildVerifierReport correctly marks the run UNVERIFIED — the gate defeating
# itself. Found by the T169 check firing on its own author. Copy the file in deliberately
# AFTER the run, when you want it as durable evidence; by then the stamp is already written.
#
# Usage: scripts/gate.sh [results-file]   (default $TMPDIR/shoresh-gate-<short-sha>.txt)
set -u
# Resolved BEFORE the cd below, and before any function runs, for two separate reasons:
#   - `:A` resolves a RELATIVE $0 against the current cwd, so capturing it after the cd can
#     silently point at the wrong directory when the script is invoked by a relative path.
#   - $0 inside a zsh FUNCTION is the FUNCTION NAME, not the script (FUNCTION_ARGZERO is on by
#     default), so `${0:A:h}` inside step() resolves against the cwd and points at a file that
#     does not exist — the pipeline then fails and the summary column goes silently blank, which
#     is the exact defect T171 item 3 exists to remove.
SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR/.."
SHA=$(git rev-parse HEAD)
DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
R="${1:-${TMPDIR:-/tmp}/shoresh-gate-$(git rev-parse --short HEAD).txt}"
mkdir -p "${R:h}"

# Chunks live in an ARRAY, not a temp directory. The first version used `mktemp -d` plus an
# EXIT trap, and the chunk files vanished between creation and the loop — every run died after
# `lint` with "no matches found: .../c_*". Rather than keep guessing which fork ran the trap,
# the temp directory is gone: there is nothing to clean up, so nothing can clean it up early.
# Slicing an array is what the code meant anyway.
# The find + zero-spec abort is scripts/gateSpecCount.sh (T168) — extracted so the "no test
# files discoverable" abort is testable against a fixture directory instead of only by hand.
# See test/gateSpecCount.test.js.
RAW_SPECS=$("$SCRIPT_DIR/gateSpecCount.sh" .)
(( $? != 0 )) && exit 2
SPECS=(${(f)"$(print -r -- "$RAW_SPECS" | sed 's|^\./||')"})
CHUNK_SIZE=45
CHUNKS=$(( (${#SPECS} + CHUNK_SIZE - 1) / CHUNK_SIZE ))

# The stamp declares what this run INTENDED: which commit, whether the tree was clean, and how
# many test chunks should appear below. verifierReport.js checks the count, which is the
# "chunk totals sum to a whole-suite count" rule this header used to state and never enforce.
print -- "# gate run against $SHA dirty=$DIRTY chunks=$CHUNKS" > "$R"

step() {
  local name=$1; shift
  local out rc t
  out=$("$@" 2>&1); rc=$?
  # T171 item 3: the summary is extracted by scripts/gateStepSummary.sh, which prints UNMATCHED
  # rather than going blank when a tool's output format drifts out from under the pattern. A
  # blank column read as "clean run, nothing to report"; UNMATCHED reads as "I could not read
  # the report", which is a different thing a human acts on differently. rc stays authoritative
  # — an unsummarisable step does NOT fail the gate. See test/gateStepSummary.test.js.
  t=$(print -r -- "$out" | "$SCRIPT_DIR/gateStepSummary.sh")
  print -- "STEP $name | rc=$rc | $t" >> "$R"
  (( rc != 0 )) && print -r -- "$out" | grep -E "^ +× |FAIL |Error:" | head -4 >> "$R"
  print -- "$name rc=$rc"
}

step lint npm run lint
# T166: the same list as VERIFY_STEPS, in the same order. These are two separate lists by
# deliberate choice (gate.sh chunks tests and uses short labels), so they must be kept in step
# by hand — a divergence here is exactly the drift class this program keeps finding.
step agents-check npm run agents:check
i=0; start=1
while (( start <= ${#SPECS} )); do
  i=$((i+1))
  end=$(( start + CHUNK_SIZE - 1 )); (( end > ${#SPECS} )) && end=${#SPECS}
  step "tests-$i" npx vitest run ${SPECS[start,end]} --no-file-parallelism --maxWorkers=1
  start=$(( end + 1 ))
done
step integration npm run test:integration
step security npm run security
step licenses npm run licenses:check
step governance npm run check:governance

# Terminal marker, written only once every step above has run.
print -- "DONE" >> "$R"
print -- "results -> $R"
print -- "to keep it as evidence:  cp \"$R\" docs/work/runs/evidence/gate-$(git rev-parse --short HEAD).txt"
# Exit non-zero when any step failed. This is scripts/gateResultCode.sh (T168), extracted so
# the exit-code contract is testable against a fixture results file. The previous line was
#   grep -c ... >/dev/null 2>&1 && exit 0 || exit 0
# which exits 0 on BOTH branches — the gate reported success no matter what was in the results
# file. That is precisely the defect this whole program exists to remove ("started" taken for
# "succeeded"), sitting in the tool built to detect it, and it shipped through a 13/13 green run
# because the gate never runs itself. See T171 / test/gateResultCode.test.js.
"$SCRIPT_DIR/gateResultCode.sh" "$R"
exit $?
