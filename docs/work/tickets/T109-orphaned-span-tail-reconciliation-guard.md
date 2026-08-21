---
title: T109-orphaned-span-tail-reconciliation-guard
document_type: ticket
status: open
created: 2026-08-20
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T105-elective-inline-authoring-and-render.md, docs/work/tickets/T111-elective-cell-atomic-content-and-mutual-exclusion.md]
archive_when: shipped and merged
---

# T109 — Orphaned span-tail reconciliation guard (PRE-EXISTING, surfaced by T105 Red Hat)

## What it is

Any multi-row schedule-cell mutation (`replaceSlot`/`collectSpanTails` for activity→activity replacement
today; span-head→elective conversion in T105) writes the head and each tail row via **separate,
sequentially-awaited `localClient.write()` IPC calls** (`scheduleRepository.js:65-73`), serialized only
by `claimAndRun` — which is **same-device write-ordering, not crash/network-atomic** (`useSlotMutations.js`
~154-235). A crash, Host disconnect, or a single rejected write between the head write and a tail-release
write leaves an **orphaned tail**: a row with `activity_id` set, `is_span_head:false`, whose head no
longer carries that activity. `buildSchedule.js:511` (`activitySlots` filter) then treats that orphaned
tail as a live activity slot with no head — the **exact HIGH class commit 8357447 fixed**, reachable
again under partial failure.

## Why it's its own ticket, not part of T105

This is a **pre-existing** latent issue affecting the existing activity→activity `replaceSlot` path, not
something electives introduce — electives merely add another multi-row mutation with the same exposure.
Folding a whole-app reconciliation guard into T105 would bloat it. T105 instead (a) corrects its design's
false "true atomicity" claim to an honest disclosed residual matching the existing posture, and (b) points
here for the real fix.

## Scope (design-first)

A reconciliation guard that detects and repairs orphaned span tails — a row with `activity_id` set,
`is_span_head:false`, whose contiguous preceding block is not an activity head with the matching
`activity_id`. Candidate seams (decide in an Architect pass): an apply-time check, a load-time
normalization, or a periodic sweep. Must protect BOTH `replaceSlot` (existing) and the T105 elective
conversion. Test-first with a partial-write/crash simulation.

## Review loop

**Architect (seam choice) → Red Hat (does the guard catch every orphan shape without false-repair of
legitimate spans?) → Maker (test-first) → Code Reviewer → Verifier → Grader.**
