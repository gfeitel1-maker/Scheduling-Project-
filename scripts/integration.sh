#!/bin/zsh
# Morning integration routine (06:30). REPORTS branch/worktree health and performs only SAFE,
# reversible auto-actions. It NEVER merges and NEVER rebases — the trunk stays a human decision
# (constitution + graph ADR §6: the human owns promotion).
#
# Safe auto-actions:
#   1. Fast-forward local `main` to origin/main. When `main` is checked out in a worktree (the
#      normal case here — `git fetch . origin/main:main` refuses to write a checked-out ref), ff it
#      IN PLACE with `git merge --ff-only` in that worktree, but ONLY when the worktree is clean.
#      Skipped (never forced) if the holding worktree has uncommitted changes or `main` diverged.
#      A fast-forward is a pointer advance, not a merge commit or rebase — the trunk-promotion
#      invariant (§6) is untouched.
#      An "uncommitted changes" tree is additionally classified before it is reported: if it shows
#      zero unstaged edits and its staged tree exactly matches a bounded-lookback ancestor of HEAD,
#      that is the signature of a PHANTOM INDEX (the `main` ref was force-moved elsewhere — e.g.
#      `git branch -f`/`update-ref` — while checked out here, so the index/worktree still hold an
#      ancestor commit's tree but HEAD now resolves to a newer one). This routine DETECTS and
#      REPORTS that signature — with the exact commands a human would run to fix it — but never
#      acts on it: the same signature is also produced by a deliberate `git checkout <old> -- .
#      && git add -A` staged revert, which looks identical and must never be discarded by a
#      script. Repair is always a human action. Genuinely dirty trees (real unstaged edits) are
#      always left alone, unchanged, either way.
#      Every path on which `main` fails to advance — phantom detected, uncommitted changes,
#      diverged, no worktree found, or a failed ff — is escalated from ⏸️/ℹ️ to 🔴 once it has been
#      stuck >= 5 commits behind origin/main, so a stuck state doesn't read the same as a routine
#      one-day pause.
#   2. Prune ABANDONED ephemeral worktrees: only those under ~/dev/shoresh/.claude/worktrees/,
#      with 0 commits ahead of origin/main, a CLEAN tree, and idle >= IDLE_DAYS. `git worktree
#      remove` (no --force) refuses a dirty tree, so anything actively in use is protected.
#      Named ~/dev/shoresh-* siblings and any branch with unmerged commits are never touched.
set -u
REPO="$HOME/dev/shoresh"
SLUG="-Users-gregfeitel-Desktop-Camp-App-System--Applications-Schedule-Project"
OUTDIR="$HOME/.claude/projects/$SLUG/_integration"
CONS="$HOME/.claude/projects/$SLUG/_consolidation"   # DATA (run.log) — a live store, never in the repo
CONSCRIPTS="${0:A:h}/consolidation"                    # SCRIPTS — version-controlled siblings
mkdir -p "$OUTDIR/reports"
DAY=$(date +%F)
REPORT="$OUTDIR/reports/integration-$DAY.md"
LOG="$OUTDIR/integration.log"
IDLE_DAYS=2
NOW=$(date +%s)

{ print -- "=== integration run $DAY @ $(date) ==="; } >> "$LOG"
if ! cd "$REPO" 2>/dev/null; then { print -- "ERROR: $REPO missing"; } >> "$LOG"; exit 1; fi
git fetch --quiet origin main 2>>"$LOG"
OM=$(git rev-parse --short origin/main 2>/dev/null)

print -- "# Integration report — $DAY" > "$REPORT"
print -- "_origin/main @ \`$OM\`. Auto-actions taken: ff local main + prune abandoned worktrees. **Merges and rebases are yours** — this routine never touches the trunk._\n" >> "$REPORT"

# --- Safe auto-action 1: ff local main ---
print -- "## Auto-actions" >> "$REPORT"
if [[ "$(git rev-parse --verify --quiet main 2>/dev/null)" == "$(git rev-parse origin/main 2>/dev/null)" ]]; then
  print -- "- ✅ local \`main\` already at \`$OM\`" >> "$REPORT"
elif git fetch --quiet . origin/main:main 2>/dev/null; then
  # main checked out nowhere → the ref fetch advances it directly. When main IS
  # checked out (the normal case), this fetch is refused; that refusal is
  # expected control flow, not an error, so its stderr is discarded rather than
  # logged — the else-branch below does the worktree-aware ff and reports it.
  print -- "- ✅ local \`main\` fast-forwarded to \`$OM\`" >> "$REPORT"
