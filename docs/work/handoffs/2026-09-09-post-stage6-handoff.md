---
title: "Handoff — after Stage 6: what is left, and what needs a second machine"
document_type: handoff
authority: descriptive
status: active
date: 2026-09-09
created: 2026-09-09
task: docs/work/plans/2026-09-07-stage6-cutover-plan.md
archive_when: Stage 6 has been validated on two physical machines and the three loose ends below are closed
---

# Handoff — after Stage 6

**Stage 6 is complete and merged.** This document does not summarise it. That summary already exists
in four places that are current — `docs/current/PLATFORM_STATE.md`, the ADRs,
`docs/current/CRDT_SECURITY_GAPS.md`, and PRs #339–#347 — and a fifth copy would be a fifth thing to
go stale. Read those for *what the system is*.

This is only **what is not done**.

---

## 1. The one that matters: Stage 6 has never run on two real machines

Everything shipped is verified by integration tests and a single-device run of the real app. Every
scenario puts two libp2p nodes in **one process, on one machine, on one OS**.

**Why this is not a formality.** Stage 5 was hardware-validated and that pass found **six defects CI
could not see** (recorded under "Hard-won findings" in the superseded Stage 6 handoff). One of them:
`A.merge` consumes its first argument, so a redundant frame left an invalidated document handle and
**permanently bricked local edits until restart** — in ordinary two-device use. In-process tests never
sent a no-op merge before a local write, so it passed every gate.

Unexercised today: mDNS across a real LAN, a real firewall, Windows, two physical devices, and any
real network timing.

**The path to test, in order** — this is the flow a director actually performs:

1. Bootstrap a camp on machine A.
2. On machine B, join **by camp code** (the address picker is gone — A opens *Add a device*, B enters
   the code A reads off its own screen).
3. Edit the same field on both while connected. A genuine disagreement should surface as a conflict
   **on both devices**, and be resolvable from either.
4. Edit on B while A is closed. Reopen A. Both sides' work should be present.
5. Delete a record on A. On B, **Trash should name who deleted it** — not "Unknown".
6. Hand-edit a name on B, then re-import a spreadsheet on A. **The correction must survive.**

Steps 5 and 6 are the newest code (authorship, provenance) and have never run across a real network.

**This needs the owner and a second machine.** It is not a solo-agent task.

---

## 2. A scheduled job is still writing to trunk

A daily "nightly current-state refresh" commits **directly to `main`**, bypassing PR and gate — 2 of
the last 25 commits arrived that way while the other 23 went through review.

Its content has been accurate and useful; the owner set it up so they would not forget to run
`/update-state`. **The purpose is now served by the gate instead**: `check-governance` grows a
`platform-state-stale` finding that fires when `PLATFORM_STATE.md` trails the last structural change
(schema, migrations, ADRs, screens) and names the command that fixes it. That fires at the moment
work lands rather than on a timer, and can only report.

So the job is now redundant *and* unattended-writing-to-trunk. **It should be stopped.**

**Where it is:** not found on this machine — not launchd (both agents were checked and neither
refreshes state or pushes), not crontab, no `.github/workflows`, and the scheduled-tasks list is
empty. It commits as `Claude <noreply@anthropic.com>`, so it is most likely a **cloud routine**,
stoppable from claude.ai or `/schedule`. Recorded rather than guessed at.

---

## 3. `localDb.js` still contains literal NUL bytes

The last such file in the repo (`reconcile.js` was fixed in #341, `syncClient.js` was deleted with
the WebSocket layer).

**Why it is worth the small effort.** A literal NUL makes plain `grep` treat the file as binary and
**silently return zero matches** — no error, no warning. `localDb.js` is one of the most-searched
files in the repo, and this already produced one wrong conclusion ("no unique index on
`operations.client_write_id` exists", 2026-09-04) that drove a migration + test + comment fix which
had to be fully reverted.

**Two traps, both learned the hard way:**

- **The authoring layer eats the escape.** Typing the six-character escape into a Bash command, a
  heredoc, or Write-tool content converts it to a raw `0x00` byte before it reaches disk — so a
  hand-edit silently *reintroduces* the defect it means to fix. What works is a pattern-driven
  `perl -i -pe` where the replacement is generated rather than typed.
- **`file` saying "text" does NOT prove `grep` works.** `file(1)` only samples a prefix;
  `localDb.js` reports as UTF-8 text while its NULs sit near line 2286. To enumerate offenders,
  byte-scan:

  ```
  for f in $(git ls-files '*.js'); do perl -ne 'if(/\x00/){print "$ARGV\n"; exit}' "$f"; done
  ```

Prove byte-identity after the change (reconstruct the raw byte from the escape and compare against
the HEAD blob) — the delimiter is load-bearing for Map keys.

---

## Working rules that earned their place this session

Not general advice — each of these cost real time on 2026-09-08/09.

- **Run `graphify affected <symbol>` BEFORE deleting or restructuring anything shared.** Four
  hand-written `grep` sweeps produced four different false negatives during the WebSocket removal
  (unquoted zsh `--include` glob; a regex assuming a path prefix; a `| head` that truncated the
  result list; `file -b` misused as a byte detector). The graph listed the missed files in one
  command. Its own blind spots are recorded in `CLAUDE.md` — object-literal methods and
  `readFileSync` string references are invisible to it, so the order is **graph → `grep -a` → gate**.
- **A zero-result search is a claim about the SEARCH.** Two tells that it is lying: a count of zero
  for something you know exists, and a *uniform* zero across many items where you expected variation.
- **Read the gate's exit code from a file, never a piped tail.** `npm run verify | tail` reports the
  pipe's status; a red gate read green this way.
- **A gate that runs fewer files than the baseline is untrustworthy in EITHER direction.** Under
  machine load ≥ ~30 the suite can silently skip files and still print a verdict. Healthy baseline is
  currently **350 files / ~4870 tests / 20 integration scenarios** — check the count before the
  verdict, and wait for load below ~15.
- **Prove a new regression test actually fails without its fix.** Both scenarios added this session
  (29, 30) were verified by temporarily disabling the fix. A test that passes before and after proves
  nothing.

---

## What is explicitly NOT open

So the next session does not go looking:

- `CRDT_SECURITY_GAPS.md` has nothing OPEN. Two vulnerabilities fixed, one tradeoff owner-accepted
  (role enforcement is device-side), the rest closed.
- Branches and worktrees are clean: `origin` has only `main`; the sole other branch is the owner's
  deliberately parked `claude/shoresh-future-architecture-364e03`.
- The op-log question is settled and should not be reopened: **retired as a sync mechanism, kept as a
  local history ledger.** Dropping the `operations` table would break Trash, Restore and ingest undo.
