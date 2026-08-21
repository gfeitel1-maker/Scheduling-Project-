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
