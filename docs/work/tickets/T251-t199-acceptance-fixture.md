---
title: T251-t199-acceptance-fixture
document_type: ticket
status: open
created: 2026-09-23
archive_when: the spec §6 acceptance fixture passes under electron:dev with no manual database edits, the full gate is green, and T199's own exit condition is satisfied
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
related_tickets: [docs/work/tickets/T199-individual-electives-end-to-end.md]
---

# T251 — T199 acceptance fixture and release closure

The integrated end-to-end pass T199 itself describes: the spec §6 acceptance fixture, visual/
accessibility QA, and closing T199. This ticket does not duplicate T199's content — it is the
"assemble and verify everything T243-T250 built" slice, and its own completion is what allows T199
to close.

## Scope

- Run the spec §6 acceptance fixture end to end under `electron:dev` (not the `:5200` mock — T199
  is explicit this must exercise real persistence and sync).
- Visual/accessibility QA pass on the Draft and Final screens (T250) per DESIGN_STANDARD.
- Confirm the D8 disclosure (T249) is present at every entry into the flow, not only the literal
  first render.
- Confirm the release-precondition copy (Delete cost honesty per D10, encryption gate per D8) reads
  as T199 requires.
- Full gate green (`npm run verify` — respect the machine-wide lock; do not run concurrently with
  another session's gate).
- Close T199: flip its `status` in the same commit that references `closes T199`, per
  WORK_RECORD_STANDARD §3.1 — do not let a later commit discover the drift.

## Non-goals

Any new code beyond what's needed to make the fixture pass — this ticket surfaces gaps in
T243-T250, it does not silently patch around them with scope those tickets should have owned.
If the fixture reveals a real gap in an earlier slice, that is a finding against that slice, fixed
there (or spun to a follow-up ticket), not absorbed here.

## Test seam

The acceptance fixture itself **is** the integration-harness-mandatory case — it is the canonical
example TESTING_STANDARD's "touching sync, auth, or schema" rule exists for.

## Dependencies

T243, T244, T245, T246, T247, T248, T249, T250 — all of them. This is the terminal ticket in the
decomposition and cannot start meaningfully before the others are substantially done, though QA
prep (fixture data assembly, accessibility checklist) can begin in parallel once T250 has a
renderable screen.
