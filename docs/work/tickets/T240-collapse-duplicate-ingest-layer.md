---
title: "Collapse the duplicate ingest layer: retire the orphaned Roots-as-dashboard banner"
document_type: ticket
status: completed
created: 2026-09-24
archive_when: rootsBanner.jsx is absent from the tree AND both screens' worksheet download resolves through a single shared module AND the orphan guard from D is green
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md]
related_adrs: [docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md, docs/adr/2026-08-27-roots-hub-tiles-are-interface.md]
related_tickets: [docs/work/tickets/T234-ingest-recurring-event-catalog-exclusivity.md, docs/work/tickets/T236-roots-attention-list-below-the-fold.md, docs/work/tickets/T237-attention-rows-open-the-reconciliation-flow.md]
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

## Owner ruling — RESTORE the grace-window undo (decided; NOT implemented here)

**The owner has ruled: restore the undo capability. Do not retire it.** Implementation is
deliberately out of scope for T240 and will be dispatched as its own stream once this PR lands — it
needs a home chosen, which is design work, and it would touch files this ticket already has open.

**THE CONSTRAINT THAT MATTERS — restore the CAPABILITY, not the BANNER.** Do **not** resurrect
`src/components/reconciliation/postImportBanner.jsx`. It is a banner; banners are banned by standing
owner rule; and that ban is *precisely what orphaned the undo in the first place*. Re-mounting the
banner to "restore" the undo will be reverted. The undo belongs in the per-slot flag vocabulary, or
as an action inside the reconciliation flow — matching the detect-and-surface, let-the-director-act
posture used elsewhere in the app.

**Why the ruling went this way (git archaeology, verified against the tree, not inferred):**

- `0bc51e4b` — "route a finished import to Roots with a post-import banner + surviving grace-window
  undo (plan T4)" introduced the undo *inside a banner*.
- `66354590` — "feat(roots): RootsHomeScreen — the redesigned Roots home (WS4) (#215)" retired
  `ReconciliationScreen`'s `mode="inspect"` branches. Its own commit message lists what went with
  them: "RootsBanner/PostImportBanner rendering, **the grace-window undo carrier**", and
  "Does not resurrect the retired justImported/PostImportBanner".

So **nobody ever decided to drop undo — it was collateral.** The no-banners rule plus the Roots
redesign deleted the banner, and the undo went with it because it had been built inside one. That
asymmetry settled the question: retiring would mean deleting working, tested code and permanently
removing the only undo for the least-reversible thing a director does, while restoring means
mounting something that already works and whose capture cost is *already being paid on every
import*.

## Background to that ruling (the state this ticket found)

`src/components/reconciliation/postImportBanner.jsx` and `src/hooks/useGraceWindowUndo.js` are ALSO
orphaned today — nothing in the running app renders `PostImportBanner` or calls
`useGraceWindowUndo`. Unlike `rootsBanner.jsx`, this pair backs a real, fully-built, fully-tested
capability: the post-import grace-window "Undo this import" affordance. And unlike `rootsBanner.jsx`,
it is not free-standing dead weight — `ReconciliationScreen.jsx:191` still calls
`captureInverse: inputs.mode !== 'replace'` on every non-replace commit specifically to feed it, so
**every import pays for a before-snapshot that nothing currently surfaces to a director**. This
ticket does not delete, rewire, or "fix" any of the three (per the Governor brief's explicit
out-of-scope instruction). That decision has since been made by the owner — see the ruling above:
**restore**, and restore the capability without the banner.

## Non-goals

- The `preference_sheet_preview`/`preference_sheet_commit` MCP sibling of `ingest_preview`/
  `ingest_commit` (#521) — a deliberate second path (`partitionSchedulePages` refuses preference
  sheets), not touched.
- Narrowing `eslint.config.js`'s `varsIgnorePattern` — measured at 135 files, too large and largely
  false-positive; the orphan guard test is the fix instead.
- **Implementing** the grace-window undo restoration. The owner has ruled to restore it (see "Owner
  ruling" above), but it is dispatched as its own stream after this PR lands: it needs a home chosen
  (design work) and would touch files this ticket already has open. The binding constraint for that
  stream is *capability, not banner* — `postImportBanner.jsx` must not be re-mounted.

## Tests

- `src/screens/RootsHomeScreen.test.jsx`: new — a failing `downloadWorkbook` surfaces a visible
  failure message on `RootsHomeScreen` (RED before the shared-module extraction: an unhandled
  rejection with no visible text; GREEN after).
- `src/orphanReactComponents.test.js`: new guard, proven non-vacuous against a planted fixture.
- `src/screens/ImportScreen.fixedEventRouting.test.jsx`: extended with a group-scoped low-confidence
  pin-only case, proven non-vacuous against a temporarily reintroduced confidence filter.
- `npm run lint`: clean (0 errors) against the unmodified `eslint.config.js`.
