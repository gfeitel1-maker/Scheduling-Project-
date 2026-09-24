---
title: "Ingest: confidence-independent catalog-exclusivity guard for fixed/recurring events"
document_type: ticket
status: completed
created: 2026-09-23
archive_when: ImportScreen.fixedEventRouting.test.jsx's confidence-independent and non-vacuity assertions pass in CI and pinOnlyActivityNames is no longer seeded from autoAccepts(fe.confidence)
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md]
related_adrs: [docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md]
related_tickets: []
---

# T234 — Ingest: confidence-independent catalog-exclusivity guard for fixed/recurring events

## Why

Live product-owner report, 2026-09-23: "things that are recurring events are also being pulled as
activities when they should not."

`src/screens/ImportScreen.jsx` seeded the pin-only/dual-use guard (ADR 2026-08-09 Decision 1) from
`inferred.filter(fe => autoAccepts(fe.confidence))` — HIGH confidence only. But
`src/ingest/fixedEvents.js`'s arm 2 (group-scoped recurring events, T141) computes `confidence`
independently of `kind`: a genuinely confirmed recurring event can be LOW confidence
(`groupsHere.size !== totalGroups`). Confidence there answers "does this event exist", not "is it
exclusive of the free-choice activity catalog" — but the guard conflated the two. A LOW-confidence
recurring event never reached the guard and could mint straight into the activity catalog whenever
its raw name-frequency happened to clear `createConfidenceTier`'s threshold — exactly the owner's
symptom.

`buildPlan.js`'s own `pinOnlyActivityNames` contract comment, and the ADR itself, never had a
confidence qualifier — this was an implementation drift from day one (2026-08-17 one-screen cutover),
not an intentional narrowing.

## Fix

`ImportScreen.jsx`: replace the two independently-computed exclusion sets
(`initialTickedFixedEventNames`/`pinOnlySet` and `assertedNonDualUseNames`) with one
confidence-independent set, `eventNonDualUseNames = every inferred fixed/recurring name minus
dualUseNames`, computed once and reused for both `pinOnlyActivityNames` and the activity-rule
Asserted-classification exclusion. Deleted the now-dead `autoAccepts` import (its only remaining
use).

No change to `src/ingest/fixedEvents.js` or `src/ingest/buildPlan.js` — both already implement the
confidence-independent contract correctly; only the ImportScreen-side seeding was wrong.

## The tier:'low' question (answered with evidence)

The owner said these names should not be pulled as activities. The fix forces `tier:'low'` on the
create item, not a hard drop. Traced the consequence of `tier:'low'` through the full commit path:

- `src/ingest/reconciliationReport.js`'s `tierToConfidence`/`classifyItem`: a create item with
  `evidence.tier` not in `HIGH_IDENTITY_TIERS` (`'low'` isn't) classifies as `needsAttention` with a
  `confirm_value` decision — never `understood`/auto-passed.
- `src/screens/reconciliationResolutions.js`'s `applyResolutions`, `confirm_value` branch (comment
  in place, unchanged by this ticket): *"Unresolved -> held back: remove from approved so it does
  not write unconditionally (the silent-write risk this module exists to guard)."* An unresolved
  `confirm_value` decision is filtered OUT of `approved.activities` before `foldTriageInputs` ever
  builds the commit payload.
- `electron/ops/ingest.js`'s `commitCreate`/`toCreate` loop only ever sees items whose name survived
  in `approved` — a held-back name never reaches it.

**Conclusion: `tier:'low'` means NOT created without explicit director action** (clicking
"looks right" or editing the row on its `confirm_value` card in ReconciliationScreen). This matches
ADR 2026-08-09 Decision 1, which explicitly rejected a hard silent drop as "correct but
unreviewable". No further change needed; reported as confirmed, not escalated.

## Tests

`src/screens/ImportScreen.fixedEventRouting.test.jsx`:
- New: a LOW-confidence pin-only fixed event (`Free Swim`) is included in `pinOnlyActivityNames`
  (confidence-independence — this is the regression test; RED before the fix, GREEN after).
- New (non-vacuity): a LOW-confidence *dual-use* name (`Yoga`) is NOT marked pin-only and still
  ships as a normal activity — proves the guard excludes by footprint, not by a blanket
  "low-confidence -> pin-only" rule.
- Updated: `every inferred fixed event ships unconditionally in the commit inputs` now includes
  `Yoga` (added to the shared fixture for the non-vacuity case above).

`src/ingest/fixedEvents.weeklyRecurring.test.js` (extends the existing T141 orientation-A fixture,
which already contains the owner's exact shape — `Ruach`, `kind:'recurring'`, `confidence:'low'`,
`dualUseNames: []`):
- New: reproduces the exact shape (`kind`/`confidence`/non-dual-use asserted directly).
- New: without the guard, `buildPlan` mints `Ruach` at `tier:'new'` — proves the guard is
  load-bearing, not redundant with `createConfidenceTier`'s own frequency heuristic.
- New: with the confidence-independent set applied, `Ruach`'s create item lands at `tier:'low'` —
  the observable outcome the owner cares about.
- New (footprint-union, replaces an order-sensitive test that would have been fake — fixed-before-
  recurring ordering is provably unobservable since `footprintByActivity` unions both passes into one
  Set before the dual-use test runs, and Set union commutes): a name with a confirmed FIXED event on
  some groups/block and a confirmed RECURRING event on other groups/a different block, whose raw
  occurrences are fully covered only by the *combined* footprint, is correctly NOT flagged dual-use.

## Non-goals

- The "ingest runs through two layers when it should only be the Roots screen" question — observed,
  not addressed, out of scope for this ticket.
- `src/ingest/preferenceSheet.js` / the MCP ingest path — owned by another in-flight session, not
  touched.
- Changing `fixedEvents.js`'s arm-2 confidence formula. Confidence is about whether the event exists;
  changing it to double as a catalog-exclusivity signal would alter unrelated review-UI semantics
  (the `fe.confidence === 'low'` badge shown to the director) for no reason — the exclusivity guard
  and the confidence badge are legitimately independent concerns.
