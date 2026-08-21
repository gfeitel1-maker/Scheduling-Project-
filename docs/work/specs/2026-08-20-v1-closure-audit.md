---
title: "V1 Closure Audit + Roots Trunk Refinement"
document_type: discovery
authority: descriptive
status: active
created: 2026-08-20
date: 2026-08-20
author: gfeitel1 (Governor-peer session shoresh-v1-closure-audit)
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_reports: [docs/work/architecture-reports/2026-08-16-architecture-audit-summary.md, docs/work/architecture-reports/2026-08-17-ingestion-reconciliation-audit-summary.md]
---

# V1 Closure Audit — evidence before implementation

Scope: the owner's "V1 Closure Audit + Roots Trunk Refinement" directive (7 seams).
This is the §9 audit deliverable. **No code changed yet.** Findings are evidence-based
against the current tree (HEAD `8baa4a7`), running tests, and a real render of the Roots
screen at 1280×720.

**Headline:** the two P0 correctness items the directive names are **already closed and
green on main**. The directive is reasoning from the 2026-08-16 architecture audit, which
predates (or ran concurrent with) the fixes. The remaining open work is P1/P2 and smaller
than the directive implies.

---

## 1 & 2 — Roots trunk diagnosis (real render)

**Confirmed, matches the owner's complaint exactly.** Render evidence (Roots screen,
1280×720, demo camp): the trunk is a solid opaque brown tapered *stump/cup* sitting on top
of the fine dark line-roots. There is a hard horizontal boundary at the trunk base where
the filled brown mass stops and the thin root lines begin — the viewer can point to the
exact "trunk ends / roots begin" seam. The trunk reads as a separate Blender primitive
(different fill, different weight, different material) pasted onto the root network. It is
visually heavier than its interface importance. This is precisely the BAD case in the
directive's diagram.

The nodes (domain + child orbs) sit on the roots and in the crown, **none on the trunk
itself** — which is what makes the trunk fix safe: reshaping the trunk does not directly
move any anchor.

**Fix shape (bounded, art-only):** reduce `FLARE`, extend the base height-fade (`fade_b`),
and lower the cylinder `round_` contribution in `build_tree.py`'s trunk block so the trunk
widens aggressively at the base, becomes irregular, and dissolves into the crown before a
clean boundary appears — keeping camera, root geometry, and horizontal composition fixed.
Scripts are reusable in the blender peer's scratchpad (`blender-roots/build_tree.py`,
`preview/bake.py`, `production_bake.py`). Render against the actual Roots screen before
accepting.

## 2 — Root-art / semantic-layout coupling (confirmed, real and explicit)

The coupling the directive suspects **exists and is documented in the code**. `NODE_LAYOUT`
in `src/components/reconciliation/rootMapLayout.js` holds hand-placed, normalized `[0,1]`
coordinates that were **re-projected through the tilted Blender render camera**
(`world_to_camera_view` over the displaced root mesh) against the specific asset
`root-map-3d.png`/`.webp`. The file itself says: *"if the backdrop is re-rendered at a
different camera, re-run that projection."*

So the semantic anchor geometry is **implicitly owned by the raster + camera**. The backdrop
is a **matched triple** (confirmed with the blender-scene peer who authored it): the shipped
`src/assets/reconciliation/root-map-3d.webp`, the `NODE_LAYOUT` coords, and the RootMap
import must all agree.

**V1 rule recommendation:** adopt *"art may change only if the semantic anchor node
coordinates remain stable."* For the bounded trunk fix this is **satisfiable for free** —
keep the camera and the anchored roots fixed and only reshape the trunk mass (no anchor
sits on the trunk), so `NODE_LAYOUT` needs no change. **One risk to verify at render time:**
the five domain nodes sit at y≈0.33–0.39, the trunk↔crown transition zone; the trunk reshape
must not move the *roots those nodes anchor to*. If it does, re-project only the affected
coords.

**Robust follow-up (defer, not V1-blocking):** decouple by authoring the coords in the same
3D scene as the render (bake an ID/UV pass → derive coords procedurally) so the two can
never drift, replacing the hand-maintained two-file matched set. Only worth it if V1 wants
this hardened; the stable-anchor rule covers the trunk fix without it.

