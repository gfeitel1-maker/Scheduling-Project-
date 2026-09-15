---
title: "Nightly consolidation scripts — why they live here and what must not move"
document_type: reference
status: active
governing_docs: [docs/governance/standards/WORKING_COPY_STANDARD.md]
---

# Nightly consolidation

## ⚠️ Two copies exist right now — launchd still runs the OLD one

Moving these scripts into the repo did **not** repoint the scheduler. As of this commit:

| | path | run by launchd? |
|---|---|---|
| repo copy (this directory) | `scripts/consolidation/*.sh` | **no** |
| original | `~/.claude/projects/<slug>/_consolidation/*.sh` | **yes, at 03:00** |

So editing a script here, seeing the gate pass, and merging **does not change what runs tonight**.
The two copies are independently editable and will drift.

The repoint is deliberately deferred: `com.shoresh.memory-consolidation.plist` can only point at
`~/dev/shoresh/scripts/consolidation/run.sh` once that path exists on the checkout launchd reads,
which means after this branch merges *and* the main checkout advances. Pointing it early breaks
the 03:00 run outright — which was tried, caught, and reverted on 2026-09-15.

**To finish the move** (after merge, with the main checkout on the merged commit):

```bash
P=~/Library/LaunchAgents/com.shoresh.memory-consolidation.plist
cp -n "$P" "$P.bak-$(date +%F)"
# replace the _consolidation/run.sh path with ~/dev/shoresh/scripts/consolidation/run.sh
plutil -lint "$P"                        # must print OK
launchctl unload "$P" && launchctl load "$P"
```

Then delete the old copies so they cannot drift, leaving a marker in their place. Until that is
done, **the original directory is the source of truth for what actually runs.** Tracked as T171.

---

`com.shoresh.memory-consolidation` (03:00) runs `run.sh`. `com.shoresh.integration-report`
(06:30) runs `../integration.sh`, which calls back into `run.sh` and `mineFromPacket.sh`.

## Why these are in the repo now

They run unattended, with permission to write the memory store. Living under
`~/.claude/projects/<slug>/_consolidation/` they were untracked, unreviewed and unbacked-up — no
history, no review, no way to see what changed or when. `WORKING_COPY_STANDARD.md` R7 is the rule;
`integration.sh` moved for the same reason on 2026-09-05 and this finishes that job. Two
independent reviewers flagged the remaining half as the load-bearing part nobody could review.

## The split that matters

| | where | may it move? |
|---|---|---|
| **Scripts** | here, in the repo | yes — resolved via `${0:A:h}` |
| **Data** — `run.log`, `memory/`, `memory/_pending/` | `~/.claude/projects/<slug>/` | **no.** A live memory store. Never check it in. |

These were one variable (`$CONS`) before the move. Splitting them is the point.

## Recovery — read this before touching a failed night

**Never run `run.sh <old-day>` to recover a past night.** `run.sh` calls `gather.sh`
unconditionally, and `gather.sh` selects transcripts by file **mtime** and writes the packet with
`>`. Mtimes drift, so re-running for an old day rebuilds the packet from the wrong file set after
truncating the good one. Measured 2026-09-14: the 2026-09-10 packet held 66 signal lines;
`gather.sh` would have found 1 file for that day.

Use `mineFromPacket.sh <day>...` — it mines the packet already on disk, never invokes `gather.sh`,
never writes `evidence-*.md`, and refuses to overwrite an existing proposal.

`run.sh <yesterday>` remains legal from `integration.sh`'s self-heal, because yesterday's mtimes
are still accurate.

## Failure classification

`run.sh` retries transient failures and **halts** on non-retryable ones (expired login, invalid
key, credit balance). The match is on message text, anchored to the **first line**, and only after
the success check has already rejected the attempt. All three conditions matter: an unanchored,
ungated match once discarded a valid 13,088-byte proposal because the proposal *described* the
auth failure it was scanning for.
