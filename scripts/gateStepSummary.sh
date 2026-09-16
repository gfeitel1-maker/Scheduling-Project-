#!/bin/zsh
# Extract the human-readable summary column for one gate step (T171 item 3).
#
# Reads a step's combined output on stdin, prints ONE line: either the summary it
# recognised, or the literal token UNMATCHED.
#
# WHY THIS IS NOT INLINE ANY MORE. The pattern below is tuned to today's vitest
# and eslint output. When a tool changes its format the pattern stops matching —
# and the old inline version then wrote `STEP lint | rc=0 |` with a blank column,
# which reads exactly like a clean run with nothing to report. That is the same
# "absence read as success" this program keeps finding: the gate's own exit code
# (gateResultCode.sh), a missing results file, an empty one, audit_events
# rejecting every write while the health check reported HEALTHY.
#
# So absence gets a NAME. `UNMATCHED` means "this step produced output I could not
# summarise", which a reader responds to differently from "this step had nothing
# to say" — the same three-valued honesty as gateResultCode's `2 = cannot tell`.
#
# DELIBERATELY NOT FATAL. rc stays authoritative: none of the DONE/dirty/binding
# logic reads this column, so a cosmetic format drift must not fail a gate whose
# steps all passed. Loud, not fatal.
emit() { print -r -- "$1"; }

input=$(cat)

# An empty step output is itself unsummarisable — say so rather than printing a
# blank that looks like a matched-but-quiet result.
if [[ -z "${input//[[:space:]]/}" ]]; then
  emit UNMATCHED
  exit 0
fi

# `byte-identical` is agents:check's summary. It was MISSING from this pattern until T171 item 3,
# which means that column was blank in every gate run ever recorded — and nobody could tell,
# because a blank column reads as "clean, nothing to report". The very first run of the UNMATCHED
# marker surfaced it. That is the argument for the marker in one line.
t=$(print -r -- "$input" \
  | grep -E "Tests +[0-9]|passed \(|no findings|0 findings|✖ [0-9]+ problems|byte-identical" \
  | tail -1 | tr -s ' ')

# Trim surrounding whitespace; a match that is only spaces is not a summary.
t="${t##[[:space:]]#}"
t="${t%%[[:space:]]#}"

if [[ -z "$t" ]]; then
  emit UNMATCHED
else
  emit "$t"
fi
