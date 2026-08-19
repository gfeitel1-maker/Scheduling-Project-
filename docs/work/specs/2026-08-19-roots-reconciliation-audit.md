---
title: "Roots × Ingestion Reconciliation — evidence-based audit & reconciliation plan"
document_type: spec
status: draft
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_docs:
  - docs/adr/2026-08-18-rootmap-screen-port.md
  - docs/adr/2026-08-18-roots-reconstruction-moment-gating.md
  - docs/work/specs/2026-08-17-reconciliation-onescreen-design.md
archive_when: superseded by the implementation ADR this audit recommends (Slice 0), or the direction is rejected
---

# Roots × Ingestion Reconciliation — Audit & Reconciliation Plan

**Invariant this audit serves (propagated to every reviewer and Maker):**
**One reconciliation system. One screen. Roots as the projection/navigation surface.
Quiet at first glance, deep on demand.**

Success criterion (owner): *"Shoresh understands my camp. I can immediately see the few
places that need me. I can address those directly, or explore what Shoresh knows by area.
Everything is reachable, but I am not forced to review everything."*

---

## 0. Headline

The feared failure mode — **"old reconciliation UI + Roots" as two systems** — did **not** ship.
There is already **one** reconciliation model (`buildReconciliationReport` → `reportToLanes`), and
Roots is a *pure projection* over it (`buildRootMapModel` → `RootMap` + `RootMapPanel`). Condition
navigation (state tiles) and domain navigation (root/child nodes) are two reads of one authoritative
model, held in a single `selection` union. **This is a reconcile-and-deepen job, not a teardown.**

Two gaps stand between what shipped and the success criterion, and they are the same two halves of
the governing principle:

- **H1 — "quiet at first glance" is broken at the landing view.** The default panel renders the
  *entire* pending-decision queue, under a header that says "Needs your attention." The few that
  need the director are not isolated from the many.
- **H2 — "deep on demand" cannot show the calm 374.** Root/child nodes are *decision-driven*: a
  fully-understood entity emits no node, so there is nothing to explore for the parts Shoresh got
  right. This is also the exact capability that makes Roots reusable *after* import.

Everything else is polish, a defensible narrowing, or a deliberate deferral.

---

## 1. Earlier one-screen capability inventory (pre-Roots)

Source: `docs/work/specs/2026-08-17-reconciliation-onescreen-design.md`, commit `2f41f96`, and the
deleted `ReconciliationSummary/Queue/Ledger` components (recovered from history).

| Axis | Earlier one-screen design |
|---|---|
| UNDERSTOOD (not counted as work) | ✅ Collapsed "N rows read cleanly" receipt; excluded from the progress denominator |
| NEEDS ATTENTION | ✅ Triage lane, discrete hold/standard rank (not a score) |
| CHANGED | ✅ `confirm_change` cards with three-option radio naming both concrete values |
| NOT IN SOURCE | ✅ Least-salient dashed footer; sourced from `readiness==='optional'` only |
| Global attention review (by-**condition**) | ⚠️ **Absent as a pivot** — state was implicit in salience ordering only |
| Domain drill-down (by-**domain**) | ✅ Multi-select domain filter **chips** with per-domain counts |
| Decision resolution in-workspace | ✅ Inline; incl. "Something else — type a value" |
| Provenance / evidence | ✅ Per-card "Why?" → two-column "From this file / Current record" |
| Return to whole picture | ✅ One continuous scroll, no wizard, no takeover modals |

**Deleted components** (relocated, mostly not lost): `ReconciliationSummary` (buckets + readiness
strip → header spine + receipt + domain chips); `ReconciliationQueue` (one-card-at-a-time →
all-cards lane; carried the evidence disclosure); `ReconciliationLedger` (field-level `was → will-be`
diff → staged tray + per-card resolved lines). The **held-conflict takeover modal** was removed by
design (held conflicts are now hold-lane cards in the same scroll).

---