else
  # The ref fetch was refused because `main` is checked out in a worktree. Find
  # that worktree and, if it is CLEAN and a true fast-forward, advance it in
  # place. `merge --ff-only` on a clean tree cannot create a merge commit and
  # refuses anything that isn't a fast-forward, so the "never force" invariant
  # holds; the clean-tree guard means a live editing session is never disturbed.
  MAINWT=$(git worktree list --porcelain 2>/dev/null | awk '
    /^worktree /{wt=$2}
    /^branch refs\/heads\/main$/{print wt; exit}')
  # How far behind, for the staleness escalation below. Never let this abort the report.
  behind=$(git rev-list --count main..origin/main 2>/dev/null); behind=${behind:-0}
  report_stall() {
    # $1 = default marker (⏸️ or ℹ️), $2 = message text (no leading marker). Upgrades to 🔴
    # with an explicit call-out when main has been stuck >= 5 commits behind.
    if (( behind >= 5 )); then
      print -- "- 🔴 $2 — **\`main\` is $behind commits behind and has not advanced; this needs a human look.**" >> "$REPORT"
    else
      print -- "- $1 $2" >> "$REPORT"
    fi
  }
  if [[ -z "$MAINWT" ]]; then
    report_stall "ℹ️" "local \`main\` left as-is (diverged from origin/main — not forced)"
  elif [[ -n "$(git -C "$MAINWT" status --porcelain 2>/dev/null | head -1)" ]]; then
    # Classify before reporting ⏸️: is this a PHANTOM INDEX signature, or real uncommitted work?
    # Detection only — nothing below this point touches $MAINWT.
    match_c=""
    if git -C "$MAINWT" diff --quiet 2>/dev/null; then
      # (a) zero unstaged changes. Now look for (b): the staged tree exactly matches an
      # ancestor of HEAD, within a bounded lookback so a runaway search can't happen.
      T=$(git -C "$MAINWT" write-tree 2>/dev/null)
      if [[ -n "$T" ]]; then
        for c in $(git -C "$MAINWT" log -n 50 --format=%H HEAD 2>/dev/null); do
          if [[ "$(git -C "$MAINWT" rev-parse "${c}^{tree}" 2>/dev/null)" == "$T" ]] \
             && git -C "$MAINWT" merge-base --is-ancestor "$c" HEAD 2>/dev/null; then
            match_c="$c"; break
          fi
        done
      fi
    fi
    if [[ -n "$match_c" ]]; then
      # This signature is NOT reliably a phantom: a deliberate `git checkout <old> -- . &&
      # git add -A` staged revert produces byte-identical evidence (zero unstaged edits, staged
      # tree matching an ancestor). Report the diagnosis and the human's fix command — never
      # act on it. The command below is ADVISORY ONLY — it is printed for a human to run by
      # hand. This script never executes it; that is the whole point of this revision.
      fixcmd="cd $MAINWT && git reset --hard HEAD && git merge --ff-only origin/main"
      report_stall "🔴" "local \`main\` in \`$MAINWT\` looks like a **phantom index** — zero unstaged edits and the staged tree exactly matches ancestor \`${match_c[1,7]}\` of HEAD, consistent with the \`main\` ref having moved (e.g. \`git branch -f\`/\`update-ref\`) while checked out here. This is very likely NOT real work, but this routine will not touch it — repair is a human action: \`$fixcmd\`. *Caveat: a deliberate staged revert (\`git checkout <old> -- . && git add -A\`) looks identical — glance at \`git diff --cached --stat\` in \`$MAINWT\` first.*"
    else
      report_stall "⏸️" "local \`main\` left as-is — uncommitted changes in its worktree (\`$MAINWT\`), not forced"
    fi
  elif ! git -C "$MAINWT" merge-base --is-ancestor main origin/main 2>/dev/null; then
    report_stall "ℹ️" "local \`main\` left as-is — diverged from origin/main in \`$MAINWT\` (not forced)"
  elif git -C "$MAINWT" merge --ff-only origin/main 2>>"$LOG"; then
    print -- "- ✅ local \`main\` fast-forwarded to \`$OM\` in its worktree (\`$MAINWT\`)" >> "$REPORT"
  else
    report_stall "⚠️" "local \`main\` ff in \`$MAINWT\` failed (see log) — left as-is"
  fi
fi

# --- Architecture-audit staleness (T84) — REPORT-ONLY, human-gated ---
# Event-triggered, never a clock: a finished initiative (new ADR), a new screen/op surface, or
# slow structural drift makes a fresh /improve-codebase-architecture worthwhile. This block ONLY
# prints a recommendation. It NEVER invokes the auditor, branches, or writes a report — same
# restraint as the trunk rule above. Dismiss the slow-drift nag by writing BASE into the ack file;
# new-ADR / new-surface signals are always loud (a finished project is worth a look even if
# drift was acknowledged). Every command is guarded so a failure here can never break the report.
AUDIT_DRIFT_COMMITS=30
AUDIT_DRIFT_DAYS=30
AUDIT_ACK="$OUTDIR/arch-audit-ack"        # owner writes the acknowledged BASE sha here to quiet drift
REPORTS_DIR="docs/work/architecture-reports"   # repo-relative; read from origin/main, not the worktree
print -- "\n## 🏛 Architecture audit" >> "$REPORT"
# Source of truth is origin/main (just fetched), NOT the local worktree — this routine may run while
# a worktree sits on an old HEAD, so a `ls` of the checkout would pick a stale report and false-DUE.
latest_report=$(git ls-tree -r --name-only origin/main -- "$REPORTS_DIR" 2>/dev/null | grep 'architecture-audit-summary\.md$' | sort | tail -1)
if [[ -z "$latest_report" ]]; then
  print -- "- ❓ no prior audit report in \`docs/work/architecture-reports/\` — consider running one (invoke the architecture-auditor agent)" >> "$REPORT"
else
  rname=$(basename "$latest_report"); rdate=${rname%%-architecture-audit-summary.md}
  BASE=$(git log -1 --format=%H origin/main -- "$latest_report" 2>/dev/null)
  new_adrs=""; new_surface=""; drift=0; agedays=0
  if [[ -n "$BASE" ]]; then
    new_adrs=$(git diff --name-only --diff-filter=A "$BASE" origin/main -- docs/adr/ 2>/dev/null)
    new_surface=$(git diff --name-only --diff-filter=A "$BASE" origin/main -- src/screens electron/ops 2>/dev/null)
    drift=$(git rev-list --no-merges --count "$BASE"..origin/main -- src/screens src/data electron/ops electron/sync src/engine 2>/dev/null)
    drift=${drift:-0}
  fi
  repoch=$(date -j -f %F "$rdate" +%s 2>/dev/null); repoch=${repoch:-$NOW}
  agedays=$(( (NOW - repoch) / 86400 ))
   acked=""; [[ -f "$AUDIT_ACK" ]] && acked=$(head -1 "$AUDIT_ACK" 2>/dev/null)
  loud=0; reasons=""
  if [[ -n "$new_adrs" ]]; then loud=1; reasons="$reasons new ADR since $rdate ($(print -- "$new_adrs" | xargs -n1 basename 2>/dev/null | paste -sd, -));"; fi
  if [[ -n "$new_surface" ]]; then loud=1; reasons="$reasons new surface ($(print -- "$new_surface" | wc -l | tr -d ' ') file(s) under src/screens|electron/ops);"; fi
  driftdue=0
  (( drift >= AUDIT_DRIFT_COMMITS )) && driftdue=1
  (( agedays >= AUDIT_DRIFT_DAYS )) && driftdue=1
  if (( loud )); then
    print -- "- 🔴 **DUE** —$reasons → run when ready (invoke the architecture-auditor agent). This routine does not run it for you." >> "$REPORT"
  elif (( driftdue )); then
    if [[ "$acked" == "$BASE" ]]; then
      print -- "- 🟡 due on drift ($drift structural commits / ${agedays}d since $rdate) — acknowledged; will renew on the next new ADR or surface" >> "$REPORT"
    else
      print -- "- 🔴 **DUE** — $drift structural commits / ${agedays}d since the $rdate audit → run when ready (architecture-auditor agent). Quiet the drift nag: \`echo $BASE > $AUDIT_ACK\`" >> "$REPORT"
    fi
  else
    print -- "- ✅ fresh — $drift structural commits since $rdate, no new ADR or surface" >> "$REPORT"
  fi
fi

pruned=0
typeset -a READY NEEDS_REBASE ACTIVE PROTECTED
# --- Claude Desktop's worktree ledger (READ ONLY — application-owned state) ---
LEDGER="$HOME/Library/Application Support/Claude/git-worktrees.json"
LEASED_PATHS=""
if [[ -f "$LEDGER" ]]; then
  # scripts/readWorktreeLeases.py, not an inline heredoc: this is the only guard between the
  # prune rule and a worktree the application still expects, and inline shell cannot be tested.
  # Its exit codes are the contract — 0 healthy / 3 unreadable / 4 schema moved. See
  # test/worktreeLeases.test.js.
  LEASED_PATHS=$("${0:A:h}/readWorktreeLeases.py" "$LEDGER" 2>/dev/null)
  LRC=$?
  n=$(print -r -- "$LEASED_PATHS" | grep -c . )
  case $LRC in
    0) { print -- "worktree ledger: $n path(s) protected from pruning"; } >> "$LOG" ;;
    3) { print -- "WARN: worktree ledger unreadable (torn or malformed read) — protecting nothing this run"; } >> "$LOG"
       print -- "\n## ⚠️ Worktree ledger unreadable this run" >> "$REPORT"
       print -- "- \`$LEDGER\` could not be parsed; lease protection was OFF for this prune pass." >> "$REPORT" ;;
    4) # The failure this whole feature exists to prevent, reintroduced by a schema change, would
       # otherwise log a line byte-identical to a healthy empty ledger. Make it impossible to miss.
       { print -- "ERROR: worktree ledger schema changed — no 'worktrees' object. Lease protection is OFF."; } >> "$LOG"
       print -- "\n## 🔴 Worktree ledger schema changed — lease protection is OFF" >> "$REPORT"
       print -- "- \`$LEDGER\` parsed, but has no \`worktrees\` object. Claude Desktop's format moved." >> "$REPORT"
       print -- "- Pruning is running **unprotected**: a pooled worktree the app still expects can be deleted." >> "$REPORT"
       print -- "- Fix the parser in \`scripts/integration.sh\` before the next 06:30 run." >> "$REPORT"
       LEASED_PATHS="" ;;
    *) # Anything else — most likely 127, the reader missing because this script is running from
       # a checkout that does not have it yet. Without this arm an unknown code falls through
       # every case, LEASED_PATHS stays empty, and protection turns off silently: the same class
       # of failure as arm 4, arriving by a different road.
       { print -- "ERROR: lease reader exited $LRC (unexpected). Lease protection is OFF."; } >> "$LOG"
       print -- "\n## 🔴 Worktree lease reader failed (exit $LRC) — protection is OFF" >> "$REPORT"
       print -- "- \`${0:A:h}/readWorktreeLeases.py\` did not run as expected. Pruning is **unprotected**." >> "$REPORT"
       LEASED_PATHS="" ;;
  esac
