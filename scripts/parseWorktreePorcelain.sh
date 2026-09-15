#!/bin/zsh
# Pure predicate: parse `git worktree list --porcelain` output into wt\tbranch\thead rows.
# Extracted from scripts/integration.sh (T168) so the parsing is testable against a fixture
# porcelain table instead of only against live git output.
#
# substr($0, 10), not $2: awk's default whitespace split truncates a path at its first space,
# and real worktree paths contain them (e.g. ~/dev/Mobile Prototype/...). Pre-existing bug found
# by Code Reviewer (44b49c6) — fixing it as $2 would have silently defeated the ledger-match
# protection this same file relies on. See test/worktreePrunePredicate.test.js.
#
# Usage: parseWorktreePorcelain.sh [file]   (defaults to stdin)
set -u
awk '
  /^worktree /{wt=substr($0, 10)}
  /^HEAD /{h=$2}
  /^branch /{print wt"\t"$2"\t"h; wt=""}
  /^detached/{print wt"\tDETACHED\t"h; wt=""}
' "${1:-/dev/stdin}"
