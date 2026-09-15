#!/bin/zsh
# Pure predicate: classify one mining attempt's output. Extracted from scripts/consolidation/
# run.sh (T168) so the classifier is testable against fixture files instead of only by reading.
#
# Order matters and is preserved exactly: the success check runs FIRST; the non-retryable
# (auth-failure) check is reached only when the success check has already rejected the attempt,
# and it is anchored to the FIRST LINE of the output (`head -n 1`), never a body-wide grep. A
# successful, >500-byte proposal whose BODY happens to mention "Failed to authenticate" (because
# the day's sessions discussed a login failure) must classify as SUCCESS, not AUTH-FAIL — an
# unanchored, whole-file grep discarded exactly such a proposal (13,088 bytes) on 2026-09-14.
#
# Usage: classifyMineOutput.sh <rc> <output-file>
#   stdout: SUCCESS | AUTH-FAIL | RETRY
#   exit 0 = SUCCESS, 2 = AUTH-FAIL, 1 = RETRY (mirrors run.sh's own exit codes for these paths)
set -u
rc="$1"
f="$2"
bytes=$(wc -c <"$f" 2>/dev/null); bytes=${bytes:-0}

if [ "$rc" -eq 0 ] && [ "$bytes" -gt 500 ] && ! grep -qaiE '^(API Error|Connection closed|Execution error)' "$f"; then
  print -- "SUCCESS"
  exit 0
fi

if head -n 1 "$f" | grep -qaiE '^(Failed to authenticate|Invalid API key|Credit balance)'; then
  print -- "AUTH-FAIL"
  exit 2
fi

print -- "RETRY"
exit 1