else
  { print -- "worktree ledger absent at $LEDGER — pruning unchanged"; } >> "$LOG"
fi

# --- Walk worktrees ---
# Parsing is scripts/parseWorktreePorcelain.sh (T168), extracted so the space-in-path handling
# is testable against a fixture porcelain table. See test/worktreePrunePredicate.test.js.
git worktree list --porcelain 2>/dev/null | "${0:A:h}/parseWorktreePorcelain.sh" | while IFS=$'\t' read wt ref head; do
  br=${ref#refs/heads/}
  # ahead/behind vs origin/main
  ab=$(git rev-list --left-right --count origin/main...$head 2>/dev/null)
  behind=${ab%%	*}; ahead=${ab##*	}
  behind=${behind:-0}; ahead=${ahead:-0}
  lastepoch=$(git log -1 --format=%ct "$head" 2>/dev/null); lastepoch=${lastepoch:-$NOW}
  idle_days=$(( (NOW - lastepoch) / 86400 ))
  lastrel=$(git log -1 --format='%cr' "$head" 2>/dev/null)
  dirty=$(git -C "$wt" status --porcelain 2>/dev/null | head -1)
  ephemeral=0; [[ "$wt" == "$REPO/.claude/worktrees/"* ]] && ephemeral=1
  protected=0
  [[ "$wt" == "$REPO" || "$wt" == "$HOME/dev/shoresh-config" || "$br" == "main" ]] && protected=1
  # Claude Desktop owns the worktrees under $REPO/.claude/worktrees and tracks them in its
  # own ledger. A pooled worktree (leasedBy: null + pooledAt) is clean, 0 ahead and idle by
  # design — bit-for-bit the shape this prune rule targets — so pruning one deletes a
  # directory the application still believes it can reuse. We READ the ledger and never
  # write it; if it is missing or mid-write, LEASED_PATHS is empty and behaviour is exactly
  # what it was before.
  #
  # NOTE the predicate is ANY membership in the ledger, not the pooled shape specifically.
  # That is deliberate — protecting a superset can only ever fail safe — but it has a cost:
  # the ledger has no expiry, so an entry Desktop has abandoned exempts that directory from
  # the idle-prune rule permanently, and the report shows only "🔒 protected" with no hint
  # that the protection came from an external file. If worktrees start accumulating, look
  # here first. Reported by Code Reviewer on 44b49c6 as an undisclosed narrowing; recorded
  # rather than "fixed", because tightening it to the pooled shape would trade a silent
  # accumulation for a silent deletion, which is the worse of the two.
  if [[ -n "$LEASED_PATHS" ]] && print -r -- "$LEASED_PATHS" | grep -qxF "$wt"; then
    protected=1
  fi

  dirtyflag=0; [[ -n "$dirty" ]] && dirtyflag=1
  # Decision is scripts/worktreeDecision.sh (T168), extracted so the
  # `ephemeral && clean && 0-ahead && idle` prune rule is testable against fixtures — this loop
  # DELETES directories and had zero coverage before this ticket. See
  # test/worktreePrunePredicate.test.js.
  DECISION=$("${0:A:h}/worktreeDecision.sh" "$protected" "$ahead" "$ephemeral" "$dirtyflag" "$idle_days" "$IDLE_DAYS")
  case "$DECISION" in
    PROTECTED)
      print -- "- 🔒 \`$br\` — protected ($wt)" >> "$REPORT.protected"
      ;;
    READY)
      tag="ready to merge"; (( behind > 0 )) && tag="ahead $ahead / behind $behind — rebase then merge"
      print -- "- ⬆️ \`$br\` — **$tag** (ahead $ahead, last $lastrel) → $wt" >> "$REPORT.ready"
      ;;
    PRUNE)
      # PRUNE: abandoned ephemeral worktree, no unmerged work, clean, idle
      if git worktree remove "$wt" 2>>"$LOG"; then
        print -- "- 🧹 pruned \`$br\` (0 ahead, clean, idle ${idle_days}d) — $wt" >> "$REPORT.pruned"
        { print -- "pruned $wt ($br)"; } >> "$LOG"
      else
        print -- "- ⚠️ prune of \`$br\` failed (see log) — $wt" >> "$REPORT.pruned"
      fi
      ;;
    ACTIVE-DIRTY)
      print -- "- 🔓 \`$br\` — uncommitted work, likely active (0 ahead) — left alone" >> "$REPORT.active"
      ;;
    *)
      print -- "- ⚪ \`$br\` — no work ahead, idle ${idle_days}d (kept; not yet at ${IDLE_DAYS}d or non-ephemeral)" >> "$REPORT.active"
      ;;
  esac
