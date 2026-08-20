---
title: T97-per-field-unknown-detection
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-17-onescreen-reconciliation-projection.md]
archive_when: per-field UNKNOWN detection ships, or the product decides "not in source = optional gaps" is sufficient
---

# T97 — Per-field UNKNOWN detection (audit M4)

**Source:** `docs/work/specs/2026-08-19-roots-reconciliation-audit.md` §12 (deferred, revisit on
evidence). Severity: MEDIUM. **The highest-value of the four M-deferrals — it's a real capability
gap, not just a UI narrowing.**

## What's missing

The reconciliation vocabulary implies "UNDERSTOOD / NEEDS ATTENTION / CHANGED / NOT IN SOURCE +
UNKNOWN," but genuine per-field **UNKNOWN** detection was never built (`reconciliationReport.js`, C1:
"does not build UNKNOWN-field detection — deferred"). Today "NOT IN SOURCE" means only
optional-readiness gaps — i.e. whole areas absent — not "this specific field of this entity could
not be determined from the source." A director cannot see "Shoresh read this activity but couldn't
tell its min_per_week."

## Why it matters

This is the honest "what Shoresh couldn't understand" axis the whole reconciliation philosophy is
built around (compress hundreds of observations into a few decisions, surface UNKNOWNs for judgment).
Its absence means low-confidence/indeterminate fields are silently defaulted or omitted rather than
flagged for the director.

## Definition of done (if picked up)

- Detect per-field UNKNOWN (a field the parser saw but could not resolve to a confident value),
  distinct from NOT-IN-SOURCE (absent) and from a confident value.
- Surface UNKNOWNs as their own reconciliation state/cards on the Roots surface (they need judgment,
  same as attention).
- Likely touches `reconciliationReport.js` (C1), the ingest confidence/evidence path
  (`import_evidence`), and `rootMapModel`'s state vocabulary.

## Related

- Sibling deferrals: T95 (multi-select), T96 (field-level diff), T98 (blast-radius ordering).
- Interacts with the census/inspector state model (`docs/adr/2026-08-19-roots-census-and-persistent-inspector.md`).
