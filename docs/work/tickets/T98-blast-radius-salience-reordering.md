---
title: T98-blast-radius-salience-reordering
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-17-onescreen-reconciliation-projection.md]
archive_when: blast-radius actually reorders salience, or the report-order default is judged correct permanently
---

# T98 — Blast-radius actually reorders salience (audit M5)

**Source:** `docs/work/specs/2026-08-19-roots-reconciliation-audit.md` §12 (deferred, revisit on
evidence). Severity: LOW.

## What's stubbed

`blastRadius.js` computes a downstream-impact index, and `salience.js` uses it as a *rendering hint*,
but the actual triage order stays report-array order (ADR invariant 2: "salience never reorders
truth"). The intent — surface the decisions with the largest downstream blast radius first
(readiness-demand ordering, spec §3/§11) — is only partially realized: the signal is computed but
does not actually reorder what the director sees first.

## Why deferred

Report order is a safe, predictable default; reordering by blast radius risks the "salience reorders
truth" concern the ADR guarded against, so it needs a careful design.

## Definition of done (if picked up)

- Decide whether blast-radius should reorder WITHIN a lane (a rendering weight) without violating the
  "salience never reorders truth" invariant — likely a within-hold / within-standard ordering, not a
  cross-lane reshuffle.
- Implement + test that a high-blast-radius decision surfaces above a low-blast-radius one of the same
  lane, and that the invariant (no decision hidden or lost by reordering) holds.

## Related

- Sibling deferrals: T95 (multi-select), T96 (field-level diff), T97 (UNKNOWN detection).
