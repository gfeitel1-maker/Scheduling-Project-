---
title: "Ingestion Reconciliation — B0 Baseline (reconcile & confirm)"
document_type: baseline-inventory
status: complete
created: 2026-08-10
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-08-10-ingestion-reconciliation-semantics.md]
related_specs: [docs/work/specs/2026-08-10-ingestion-phaseA-discovery.md, docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md]
related_program: docs/work/onboarding-reconciliation/00-INDEX.md
program: ingestion-reconciliation
pinned_base: a9bd126 (main, includes PR #35 fixed-event-reimport tombstone fix)
archive_when: superseded by an approved B1+ implementation
---

# B0 — Reconcile & Confirm Baseline

Read-only. No product code touched. Verified every claim below against the actual worktree at
`~/dev/shoresh-ingestion`, branch `work/ingestion-reconciliation`, rebased on
`main` at `a9bd126` (`git merge-base main HEAD` = `0162ec2`, i.e. this branch's only commits beyond
`main` are the ADR/discovery/brief docs themselves — no product code has diverged from `main` yet).

## 1. What is ACTUALLY LIVE on main today (a9bd126)

| Spine piece | Status | Evidence |
|---|---|---|
| Field-delta `ReconciliationPlan` | **LIVE** | `src/ingest/buildPlan.js` — pure diff layer emitting `{op, entity, entity_id, fields:{field:{from,to,source}}, evidence, _humanFields}` items (`buildPlan.js:1-13` doc comment, item shapes at ~255-275). `op` arms `create`/`update`/`unchanged`/`clear`/`conflict` all present and typed, not stubs. |
| Per-field import/human provenance | **LIVE** | `operations` table has a `source` column (`electron/db/schema.sql:141` `CREATE TABLE operations`, `source` documented at lines 126-140 as a migration-v18 addition, deliberately not in the base `CREATE TABLE` per the comment at 131-140). `_humanFields`/`humanFieldsFor` consumed in `buildPlan.js` (referenced at item-construction sites). |
| `source_aliases` identity | **LIVE** | `electron/db/schema.sql:108` `CREATE TABLE IF NOT EXISTS source_aliases`. |
| Held-conflict resolution (T73) | **LIVE** | `electron/ops/ingest.js` hold-the-whole-import gate; `src/screens/ReconciliationLedger.jsx` renders it. (Not independently re-verified test-by-test in B0 — Phase A discovery already cited `ingest.t73.test.js`; no code changed since.) |
| Six-state Setup Readiness model | **LIVE** | `src/engine/readiness.js:174-175` states `'ready'\|'needs-attention'\|'missing'\|'optional'\|'not-applicable'\|'in-progress'`; state-resolution logic at lines 195-206. `FORWARD_AREAS` exported at line 137, merged into a combined descriptor list at line 147-148 (`OPTIONAL_AREAS` + `FORWARD_AREAS` with `kind` tags). |
| Fixed-event reimport tombstone fix (PR #35) | **LIVE, confirmed merged into main** | `git log main..HEAD` base check: `a9bd126` is literally the merge commit "Merge pull request #35 from .../fix/fixed-event-reimport-tombstone", with `ad6db08` ("Honor a director's fixed-event deletion across re-import (tombstone)") and `8b551ba` ("Replace-mode import clears prior fixed-event rejections") as its two commits — both already inside `main`, not just this branch. Code: `electron/ops/ingest.js:556` `anchorSlotKey`, `575-587` reads `__deleted__`-tombstoned `anchor_activities` rows via `operations` and builds a `rejected` slot-key set, `920-946` "live wins over tombstone" comparison at commit time. **The ADR's external prerequisite is satisfied — no rebase action needed, B3 is unblocked on this dependency.** |
| Activity-rule inference | **LIVE** | `src/ingest/activityRules.js:82` `priority = share >= HIGH_PRIORITY_THRESHOLD ? 'high' : 'low'` (forced binary, exactly as discovery reported — the manufactured-certainty target of D4/B2). Line 78 `if (perWeek < 1) perWeek = 1` (frequency floor). `eligibility_known` computed at line 86 and tested (`activityRules.test.js:89-109`) but **not read anywhere downstream** — confirmed dead: grep across `src/ingest/*.js` and `src/screens/*.js` for `eligibility_known` returns only `activityRules.js` and its own test file. |
| Fixed-event inference | **LIVE** | `src/ingest/fixedEvents.js:46,132,141,170` — its own two-valued `confidence:'high'|'low'` scheme, independent of `activityRules.js`'s threshold and `preview.js`'s `lowConfidence` boolean (`preview.js:107`). Three incompatible schemes confirmed still present, unchanged since discovery. |
| Engine's two-valued priority contract | **LIVE, confirmed** | `src/engine/buildSchedule.js:302` `runRound(slotsToFill, priority)` filters `a.priority === priority` inside `roundSlots`/sort — only ever called with `'high'`/`'low'` (per discovery's citation at line 302; re-read confirms the filter shape, not a third bucket). |
| Protected-field list (Policy A) | **LIVE, scope unchanged** | `electron/ops/ingest.js` `COMPARABLE_COLUMNS` (near line 179): `activities: ['priority','min_per_week','max_per_week','location','eligible_group_ids']`. `groups: ['availability','tier_id']` and `tiers: ['sort_order']` **are** present in the map — but the discovery's Gap 1 claim was about the field-hold/conflict protection semantics broadening to those entities' business fields (`groups.tier_id` as a director-confirmed decision surviving re-import the same way `activities.priority` does), not about `COMPARABLE_COLUMNS` membership alone. Re-read: `COMPARABLE_COLUMNS` governs what buildPlan diffs at all; Policy A protection (conflict-on-stale-overwrite) for non-activity entities has not been separately confirmed live in B0 and should be treated as **not yet verified** — B3 must re-check this precisely, not just extend a column list. |

## 2. What is DESIGNED BUT NOT LANDED

Confirmed absent from the actual worktree (not just "the ADR proposes it" — checked for real):

- **No `state`/confidence column or unified confidence primitive.** No `src/ingest/confidence.js` exists (`ls src/ingest/` has no confidence or evidence file). Three incompatible schemes (`activityRules.js:82` threshold, `fixedEvents.js` `'high'|'low'`, `preview.js:107` `lowConfidence` boolean) remain unmerged, exactly as discovery found — this is **B1**, untouched.
- **No evidence persistence.** No table or file artifact stores the observation bundle past the import session; `extractEntities.js` counts and `fixedEvents.js:66-79` `occupied`/`operatingDays` remain transient in-memory structures discarded when the plan is built. **B4/D3, untouched.**
- **No OBSERVED-vs-INFERRED tag.** Nothing in `buildPlan.js` items or `operations` distinguishes a literal-fact import value from a heuristic-rule-derived one; `source='import'` is undifferentiated. **B5/D1, untouched — and it depends on B4 per the ADR's dependency order, confirmed correct (there's nothing to tag against without the evidence record it tags).**
- **No UNKNOWN-priority path.** `activityRules.js:82` still forces every activity to `high`/`low`; no branch emits an absent/UNKNOWN value. **B2/D4, untouched.**
- **No group-scope-drift CHANGED signal.** `ingest.js`'s `anchorSlotKey` skip-branch (T72 behavior, confirmed live) still silently ignores a changed `group_ids`/`is_all_groups` on a recognized slot — no read-only diff/report annotation exists yet. **C1a, correctly scoped to Phase C, not B.**
- **No semantic-category reconciliation report.** `ReconciliationLedger.jsx` still groups by CRUD op (`create`/`update`/`unchanged`/`clear`/`conflict`), not by UNDERSTOOD/NEEDS ATTENTION/NOT IN SOURCE/CHANGED. **C1/D1, untouched.**
- **Auto-accept policy still lives in the UI**, not extracted to domain: `ImportScreen.jsx` still contains the `confidence === 'high'` filtering the discovery cited (lines ~290, ~299 per the grep above, matching discovery's `130,284-299` citation closely enough — line numbers have drifted slightly with unrelated commits since discovery, content unchanged). **Part of B1's scope per D2.**

Everything above matches the discovery report's findings; **B0 found no drift between the discovery's snapshot and the current worktree** — no unrelated commits landed on `main` since Phase A that touch the ingestion path (the `git log` on `main..HEAD` for this branch shows only the three ADR/discovery/brief doc commits since `a9bd126`, and `a9bd126` itself is the tombstone-fix merge the ADR already accounted for).

## 3. Concrete attach points for the three deltas

1. **Four-state OBSERVED/INFERRED tag (D1/B5).** Attaches at `buildPlan.js` item construction — each `fields[field]` delta needs an origin tag joined from the evidence record (B4). No new column on `operations`; the tag is computed at read time by joining a plan item's evidence reference against the persisted evidence bundle. Concretely: wherever `buildPlan.js` currently sets `fields[field] = {from, to, source}` (the delta shape, e.g. near lines 255-275), the evidence-bundle key needed to answer "was this observed or inferred" must be threaded through from `activityRules.js`/`fixedEvents.js`/`extractEntities.js` call sites — those are the only producers of import-derived values today.

2. **"Stop manufacturing certainty" (D4/B2).**
   - `activityRules.js:82` — replace `priority = share >= HIGH_PRIORITY_THRESHOLD ? 'high' : 'low'` with a branch that can emit `undefined`/no value when evidence is insufficient (exact threshold for "insufficient" is a B2 design question, not yet decided — flag for Governor/B1 brief).
   - `activityRules.js:78` (`if (perWeek < 1) perWeek = 1`) and `ingest.js` near line ~600-604 (`commitCreate`, force-writing `min_per_week`) — both are candidate sites for the symmetric frequency de-manufacturing named in D4; confirmed both still force a floor/default today.
   - `buildSchedule.js:302` `runRound` — **confirmed untouched, engine's two-valued filter is exactly as discovery found.** The ADR's resolution (generation-time default outside the engine, column stays NULL) means B2 must NOT touch this line; the default gets applied wherever priority is read for scheduling generation, upstream of this filter, not inside it. Confirm this stays outside `src/engine/` entirely — B2 should be scoped to `src/ingest/` and whatever generation-trigger call site currently reads `activities.priority` before invoking `buildSchedule`.

3. **Evidence bundle persistence (D3/B4).** The importer output shape a compression layer (Phase C) will consume is `buildPlan.js`'s existing `plan.items[]` (`{op, entity, entity_id, fields, evidence}`) — `evidence` is already a per-item field (seen at `tier`/`matched_name` object literals in the code read above, e.g. `evidence: { tier, matched_name: match.name }`). B4's job is to persist a **richer, import-run-scoped** evidence record (the transient `seenCounts`/`activityPages`/`occupied`/`operatingDays` structures currently discarded) and give each plan item's existing `evidence` field a stable key into that persisted record. B4 does not need to change `buildPlan.js`'s item shape — it needs a new persistence call sited wherever the import pipeline currently discards those transient structures (in `extractEntities.js` and `fixedEvents.js`, at the point their per-entity aggregates are computed, before `buildPlan` consumes them). The physical storage shape (file vs. local table) is explicitly still open per the ADR's OQ1 follow-up — not decided in B0, correctly deferred to B4's own sub-ADR.

## 4. Surprises vs. discovery assumptions

None material. Two small precisions, not corrections:

- Discovery's Gap 1 ("protected-field list scoped to activities only") is accurate for *Policy A conflict-hold protection*, but B0's re-read shows `COMPARABLE_COLUMNS` (the diff-scope map, a different concern) already lists fields for `groups` and `tiers`, not only `activities`. **B3 needs to verify precisely which mechanism (diff scope vs. conflict-hold) is missing coverage for `groups.tier_id`/tiers/fixed events before writing its test** — this is a scoping precision for B3's brief, not a finding that changes the B0-B5 plan.
- The tombstone fix (external prerequisite) is not just "will merge" as the ADR anticipated — it **is already merged into `main`**, and this integration branch is already rebased onto it (confirmed via `git merge-base`). The ADR's open question 3 ("confirm rebase timing") is therefore **resolved**: no rebase action is needed before B3 starts; `main` at `a9bd126` already contains it.

## 5. B1 starting point

**B1 — One confidence primitive (D2), per the ADR's decomposition, confirmed as the correct next slice and confirmed unblocked (only depends on B0, which is now done).**

Scope, precisely bounded by what B0 found live:

- Create `src/ingest/confidence.js` (or equivalent domain module) as the single primitive the three existing schemes normalize into: `activityRules.js:82`'s `share >= HIGH_PRIORITY_THRESHOLD` threshold, `fixedEvents.js`'s `confidence:'high'|'low'` (set at lines 132/141/170), and `preview.js:107`'s `lowConfidence` boolean.
- Extract the auto-accept policy filtering `confidence === 'high'` out of `ImportScreen.jsx` (current call sites around lines 290/299) into the same domain module.
- Do **not** touch `buildSchedule.js` or any engine file — B1 is `src/ingest/` + `ImportScreen.jsx` only.
- Surface (don't yet consume) the already-computed, currently-dead `eligibility_known` signal (`activityRules.js:86`) through the new primitive — B1 makes it live-but-unread; a later slice (C1/C2) is what actually branches on it.

**First failing test seam:** a new unit test file (e.g. `src/ingest/confidence.test.js`) asserting that all three of today's inputs — an `activityRules`-style `share` ratio, a `fixedEvents`-style `'high'|'low'` label, and a `preview`-style boolean — normalize through the new primitive to the **same** three-tier output (HIGH/MEDIUM/LOW per the ADR's D2 attention model). Write this test first, watch it fail because `src/ingest/confidence.js` does not exist yet, then implement. This is the correct TDD seam because it's the one place all three schemes' outputs can be compared side-by-side without touching any call site yet — call-site migration (wiring `activityRules.js`/`fixedEvents.js`/`preview.js`/`ImportScreen.jsx` to actually use the primitive) is the second, integration-level round of B1, after the primitive itself is proven correct in isolation.

## B1 closure note (2026-08-10) — `eligibility_known` deliverable descoped

B1 landed (commits `d587ab3`, `694c16c`): `src/ingest/confidence.js` unifies the three schemes
(`activityRules.js:82`, `fixedEvents.js:132/170`, `preview.js:107`) and holds the extracted
auto-accept policy (`autoAccepts`), which `ImportScreen.jsx` now consumes. Verified behavior-preserving
(Verifier PASS, 66/66 focused tests; Red Hat could not break the claim; Grader 4.33 PASS).

One §5 sub-item was deliberately NOT implemented: "surface (don't yet consume) `eligibility_known`
through the new primitive." Review found B0's premise for it is **stale** — `eligibility_known` is
NOT dead; it is already read live at `src/screens/ImportScreen.jsx:1594` (predates B1, from T35). Its
goal ("make it live-but-unread") is therefore already exceeded. Threading it through the confidence
primitive with no new consumer would add speculative dead coupling the ADR explicitly warns against,
so it is **descoped from B1 and deferred to C1/C2**, where an actual consumer that branches on it exists.
No dead surface was created for it. Two LOW readability nits (fixedEvents.js:172 boolean round-trip;
confidence.test.js:49 raw literal) were accepted as-is, not worth a churn round.

## Confirmed/corrected dependency order

B0 confirms the ADR's Phase B/C/D decomposition and dependency order as stated, with one precision: B3's dependency on the external tombstone PR is now satisfied (already merged), so B3 is blocked only on B0 (done) going forward, not on any further external event. No other reordering warranted.
