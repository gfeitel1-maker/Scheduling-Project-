#!/bin/zsh
# Recovery path for a night whose MINE stage failed while its GATHER stage succeeded.
#
# Why this exists instead of `run.sh <day>`:
#   run.sh calls gather.sh unconditionally, and gather.sh (a) selects transcripts by file
#   MTIME and (b) writes the packet with `>` (truncate). Transcript mtimes drift — a file
#   touched later no longer falls in its original day. So re-running run.sh for a past day
#   DESTROYS the preserved evidence packet and rebuilds it from the wrong file set.
#   Measured 2026-09-14: 2026-09-10's packet holds 66 signal lines; gather.sh would now
#   find 1 file for that day.
#
# This script therefore NEVER invokes gather.sh and NEVER writes to evidence-*.md.
# It mines the packet that is already on disk. Strictly additive.
set -u
export PATH="$HOME/.local/bin:$PATH"
CLAUDE="$HOME/.local/bin/claude"
source "${0:A:h}/../memoryProject.sh"
PROJ="$MEMORY_PROJ"
SCRIPTS="${0:A:h}"
CONS="$PROJ/_consolidation"   # DATA (run.log) — unchanged
MEMDIR="$PROJ/memory"
REPO="$HOME/dev/shoresh"
OUT="$MEMDIR/_pending"
LOG="$CONS/run.log"

DAY="${1:-}"
if [[ -z "$DAY" ]]; then
  print -u2 -- "usage: mineFromPacket.sh <YYYY-MM-DD> [...]   (mines an EXISTING evidence packet)"
  exit 64
fi

