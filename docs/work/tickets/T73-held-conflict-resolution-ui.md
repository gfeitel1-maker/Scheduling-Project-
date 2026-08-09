---
title: T73-held-conflict-resolution-ui
document_type: ticket
status: completed
created: 2026-08-08
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs:
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md
program: onboarding-reconciliation
archive_when: the ImportScreen surfaces held conflicts and a director can resolve them end-to-end
---

# T73 — Wire held-conflict resolution into the import UI

**Status: open.** Backend-only gap surfaced during S2b implementation.

## What exists (backend, landed)

The reconciliation commit path now produces **held conflicts**:
- **S1a:** `ambiguous_identity` (an incoming label matches >1 existing row, e.g. "Art"/"art ").
- **S2b:** `stale` (a re-import would change a human-authored field — Policy A protection).

Any conflict trips the **HELD sentinel** (`electron/ops/ingest.js`): the whole import writes nothing and
returns `{ held: true, conflicts: [...] }`. The resolution contract also exists:
`resolveConflict({..., stale_accept: true})` (`electron/main.js` ~661) writes an accepted import value with
`source:'import'` so the acceptance sticks (the S2b R1 decay fix). All of this is unit-tested.

## What is missing (the gap)

There is **no renderer wiring** to:
1. Surface a held import's `conflicts[]` to the director (the confirm-identity card for `ambiguous_identity`;
   the "this would overwrite a change you made" surface for `stale`), and
2. Route the director's decision back — an `ambiguous_identity` pick, or a `stale`-accept — so the held import
   re-commits. Note `resolveConflict` today resolves by `chosen_op_id` against a *persisted* op, but a HELD
   import's proposed value was **never written**, so the held-import resolution needs its own path (re-submit
   the resolved plan, or a held-import-specific resolve), not the existing persisted-conflict handler.

Consequence: today the **happy path works end-to-end** (a clean re-import recognizes + updates via
`ImportScreen` → `commitIngest`), but an import that **holds** on any conflict has no in-app way to be resolved
— the director sees the import did not complete, with no surface to act on the held items.

## Scope / sequencing

This is UX + a thin renderer/IPC surface, and it belongs with the **reconciliation preview / Needs-Attention**
work (the Designer's ranked prototypes: six-state preview, confirm-identity card, Needs-Attention queue —
`ONBOARDING_UX_OPTIONS.md`), i.e. the S5-adjacent UX slice, not a backend slice. Design the held-import
resolution path (re-submit-resolved-plan vs held-conflict resolve) as part of that slice.

## Acceptance

- [ ] A held import surfaces its `ambiguous_identity` and `stale` conflicts in `ImportScreen`.
- [ ] A director can resolve each (pick identity / accept-import-or-keep-mine) and re-commit the import.
- [ ] A `stale`-accept routes through the `stale_accept` path so the field becomes `source:'import'` (decay).
- [ ] End-to-end test: a held re-import is resolved in-app and commits.