## 2. Current Roots capability inventory

Source: current tree (`ReconciliationScreen.jsx`, `src/components/reconciliation/*`,
`src/ingest/rootMapModel.js`), ADR `2026-08-18-rootmap-screen-port.md`.

| Axis | Current Roots |
|---|---|
| UNDERSTOOD | ✅ Collapsed receipt, not counted |
| NEEDS ATTENTION | ✅ hold+standard lanes, same cards |
| CHANGED | ✅ same `confirm_change` cards |
| NOT IN SOURCE | ✅ collapsed dashed footer; **plus** `absent` state on the (empty) Context root |
| Global attention review (by-**condition**) | ✅ **NEW: four state tiles** (understood/attention/changed/absent), dim non-matching nodes, scope the panel |
| Domain drill-down (by-**domain**) | ✅ Root/child nodes on the illustration; **"Open in {Screen} →"** deep-links |
| Decision resolution in-workspace | ✅ same cards, real dry-run on every answer |
| Provenance / evidence | ✅ per-card "Why?" evidence table (unchanged) |
| Return to whole picture | ✅ "Show all" → `selection:none` |

One report model → two projections, one `selection` union. Verified: `buildRootMapModel`'s test
pins `Σ child.decisionIds === report.decisions.length` (no decision lost or double-counted).

---

## 3. Gap matrix (what survived / improved / weakened / duplicated / delete)

| # | Finding | Class | Severity | Evidence |
|---|---|---|---|---|
| H1 | **Default view = full queue, not the needs-attention subset.** Header reads "Needs your attention"; body shows every pending decision. | Weakened vs intent | **HIGH** | `RootMapPanel.jsx:101-110` (`selection:none` → `allDecisions`) |
| H2 | **Nodes are decision-driven, not census-driven.** A fully-understood entity has no node → cannot inspect what Shoresh understood by area. Blocks "deep on demand" *and* persistence. | Missing | **HIGH** | `rootMapModel.js:47-65` (children built only from decisions) |
| C1 | **"Context" is a phantom domain** — no entity maps to it, always zero decisions, hard-coded `absent`. Added to widen 4→5 for the artwork. | Duplicated/decoration | **MED** (decision) | `domainRollup.js:22`, `rootMapModel.js:40-44,71` |
| M1 | **By-state navigation only exists as tile-filter**; no "jump to all CHANGED across domains" beyond selecting one tile. | Improved but partial | LOW | `RootMap.jsx:162-188` |
| M2 | **Multi-select domain filtering lost** → single-select tile *or* node. | Weakened | LOW | ADR port §5; `ReconciliationScreen.jsx:49-54` |
| M3 | **Field-level `was → will-be` ledger diff compressed** into per-card lines. | Weakened | LOW-MED | Deleted `ReconciliationLedger` |
| M4 | **Per-field UNKNOWN detection never built** — "not in source" = optional-readiness gaps only, not genuine per-field unknowns. | Never built | MED | `reconciliationReport.js` (C1 "does not build UNKNOWN-field detection — deferred") |
| M5 | **Blast-radius does not reorder** — computed as a hint, order stays report order. | Stub | LOW | `salience.js`; ADR invariant 2 |
| D1 | **`ReconstructionMoment`** is a first-import transient over the same data — a curtain-raiser, not a duplicate reconciliation. Coarser 2-state projection. | Duplicated? (curtain-raiser) | LOW (decide) | `ReconciliationScreen.jsx:205-224` |
| D2 | **Parse-preview antechamber** in `ImportScreen` (extract-and-confirm entity names) is a second *editing* surface a director sees before Roots. Not a second reconciliation. | Confirm-intended | LOW | `ImportScreen.jsx:730-1064` |

---

## 4. Recommended unified interaction model

Keep the shape that shipped — one report, two projections, one selection union. Change three things:

