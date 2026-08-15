---
task: M1 — create the locations entity (schema v32)
document_type: run
date: 2026-08-15
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: []
related_specs: [docs/work/specs/2026-08-15-camp-spatial-model-assessment.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md]
selected_agents: [governor, maker, verifier, red-hat, security, code-reviewer, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: design is settled in the accepted ADR; no new structural decision in M1
  - agent: designer
    reason: not-applicable
    note: M1 ships no UI (entity + migration + registries only)
  - agent: tester
    reason: no-predicate
    note: no running surface to evaluate in M1; Tester binds at M3 (setup screen)
deterministic_checks: [test, lint, build, integration]
human_gates: []
verdict: pass
completion_evidence: [docs/work/runs/gate-reports/2026-08-15-locations-m1-create-entity-r1.json, electron/db/locations.migration.test.js, electron/ops/restoreLocationRebind.test.js, electron/ops/locationsRegistries.test.js]
archive_when: M1 merged to main
---

# Run: M1 — create the locations entity (schema v32)

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1.

## Brief

**Product outcome:** Locations become a real thing the camp owns — a `locations` table with a name and
a capacity — with every existing free-text location string migrated into it, deterministically and
identically on every device. No UI yet; this is the foundation the capacity fix (M2) and the setup
screen (M3) build on.

**Success predicate:** schema v32 exists (`locations`, `activities.location_id`,
`week_location_exclusions`); a deterministic backfill migrates existing free-text strings into
`locations` rows and sets `activities.location_id`; `v32_down.js` rolls back losslessly for names; all
nine registries in the ADR carry the new entities; mock parity holds; and the three invariant tests
pass — **INV-1's two-db cross-device migration test is the non-negotiable one**. Verifier reports
test + lint + build + integration green.

**What does not count as done:**
- Any UI. That is M3.
- The engine capacity fix. That is M2 — M1 creates the entity and migrates data; it does **not** change
  `buildSchedule.js` enforcement yet (the engine keeps reading the frozen `activities.location` until
  M2 re-points it, so M1 is behavior-preserving for scheduling).
- A migration whose backfill ids differ across devices (INV-1). A green single-db test is not evidence;
  the cross-device two-db test is.
- Case-folding or merging near-duplicate location strings (Article V).

## Task class and what it pulls in

`database-sync` (spanning `architecture`) — per `GOVERNANCE_INDEX.md` this governs:

| | |
|---|---|
| Standards | relevant ADRs · `ARCHITECTURE_STANDARD.md` |
| Mandatory gates | **integration (mandatory)** · fresh-vs-migrated schema equivalence · test · lint · build |
| Human gate | ADR + migration/rollback plan — **satisfied** (ADR accepted, rollback in §Rollback) |

## Dependency — gap 16 (separate session)

The `permissions.ENTITIES` drift fix (gap 16 / INV-3 prerequisite) is running in a **separate local
session** (task_2dcd6e36). M1 must add **both** `locations` and `week_location_exclusions` to
`permissions.ENTITIES` **regardless of whether gap 16 has landed** — Maker ensures the two new entities
are present and correct on its own, rather than blindly copying the `week_activity_exclusions` template
(which is itself the bug gap 16 fixes). If both branches edit `permissions.js`, reconcile at merge; the
additions are independent and both must survive.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing, brief, gate synthesis |
| Architect | no | design settled in accepted ADR; no new structural decision |
| Designer | no | no UI in M1 |
| Maker | yes | writes the schema, migration, registries, invariant tests |
| Code Reviewer | yes | large slice; plan alignment + maintainability across many registries |
| Verifier | yes | always — runs test/lint/build/integration, sets the verdict |
| Tester | no | no running surface; binds at M3 |
| Security | yes | touches `permissions.ENTITIES` (an authorization surface) and migrates stored data |
| Red Hat | yes | **mandatory** — new stored shape, op-log participation, migration, the INV-1 cross-device hole |
| Grader | yes | consolidates the four opinion reports + Verifier into a score |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| lint | **RED — pre-existing, not M1** | `eslint .` exits 1 on 3 errors in `ingest.s4b.test.js`, `ReconciliationLedger.test.jsx`, `exportSanitize.test.js` — all byte-identical to `origin/main`, introduced 2026-08-08 (commits 481d166, 8768438). M1's 18 files are lint-clean. Governor to remove the 3 nits as disclosed janitorial cleanup so M1 lands green |
| test | running | full vitest `--no-file-parallelism`, top-level |
| build | pending | |
| integration | pending | `node test/integration/run.js` (scenarios 12 schema-migration, 17 second-device-domain-sync are the M1-relevant ones) |
| fresh-vs-migrated equivalence | GREEN (Maker + Code Reviewer confirmed) | `locations.migration.test.js` asserts columns, indexes, DDL text, whole table-set incl. journal, + idempotency twin |
| INV-1 two-db cross-device migration test | GREEN | `locations.migration.test.js:193-216` — two independent dbs, identical pre-state, byte-identical `locations.id` + `location_id`, 0 ops. Code Reviewer confirmed non-trivial |

## Opinion reports (in as of first pass)

- **Security: 5/5 — no vulnerabilities.** New entities get correct default-deny role grants; every write/list path (IPC + WS) routes through `authorize()`; migration uses bound parameters, crosses no new trust boundary; the non-replicated review journal holds nothing sensitive.
- **Code Reviewer: clean and faithful, no must-fix code defects, "would commit as-is."** Scope discipline exemplary (engine untouched, no UI, gap 16 left alone). Three findings — one resolved by Governor (below), two carried to M3.
- **Red Hat: pending.**
- **Verifier: pending (gates running).**

## Governor decision on Code Reviewer Finding 1 (D5 freeze phasing)

Accepted (rule 8). The ADR listed an app-wide "no code path writes `activities.location`" test as an
M1 item; it cannot pass in M1 because the free-text input persists until the M3 picker. **ADR amended**
to phase D5 enforcement: M1 lands the schema header comment + a migration-path no-write test (both
present); the app-wide test is **pinned into M3's definition of done** (ADR ticket table updated). No
product decision changed — this corrects an M1-vs-M3 scope overstatement.

## Findings carried forward (to M3)

- `location_migration_reviews` is populated only on the device that ran the migration over real
  activity data (typically the Host). M3 must not assume it exists on every device (Code Reviewer).
- The migration journal records a NULL-vs-declared-number as a `capacity_disagreement` (`[null,3]` →
  reads as `[1,3]`). M3 decides whether that reads as disagreement (kind a) or "was unlimited"
  (kind b) (Code Reviewer). Seeded capacity is correct regardless.

## Red Hat (in)

**Resilience 4/5 — no commit-blocker.** All stated invariants (INV-1/2/3, idempotency, fresh-vs-migrated,
sync wiring, capacity seeding, review kinds) hold under adversarial input. Two hardening fixes made in a
focused Maker pass (both in M1 files, tested, 18/18 green):
- Rollback `v32_down.js` now `COALESCE`s the frozen name so a dangling `location_id` no longer nulls the
  anchor (forward-safety for M3 delete).
- Backfill clamps negative declared capacity to 1 (`Math.max(1, …)`) so `locations.capacity` is never < 1.
Carried to M3: whitespace/Unicode near-duplicate detection; the journal-only-on-Host and NULL-vs-declared
presentation nuances (already pinned into the ADR's M3 row).

## Deterministic gates — pre-existing baseline reds isolated

First full run (pre-hardening): **test GREEN** (2540 passed/1 skipped, 173 files), **build GREEN**,
**lint RED (3 pre-existing)**, **integration 20/21** — the two M1-critical scenarios (12 schema-migration,
17 second-device-domain-sync) **PASS**; scenario 21 (ingest prior year) FAILS.

**Both reds proven pre-existing and main-wide, NOT M1 regressions:**
- **Scenario 21** — stashed all M1 changes (schema reverted, `location_id` gone) and it fails identically
  (`Missing expected exception: a colliding import throws`); restored M1 cleanly. Nothing in
  `4a8a038..origin/main` touches ingest/harness/scenario, so it is red on current main too. Invisible to CI
  because `npm run verify` = `lint && test && check:governance` (no integration). Tracked as its own task
  (task_4b81a1c2), not fixed in M1 (out of scope, main-wide, unknown root cause — possibly S1a stale
  expectation vs. real regression).
- **Lint** — 3 unused-var errors in `ingest.s4b.test.js`/`ReconciliationLedger.test.jsx`/`exportSanitize.test.js`,
  byte-identical to origin/main, introduced 2026-08-08. **Governor removed them as disclosed janitorial
  cleanup** (outside M1's feature scope) so the branch's `verify` lint goes green. A final authoritative gate
  run is in flight on the cleaned + hardened code.

## Rebase requirement (before merge, not before pass)

`origin/main` advanced 4a8a038 → 2d9244b while M1 was built. The range includes **ed5cdbc — the gap-16
fix (INV-3 prerequisite), now merged**, plus a new `electron/auth/permissionsEntityParity.test.js` drift
guard. M1 must be **rebased onto current main** so its two entities sit atop gap-16's additions and are
validated by the new parity guard. Rebase is an integration step for merge time (requires committing M1
first), held for owner direction per "commit only when asked."

## Final gates (authoritative, cleaned + hardened code)

| Gate | Result | Evidence |
|---|---|---|
| lint | **GREEN** | `LINT_EXIT=0`, 0 errors (13 pre-existing warnings). 3 pre-existing errors removed as disclosed cleanup |
| test | **GREEN** | `TEST_EXIT=0`, 2542 passed / 1 skipped, 173 files, all three invariant test files green |
| build | **GREEN** | `BUILD_EXIT=0` |
| integration | **20/21** | scenarios 12 (schema-migration) + 17 (second-device-domain-sync) PASS; only pre-existing scenario 21 red |
| fresh-vs-migrated equivalence | **GREEN** | asserted in `locations.migration.test.js` |
| INV-1 two-db cross-device | **GREEN** | Verifier independently reproduced + confirmed non-trivial |

## Verifier verdict

**PASS — for M1's own work (zero regressions).** Two facts, both stated (Art II rule 3): (1) M1 introduces
no new gate failure; the integration delta vs. the main baseline is zero — Verifier reproduced scenario 21's
failure with M1 stashed out and restored the tree byte-identical. (2) Absolute suite is 20/21 with one
pre-existing, separately-ticketed red (scenario 21), disclosed, not laundered into green. Every
success-predicate claim including INV-1 traces to a named passing assertion.

## Grader score

**PASS — 4.67** (Security 5, Red Hat 4, Code Reviewer 5). Lowest dimension 4 ≥ 3; Verifier PASS.
`decision_eligibility: PASS_ELIGIBLE`, no block rule fired. GateReport:
`docs/work/runs/gate-reports/2026-08-15-locations-m1-create-entity-r1.json`. Tester correctly omitted
pre-dispatch (no UI) — no completeness gap. Pre-existing scenario 21 does not mask into the PASS.

## Decision

**PASS.** M1 is complete and sound: schema v32, deterministic device-identical migration, lossless rollback,
all registries, three invariant tests, two Red Hat hardening fixes — all green, all four reviewers favorable,
Verifier PASS, Grader 4.67. Not yet committed (held for owner per "commit only when asked").

**Before merge (integration steps, owner-gated):**
1. Commit M1.
2. Rebase onto current `origin/main` (2d9244b) — brings in the gap-16 permissions fix (ed5cdbc) and the new
   `permissionsEntityParity.test.js` drift guard; reconcile the `permissions.js` overlap so M1's two entities
   sit atop gap-16's additions and pass the guard. Re-run gates post-rebase.
3. Open PR.

**Handed off (not M1's scope):**
- Scenario 21 pre-existing integration failure — task_4b81a1c2 (chip for owner).
- M3 forward-notes pinned into the ADR's M3 row: whitespace/Unicode near-duplicate detection; journal-only-on-Host;
  NULL-vs-declared review presentation; the D5 app-wide no-write freeze test.
