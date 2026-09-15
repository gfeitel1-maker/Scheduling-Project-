---
title: "Finish the consolidation move, and make gate.sh trustworthy about its own result"
document_type: ticket
status: open
created: 2026-09-15
task_class: test-infrastructure
governing_docs: [docs/governance/standards/WORKING_COPY_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
archive_when: launchd runs the in-repo consolidation scripts, the out-of-repo copies are gone, gate.sh has automated coverage of its own exit code, and the per-user slug is not hardcoded in three scripts
---

# T171 — Finish the consolidation move; harden `gate.sh`

Raised by Code Reviewer against `f3c5c16..31ba59e` (scored 3/5).

## 1. The plist repoint is not done — two copies exist

`scripts/consolidation/*.sh` and `~/.claude/projects/<slug>/_consolidation/*.sh` both exist, and
**launchd runs the second one.** Editing the repo copy, watching the gate pass, and merging does
not change what runs at 03:00. Documented at the top of `scripts/consolidation/README.md`, with
the exact repoint commands; it cannot happen until this branch merges *and* the main checkout
advances, because pointing the plist at a path that does not exist yet breaks the run outright —
which was tried, caught and reverted on 2026-09-15.

Done when: the plist runs the in-repo copy, the old copies are deleted with a marker left behind,
and one 03:00 run has succeeded through the new path.

## 2. `gate.sh` always exited 0 — fixed, but untested

The final line was `grep -c ... >/dev/null 2>&1 && exit 0 || exit 0`, which exits 0 on **both**
branches. The gate reported success regardless of what was in its own results file.

That is the defect this entire program exists to remove — "started" taken for "succeeded" —
sitting in the tool built to detect it. It shipped through a 13/13 green run for a simple reason:
**the gate never runs itself.** Nothing in the suite executes `gate.sh` and checks what it
returns, so the one tool whose output the GateReport chain trusts is the one thing with no
coverage.

Fixed in this branch and verified by hand both directions (failing run → 1, passing run → 0). It
needs a test, which is blocked on the same shell-testing gap as T168: the tractable version is a
fixture results file plus an assertion on the exit code, needing no real gate run.

## 3. `scripts/gate.sh`'s summary grep is format-coupled

`step()` extracts a summary with a fixed pattern tuned to today's vitest/eslint output. If a
tool's format changes the summary column silently goes blank. Low severity — `rc` is still
captured correctly and none of the DONE/dirty/binding logic reads the summary — but it is the
same brittle text-matching this repository has been burned by before, and it should fail loudly
rather than quietly produce an empty column.

## 4. The per-user slug is hardcoded in three scripts

`run.sh`, `mineFromPacket.sh` and `integration.sh` each embed
`-Users-gregfeitel-Desktop-Camp-App-System--Applications-Schedule-Project`. The move's stated
point was "works from any checkout", and that is only half true: the SCRIPTS half is portable via
`${0:A:h}`, the DATA half is one person's home directory literal. Pre-existing, not introduced
here, but the claim and the code should agree.