1. **Make the default view honest to its header (fixes H1).** `selection:none` scopes the panel to
   the **needs-attention subset** (unresolved hold+standard). Understood, changed, and not-in-source
   remain one tile-click away. "Quiet at first glance" then literally holds: the landing panel shows
   the few, the tiles summarize the whole.

2. **Emit a census, not just decisions (fixes H2).** `buildRootMapModel` gains calm per-child /
   per-entity nodes from the *live camp snapshot* (already fetched for readiness), so every area
   Shoresh understood is a reachable, quiet node — depth on demand for the 374, not only for the 4.
   Real per-entity `absent` ("this unit was expected but not in the file") becomes representable
   (peer open-thread B).

3. **Preserve both pivots explicitly.** Condition (tiles) and domain (nodes) stay mutually-exclusive
   reads of the one model. Recommend **keeping single-select** (M2) — simpler, matches the port
   spec; record the lost multi-domain combination as an accepted narrowing, revisit only on evidence
   of real director need.

---

## 5. Recommended root/domain model — explicit Context decision

**Decision: REPURPOSE Context to the real "around-the-normal-schedule" layer; do not delete, do not
keep empty.** (Owner-selected direction, grounded below.)

Evidence: the concept the owner suspected *does* exist in the domain model —
`FieldTripDrawer` (`PRESET_STAMPS = ['Field Trip','Special Event','Service Project']`, rendered as
schedule overlays), `day_override_templates` (alternate-day schedules), per-week exclusions. **But
none of it is ingestible** — `INGESTIBLE_ENTITIES` is `cohorts, tiers, groups, days_of_operation,
time_blocks, locations, activities`. Field trips / special events / day overrides are *authored in
the schedule*, never *reconstructed from a spreadsheet*.

Therefore Context is honest **only** once Roots persists beyond import:
- **During ingestion:** Context stays genuinely calm — "nothing special-schedule was in this file
  yet." Not decoration, because it names a real domain, but correctly quiet.
- **In the persistent inspector:** Context becomes the place a director sees and manages field
  trips, special events, and day overrides — a real, populated root.

This snaps the two owner decisions together: **Context survives *because of* the persistence
decision, not in spite of it.** The camp ontology (not the artwork) determines the root: five roots
= the four ingestible domains + the one authored-content domain that only lights up post-import.

