---
title: T67-ingest-spec-deletion-step-2-wording
document_type: ticket
status: open
created: 2026-08-07
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T61-replace-ingest-atomic-transaction.md]
related_specs: [docs/work/specs/S-replace-ingest-atomic-transaction.md]
archive_when: the spec's deletion step 2 names the scoping path rather than the FK, and no other step conflates the two
---

# T67 — Ingest spec's deletion step 2 describes an FK where it means a scoping path

**Raised:** 2026-08-07, by Red Hat and Code Reviewer during the T61 review loop.

## The problem

`docs/work/specs/S-replace-ingest-atomic-transaction.md`, §"Deletion order (normative)",
step 2 reads:

> **`template_overlays`** — references `days_of_operation(id)`.

That names the table's foreign key. It is not how the rows are **enumerated**.
`template_overlays` is scoped through `schedule_templates` via `template_id`, exactly as
`electron/ops/campScopedEntities.js`'s `PARENT_SCOPED_ENTITIES` encodes it, and that is what
the T61 implementation correctly does.

The implementation is right. The spec's prose is what is misleading.

## Why it is worth fixing rather than leaving

The spec is normative and marked "do not rediscover this" precisely so a future Maker
follows it without re-deriving the order. A reader who takes step 2 literally would go
looking for a `days_of_operation` join that does not exist, or hand-write one — which is
the exact instruction (§"reuse `PARENT_SCOPED_ENTITIES`, do not hand-write joins") the
spec's own security review singled out for review attention.

Per `CONSTITUTION.md` Article I this is a documentation defect, not a licence to change
either the code or the standard: the code is right and the document is stale.

## What to build

- Correct step 2 to name the scoping path (`schedule_templates` via `template_id`), keeping
  the FK as a secondary note if it is worth stating at all.
- Re-read the other seven steps for the same conflation and correct any found. Step 1
  (`template_slots`) is scoped identically and should be checked first.
- No code change. If a code change looks necessary, that is a finding to raise, not to act
  on.

## Definition of done

Every step in §"Deletion order (normative)" describes how its rows are enumerated. A reader
implementing from the spec alone arrives at the same queries the T61 implementation uses.