done

# assemble sections in order
for sec in ready pruned active protected; do
  if [[ -s "$REPORT.$sec" ]]; then
    case $sec in
      ready) print -- "\n## ⬆️ Ready to merge / rebase (YOUR call)" >> "$REPORT";;
      pruned) print -- "\n## 🧹 Pruned (auto — abandoned, no unmerged work)" >> "$REPORT";;
      active) print -- "\n## Kept" >> "$REPORT";;
      protected) print -- "\n## 🔒 Protected" >> "$REPORT";;
    esac
    cat "$REPORT.$sec" >> "$REPORT"; rm -f "$REPORT.$sec"
  fi
done
# Flagged review items — a persistent queue (humans/agents append to review-queue.md); surfaced
# every morning until cleared. Lets "flag this for me tomorrow" actually reach the owner.
RQ="$OUTDIR/review-queue.md"
if [[ -s "$RQ" ]]; then
  print -- "\n## 📌 Flagged for your review" >> "$REPORT"
  cat "$RQ" >> "$REPORT"
fi

# Self-heal: back up the 3 AM nightly memory pass. If it did not run for yesterday (e.g. the Mac was
# asleep at 03:00 and launchd did not catch up the missed run), run it now — this 06:30 job runs
# reliably because the machine is awake by then. Recovers a slept-through night automatically.
#
# The decision is scripts/selfHealDecision.sh (T168), extracted so the four-outcome predicate
# is testable against a fixture _pending directory and run.log instead of only by reading. See
# test/selfHealDecision.test.js for the defect it guards ("started" read as "succeeded").
YDAY=$(date -v-1d +%F)
PEND="$HOME/.claude/projects/$SLUG/memory/_pending"
HEALDEC=$("${0:A:h}/selfHealDecision.sh" "$PEND" "$CONS/run.log" "$YDAY")
case "$HEALDEC" in
  SUCCESS|QUIET|NONE)
    :
    ;;
  FAILED-AUTH|FAILED-MINE)
    # ran and failed. Do NOT re-run: it already retried, and for a non-retryable class
    # (expired login) another attempt only burns another failure. Surface it instead.
    print -- "\n## 🔴 Nightly memory pass FAILED for $YDAY" >> "$REPORT"
    if [[ "$HEALDEC" == "FAILED-AUTH" ]]; then
      print -- "- **not authenticated** — sign in once with \`claude /login\`, then recover the backlog" >> "$REPORT"
    else
      print -- "- mining failed after retries — see \`$CONS/run.log\`" >> "$REPORT"
    fi
    ;;
  SELFHEAL)
    # never started (Mac asleep at 03:00). Safe to run now: yesterday's transcript mtimes
    # are still accurate, so gather.sh selects the right files. This is the ONLY case where
    # run.sh may be invoked for a past day — see the backlog note below.
    print -- "\n## 🩹 Self-heal: recovered a missed nightly memory pass" >> "$REPORT"
    print -- "- the 3 AM consolidation had not run for $YDAY (Mac likely asleep) — ran it now" >> "$REPORT"
    { print -- "self-heal: nightly memory pass for $YDAY missing; running consolidation/run.sh $YDAY"; } >> "$LOG"
    RES=$("$CONSCRIPTS/run.sh" "$YDAY" 2>>"$LOG")
    print -- "- result: \`${RES:t}\` (review it with the morning proposals)" >> "$REPORT"
    ;;