Root/domain model (canonical keys unchanged; only Context's *meaning* and *wiring* change):

| Root | Children | Populated when |
|---|---|---|
| Structure | Units (cohorts), Groups, Age Divisions (tiers) | ingestion + persist |
| Scheduling | Activities, Fixed Events (anchors) | ingestion + persist |
| Time | Days, Time Blocks | ingestion + persist |
| Facility (label "Resources") | Locations | ingestion + persist |
| **Context** | Field Trips, Special Events, Day Overrides | **persist only** (calm at ingestion) |

---

## 6. Persistence beyond import (in-scope by design; full editing deferred)

Blockers today: the *screen* is welded to the import lifecycle — reachable only via
`ImportScreen`'s `if (ledger)` takeover, requires `baseInputs`/`sourceLabel` from a staged import,
runs a dry-run ingest on mount, and unmounts on commit. The *model builder* (`buildRootMapModel`) is
pure and already reusable.

Design (build once, share with H2): a **file-less "inspect" mode** that synthesizes the census view
from live camp data — no source file, no dry-run, no commit tray — mounted as a real `SCREENS`
route with a sidebar entry. The census work in Slice 2 is the shared substrate: import mode overlays
decisions on the census; inspect mode shows the census alone. **Editing stays via the existing
"Open in {Screen} →" deep-links** — we do not rebuild Camp Setup inside Roots.

---

## 7. Required view-model / data changes

- `buildRootMapModel` — emit census nodes from a live snapshot; support real per-entity `absent`;
  a `mode: 'import' | 'inspect'` shaping (import overlays decisions, inspect is census-only). **Pure,
  test-pinned — the highest-leverage and highest-risk change; everything reads this.**
- `RootMapPanel` — `selection:none` scopes to needs-attention (H1); census nodes render calm detail
  with deep-links, no decision cards when there are none.
- `domainRollup` — Context gains real child attribution (Field Trips / Special Events / Day
  Overrides) in inspect mode; stays unmapped (calm `absent`) in import mode.
- `ReconciliationScreen` — accept `mode`; in inspect mode skip the dry-run/commit tray.
- New: a file-less entry that builds `baseInputs`-equivalent census from live `localClient.list(...)`.
- No schema change anticipated for Slices 1–3. Slice 4 persistence uses existing tables
  (`template_overlays`, `day_override_templates`); confirm during its ADR.

---

## 8. Component reuse / deletion plan

- **Reuse unchanged:** `buildReconciliationReport`, `reportToLanes`, `reconciliationCards`,
  `reconciliationTriage`/`reconciliationResolutions`, `RootMap` (the illustration + node layer),
  evidence disclosure, deep-link nav (`rootMapNav`).
- **Modify:** `buildRootMapModel`, `RootMapPanel`, `domainRollup`, `ReconciliationScreen` (per §7).
- **Keep (do not delete):** `ReconstructionMoment` — it is a first-import curtain-raiser over the
  same data, not the duplication the brief targets. Out of scope; revisit only if the census landing
  makes it redundant.
- **Confirm intended (no change):** the `ImportScreen` parse-preview antechamber — a legitimate
  upload→extract→confirm phase, not a second reconciliation.
- **Delete nothing structural.** The one thing the brief flagged as delete-not-reconcile —
  Context-as-empty-decoration — is *repurposed*, not deleted (§5).

---

## 9. Bounded implementation slices

Each slice is test-first at its seam and independently reversible. Slices 0 and 2 hit human gates.

- **Slice 0 — ADR (human gate).** Ratify: unified model refinements (H1/H2), Context redefinition,
  persistence path. No code. Architect writes; Red Hat challenges *before* any Maker work.
- **Slice 1 — Quiet default (fixes H1).** `selection:none` → needs-attention subset; tiles/nodes
  reach the rest. Small, high-leverage, characterization-test-first on `RootMapPanel`.
- **Slice 2 — Census model (fixes H2; peer thread B).** `buildRootMapModel` emits calm per-entity
  nodes + real per-entity `absent` from the live snapshot. **Architect + Red Hat** (touches the
  model everything reads; pin the existing Σ-invariant test and extend it).
- **Slice 3 — Context repurpose.** Wire Context children (Field Trips / Special Events / Day
  Overrides); calm at ingestion, populated in inspect. Depends on Slice 2.
- **Slice 4 — Persistence (inspect mode).** File-less entry, `SCREENS` route + sidebar, no-commit
  render. Depends on Slice 2. Own ADR for the mount/route surface.
- **Deferred, revisit on evidence:** M3 field-level ledger diff, M4 UNKNOWN detection, M5 real
  blast-radius ordering, M2 multi-select. Recorded, not scheduled.

---

## 10. Where this audit would tell the owner "no"

Nothing in the brief's direction is contradicted by the evidence. The one correction: the brief
frames this as reconciling "old reconciliation UI + Roots" — but there is **no old reconciliation UI
left to reconcile against.** The real work is *deepening one already-unified surface* (H1/H2 +
Context + persistence), not merging two. That reframing makes the job smaller and lower-risk than
the brief assumes.

---

## 11. Red Hat challenge — findings and resolutions (2026-08-19)

Red Hat challenged this plan before any code. It verified the headline ("one surface, deepen not
merge") as true, and surfaced three HIGH issues that make Slices 2/4 **not buildable as first
written**. Resolutions below; the slice plan in §9 is superseded by §12.

- **HIGH-1 — census as canvas nodes re-creates the "wall of 374" the owner forbade, and
  `layoutForChild` hard-caps at 5 positions (`index % 5` → coincident dots).** *Resolution — design
  correction:* the **canvas stays calm and category-level** (the ~8 named children we already have).
  "Deep on demand" for the calm 374 happens in the **panel as a roster** when a category node is
  selected — not as hundreds of dots on the illustration. This dissolves both the "wall" risk and
  the layout-collision bug: the canvas node count never grows with camp size. `rootMapLayout` is
  untouched.
- **HIGH-2 — census granularity (per-entity vs per-category) was never decided, yet drove the "374"
  framing.** *Resolution:* **per-category node on the canvas, per-entity roster in the panel.** The
  "374" is a *panel roster* count, never a canvas count. A worked example against real camp-sized
  data (not the 3-group fixture) is a required input to Slice 2's ADR.
- **HIGH-3 — inspect mode has no data-production path: `ingestReconcile` is a diff engine that
  requires a file; there is no live-data-only producer of `planItems`.** *Resolution:* inspect mode
  does **not** reuse the report/dry-run pipeline at all. It reads live entities directly
  (`localClient.list(...)`) into the **census roster** — no diff, no `planItems`, no commit tray.
  Import mode overlays decisions on that roster; inspect mode is the roster alone. This is a named
  artifact for Slice 4's ADR, not a hand-wave. Confirms "reconciling the camp against itself" is
  explicitly rejected.

Accepted MEDIUM items, folded into the slices:
- **H1 resolved-items affordance:** scoping `selection:none` to unresolved must ship *with* a
  "recently resolved / Show all" affordance reachable from the default view (today "Show all" only
  appears after a selection). Slice 1 owns this — it is not pure subtraction.
- **Context regression trap:** add an invariant test asserting no `INGESTIBLE_ENTITIES` member is a
  Context-only entity, so a future parser growth can't silently re-phantom Context. Slice 3.
- **Census completeness invariant:** the existing `Σ child.decisionIds === report.decisions.length`
  covers decisions only. Slice 2 must add a census-completeness invariant (`Σ roster entries ===
  entities in live snapshot`) so an entity type can't silently vanish from the roster.
- **Empty-camp state:** a domain that is empty by neglect (fresh camp) must not read as `understood`
  (false confidence). Needs a distinct "not set up yet" state — design question for Slice 2's ADR.
- **Large quiet category browsing** and the **inspect-mode load-race guard** (`requestGenRef` reuse)
  are Slice 2 design inputs.

**Red Hat's sequencing recommendation, adopted:** ship Slice 1 now (genuinely small, safe, real
value); do **not** ratify an ADR for Slices 2/4 until census granularity, the N-node/roster
rendering, and inspect-mode's data path are each designed against real camp-sized data.

---

## 12. Revised slice plan (supersedes §9)

- **Slice 1 — Quiet default (fixes H1).** `selection:none` → unresolved needs-attention subset,
  **plus** a from-default "recently resolved / Show all" affordance. Characterization-test-first on
  `RootMapPanel`. Independently shippable, no ADR gate beyond the standard loop. **Ready now.**
- **GATE — Slice 2/4 ADR (human).** Architect designs, against real camp-sized data: (a) the
  census roster shape (per-category canvas node → per-entity panel roster), (b) large-category
  browsing, (c) census-completeness invariant, (d) empty-vs-understood state, (e) inspect-mode's
  file-less `localClient.list` data path, (f) load-race guard. Red Hat re-challenges the worked
  example. Only then does code begin.
- **Slice 2 — Census roster.** Per the ratified ADR. Touches the model everything reads.
- **Slice 3 — Context repurpose** + the ingestible-overlap invariant test. Depends on Slice 2.
- **Slice 4 — Persistent inspect mode.** File-less census, `SCREENS` route + sidebar. Depends on
  Slice 2. Its data path is designed in the Slice 2/4 ADR, not deferred.
- **Deferred, unchanged:** M3 field-level diff, M4 UNKNOWN detection, M5 blast-radius ordering, M2
  multi-select.
</content>
</invoke>
