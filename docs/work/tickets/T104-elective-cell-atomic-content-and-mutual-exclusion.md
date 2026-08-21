---
title: T104-elective-cell-atomic-content-and-mutual-exclusion
document_type: ticket
status: in-progress
created: 2026-08-20
task_class: database-sync
governing_docs: [docs/adr/2026-08-20-electives-authoring.md]
related_adrs: [docs/adr/2026-08-20-electives-authoring.md, docs/adr/2026-08-12-drag-live-write-serialization.md]
depends_on: [docs/work/tickets/T103-electives-sets-crud-and-durability-marker.md]
archive_when: shipped and merged
---

# T104 — Elective cell: atomic content-kind + mutual exclusion (the correctness-critical seam)

**The HIGH-severity seam Red Hat named.** A `template_slots` cell must never carry both `activity_id`
and `elective_set_id`. Conflict detection is per-`(entity,entity_id,field)`, so writing the two as
independent fields lets a multi-device interleave leave both set with **no conflict recorded** — the
T91/DnD write-race class.

## Decision needed first (Architect + Red Hat, with the real code in view)

Choose the resolution the ADR (D4) left to build-time:
- **(i)** a single typed `content_ref` (`activity:<id>` | `elective:<id>`) — removes the race by
  construction; cost = read-migration of every slot reader (engine, ScheduleScreen, projections, sync,
  export).
- **(ii)** keep two columns but make the paired clear+set one serialized unit via the existing per-cell
  **write queue** (`2026-08-12-drag-live-write-serialization`) + a row-level apply-time invariant that
  rejects/repairs a both-non-null row.

Recommend (i) if the reader blast-radius is tractable; else (ii). This is an Architect design pass
(ADR-level note), Red-Hat-challenged, before Maker.

## Required test

A **multi-device interleave test** (not just single-device sequencing) proving no interleaving of the
paired writes can leave both columns non-null. A test that only sequences one device would pass and still
ship the bug.

## Review loop

**Architect (design (i)/(ii)) → Red Hat (challenge the chosen resolution + the interleave test) → Maker
(test-first) → Red Hat (verify) → Code Reviewer → Verifier → Grader.**

## ⚠️ Pre-PR renumber obligation (2026-08-21)

**This ticket's number COLLIDES with a merged origin/main ticket** (main owns a different
`T104-extract-shared-free-suffix-scan`).
Confirmed with the peer that T105–T111 is clear. **Before opening the PR**, renumber this ticket to
**T111** and update all references (the other 2026-08-20 ADRs/specs,
sibling tickets T105–T109, the INDEX, the ~35 in-code comments citing the bare number, and the
gate-report JSON filename). Bare-number citations are currently disambiguated by their full doc-path,
so the collision is inert until merge — but must be resolved for numbering integrity.