esac

# Outstanding backlog — every failed night, surfaced every morning until cleared, so a
# failure can no longer go quiet for nine days. Recovery is mineFromPacket.sh, never
# `run.sh <old-day>`: run.sh re-runs gather.sh, which selects transcripts by mtime and
# truncates the packet, so re-running it for an old day DESTROYS the preserved evidence.
# A marker whose day now has a real proposal is RESOLVED — recovered by mineFromPacket.sh, or by
# a later successful attempt. Reporting it anyway is the mirror of the bug this whole change fixes:
# instead of a failure going silent, a success keeps shouting, and the reader learns to ignore the
# one surface that is supposed to be trustworthy. Filter those out, and retire the stale marker.
typeset -a BACKLOG
for f in "$PEND"/NEEDS-AUTH-proposal-*.md(N) "$PEND"/FAILED-proposal-*.md(N); do
  d="${${f:t:r}##*proposal-}"
  if [[ -f "$PEND/proposal-$d.md" ]]; then
    rm -f "$f"
    { print -- "retired stale marker ${f:t} — proposal-$d.md exists"; } >> "$LOG"
    continue
  fi
  BACKLOG+=("$f")
done
if (( ${#BACKLOG} > 0 )); then
  print -- "\n## 📥 Unmined nights awaiting recovery (${#BACKLOG})" >> "$REPORT"
  typeset -a DAYS
  for f in "${BACKLOG[@]}"; do
    d="${${f:t:r}##*proposal-}"
    DAYS+=("$d")
    print -- "- \`$d\` — evidence packet preserved ($(wc -c < "$PEND/evidence-$d.md" 2>/dev/null | tr -d " ") bytes)" >> "$REPORT"
  done
  print -- "\nRecover all of them with:" >> "$REPORT"
  print -- '\n```bash' >> "$REPORT"
  print -- "$CONSCRIPTS/mineFromPacket.sh ${DAYS}" >> "$REPORT"
  print -- '```' >> "$REPORT"
fi

git worktree prune 2>>"$LOG"  # clean metadata for any removed dirs
{ print -- "report -> $REPORT"; } >> "$LOG"
print -- "$REPORT"
