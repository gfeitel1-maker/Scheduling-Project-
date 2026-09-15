#!/bin/zsh
# Nightly deterministic "sleep" pass — Option 2.
# Selects the day's transcripts, filters to correction signal (RAW lines, not summaries),
# and writes a pending evidence packet. NO LLM, NO writes to real memory.
set -u
JQ="$HOME/bin/jq"
PROJ="$HOME/.claude/projects/-Users-gregfeitel-Desktop-Camp-App-System--Applications-Schedule-Project"
OUT="$PROJ/memory/_pending"
mkdir -p "$OUT"
# Day window: default today; arg1 can override (YYYY-MM-DD) for dry-runs.
DAY="${1:-$(date +%F)}"
PACKET="$OUT/evidence-$DAY.md"

print -- "# Consolidation evidence — $DAY" > "$PACKET"
print -- "_Deterministic gather across ALL shoresh-family launch identities (Desktop project + every ~/dev/shoresh* slug incl. worktrees). Raw human corrections + tool errors from the day's sessions. Review with Claude to mine into memory deltas._\n" >> "$PACKET"

# Scan transcripts across every shoresh-family project slug, not just the Desktop one, so work
# done from ~/dev/shoresh or any worktree is consolidated into the one canonical memory.
# Selected by mtime == DAY.
PROJECTS="$HOME/.claude/projects"
typeset -a SRCDIRS
SRCDIRS=("$PROJ" "$PROJECTS"/-Users-gregfeitel-dev-shoresh*(/N))
found=0
for d in "${SRCDIRS[@]}"; do
  slug="${d:t}"
  for f in "$d"/*.jsonl(.N); do
    fday=$(date -r "$f" +%F)
    [[ "$fday" != "$DAY" ]] && continue
    sid="${f:t:r}"
    # Extract: human text turns (not tool_results) + error tool_results, with line numbers.
    sig=$("$JQ" -rc --arg sid "$sid" '
      select(.type=="user")
      | (.message.content) as $c
      | if ($c|type)=="string" then [{t:"USER",text:$c}]
        elif ($c|type)=="array" then
          [ $c[] | if .type=="text" then {t:"USER",text:.text}
                   elif (.type=="tool_result" and (.is_error==true))
                     then {t:"ERR", text:((.content|tostring))}
                   else empty end ]
        else [] end
      | .[]
      | select((.text|type)=="string" and ((.text|gsub("\\s";""))|length)>0)
      # drop harness plumbing injected as user messages (not human-typed)
      | select((.text|test("<system-reminder>|<command-name>|<local-command|<task-notification>|<task-id>|<output-file>|<tool-use-id>|caveat: The messages below|Base directory for this skill|Launching skill:"))|not)
      | "  - ["+.t+" "+$sid[0:8]+":L"+(input_line_number|tostring)+"] "+(.text|gsub("\n";" ")|.[0:400])
    ' "$f" 2>/dev/null)
    if [[ -n "$sig" ]]; then
      found=1
      print -- "\n## session $sid  (launched from: $slug)" >> "$PACKET"
      print -- "$sig" >> "$PACKET"
    fi
  done
done

if [[ "$found" == 0 ]]; then
  print -- "\n_No sessions found for $DAY._" >> "$PACKET"
fi
print -- "$PACKET"
