#!/bin/zsh
# Pure predicate: given a worktree's already-computed facts, what does integration.sh's 06:30
# prune pass do with it? Extracted from scripts/integration.sh (T168) so the
# `ephemeral && clean && 0-ahead && idle` prune rule is testable against fixtures — this
# routine DELETES directories and had zero coverage before this ticket.
#
# Usage: worktreeDecision.sh <protected:0|1> <ahead> <ephemeral:0|1> <dirty:0|1> <idle_days> <idle_threshold>
#   stdout: PROTECTED | READY | PRUNE | ACTIVE-DIRTY | ACTIVE-IDLE
#
# Order mirrors integration.sh exactly: a leased/ledger-protected or trunk/config path wins over
# everything (protection can only ever fail safe), then unmerged work (ahead > 0) is surfaced for
# a human decision, then — only for an ephemeral worktree that is clean and idle long enough — it
# is pruned. A worktree present in Claude Desktop's ledger (leasedBy/pooledAt) is bit-for-bit the
# shape this prune rule targets, which is exactly why the ledger check must run first.
set -u
protected="$1" ahead="$2" ephemeral="$3" dirty="$4" idle_days="$5" idle_threshold="$6"

if (( protected )); then
  print -- "PROTECTED"
elif (( ahead > 0 )); then
  print -- "READY"
elif (( ephemeral )) && (( ! dirty )) && (( idle_days >= idle_threshold )); then
  print -- "PRUNE"
elif (( dirty )); then
  print -- "ACTIVE-DIRTY"
else
  print -- "ACTIVE-IDLE"
fi