## 3 — PROJECTIONS registry guard — **ALREADY DONE (green)**

The directive's acceptance criterion is *already met*. `electron/ops/projectionsCoverage.test.js`
statically scans every entity/field `src/` writes via `localClient.write()/writeFields()/
bulkReplace()` and asserts each is registered in `PROJECTIONS`, and separately asserts every
live-schema column of every PROJECTIONS table is either registered or exempted with a reason.
Removing a registered writable entity or field from `PROJECTIONS` makes a test fail with a
clear message (e.g. *"Field 'X.y' is written but is not in PROJECTIONS['X'].fields … Add 'y'
to electron/ops/projections.js"*). It carries anti-vacuity floors + a per-pattern canary set
(including the historical `activities.is_locked` incident) so the scanner cannot silently go
blind.

**Deterministic evidence:** `projectionsCoverage.test.js` + `ingest.test.js` → **83 tests
passed (exit 0).**

**Recommendation:** no work needed. Verify the guard stays green under the audit-peer's v36
`elective_sets` migration (their Maker registers `is_reusable`; the guard will fail loudly
if they forget — that's the guard doing its job). Optionally, a one-line note in the audit
report closing this item.

## 4 — Ingest replace-mode atomicity — **ALREADY DONE (green)**

`T61` is `completed`. `electron/ops/ingest.js` exports `replaceScope(...)` and `commitIngest`
runs the replace teardown as the first statement inside the single `db.transaction(...)`
body; `src/screens/ImportScreen.jsx`'s `commit()` no longer has a renderer delete loop — it
passes `mode: 'replace'` through one IPC call. The Host-only guard, `min_per_week` floor, and
rollback tests from spec `S-replace-ingest-atomic-transaction.md` are in place.

**Deterministic evidence:** ingest suite green (part of the 83 above).

**Recommendation:** no work needed. Confirm `archive_when` on `S-replace-ingest-atomic-transaction.md`
(rollback coverage + real replace against a camp) and archive the spec if satisfied.

## 5 — Reconciliation per-field UNKNOWN state — **REAL, SCOPED V1 GAP**

Reconciliation is modeled at **entity/domain grain**, not field grain. Roots node states are
`understood | attention | changed | absent | not_set_up` (`src/ingest/rootMapModel.js`);
`absent`/`not_set_up` express "domain not present," but **"entity present, this property
could not be inferred" has no representation.** A `decision.unknowns: []` array is *reserved
on every decision branch but hardcoded empty everywhere* — the capability was deferred (C1).

**Two concrete "fabricated value shown as certain" cases:**
- `electron/ops/ingest.js:1008-1010` floors `min_per_week` to `1` when it can't infer one;
  committed as a plain integer, indistinguishable downstream from a director-set 1.
- `src/ingest/resolvePriorityForGeneration.js:8-12` coerces unknown priority to `low` at
  generation; nothing surfaces that priority was never actually judged. (Stored priority
  stays honestly NULL; the lie is at display/scheduling time.)

An activity that imports cleanly but never had `priority`/`min_per_week` determined lands in
`understood` and renders as a clean green roster row.

**Size:** medium, uneven. Schema = small (the per-field `import_evidence` spine already
exists; add an `unknown` tag). Projection = medium (populate the reserved `unknowns`; stop
NULL-punning the two defaults). UI = medium (a "known-but-incomplete" roster/node state).

**Recommendation: close a SCOPED slice now, not the full build.** Tag the `min_per_week=1`
floor as inferred/defaulted and wire the already-reserved `unknowns` array for `priority`
(a natural extension of the existing legacy-priority batch decision). Full per-field-UNKNOWN
across all columns defers — the honesty exposure is concentrated in these two. **This is a
data-model change → produce an ADR + recommendation before code (per the directive and the
constitution).** It is also the explicit blocker for the audit-peer's T107 (Roots Context
wiring), so it should be the first open item sequenced.

## 6 — Merged-span / manual-build editing — **DEFER BOTH (well-defined, non-broken)**

(A) Replacing an activity in a merged span is **honest and reversible** (T91): `replaceSlot`
frees each covered tail to an empty fresh head and places the incoming activity as a single
block — a 2-block swim replaced becomes head=new activity + tail=empty cell, not an orphan
or torn span. Tested (`ScheduleScreen.test.jsx:158-231`). The only gap is that span *length
is never inherited* — dropping a `span_blocks:2` activity yields a 1-block placement; the
director re-merges manually. Convenience gap, not integrity.

(B) Manual build **can** create spans, but only 2-block via the explicit merge-down gesture
(`expandSlot`), whereas the generator writes arbitrary-length `span_blocks` chains. Manual
reaches a strictly weaker form.

**Recommendation: defer both.** Neither undermines direct manipulation (replace is
predictable and fully undoable). Worth one line in the report: an activity's configured
length is currently a generator-only concept. Fixes are medium (A) / small-medium (B) if
ever wanted.

## 7 — Roots screen density / compression (real render)

At true 1280×720 the roots illustration (920×570) starts at **top=339px — 47% down the
viewport** — and being 570px tall, **most of the root system is below the fold.** The entire
upper half is dashboard chrome, stacked: header + subtitle → readiness banner ("Ready to
build a week." + 3 buttons) → "Your camp, as Shoresh understands it" heading → 4 state-count
cards → *then* the roots. Total content is 1036px against a 720px viewport.

So the director experiences **a conventional dashboard first and reaches the root
illustration around the vertical midpoint**, crown-and-trunk only, with the roots themselves
mostly below the fold. The intent ("Roots is the visual center… quiet at first glance, deep
on demand") is not met at laptop size.

**Recommendation: a bounded compression pass, not a redesign.** Tighten/merge the header +
readiness banner + count cards into one slim strip so the crown sits higher and the root
system is the visual center above the fold. Preserve state-based nav, domain nav, drill-down,
decision resolution, provenance, and reachability of UNDERSTOOD data — remove no information,
just compress the chrome. Coordinate with the blender-scene peer's Wave-1 RootMap craft work
(code-only) and their held RA-9 "tree-as-primary."

---

## V1-now vs defer split — FINAL OUTCOMES (updated 2026-08-21)

| # | Item | Verdict | Outcome |
|---|------|---------|---------|
| 3 | PROJECTIONS guard | Already done | **Closed** — `projectionsCoverage.test.js` meets the acceptance criterion; 83 tests green. No work. |
| 4 | Replace atomicity | Already done | **Closed** — T61 `completed`; `replaceScope` in one transaction; green. No work. |
| 5 | Per-field UNKNOWN | V1 now, scoped | **SHIPPED** — [PR #128](https://github.com/gfeitel1-maker/Scheduling-Project-/pull/128); ADR `2026-08-20-per-field-unknown-reconciliation-state.md`; full gate green; Red Hat HIGH (mainstream floor path) closed. |
| 1 | Trunk / root-crown | Bounded art fix | **ABANDONED** — owner reviewed the dissolve render (2026-08-21) and rejected it; asset reverted, branch dropped. Main's trunk stands. |
| 2 | Art↔anchor coupling | V1 rule | **Documented, no code** — coupling confirmed real (coords hand-projected against the render, `rootMapLayout.js`). Rule: art may change only if node coords stay stable; procedural-bake decouple deferred. Moot now that no art change ships. |
| 7 | Roots density | Bounded compression | **Handed off** — owned by the blender-scene session as RA-9/RA-10 (`ReconciliationScreen.jsx`/`RootMap.jsx`), ADR `2026-08-21-roots-tree-as-primary.md`. My render evidence (roots start ~47% down at 1280×720) is the ADR's before-state. No separate PR from this session. |
| 6A/6B | Merged-span editing | Defer | **Deferred, documented** — replace-in-span is honest/reversible (T91-tested); missing span-length inheritance + >2-block manual spans are convenience gaps, not integrity. |

## Net closure status

The two P0 correctness items (#3, #4) were **already closed and green** before this work — the directive reasoned from the 2026-08-16 audit that predated the fixes. Of the remaining items, **#5 shipped** (the one real open correctness/truthfulness gap), **#7 is being delivered by the peer session**, **#2 is a recorded rule needing no code**, **#6 is deferred with rationale**, and **#1 (trunk) was attempted and rejected by the owner** — reverted, main unchanged.

No new architecture was invented to make code prettier. The specific correctness seam that could silently ship bad data (#5) is closed; nothing was reopened.

