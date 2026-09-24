---
title: "Collapse the duplicate ingest layer: retire the orphaned Roots-as-dashboard banner"
document_type: ticket
status: completed
created: 2026-09-24
archive_when: rootsBanner.jsx is absent from the tree AND both screens' worksheet download resolves through a single shared module AND the orphan guard from D is green
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md]
related_adrs: [docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md, docs/adr/2026-08-27-roots-hub-tiles-are-interface.md]
related_tickets: [T234, T236, T237]
---

# T240 — Collapse the duplicate ingest layer: retire the orphaned Roots-as-dashboard banner

## Why

Owner report: "2 different layers at the ingest stage when we should only be using the roots
screen." The second layer was an abandoned Roots-as-dashboard design (plan
`docs/work/plans/2026-08-19-roots-dashboard-spine.md`, T2) that ADR
`docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md` superseded with `RootsHomeScreen.jsx` — but
the supersession left its predecessor's component sitting in the tree, fully wired to real product
logic, with zero non-test importers.

Confirmed before touching anything:

1. `src/components/reconciliation/rootsBanner.jsx` (`RootsBanner`) had zero non-test importers
   (`graphify affected "RootsBanner"` — one `EXTRACTED` edge, its own test; `grep -a -rn` sweep
   confirmed no other live-code importer). It rendered a retired readiness verdict (`src/App.jsx`'s
   own comment: "Setup Readiness (ReadinessHub) is retired; there is no verdict banner on this
   screen") plus the same two entry points `RootsHomeScreen.jsx`'s `styles.bottomActions` already
   renders — a banner, which is also a standing owner anti-pattern (see
   `docs/current/PLATFORM_STATE.md`'s design history).
2. `downloadWorksheet` (the S4a enrichment-workbook export) was implemented twice and had already
   drifted: `ImportScreen.jsx` wrapped it in try/catch and surfaced `describeWriteFailure`;
   `RootsHomeScreen.jsx` used try/**finally only, no catch** — a failing download there produced an
   unhandled rejection and no message the director could see. Real, director-visible defect, not a
   hypothetical.
3. `src/App.jsx` imported `ReconciliationScreen` and never used it (JSX-dead; only a stale comment
   named it), and that comment claimed a `mode="import"` prop `ReconciliationScreen` does not have
   (its only `mode` is the local `apply(mode)` commit mode).
4. Systemic root cause: `eslint.config.js`'s `no-unused-vars` exempts every capitalized binding
   (`varsIgnorePattern: '^[A-Z_]'`) — every React component import — so a dead component import or
   an orphaned component file sits in a green tree indefinitely. Measured narrowing the pattern to
   `^_`: **135 files** flagged, the large majority legitimate (components referenced only as object-
   literal values — e.g. `App.jsx`'s `SCREENS` map — which `no-unused-vars` can't see through as
   usage). Too large a blast radius to churn for this ticket; see "Fix" below for what was done
   instead.

## Fix

- **Single-sourced `downloadWorksheet`.** New `src/utils/downloadWorksheet.js` exports
  `runWorksheetDownload(cohortId)` — the shared read-only S4a export logic (list entities, stamp
  `base_generation`, call `downloadWorkbook`). Both `ImportScreen.jsx` and `RootsHomeScreen.jsx` call
  it and handle the thrown error in their own idiom: `ImportScreen` keeps its existing
  `exporting`/error-banner state; `RootsHomeScreen` gained a `worksheetError` state and an inline
  `S.errorBanner` render next to its `bottomActions` (not a banner-chrome component — the repo's
  existing per-screen error-text idiom).
- **Deleted** `src/components/reconciliation/rootsBanner.jsx` and `rootsBanner.test.jsx`.
  `docs/current/PLATFORM_STATE.md`'s line describing it as "still exists ... but no longer imported"
  was marked historical (strikethrough + `_Prior:`) rather than silently rewritten, per this repo's
  doc-staleness convention.
- **`src/App.jsx`**: removed the dead `ReconciliationScreen` import; corrected the `SCREENS.roots`
  comment to state what's actually true (census/RootMap stay scoped to `ReconciliationScreen`, which
  `ImportScreen` renders as its whole surface once an import is staged; no `mode` prop exists).
- **Orphan guard** (`src/orphanReactComponents.test.js`, new): fails when a default-exporting React
  component file under `src/components/` or `src/screens/` has no non-test importer. Proven
  non-vacuous by planting a throwaway orphan fixture, watching the guard go red, then removing the
  fixture. Carries an explicit, documented allowlist (`KNOWN_ORPHANS`) for the one legitimately-
  orphaned-but-kept file, `postImportBanner.jsx` — see Open Question below; the guard must not
  silently start passing by including files under active owner review.
- **T234 confidence-independence, extended** (`src/screens/ImportScreen.fixedEventRouting.test.jsx`):
  the existing low-confidence pin-only assertion (`Free Swim`) only exercised an all-groups event. A
  group-scoped recurring event is *structurally* always low-confidence (T141 arm 2), which is exactly
  the shape a confidence-gated regression would miss even after "fix the all-groups case." Added a
  group-scoped, low-confidence, non-dual-use fixture (`Bunk Cleanup`) and an assertion it still lands
  in `pinOnlyActivityNames`. Proved non-vacuous by temporarily reintroducing a
  `confidence === 'high'` filter in `ImportScreen.jsx`, watching both the existing and the new
  assertion go red, then reverting — the production T234 guard logic itself was not otherwise
  touched.

## Open question for the owner (not decided here)

`src/components/reconciliation/postImportBanner.jsx` and `src/hooks/useGraceWindowUndo.js` are ALSO
orphaned today — nothing in the running app renders `PostImportBanner` or calls
`useGraceWindowUndo`. Unlike `rootsBanner.jsx`, this pair backs a real, fully-built, fully-tested
capability: the post-import grace-window "Undo this import" affordance. And unlike `rootsBanner.jsx`,
it is not free-standing dead weight — `ReconciliationScreen.jsx:191` still calls
`captureInverse: inputs.mode !== 'replace'` on every non-replace commit specifically to feed it, so
**every import pays for a before-snapshot that nothing currently surfaces to a director**. This
ticket does not delete, rewire, or "fix" any of the three (per the Governor brief's explicit
out-of-scope instruction) — restoring the undo affordance to a live screen, versus retiring it and
the `captureInverse` cost together, is a product decision for the owner, not an engineering one.

## Non-goals

- The `preference_sheet_preview`/`preference_sheet_commit` MCP sibling of `ingest_preview`/
  `ingest_commit` (#521) — a deliberate second path (`partitionSchedulePages` refuses preference
  sheets), not touched.
- Narrowing `eslint.config.js`'s `varsIgnorePattern` — measured at 135 files, too large and largely
  false-positive; the orphan guard test is the fix instead.
- Restoring or retiring `postImportBanner.jsx`/`useGraceWindowUndo.js`/`captureInverse` — see Open
  Question above.

## Tests

- `src/screens/RootsHomeScreen.test.jsx`: new — a failing `downloadWorkbook` surfaces a visible
  failure message on `RootsHomeScreen` (RED before the shared-module extraction: an unhandled
  rejection with no visible text; GREEN after).
- `src/orphanReactComponents.test.js`: new guard, proven non-vacuous against a planted fixture.
- `src/screens/ImportScreen.fixedEventRouting.test.jsx`: extended with a group-scoped low-confidence
  pin-only case, proven non-vacuous against a temporarily reintroduced confidence filter.
- `npm run lint`: clean (0 errors) against the unmodified `eslint.config.js`.
