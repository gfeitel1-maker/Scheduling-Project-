---
title: "Ingest flow audit — what works, what's duplicative, and Roots as the spine"
document_type: spec
status: draft
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_docs:
  - docs/work/specs/2026-08-19-roots-reconciliation-audit.md
  - docs/adr/2026-08-19-roots-census-and-persistent-inspector.md
  - docs/adr/2026-08-17-onescreen-reconciliation-projection.md
archive_when: superseded by the "Roots as spine" design ADR this audit recommends, or the direction is rejected
---

# Ingest Flow Audit — what works, what's duplicative, and Roots as the spine

**Owner brief:** audit the ingest flow to reveal what is working and what is duplicative
(specifically *what happens after you import a schedule*), and how the Roots screen can be used to
best advantage.

**Method:** evidence-first, two read-only investigations (full flow map + duplication/leverage
analysis) plus first-hand tracing of the post-commit path. This audit is the input to a
`brainstorming` design phase, not a locked design — it establishes the landscape.

---

## 0. Headline

The ingest machinery is sound and already shares one model spine. The weakness is **the post-import
moment and the surfaces around it**: after a substantive import, the director is dropped back on the
Import screen with an ephemeral banner, pointed at "Go to Groups" — **never at Roots** (the
purpose-built "see what Shoresh understood" view) and, on the real-import path, never even at
"Go to Schedule." Meanwhile **"what's missing" is computed twice** (ReadinessHub from counts, Roots
from rows) — the exact multi-answer drift `readiness.js` was written to end, quietly re-forming.

**The move: make the Roots inspector the spine of the post-import journey** — census body + a
readiness verdict banner — and wire the flow into it. Because everything already reads the same
model spine, this is mostly **navigation + a banner**, not new architecture.

---

## 1. The five surfaces

| Surface | File | Answers |
|---|---|---|
| ReadinessHub (default landing) | `src/screens/ReadinessHub.jsx` | "Can this camp build a week yet?" (from row **counts**) |
| Import antechamber | `src/screens/ImportScreen.jsx` (`proposal` block ~730–1069) | "Shape the parsed proposal before reconciling" |
| Reconciliation (`import` mode) | `src/screens/ReconciliationScreen.jsx` | "Resolve this file against the live camp" |
| **Roots inspector (`inspect` mode)** | same file, `mode:'inspect'`, `roots` route | "What does Shoresh know about my camp?" (from full **rows**) |
| Setup CRUD screens | Tiers/Groups/Days/… | the actual edit surfaces the others deep-link into |

All read one spine: `buildReconciliationReport → reportToLanes → buildRootMapModel → RootMap +
RootMapPanel`, plus `getReadiness` (`src/engine/readiness.js`). **That shared spine is why
consolidation is navigation, not a rewrite.**

---

## 2. What's working (keep)

- **The shared model spine** — import, inspect, and readiness cannot structurally disagree about
  *which entities exist*; they only present differently.
- **Antechamber ≠ reconciliation is a principled split.** The antechamber edits *parse-time
  inference* (unit column, activity rules, keep/replace mode) that only exists because a file was
  parsed; reconciliation resolves *existing-camp collisions* (`ImportScreen.jsx:99-101`,
  `730-1069`). Not the same data edited twice in the general case.
- **Re-import handling** — hand-edit provenance protection (Policy A), host-local aliases (S1b),
  held-conflict cards instead of silent overwrite, enrichment-workbook round-trip with staleness
  gating (`handleWorkbookReimport`).
- **Inspect → edit deep-links** — `RootMapPanel`'s "Open in {screen} →" and per-row `onRowClick`
  resolve through `rootMapNav.js` (with a dangling-target test), and Field Trips resolve per-row to
  the right schedule route.

## 3. What's duplicative

- **D1 — "What's missing" computed twice (the real dedup).** ReadinessHub's `missing` (from
  count-only stand-ins, `ReadinessHub.jsx:47-57`) is definitionally the same set as Roots'
  `not_set_up` (from full rows, `rootMapModel.js`), both scoped to the same `REQUIRED_AREAS`
  imported from `readiness.js`. Two reads, two screens, one truth — the multi-answer drift
  `readiness.js:5-10` exists to prevent.
