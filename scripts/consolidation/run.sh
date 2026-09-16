#!/bin/zsh
# Nightly Option-1 pipeline: gather (deterministic) -> mine (claude -p) -> quarantined proposal.
# The model runs WITHOUT Write/Edit; the shell captures stdout, so real memory cannot be touched.
set -u
export PATH="$HOME/.local/bin:$PATH"
CLAUDE="$HOME/.local/bin/claude"
# Script location vs data location were the SAME variable ($CONS) while these scripts lived beside
# the data. Moving the scripts into the repo splits them, and the split is the whole point:
#   SCRIPTS — this directory, version-controlled, reviewable, has history
#   DATA    — ~/.claude/projects/<slug>/_consolidation and .../memory, a LIVE memory store that
#             must not move and must never be checked in
# Resolve siblings via ${0:A:h} so the scripts work from any checkout without a hardcoded path.
SCRIPTS="${0:A:h}"
source "${0:A:h}/../memoryProject.sh"
CONS="$MEMORY_CONS"   # DATA (run.log) — unchanged
PROJ="$MEMORY_PROJ"
MEMDIR="$PROJ/memory"
REPO="$HOME/dev/shoresh"
OUT="$MEMDIR/_pending"
# Nightly runs at 03:00, so by default consolidate the day that just ended (yesterday),
# not the ~3h-old current day. An explicit YYYY-MM-DD arg still overrides (for backfills).
DAY="${1:-$(date -v-1d +%F)}"
LOG="$CONS/run.log"

{ print -- "=== run $DAY @ $(date) ==="; } >> "$LOG"

# 0. Refresh the quiet agent-config worktree to the latest main, so the Desktop project's
#    symlinked .claude/agents stays fresh AND stable (decoupled from the churning main clone).
#    Best-effort: never let a git hiccup here block memory consolidation.
CFG="$HOME/dev/shoresh-config"
if git -C "$CFG" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$CFG" fetch --quiet origin main 2>>"$LOG"
  # Track the freshly-fetched origin/main (local `main` can lag when PRs merge on GitHub).
  if git -C "$CFG" checkout --detach --quiet origin/main 2>>"$LOG"; then
    { print -- "agent-config worktree synced to origin/main @ $(git -C "$CFG" rev-parse --short HEAD 2>/dev/null)"; } >> "$LOG"
  else
    { print -- "WARN: agent-config worktree refresh failed (agents keep prior state, not blocking)"; } >> "$LOG"
  fi
else
  { print -- "WARN: $CFG is not a git worktree; skipping agent refresh"; } >> "$LOG"
fi

# 0b. Read side: ensure every shoresh-family project slug shares the ONE canonical memory, so a
#     session launched from ~/dev/shoresh or any (future) worktree loads the same memory rather
#     than a blank slate. Idempotent + best-effort; never clobbers a real memory dir.
for d in "$HOME/.claude/projects"/-Users-gregfeitel-dev-shoresh*/; do
  [ -d "$d" ] || continue
  m="${d%/}/memory"
  [ -L "$m" ] && continue
  if [ -d "$m" ] && [ -f "$m/MEMORY.md" ]; then
    { print -- "WARN: ${d:t} has a real memory dir; not linking"; } >> "$LOG"; continue
  fi
  [ -d "$m" ] && rmdir "$m" 2>/dev/null
  ln -s "$MEMDIR" "$m" 2>>"$LOG" && { print -- "linked memory for ${d:t} -> canonical"; } >> "$LOG"
done

# 1. Deterministic gather.
PACKET="$("$SCRIPTS/gather.sh" "$DAY")"
if ! grep -q '^  - \[' "$PACKET" 2>/dev/null; then
  { print -- "no signal for $DAY, skipping mine"; } >> "$LOG"
  exit 0
fi

# 2. Build the mining prompt with paths substituted.
PROMPT="$(sed -e "s#{{PACKET}}#$PACKET#g" -e "s#{{MEMDIR}}#$MEMDIR#g" -e "s#{{REPO}}#$REPO#g" "$SCRIPTS/consolidate.md")"

# 3. Mine — Write/Edit disabled; stdout captured to a quarantine proposal file.
#    Retries transient API failures (e.g. "Connection closed mid-response", which lost the
#    2026-08-10 run). A real proposal is >500 bytes and does not start with an API-error marker;
#    anything else is treated as a failed attempt. On total failure the bad output is parked as
#    FAILED-proposal-<day>.md so it can never be mistaken for a real proposal.
PROPOSAL="$OUT/proposal-$DAY.md"

