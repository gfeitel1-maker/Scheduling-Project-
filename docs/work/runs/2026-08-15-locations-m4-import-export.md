---
task: M4 — locations import/export round-trip (ingest → location_id, export id↔name, Q8 propose)
document_type: run
date: 2026-08-15
round: 2
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_specs: [docs/work/specs/2026-08-15-camp-spatial-model-assessment.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-08-10-ingestion-reconciliation-semantics.md, docs/adr/2026-08-10-ingestion-evidence-persistence.md, docs/adr/2026-08-09-s1b-host-local-aliases.md, docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md, docs/adr/2026-08-08-t72-fixed-event-reimport-idempotency.md, docs/adr/2026-08-08-export-formula-injection-sanitizer.md]
related_runs: [docs/work/runs/2026-08-15-locations-m3c-merge.md]
selected_agents: [governor, architect, maker, code-reviewer, verifier, tester, red-hat, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: no new screen; the Q8 "propose room text" review reuses the existing fixed-event reviewable-unit pattern in the reconciliation report (owner-approved IA). Architect designs the data/ingest layer.
  - agent: security
    reason: not-applicable
    note: CONFIRMED on the actual diff — no changes to electron/preload.js, electron/main.js, or electron/sync/ (no new IPC/auth/protocol surface). Ingest reuses commitIngest; export is a renderer util whose string cells already pass through the aoaToSanitizedSheet formula-injection boundary (ADR §D6). If a later fix round adds an IPC or a sanitizer gap, Security is re-added (rule 8).
deterministic_checks: [test, lint, build, integration]
human_gates: [ADR approval for the ingest resolve-or-create + provenance + Q8 parser design]
verdict: pass
completion_evidence: [electron/ops/ingest.js, src/ingest/extractEntities.js, src/ingest/preview.js, src/ingest/buildPlan.js, src/ingest/fieldUpdate.js, src/utils/exportWorkbook.js, src/screens/ImportScreen.jsx, src/screens/ImportScreen.locations.test.jsx, electron/ops/ingest.locationRoundtrip.test.js, docs/adr/2026-08-15-locations-import-export-roundtrip.md]
archive_when: M4 merged to main
---

# Run: M4 — locations import/export round-trip

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1. Owner authorized auto-land of locations slices.

## Brief

**Product outcome:** A place a director assigns survives the full export → edit → re-import round-trip
(assign "Pool" → export the enrichment workbook → edit it → re-import → the activity is still on "Pool",
and a hand-set place is NOT clobbered by re-import). And — Q8 = **propose** — when an imported schedule
already prints room names the parser used to throw away, Shoresh now captures recognized room text and
offers it as reviewable `observed` places the director confirms or dismisses (nothing created without an OK).

**Success predicate:**
1. **Ingest writes `location_id`, not free-text `location`.** The ingest pipeline (`ingest.js`
   commitCreate/commitUpdate, `buildPlan.js`, `fieldUpdate.js`) resolves a parsed place NAME → an existing
   `locations` row or creates one, and writes `activities.location_id`. **Host-side resolve-or-create is
   cross-device deterministic:** resolve by exact name first (reuses ANY existing row — picker-created
   random-UUID OR migration-created deterministic-id); only when truly absent, MINT via
   `deriveLocationId(campId, trimmedName)` (case-sensitive/TRIM-only, matching `restore.js` INV-2 and the
   v32 UNIQUE(camp_id,name)). Never `crypto.randomUUID()` on the ingest path (that is the picker's
   client-side policy and would fork ids across devices).
2. **Export emits the place NAME** resolved from `location_id` (`exportWorkbook.js` activities `location`
   column, mirroring how `unit` resolves `tier_id → tierNameById`); re-import resolves name → row;
   the `<clear>` sentinel still clears the binding.
3. **Hand-set `location_id` survives re-import** like units/groups/activity-rules: `location_id` joins the
   re-import diff/protection surface (`COMPARABLE_COLUMNS.activities` + `_humanFields`/`isProtected`) in
   BOTH the electron copy (`ingest.js`) and the verbatim `src/localClient.mock.js` copy. The frozen
   free-text `location` column STAYS (D5 op-log replay/rollback anchor) — never removed, just no longer
   the ingest write target.
4. **Q8 (propose):** the daysheet/text parser stops silently stripping recognized room text
   (`textGrid.js stripLocations`) and instead proposes it as a reviewable `observed` location via the
   existing reconciliation reviewable-unit machinery. Locations join `INGESTIBLE_ENTITIES`, the alias
   registries (`ALIAS_ENTITY_TABLE`), and `EVIDENCE_ENTITY_TYPES`. **No auto-create** — proposal only.
5. **Display cleanup:** remove the M3b interim free-text fallback in
   `ScheduleActivityView.jsx placeNameFor` (M4 owns it) now that ingest binds `location_id`.
6. Registry parity + `projectionsCoverage` updated (taught, not lowered); test/lint/build/integration green.

**What does not count as done:** minting ingest location ids with `crypto.randomUUID()` (cross-device
fork — the exact hole the initiative exists to close); auto-creating locations from room text without
review (Q8 is *propose*, not silent-create); removing the frozen `location` column (D5 anchor); a dangling
`location_id` written before its `locations` row exists (no DB FK — ordering is on us); redesigning the
ingestion UI (reuse the fixed-event reviewable-unit pattern); breaking the picker's own client-side
inline-create (that stays random-UUID/case-insensitive by design — only the Host ingest path is
deterministic).

## Standing context (from the Explore code map, 2026-08-15)

- **Ingest has ZERO `location_id` refs today** — writes free-text `location` throughout
  (`ingest.js:817/873/900/911`, `buildPlan.js:231/307`, `fieldUpdate.js:71`). Row-9 deferral confirmed.
- **Dedupe-policy mismatch (biggest landmine):** picker `createLocation` (`ActivitiesScreen.jsx:619`) +
  screen template-importer `confirmImport` (`:848`) are case-INSENSITIVE + `randomUUID`;
  `deriveLocationId` (`locationId.js:33`) is case-SENSITIVE + deterministic. Ingest MUST use the
  deterministic key. **Restore is the pattern to mirror:** `restore.js:224-243` re-binds `location_id`
  via `deriveLocationId`, stamped `human`.
- **#68 / M3c interaction:** exact-same-name create is rejected by #68's `UNIQUE_FIELD_ENTITIES`; the
  ingest resolve-by-exact-name-first design avoids ever hitting that (it REUSES the existing row rather
  than creating a duplicate). Case variants ("Pool"/"pool") legitimately become two rows the M3c merge
  gate can heal — consistent, not a bug.
- **Ordering:** `activities.location_id` has NO DB FK (`projections.js:143`) — a `location_id` op written
  before its `locations` row exists dangles silently. Ingest must create/resolve the location BEFORE the
  activity's `location_id` op.
- **Replace mode:** `REPLACEABLE_ENTITIES` (`ingest.js:38`) tears down activities but not locations —
  Architect decides replace-mode location handling + ordering vs teardown.
- **Registries needing M4 wiring:** `INGESTIBLE_ENTITIES` (`ingest.js:28`, locations ABSENT),
  `ALIAS_ENTITY_TABLE` (`ingest.js:200`, locations ABSENT), evidence; `COMPARABLE_COLUMNS` (electron
  `ingest.js:180` + mock `localClient.mock.js:37` — dual verbatim copies), `projectionsCoverage.test.js`.
  Already done in M1: `DIRECT_CAMP_ENTITIES`, `PROJECTIONS`, `DOMAIN_SNAPSHOT_TABLES`,
  `MOCK_WRITE_ALLOWLIST`.
- **Sanitizer:** all export string cells pass through `aoaToSanitizedSheet` — a location named `=cmd` is
  already covered (no new security surface expected).

## Agents

| Agent | Selected | Why |
|---|---|---|
| Governor | yes | routing |
| Architect | yes | ingest resolve-or-create determinism, provenance-survival surface, replace-mode ordering, Q8 parser design, registry wiring → ADR |
| Designer | no | reuses the existing reconciliation reviewable-unit pattern; no new screen |
| Maker | yes | builds to the ADR, test-first |
| Code Reviewer | yes | plan fidelity + the dual-registry parity |
| Verifier | yes | test/lint/build/integration (round-trip + re-import idempotency scenario) |
| Tester | yes | the import→review→confirm director experience + round-trip |
| Red Hat | yes | **mandatory** — stored shape, op-log, cross-device id determinism, re-import idempotency, ordering |
| Security | conditional | added only if a new IPC or sanitizer gap appears (see omissions) |
| Grader | yes | consolidates |

## ADR + owner approval (2026-08-16)

ADR `docs/adr/2026-08-15-locations-import-export-roundtrip.md` (Approach A: `locations` as a genuine 7th
`INGESTIBLE_ENTITIES` member → the existing generic tick-list produces Q8's review rows with zero new UI;
ordering falls out of array position; export cascades through registry-iterating call sites). **ACCEPTED
by owner 2026-08-16.** Owner confirmed the one product-visible consequence: ingest recognizes names
case-sensitively (consistent with `deriveLocationId`/M3c), so "pool" vs an existing "Pool" proposes a
SECOND row (mergeable via the M3c gate), never silent reuse.

**Governor calls on the Architect's three deferred items:**
- **Evidence write (§D5 row 24): SHIP in M4.** Cheap, reuses `writeEvidence` verbatim on the existing
  `activities`/`location` evidence entry, feeds the future "why?" panel — consistent with surface-everything.
- **Q8 review-row copy:** Maker uses sensible wording ("Seen in this file as a room — add it as a place?");
  owner refines live post-merge if desired. Not a blocker.
- **`ActivitiesScreen.jsx` M3b template importer (§D7):** OUT of scope; spun off as a follow-up ticket
  (separate non-deterministic CSV create path, known accepted gap).

## Build + safety panel (2026-08-16)

Maker built the full 24-row changeset test-first (5 invariants fail-first→green) and — notably — found +
fixed **two dual-copy gaps beyond the ADR's enumeration**: `confirmAlias.js`'s private `ALIAS_ENTITY_TABLE`
copy and a THIRD `buildExistingSnapshot` in `src/ingest/existingSnapshot.js` (renderer-side, missing the
replace-mode carve-out). Evidence write shipped (row 24). Disclosed scope call: no new integration-harness
scenario (argued the two-db ops test is equal fidelity).

Gate baseline: lint 0 err / **test 2760 pass·1 skip·0 fail** / integration 22/22 / build OK. `check:governance`
initially flagged 2 doc-wiring items (a non-enum `conditional` omission reason + stale work-index) — both
fixed (Security omission → `not-applicable`, CONFIRMED no IPC/preload/sync diff; index regenerated) →
governance clean.

| Agent | Verdict | Findings |
|---|---|---|
| Code Reviewer | Ready | All 24 rows correct in every copy; dual-copy verified by direct comparison; the 2 extra gaps genuine+fixed; `recognitionKey` clean; invariant tests genuinely assertive. **MEDIUM:** renderer Q8 tick-gate has no dedicated test (the "never auto-create" enforcement point). 2 LOW (trim-comment; evidence feeds future "why" panel — no action). |
| Security | n/a | Omitted — confirmed no IPC/preload/sync change; export cells already through the sanitizer boundary. |
| Tester | UX 3 / Visual 4 | **MEDIUM** candidate copy doesn't say ticking creates+binds; **MEDIUM** `workbookToSource.test.js` fixture passes `locations:[]` (round-trip under-tested); LOW generic "already in your camp" copy. Confirmed unticked-default, `!labeled` capture no-regression, export emits name. |
| Red Hat | Resilience **4** | 4/5 invariants cleanly hold (determinism byte-identical two-db, ordering, replace-mode carve-out genuinely closed incl. the 2 extra copies, D1c double-mint safe by construction). **HIGH:** Q8 candidate case-folding (shared `tally()`/`dedupe()` upstream of `recognitionKey`) collapses "pool"/"Pool" to one candidate while per-activity pairing keeps exact text → exact-string gate silently OMITS bindings for the non-surfaced spelling. Untested (invariants feed pre-separated arrays). Also: §D7's "app-wide no-write test exists" claim is FALSE (only scenario-specific); §D7's template-importer description is stale (real gap = non-deterministic mint, already ticketed task_3ccc52a8). |

## Consolidated fix round (dispatched 2026-08-16)

1. **HIGH (test-first):** location candidate tally → case-SENSITIVE/exact (carry §D3 one layer upstream),
   so "pool"/"Pool" surface as two candidates + each activity pairs exactly → no silent under-binding.
   **New renderer/integration test** driving the real `extractEntities → buildPreview → ImportScreen gate
   → final records` path with case-variant fixture (the coverage Red Hat + Code Reviewer both flagged).
2. Renderer tick-gate coverage (Code Reviewer MEDIUM) — fold into #1's test file (`ImportScreen.locations.test.jsx`),
   incl. the propose-only direction (unticked → no create, no bind).
3. Mock parity (Red Hat MEDIUM) — ingest-created location sets `capacity:1` explicitly.
4. Real round-trip test with populated `locations` (Tester MEDIUM).
5. Candidate copy conveys create+bind (Tester MEDIUM).
6. Add the genuinely app-wide `activities.location` no-write guard M3 never landed (Red Hat §D7 finding) —
   M4 closes the last writer, so it's the right slice.
7. LOW trim-precondition comment.
   NOT fixing: evidence "why" wiring (ADR-consistent), template-importer determinism (ticketed), generic
   shared copy (cross-entity by design).

## Fix round + verdict (2026-08-16)

All 7 findings closed (HIGH test-first via `tallyExact`; renderer tick-gate test `ImportScreen.locations.test.jsx`;
mock `capacity:1`; real round-trip test — which uncovered+closed a latent hole where prior location tests
bypassed name resolution; sharper candidate copy; the genuine app-wide `activities.location` no-write guard
M3 never landed; trim comment). Post-fix gates: lint 0 / **test 183 files 2773 pass·1 skip·0 fail** /
integration 22/22 / governance clean / build 0.

**Red Hat re-verify: HIGH CLOSED, Resilience 5/5** — proved by reverting `tallyExact`→`tally` (2 tests fail)
then restoring (pass); fix scoped to the locations candidate path only, no new hole, all 4 prior-HOLDS
invariants intact (476-test ingest suite clean); FIX 3 + FIX 6 verified correct.

## Decision

**PASS — Grader 4.67** (Verifier PASS · Code Reviewer 5 · Resilience 5 · UX 4; lowest dim 4 ≥ 3; no
blocking findings; HIGH found-within-loop-and-closed). GateReport at
`docs/work/runs/gate-reports/locations-m4-import-export-r2.json`. Auto-landing per owner authorization
(commit → rebase → re-verify → PR → merge). M4 complete.

**Live-UI caveat (carried from M1–M3):** Tester's eval is static against the tests + ADR — the in-app
browser MCP was unresponsive this whole initiative. Owner can `npm run electron:dev` to click through the
import → review → bind experience.

**Follow-ups:** task_3ccc52a8 (ActivitiesScreen template-importer non-deterministic mint — the real gap
§D7's stale text mislabeled). ADR §D7's "app-wide no-write test already exists" claim was FALSE; M4's
FIX 6 now actually provides that guard.

## Architect design summary (2026-08-15)

Design complete. ADR filed at
[`docs/adr/2026-08-15-locations-import-export-roundtrip.md`](../../adr/2026-08-15-locations-import-export-roundtrip.md),
status `proposed`, amending the parent v32 ADR's M4 row (not re-deciding anything already settled).

**Shape of the design:** `locations` joins `INGESTIBLE_ENTITIES` as a genuine 7th entity (reusing
buildPlan/commitPlan's existing create/unchanged machinery and ImportScreen's existing generic tick-list
UI — no new UI component), positioned immediately before `activities` so location creates land first in
the same commit (ordering falls out of existing array order, no bespoke scheduling code). Two distinct
resolution rules: a brand-new `locations` entity create mints via `deriveLocationId` (never
`randomUUID`); an activity's `location` field resolves via a **pure, lookup-only** path
(`resolveFieldWrite`, held as `location_unresolved` if absent — mirroring `unit`) for re-imports, plus
one **impure, DB-aware** resolve-or-create helper used only when a brand-new activity's location was
never separately proposed as its own create (the S4 enrichment-workbook path, where a director types a
room name directly into an editable cell). Recognition must be case-sensitive/exact for `locations`
specifically (unlike every other entity's `normalizeName`-based recognition) to stay consistent with
INV-1's deterministic id key and M3c's "case variants are real, mergeable rows" design — this is the
single riskiest piece, touching 4+ call sites across `preview.js`/`buildPlan.js`/`ingest.js`/the mock.
Q8's parser change is strip→capture in `textGrid.js`, tallied like any other entity, routed through the
ordinary tick-list with one deviation (create candidates default unticked, mirroring the fixed-event
pin-only precedent) — an activity's `location` field is only proposed when its paired location name is
ticked, which is what keeps Q8 genuinely propose-only.

**Human-gate decisions the owner should confirm before Maker starts** (see the ADR's "Open questions for
Governor"):
1. Q8's review-row copy ("Seen in this file as a room — add it?" or equivalent) — a wording call, not
   decided in the ADR.
2. Whether the recommended-but-not-required `import_evidence` write for an activity's observed location
   ships in M4 or is deferred (cheap, but not required by the success predicate).
3. Confirm the case-sensitive-recognition consequence reads as intended: a file saying "pool" against an
   existing "Pool" proposes/mints a **second** row, not a silent reuse — consistent with M3c's own design
   for the one-time migration, now extended to the live ingest path.
4. `ActivitiesScreen.jsx`'s separate M3b template importer stays non-deterministic (case-insensitive
   `randomUUID`) by design and is out of scope for M4 — confirm whether that gap needs its own follow-up
   ticket or stays accepted.

Architect did not implement any code. Maker should treat the ADR's numbered registry checklist (24 rows)
and the five stated invariants as the definition of done, and Red Hat's five adversarial-verification
items as mandatory review scope given the `database-sync` task class.