for DAY in "$@"; do
  PACKET="$OUT/evidence-$DAY.md"
  PROPOSAL="$OUT/proposal-$DAY.md"

  if [[ ! -f "$PACKET" ]]; then
    print -u2 -- "SKIP $DAY — no evidence packet at $PACKET (nothing to mine; do NOT run gather for a past day)"
    continue
  fi
  if [[ -f "$PROPOSAL" ]]; then
    print -u2 -- "SKIP $DAY — $PROPOSAL already exists; refusing to overwrite a proposal"
    continue
  fi
  if ! grep -qa '^  - \[' "$PACKET"; then
    print -u2 -- "SKIP $DAY — packet has no signal lines (a genuinely quiet day, not a failure)"
    continue
  fi

  PROMPT="$(sed -e "s#{{PACKET}}#$PACKET#g" -e "s#{{MEMDIR}}#$MEMDIR#g" -e "s#{{REPO}}#$REPO#g" "$SCRIPTS/consolidate.md")"

  # Same guarantees as the nightly run: no Write, no Edit, no Bash. Real memory cannot be
  # touched; the model's stdout is captured into the quarantine proposal file.
  # Atomic claim. The `[[ -f $PROPOSAL ]]` check above is a TOCTOU: two recoveries for the same day
  # can both pass it, because a full `claude -p` runs between check and write, and the last mv wins
  # silently. mkdir is atomic on POSIX, so exactly one claimant proceeds. (Red Hat, 44b49c6.)
  LOCK="$OUT/.mining-$DAY.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    # A `kill -9` on a prior run bypasses the `trap` below and leaves $LOCK on disk forever,
    # which would otherwise SKIP this day permanently. Consult the pure staleness predicate
    # before assuming the lock is live — it now checks the recorded holder's PID, not just
    # age, so a `claude -p` mine that legitimately outruns the age bound is never treated
    # as abandoned out from under it. (T169; Red Hat round 2.)
    "$SCRIPTS/lockIsStale.sh" "$LOCK"
    staleRc=$?
    if [[ $staleRc -eq 0 ]]; then
      # Same probe order as lockIsStale.sh: GNU `stat -f %m` SUCCEEDS on Linux (prints the
      # mount point), so an `||` fallback would never run and the arithmetic would throw.
      mtime="$(stat -c %Y "$LOCK" 2>/dev/null)"
      [[ "$mtime" =~ ^[0-9]+$ ]] || mtime="$(stat -f %m "$LOCK" 2>/dev/null)"
      [[ "$mtime" =~ ^[0-9]+$ ]] || mtime=$(date +%s)
      age=$(( $(date +%s) - mtime ))
      print -u2 -- "STALE LOCK $DAY — $LOCK is ${age}s old; a prior run likely died without cleaning up. Removing and retaking."
      rm -rf "$LOCK"
      if ! mkdir "$LOCK" 2>/dev/null; then
        # Distinguishable from FAIL/SKIP-no-packet in $LOG: this SKIP means a second
        # invocation legitimately lost the mkdir race to take over a truly stale lock,
        # not that it never ran at all.
        print -u2 -- "SKIP $DAY — another recovery won the race for this day ($LOCK)"
        { print -- "recover $DAY: SKIPPED (lost mkdir race after removing a stale lock)"; } >> "$LOG"
        continue
      fi
    elif [[ $staleRc -eq 2 ]]; then
      print -u2 -- "SKIP $DAY — lock state at $LOCK could not be determined; refusing to remove it ($LOCK)"
      continue
    else
      print -u2 -- "SKIP $DAY — another recovery for this day is already running ($LOCK)"
      continue
    fi
  fi
  # Record the holder so a later lockIsStale.sh call can tell "still running" from
  # "died without cleaning up" instead of guessing from age alone. $LOCK already exists at
  # this point on every path that reaches here, so this is just a file inside it — removed
  # along with everything else by the `rm -rf "$LOCK"` in the trap below.
  print -- "$$" > "$LOCK/holder.pid"
  TMP="$OUT/.mining-$DAY.$$"
  trap 'rm -rf "$LOCK"; rm -f "$TMP"' EXIT INT TERM
  "$CLAUDE" -p "$PROMPT" \
    --allowedTools "Read" "Grep" "Glob" \
    --disallowedTools "Write" "Edit" "Bash" \
    > "$TMP" 2>>"$LOG"
  rc=$?
  bytes=$(wc -c <"$TMP" 2>/dev/null); bytes=${bytes:-0}

  # Order matters, and this cost a recovered proposal on 2026-09-14. The auth check MUST come
  # after the success check and MUST be anchored: a SUCCESSFUL proposal about a day whose sessions
  # discussed the login failure legitimately contains the words "Failed to authenticate" and
  # "OAuth session expired". An unanchored, ungated match discarded a valid 13,088-byte proposal
  # and reported "not authenticated" while `claude auth status` said loggedIn: true. A failure
  # detector must never fire on a success that merely describes the failure.
  if [[ $rc -eq 0 && "$bytes" -gt 500 ]] && ! grep -qaiE '^(API Error|Connection closed|Execution error)' "$TMP"; then
    # Lock held THROUGH the write: releasing before the mv reopened the window it was added to
    # close — a second recovery could claim the lock and start a concurrent mine. (Red Hat r2.)
    if ! mv "$TMP" "$PROPOSAL"; then
      trap - EXIT INT TERM; rmdir "$LOCK" 2>/dev/null
      print -u2 -- "MV-FAILED $DAY — mined output preserved at $TMP, NOT deleted"
      { print -- "recover $DAY: MV FAILED; output preserved at $TMP"; } >> "$LOG"
      exit 4
    fi
    rmdir "$LOCK" 2>/dev/null
    rm -f "$OUT/FAILED-proposal-$DAY.md" "$OUT/NEEDS-AUTH-proposal-$DAY.md"
    { print -- "recover $DAY: mined from existing packet -> $PROPOSAL ($bytes bytes)"; } >> "$LOG"
    print -- "$PROPOSAL"
  elif head -n 1 "$TMP" | grep -qaiE '^(Failed to authenticate|Invalid API key|Credit balance)'; then
    # Reached only when the attempt already failed, and matched only at the START of the output —
    # the real body is the whole file ("Failed to authenticate: OAuth session expired ...", 73 bytes).
    if ! mv "$TMP" "$OUT/NEEDS-AUTH-proposal-$DAY.md" 2>/dev/null; then trap - EXIT INT TERM; print -u2 -- "could not park $TMP — left in place"; fi
    rmdir "$LOCK" 2>/dev/null
    print -u2 -- "STOP $DAY — not authenticated. Run: claude /login   (packets intact; output parked for inspection)"
    { print -- "recover $DAY: NEEDS-AUTH (output parked, no packet touched)"; } >> "$LOG"
    exit 2
  else
    if ! mv "$TMP" "$OUT/FAILED-proposal-$DAY.md" 2>/dev/null; then trap - EXIT INT TERM; print -u2 -- "could not park $TMP — left in place"; fi
    rmdir "$LOCK" 2>/dev/null
    print -u2 -- "FAIL $DAY — mine failed (exit=$rc, $bytes bytes); output parked, packet untouched"
    { print -- "recover $DAY: FAILED (exit=$rc, $bytes bytes); output parked"; } >> "$LOG"
  fi
done