# Refuse to clobber a proposal that already exists for this day. Red Hat found this asymmetry on
# 44b49c6: mineFromPacket.sh guards its write, run.sh did not — so a manual `run.sh <day>` on an
# already-recovered day silently replaced a good analysis with a fresh (possibly worse, possibly
# failed) one, with no log line distinguishing "created" from "replaced".
if [[ -f "$PROPOSAL" ]] && [ "$(wc -c <"$PROPOSAL" 2>/dev/null || print 0)" -gt 500 ]; then
  { print -- "refusing to re-mine $DAY — $PROPOSAL already exists ($(wc -c <"$PROPOSAL" | tr -d ' ') bytes). Delete it first if you really mean to replace it."; } >> "$LOG"
  print -- "$PROPOSAL"; exit 0
fi

# Mine into a temp file, not straight onto $PROPOSAL: a failed or killed attempt must never leave a
# truncated file sitting where a real proposal belongs.
MINETMP="$OUT/.mining-$DAY.$$"
trap 'rm -f "$MINETMP"' EXIT INT TERM
attempt=0; rc=1
while [ $attempt -lt 3 ]; do
  attempt=$((attempt+1))
  "$CLAUDE" -p "$PROMPT" \
    --allowedTools "Read" "Grep" "Glob" \
    --disallowedTools "Write" "Edit" "Bash" \
    > "$MINETMP" 2>>"$LOG"
  rc=$?
  bytes=$(wc -c <"$MINETMP" 2>/dev/null); bytes=${bytes:-0}
  # Classification is scripts/consolidation/classifyMineOutput.sh (T168) — extracted so the
  # success/auth-fail/retry decision is testable against fixture files instead of only by
  # reading. Ordering and anchoring (success check first, auth check anchored to the first
  # line, reached only after success is rejected) are preserved exactly inside that script.
  CLASS=$("$SCRIPTS/classifyMineOutput.sh" "$rc" "$MINETMP")
  if [ "$CLASS" = "SUCCESS" ]; then
    # A later success for this day retires any marker an earlier attempt parked. Without this,
    # integration.sh's backlog block reports a day that is actually done, every morning, forever —
    # which trains the reader to ignore the one surface whose whole job is "never go silent".
    # mv can fail — full disk, an unmounted or unwritable home at 03:00. Unchecked, the trap
    # below then deletes the temp holding the only copy of a mined analysis that cost real API
    # calls, while the log says "ok". Red Hat, round 2: that is a regression in kind from the
    # unguarded-write finding it was fixing. On failure: disarm the trap, keep the output, and
    # say so loudly.
    if ! mv "$MINETMP" "$PROPOSAL"; then
      trap - EXIT INT TERM
      { print -- "ERROR: mined $bytes bytes for $DAY but mv to $PROPOSAL FAILED — output preserved at $MINETMP, NOT deleted"; } >> "$LOG"
      print -- "MV-FAILED"; exit 4
    fi
    rm -f "$OUT/FAILED-proposal-$DAY.md" "$OUT/NEEDS-AUTH-proposal-$DAY.md"
    { print -- "mine ok (attempt $attempt) -> $PROPOSAL ($bytes bytes)"; } >> "$LOG"
    print -- "$PROPOSAL"; exit 0
  fi
  # Non-retryable failure classes. An expired login cannot heal in 20s, so three
  # attempts only turn one dead night into three. Matched on the message TEXT, never
  # on size or exit code: the transient failures (35/48/81/115/162 bytes) recovered on
  # retry and must keep doing so. Parked under a distinct name the morning report can
  # tell apart from a transient failure.
  if [ "$CLASS" = "AUTH-FAIL" ]; then
    { print -- "mine FAILED non-retryably for $DAY (authentication) after $attempt attempt(s) — not retrying. Fix: claude /login, then mineFromPacket.sh $DAY"; } >> "$LOG"
    if ! mv "$MINETMP" "$OUT/NEEDS-AUTH-proposal-$DAY.md" 2>/dev/null; then trap - EXIT INT TERM; { print -- "ERROR: could not park $MINETMP for $DAY — left in place, not deleted"; } >> "$LOG"; fi
    print -- "NEEDS-AUTH"; exit 2
  fi
  { print -- "mine attempt $attempt FAILED (exit=$rc, $bytes bytes)$([ $attempt -lt 3 ] && echo '; retrying in 20s')"; } >> "$LOG"
  [ $attempt -lt 3 ] && sleep 20
done
# All attempts failed — park the bad output; do NOT leave it looking like a proposal.
if ! mv "$MINETMP" "$OUT/FAILED-proposal-$DAY.md" 2>/dev/null; then trap - EXIT INT TERM; { print -- "ERROR: could not park $MINETMP for $DAY — left in place, not deleted"; } >> "$LOG"; fi
{ print -- "mine FAILED after $attempt attempts for $DAY — parked as FAILED-proposal-$DAY.md; recover with: mineFromPacket.sh $DAY (NOT run.sh $DAY — that re-runs gather.sh, which is mtime-selected and truncating, and would destroy the preserved packet)"; } >> "$LOG"
print -- "FAILED"; exit 1