- **D2 — Four overlapping "what does Shoresh know" surfaces** — ReadinessHub, Roots inspector, setup
  screens, import RootMap. Roots is a strict **superset** of ReadinessHub's information *except* the
  build-a-week verdict headline and the worksheet download.
- **D3 — Two "understood" surfaces, disconnected** — reconciliation's collapsed "N rows read
  cleanly" receipt (a count) vs the Roots census roster (the enumeration behind the count).
  Complementary, but the receipt's "Show details" expands inline instead of pointing at the
  purpose-built detail view (Roots).
- **D4 — Dead code:** ReadinessHub's `needs-attention` state never fires in production (`getReadiness`
  called with no `signals`, `ReadinessHub.jsx:63-65`). Forward-scaffolding, not live.

## 4. The gaps — "what happens after you import"

- **G1 — No route to Roots, ever.** `onNavigate('roots')` appears in zero non-test files; Roots is
  reachable only by clicking the sidebar item. The highest-intent moment to inspect the census
  (post-import) routes elsewhere.
- **G2 — Weak, backwards forward-affordance.** After a real import the receipt offers only "Go to
  Groups" / "See Setup Readiness" (`ImportScreen.jsx:687-694`) — **never "Go to Schedule."** The
  *only* path that offers "Go to Schedule" is `EndState` (`ReconciliationScreen.jsx:454-468`),
  reached only when the import was a no-op (`isGenuinelyEmpty`). The director who did the most work
  gets the least direction toward the goal.
- **G3 — Ephemeral receipt.** The success banner + grace-window undo live on ImportScreen; any
  navigation or new upload discards them (`result` cleared at `ImportScreen.jsx:187`).
- **G4 — Edit → back-to-Roots dead-end.** Setup screens have no "return to Roots" affordance; the
  inspect→edit→re-inspect loop is one-directional.
- **G5 (incidental) — No early host-gate on the import UI.** A Client-mode director can traverse the
  entire flow and only fail at `ingestCommit` (`electron/main.js:288`). Tracked as **T93**.

---

## 5. Recommended direction — Roots as the spine (for the brainstorming phase)

Grounded in the shared spine; mostly navigation + a banner. To be pressure-tested in
`brainstorming` against real camp data before an ADR.

**Roots inspect absorbs:**
1. **The readiness verdict** — add `getReadiness`/`describeReadiness` as a banner atop the inspect
   RootMap, so "what's missing" is computed **once** (resolves D1). ReadinessHub's unique assets
   (worksheet download, "Import last year" CTA) move onto that banner.
2. **The post-import destination** — after commit, route to Roots ("Here's everything Shoresh now
   understands") with the readiness verdict on top and a **"Go to Schedule"** CTA below (resolves G1,
   G2). Roots becomes the hinge: *imported → review → build.*
3. **The 'understood' detail view** — point the reconciliation receipt's "Show details" at Roots
   (resolves D3).
4. **The return loop** — a lightweight "← Roots" on setup screens (resolves G4).

**Stays separate (do not fold into Roots):**
- The **file-shaped antechamber** — file-time controls have no meaning on a file-less screen.
- The **build-a-week gate logic** — `getSetupGaps` remains the single blocking truth the generation
  gate calls directly; Roots *displays* the verdict, never *becomes* the gate (`readiness.js:5-16`).
- The **setup CRUD screens** as the system of record for editing.

**Open question for brainstorming:** does ReadinessHub survive as a distinct screen at all, or does
"Roots + readiness banner" fully replace it (with the sidebar `readiness` route pointing at Roots)?
The audit leans toward replacement but flags the migration risk (ReadinessHub is the *default
landing screen* — `App.jsx:80`).

---

## 6. Success criterion

A director who imports a schedule lands on **one persistent surface** that says, in order:
*"Here's everything Shoresh now understands about your camp. Here's the handful still needed before
you can build a week. → Build the schedule."* — and can return to that same surface any time to
inspect or edit, without hunting the sidebar. Roots stops being a fourth island and becomes the
connective tissue.

---

## 7. Next step

`brainstorming` on the Roots-as-spine design (esp. the ReadinessHub replace-vs-keep question and the
post-commit routing), then a design ADR, then bounded slices — the same loop the Roots initiative
used. Incidental T93 (host-gate) is independent and can proceed any time.
