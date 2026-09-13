---
title: T96-reconciliation-field-level-diff-ledger
document_type: ticket
status: closed
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md]
archive_when: field-level diff is restored where it adds value, or judged unnecessary given the per-card resolved lines
---

# T96 — Reconciliation field-level `was → will-be` ledger diff (audit M3)

## CLOSED 2026-09-13 — the narrow half was built; the ledger was judged unnecessary

Closed under the second `archive_when` clause: *"or judged unnecessary given the
per-card resolved lines."* Recording the reasoning here rather than only in a
commit message, because a decision that lives in `git log` is invisible to the
next open-ticket sweep — which would have re-raised this asking for the full
ledger again.

### Why not the ledger

The owner reframed it: *"if you are doing a second import, don't you think you
would know that you want to work from that copy?"* Read against the code, that
is already most of the behaviour, and Red Hat verified it:

| on a re-import | what happens |
|---|---|
| import-owned field, read at HIGH confidence | applied silently — the new file wins |
| import-owned field, MEDIUM/LOW confidence | asks, because the importer is unsure it READ the file right — a different question from ownership |
| field not sourced from a file | asks, always (`confirm_change`) |

A restored was → will-be ledger would re-answer a question the machinery
already narrows. The genuine gap was one thing, at the only moment it matters.

### What was actually missing

The `confirm_change` card offered *"Use the file's value — X"* against
*"Keep the current value"* — naming one side and not the other. The director
was choosing between a value they could see and one they could not.
`currentValue` now rides the decision beside `proposedValue`, carrying the
delta's `from`, and the card names it.

### Scope of that fix, stated precisely

It covers the `confirm_change` decisions built from a field delta
(`classifyItem`'s human-provenance branch) and the generic fallback branch.
It does **not** add `currentValue` to fixed-event `moved`/`scopeChanged`
decisions — `moved` already shows both sides via its own day/time-block line,
and `scopeChanged` carries its before/after only as prose inside `reason`.
That was true before this ticket and remains true; flagged by Red Hat because
the original commit message implied broader coverage than was delivered.

### Found while building it

- The card rendered `""Field""` — double-quoted, **already shipping**, on both
  the `confirm_change` and generic-fallback branches. Fixed on both.
- `quoteValue` did not escape an embedded quote, so a real camp value like
  `6' x 10" tent` read as ending early. Fixed, with a test.
- The headline claimed *"was hand-edited"*, but `fieldProvenance` decodes NULL
  as human **deliberately** — an unlabelled write counts as a hand edit — so
  the card fired for values nobody typed. Reworded to what the check actually
  knows: *"wasn't imported from a file."*


**Source:** `docs/work/specs/2026-08-19-roots-reconciliation-audit.md` §12 (deferred, revisit on
evidence). Severity: LOW-MED.

## What was lost

The retired `ReconciliationLedger.jsx` (S5b) rendered an explicit field-level `was → will-be` diff
for every changed entity, with an Unchanged reassurance count. The one-screen rebuild compressed this
into the understood receipt + per-card "✓ Will set to X" resolved lines — a genuine reduction in
field-level diff visibility. A director can no longer scan a compact ledger of every field that
changes.

## Why deferred

The per-card resolved lines cover the common case; the full ledger view is heavier and may not earn
its place on the "quiet at first glance" surface.

## Definition of done (if picked up)

- Restore a field-level `was → will-be` view where it adds value (e.g. an on-demand disclosure per
  changed entity, or a "review all changes" affordance) WITHOUT reintroducing a second full screen or
  breaking the one-continuous-surface principle.
- OR record that the per-card lines are sufficient and close.

## Related

- Sibling deferrals: T95 (multi-select), T97 (UNKNOWN detection), T98 (blast-radius ordering).
