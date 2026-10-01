---
task: q-rename-silent-lookup-gate — three scripts/ detectors for the "wide rename, lookup silently returns nothing" class (#696 shipped five instances)
document_type: run
date: 2026-10-01
round: 1
status: in-progress
task_class: test-infrastructure
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: []
related_specs: []
related_adrs: []
selected_agents: [governor, architect, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: no UI surface; the deliverable is scripts/ governance checks.
  - agent: tester
    reason: not-applicable
    note: no director-facing UX/visual surface; the deliverable is test/governance infrastructure.
  - agent: security
    reason: not-applicable
    note: no auth/PIN/secret/IPC/LAN-protocol/packaging change; checks are read-only static analyzers over committed test/scripts/schema text. (Revisit only if Architect finds detector C touches a security surface.)
deterministic_checks:
  - planted-defect red/green per detector shape on a scratch copy (cmd; echo EXIT=$?, unpiped)
  - each detector run against the full current clean tree -> zero false positives
  - the three new *.test.js unit tests beside each check (vitest, exit 0)
  - npm run check:governance exit 0 on the clean tree (new checks wired, blocking unless Architect justifies advisory)
  - npx eslint scripts (exit 0 — orphaned-import backstop)
  - footprint git diff --name-only origin/main (scripts/, optionally docs/governance/standards/TESTING_STANDARD.md, this run record; nothing under src/ or electron/)
human_gates: []
verdict: null
completion_evidence: []
archive_when: merged to main and the board item q-rename-silent-lookup-gate is closed
---

# Run: rename-silent-lookup gate (three detectors)

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** a wide rename (like #696 anchor→events) can no longer ship a lookup that keeps compiling and silently returns nothing without a gate catching it. Three static detectors, each wired BLOCKING into `npm run check:governance`, cover the three shapes #696 proved invisible to CI.

**Success predicate:** three checks exist under `scripts/`, each wired into `check:governance`, each proven to go RED on a planted instance of its shape and GREEN when removed, each producing ZERO false positives on the current clean tree, each stating what it cannot see; `check:governance` exits 0 on the clean tree; eslint clean; run record filled with canonical agent names.

**What does not count as done:** a detector with false positives on good code; a detector widened to catch a plant at the cost of real noise; a general-static-analysis claim that is not sound; any production-code change (src/, electron/).

## The three detector shapes (from #696)

- (A) A caller passing an object-literal argument key the callee no longer destructures/reads (shapes 1,2: findRouteConflicts call sites; scheduleInputNormalization key). HARD — Architect scopes the SOUND tractable subset and states what it cannot see.
- (B) A vacuous-assertion detector for test files: `expect(...)` over a statically empty/undefined selection (shape 3: ingest.t267 identity guard). Target the detectable subset; report the uncovered cases.
- (C) A renamed/dropped column name as a string in test/scenario/script SQL literals, checked against the LIVE schema (shape 5: `is_anchor` in 19-retire-orphan-slots.automerge.js). Parse CREATE TABLE columns from electron/db/schema.sql; denylist of known-migrated columns acceptable as the sound core.

## Task class and what it pulls in

`test-infrastructure` — governance/test tooling under `scripts/`.

| | |
|---|---|
| Standards | TESTING_STANDARD.md (gate list; one new sentence may describe the gate), CONSTITUTION.md Art. VII |
| Mandatory gates | check:governance (the checks wire in here), eslint, the new unit tests |
| Human gate | none |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | yes | scopes the SOUND form of each of the three detectors + writes what each cannot see |
| Designer | no | not-applicable — no UI |
| Maker | yes | implements each check test-first |
| Code Reviewer | yes | read-only — are the three checks SOUND (zero FP on the clean tree)? |
| Verifier | yes | always — plants each shape on a scratch copy, red/green, FP sweep, footprint |
| Tester | no | not-applicable — no director-facing surface |
| Security | no | not-applicable — read-only static analyzers; no threat surface |
| Red Hat | yes | read-only — what rename shape does each detector miss? can C FP on migration-down files/aliases? can A be fooled by a spread/renamed param? |
| Grader | yes | calibrated score; a Grader FAIL ends the loop |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| planted red/green (A,B,C) | PASS | each `*.test.js` below asserts a RED fixture (finding fires) and a GREEN/safe fixture (no finding) in the same file, watched to fail before implementation per TDD |
| FP sweep on clean tree | PASS (A, C zero; B see below) | A: `checkStaleSettingsKey(root)` → 0. C: `checkRetiredSqlColumn(root)` → 0. B: `checkVacuousFilterAssertion(root)` → 57, all confirmed genuinely vacuous latent tests (spot-checked `src/engine/buildSchedule.test.js:48`, `test/governance.test.js:79`, `electron/ipcSurfaceParity.test.js:183`), not detector false positives — per the BLOCKING-DECISION PROTOCOL, `vacuous-filter-assertion` is ADVISORY (`ADVISORY_CODES` in `scripts/check-governance.js`), carried forward below |
| new unit tests | PASS | `npx vitest run --no-file-parallelism scripts/staleSettingsKey.test.js scripts/vacuousFilterAssertion.test.js scripts/retiredSqlColumn.test.js` → 3 files, 18 tests, exit 0 |
| check:governance exit 0 | PASS | `npm run check:governance` on the clean tree → exit 0; 58 advisory findings (1 pre-existing `platform-state-stale` + 57 new `vacuous-filter-assertion`), 0 blocking |
| eslint scripts | PASS | `npx eslint scripts` → exit 0 (6 pre-existing unrelated warnings in `security-gate.js`/`verify.js`, 0 errors) |
| footprint | PASS | `git diff --name-only origin/main` plus untracked: `scripts/astWalk.js`, `scripts/staleSettingsKey.js`(+.test.js), `scripts/vacuousFilterAssertion.js`(+.test.js), `scripts/retiredSqlColumn.js`(+.test.js), `scripts/check-governance.js`, `docs/governance/standards/TESTING_STANDARD.md`, this run record. Nothing under `src/` or `electron/` (the other diffed paths against origin/main — `docs/work/specs/2026-10-01-t233-...`, `src/screens/elective/...` — predate this session, already on `HEAD` via commit `2f2b681d`, not touched here) |

## Architecture (detector design — recorded here, no ADR needed for a gate)

Architect (adhd + codebase-design), ground-truth verified by reading source. All three ship as ES
modules under `scripts/`, wired into `checkAll()` beside `checkDocFacts`/`checkNoLiteralNul`, using
the existing `finding()` helper. File enumeration via `git ls-files` through an injectable `execFn`
(the `noLiteralNul.js` convention — tracked files only). Parsing via **acorn** (already a
`package.json` dep, `^8.16.0`); a small shared `scripts/astWalk.js` recursive walker (no new dep;
`acorn-walk` NOT added). Per-file parse failures reported as their own non-fatal finding, never
silently skipped.

- **(A) `scripts/staleSettingsKey.js` — BLOCKING** (`stale-settings-key`). Curated-callee AST check:
  a hand-maintained registry (`findRouteConflicts` → keys from `src/engine/routeConflicts.js:38`;
  `buildSchedule` → union of both `normalizeInput` branches, `src/engine/buildSchedule.js:58-88`).
  For each `CallExpression` to a curated callee with an `ObjectExpression` arg: flag any literal key
  ∉ the callee's key-set; **abstain on the whole call site** for any spread/computed key. Zero FP
  verified against current call sites. Cannot see: non-curated callees; spreads; computed keys;
  variable/identifier args; indirect/method-access call targets; a stale registry (hand-maintained
  fact, same discipline as a doc-fact marker). Plant: `routeConflicts.test.js` call site key
  `fixedEvents`→`anchors`.
- **(B) `scripts/vacuousFilterAssertion.js` — BLOCKING if the corpus yields zero clean-tree
  findings; ADVISORY fallback only with the reason stated** (`vacuous-filter-assertion`). Flags an
  `it`/`test` body whose SOLE `expect()` (not descending into nested fns) is absence-shaped:
  `<expr>.filter(fn)` (or a const assigned from one) chained to `.toHaveLength(0)` /
  `.toEqual([])` / `.toStrictEqual([])`. Matches the pre-fix `ingest.t267.test.js` DoD-3b shape.
  Maker MUST run it against the full corpus and report the finding count; Governor decides
  blocking/advisory at synthesis (default blocking at zero findings). A genuinely-vacuous latent
  test it surfaces is REPORTED, not fixed here (scope). Cannot see: non-`.filter()` empties; tests
  with a padding companion expect; assertions in a called helper; `throw`-based emptiness checks
  (which is why detector B does NOT apply to the shape-5 `throw`-style scenario file — detector C
  covers that). Plant: a new `it(...)` whose only assertion is an absence-shaped filter check.
- **(C) `scripts/retiredSqlColumn.js` — BLOCKING** (`retired-column-in-sql-literal`). Denylist of
  the T293 v84-retired identifiers (`anchor_id`, `is_anchor`, `anchor_model`, `anchor_name`) —
  confirmed via `electron/db/localDb.js:4017-4049`. Scans tracked `*.js` **excluding
  `electron/db/**`** (migration/rollback machinery legitimately names these). A string/template
  literal is SQL-shaped if it contains (case-insensitive) `insert into`/`create table`/`alter table`;
  flag a denylisted name as a whole word inside one. Keyword gate kept narrow (no `UPDATE...SET`).
  Zero FP verified: every live occurrence of these names is under `electron/db/**`. A live-column
  diff from `schema.sql` was REJECTED — ALTER-added columns (`is_fixed_event`, `flags`, …) aren't in
  the CREATE TABLE text, so that approach false-flags correct names. Cannot see: future renames not
  in the denylist; names split across concatenation/interpolation; non-gated statements
  (`UPDATE...SET`); substring-only non-SQL occurrences. Plant: `19-retire-orphan-slots.automerge.js`
  INSERT column `is_fixed_event`→`is_anchor`.

Governor rulings on Architect's three open questions: (1) B targets blocking at zero clean-tree
findings, advisory only as a stated fallback; (2) C keeps the narrow 3-keyword gate; (3) A keeps
exactly the two curated callees, no opportunistic growth.

## Verifier verdict

PASS / FAIL / UNVERIFIED — <pending>

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average — , lowest dimension — . Pass is ≥ 4.0 with no dimension below 3.

## Findings carried forward

`vacuous-filter-assertion` fired on 57 pre-existing tests on the clean tree (2026-10-01) — each is a
test whose only `expect()` asserts a filtered/derived collection is empty, with no companion
assertion proving the positive path ran. Confirmed genuinely vacuous (not detector false positives)
by spot-checking several against their surrounding source. Added to `ADVISORY_CODES` rather than
fixed, per the ticket's BLOCKING-DECISION PROTOCOL (fixing 57 pre-existing tests is out of scope for
this gate-adding ticket). Full list (`npm run check:governance` reproduces it):

electron/auth/permissionsEntityParity.test.js:155, :171, :182, :190, :196 — electron/campDataRecord.test.js:155 —
electron/campDataRecordNotSynced.test.js:93 — electron/db/migrationDomainState.test.js:31, :36 —
electron/db/migrationWriteTrace.test.js:543 — electron/ipcSurfaceParity.test.js:183, :191, :226, :236, :357 —
electron/ops/mergeActivity.test.js:258 — electron/ops/projectionsCoverage.test.js:634 —
electron/ops/projectionsEntityParity.test.js:68, :79 — electron/ops/restore.test.js:114 —
electron/ops/slotOccupantCascadeParity.test.js:62 — electron/sync/automerge/transportBoundary.guard.test.js:74, :101 —
scripts/check-governance.test.js:450, :456 — scripts/preferenceSheetCli.test.js:556 —
scripts/security-gate.test.js:127, :132, :144 — src/data/scheduleRepository.test.js:548 —
src/engine/buildElectiveAssignments.test.js:1025 —
src/engine/buildSchedule.test.js:48, :105, :160, :517, :541, :581, :594, :605, :618, :1000, :1389, :1413, :1642 —
src/ingest/extractEntities.test.js:375, :382, :387, :393 — src/screens/schedule/dragHandlers.test.js:202 —
test/gatePredicates.test.js:77 — test/governance.test.js:79, :86, :157 — test/panelWorkbookTabs.test.js:191 —
test/preferenceCorpusNames.test.js:146 — test/unattributedSubjectIdentity.test.js:313, :322

## Decision

PASS / RETRY / ESCALATE — <pending>

> A Grader FAIL ends this loop and escalates to the worker; it does not become a round 2.
