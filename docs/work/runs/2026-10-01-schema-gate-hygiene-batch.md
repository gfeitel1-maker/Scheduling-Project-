---
task: "T324/T325 — schema-check whole-family gate + Verifier binding local-bar gap-closure (board q-schema-bump-family-self-maintaining, q-verifier-binding-ci-is-the-gate)"
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T324-schema-check-whole-family-gate.md, docs/work/tickets/T325-verifier-binding-local-bar-is-not-full-verify.md]
related_specs: []
related_adrs: []
selected_agents: [governor, maker, code-reviewer, red-hat, verifier]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: no schema/module-boundary design decision — a new npm script globbing existing test files, one literal-pin fix following an established precedent pattern, and a doc-binding edit
  - agent: designer
    reason: not-applicable
    note: no UI surface in the footprint
  - agent: tester
    reason: not-applicable
    note: nothing a camp director can see changes; the whole footprint is build tooling, test files, and governance docs
  - agent: security
    reason: not-applicable
    note: no auth/secrets/PIN/LAN-protocol/IPC surface touched
  - agent: grader
    reason: human-waived
    note: "orchestrator ran this as direct Maker dispatch + Code Reviewer/Red Hat round, not a full Governor loop with a Grader consolidation — per the dispatch-discipline note below"
deterministic_checks: [schema:check, check:governance, lint, test]
human_gates: []
verdict: pass
completion_evidence:
  - "npm run schema:check (post-fix, broadened family) — 94 test files, 874 tests passed + 9 skipped (883 total), all green, 222.61s"
  - "npx vitest run --root <worktree> scripts/schemaCheck.test.js electron/automerge/purgeCollateral.test.js electron/db/rollback/bareEqualityRollback.guard.test.js electron/db/peerTombstoneReports.migration.test.js — 19 tests, all green, re-run after the round-1 fixes"
  - "schemaCheck.test.js proven non-vacuous twice: (1) initial pass — temporarily removed the electron/ops/*[Pp]arity*.test.js glob, drift-guard test went red naming the missing file, restored green; (2) round-1 fix pass — ran the two newly-required integration fixtures (electiveAcceptanceFixture, ingestPassExclusivity) standalone under plain vitest run to confirm they need no multi-node harness before adding them to the family (34 tests, green)"
  - "npm run check:governance — 0 blocking findings (1 pre-existing platform-state-stale advisory, unrelated to this batch), re-run clean after all round-1 edits"
  - "npm run agents:check — all 13 profiles + manifest report match, re-run after node scripts/generateAgentProfiles.js --write regenerated .claude/agents/verifier.md from the reconciled binding"
  - "npx vitest run --root <worktree> test/governance.test.js — 42/42 green, re-run after all round-1 edits (frontmatter/link-integrity on both tickets and this run record)"
archive_when: "the next schema bump (v87+) lands with a single npm run schema:check CI round instead of a one-red-per-forgotten-file pattern, and no Verifier round in the following month defaults to the full npm run verify without the Governor brief naming it"
---

# Run: schema-check whole-family gate + Verifier binding local-bar gap-closure

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.

## Brief

**Product outcome:** a schema bump (the next one past v86) costs one CI round, not one red per
forgotten test file in the family — the v84/v85/v86 pattern this batch closes. Separately, the
Verifier's own binding stops defaulting to the full ~13-minute local gate when CI already re-runs
the identical steps on every PR.

**Success predicate:**

1. `npm run schema:check` exists, runs the entire schema-sensitive test family in one invocation —
   genuinely schema-sensitive, not merely filename-matched — and a drift guard fails if a glob stops
   matching a real family member.
2. The one remaining bare schema-version-literal pin added after #711's sweep
   (`electron/db/peerTombstoneReports.migration.test.js`) reads `CURRENT_SCHEMA_VERSION` instead of
   a literal `86`, matching the precedent `camperIdentityKeys.migration.test.js` (v85, #711) already
   established — with the per-migration historical pin (`schema_migrations WHERE version = 86`) left
   untouched.
3. The `bareEqualityRollback` and `purgeCollateral` guards' failure messages name the exact
   file/constant to edit when they fire.
4. `CLAUDE.md` documents `schema:check` as the required pre-push step for `electron/db/**`/
   `schema.sql` changes, honestly describing actual membership.
5. `docs/governance/agent-bindings/verifier.md` states the Verifier's default local bar is
   touched-file tests + conditional `schema:check` + unconditional `check:governance`/`lint`, with
   the full `npm run verify` and the `build`/`test:integration` steps run only when a Governor
   brief names them or a specific failure is being iterated on — stated as ONE coherent policy, not
   contradicted by older bullets elsewhere in the same file. `.claude/agents/verifier.md` is
   regenerated (never hand-edited) to match.

**What does not count as done:**

- Weakening any per-migration historical version pin (`schema_migrations WHERE version = N`,
  `v78_down.test.js`'s `.toBe(77)` after rollback, bounded `WHERE version <= N` checks) — those are
  correct forever and the brief explicitly forbids touching them.
- Changing `TESTING_STANDARD.md`'s gate list or order — this is a Verifier-binding alignment to what
  that standard and `CLAUDE.md` already say, not a standards change.
- A family glob that matches by filename convention ("*.migration*") rather than by actually being
  schema-version-sensitive — this is exactly round 1's Red Hat HIGH finding.
- A full `npm run verify` run as this batch's own evidence — out of scope by instruction; CI is the
  gate of record and the focused gates above are what this run cites.

## Task class and what it pulls in

`database-sync` (schema/migration test infrastructure), spanning `documentation-governance` for
T325's binding edit. Per `WORK_RECORD_STANDARD.md` §4, the stricter gate list from both applies.

| | |
|---|---|
| Standards | `TESTING_STANDARD.md` · `CONSTITUTION.md` |
| Mandatory gates | `schema:check` (new, this batch) · `check:governance` · `lint` · focused `test` |
| Human gate | none — no constitution/standard text changed, no shared-harness/gate-budget edit |

## Orchestration note — why this ran as direct Maker dispatch, not a full Governor loop

**Twice tonight, a Governor subagent parked after backgrounding its Maker child instead of running
it synchronously/foreground, each time costing a long stall.** That is why this batch was run as
direct Maker dispatch (with Code Reviewer and Red Hat review rounds, but no Grader consolidation)
instead of a full Governor loop — not a judgment that the work didn't warrant the loop. This is a
note only: `docs/governance/agent-bindings/governor.md` is **not edited** in this batch. Whoever
next touches that binding should see this and enforce the foreground-Maker dispatch discipline
there (the binding should make backgrounding its own Maker child and parking on a notification an
explicit anti-pattern, the same way `verifier.md` already tells Verifier never to background the
suite it is judging).

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing/orchestration note above |
| Architect | no | `no-predicate` — no schema/module-boundary design decision |
| Designer | no | `not-applicable` — no UI surface |
| Maker | yes | implementation, round 1 and the in-round fix pass below |
| Code Reviewer | yes | found FINDING 2 (MEDIUM — contradictory verifier-binding policy) |
| Verifier | — | gates run and cited directly as `completion_evidence`, synchronously, in place of a dispatched Verifier round |
| Tester | no | `not-applicable` — no director-visible surface |
| Security | no | `not-applicable` — no auth/secrets/IPC/LAN surface |
| Red Hat | yes | found FINDING 1 (HIGH — SCHEMA_FAMILY_GLOBS missed schema-sensitive files) and corroborated FINDING 2 |
| Grader | no | `human-waived` — no full loop this round; two confirmed review findings were resolved in-round instead |

## Round-1 review findings and their fixes

**FINDING 1 (Red Hat, HIGH — defeats the item's core claim).** `SCHEMA_FAMILY_GLOBS`'s
`electron/db/*.migration*.test.js` matches only the literal `.migration` filename substring, so it
silently omitted five `electron/db/*.test.js` files that actually import
`CURRENT_SCHEMA_VERSION`/`getSchemaVersion` (`eraMigration.test.js`, `migrationDomainState.test.js`,
`migrationWriteTrace.test.js`, `projectManager.test.js`, `testDbTemplate.test.js`), plus
`src/engine/fixtureSchemaParity.test.js` (the fresh-vs-migrated schema parity guard, deliberately
under `src/engine/` to keep the engine pure) and two integration-suffixed fixtures
(`electron/electiveAcceptanceFixture.integration.test.js`,
`electron/ingestPassExclusivity.integration.test.js`). **Fix:** broadened the glob from
`electron/db/*.migration*.test.js` to `electron/db/*.test.js` (keeping the rollback/ops-parity/
ipcSurfaceParity/purgeCollateral globs as-is), and added the three explicitly-named files. Verified
the two integration fixtures run cleanly standalone under plain `vitest run` (34 tests, no automerge
multi-node harness needed) before including them, and documented them in the script's own comment
as a deliberate inclusion rather than leaving them silently unaccounted for.
`scripts/schemaCheck.test.js`'s `mustInclude` list now names all eight newly-required files so the
drift guard enforces their presence going forward. `npm run schema:check` re-run and confirmed
all-green with the broader set: 94 files / 874 passed + 9 skipped. `CLAUDE.md`'s `schema:check` line
rewritten to describe actual membership honestly rather than "*.migration*".

**FINDING 2 (Code Reviewer MEDIUM + Red Hat MEDIUM corroboration — contradictory binding).** The new
"default local bar" paragraph in `docs/governance/agent-bindings/verifier.md` contradicted
pre-existing bullets further down the same file that still said `npm run build` "always" for
schema/dependency/import changes and `node test/integration/run.js` "mandatory" for sync/auth/schema
changes — and read as an exhaustive 3-item list rather than a floor. **Fix:** reconciled into one
coherent policy — the default-bar paragraph now says explicitly it is a floor, not a replacement for
the bullets below it; the old `build`/`test:integration` bullets were rewritten to say both are part
of the FULL gate CI already runs on every PR, run locally only when the Governor brief names them or
a specific failure is being iterated on, never reflexively because the change "touches
schema/sync/auth" — while preserving the original epistemic rule that an unverifiable
integration-only claim is reported UNVERIFIED rather than assumed covered by a future CI run.
Regenerated via `node scripts/generateAgentProfiles.js --write`; `npm run agents:check` confirms
byte-identical.

**Organizer standing-rule addition (not from a reviewer, folded into the same commit-2 edit set):**
`npm run check:governance` is now stated as an UNCONDITIONAL pre-push gate in both
`docs/governance/agent-bindings/verifier.md` (explicitly distinguished from being merely item 3 of
the default-bar list) and `CLAUDE.md` (a new pre-push line) — it runs before every push, regardless
of what changed, no exceptions. Basis: four reds landed in one day that were one-second run-record/
frontmatter findings this check catches locally in under two seconds.

## Item (1) of the organizer's original batch — VERIFIED-NO-CHANGE

The organizer's batch also named a third item: the `electron/sync`+`db` **anchor** identifier
remainder. That item is classified **VERIFIED-NO-CHANGE** — every remaining hit for `anchor` in
that surface is one of:

- a load-bearing historical table/column name migration and rollback code depends on verbatim
  (`anchor_activities`, `anchor_id`, `anchor_model`) — renaming the string breaks the migrations
  that reference it by that exact name, for no behavior change;
- "trust anchor" security terminology, an unrelated and correct sense of the word.

Zero safe renames were found. Per-sense counts (`grep -rn '\banchor' electron/sync electron/db`,
case-insensitive, this tree): historical table/column identifiers — the majority of hits, all in
`localDb.js` migration blocks, `schema.sql`, and the `*.migration.test.js`/`rollback/*.js` family;
"trust anchor" security-sense hits — the remainder, confined to `electron/sync/automerge/`
docstrings and variable names describing the mutual-auth trust model. This matches and confirms
#713's closing scope (T323, "Rename retired fixed-event 'anchor' identifier/comment remainder to
fixed-event vocabulary") — #713 already renamed every safely-renameable comment/identifier
remainder; what's left is exactly the load-bearing and security-sense set this verification found.

## What was built

- `scripts/schemaCheck.js` + `scripts/schemaCheck.test.js` (new, broadened in-round per Finding 1) —
  the whole-family runner and its drift guard; `package.json` gained `schema:check`/
  `preschema:check`.
- `electron/db/peerTombstoneReports.migration.test.js` — two literal `86` assertions rewritten to
  `CURRENT_SCHEMA_VERSION`, with the same explanatory comment `camperIdentityKeys.migration.test.js`
  carries for the identical fix.
- `electron/db/rollback/bareEqualityRollback.guard.test.js` — the file-count assertion now names
  what to do when a new `vNN_down.js` lands.
- `electron/automerge/purgeCollateral.test.js` — the core drift-catcher assertion now names the four
  bucket constants and the file to edit.
- `CLAUDE.md` — the `schema:check` line rewritten to describe actual membership (Finding 1), plus a
  new unconditional `check:governance` pre-push line (organizer addition).
- `docs/governance/agent-bindings/verifier.md` — "default local bar" section reconciled into one
  coherent policy with the rest of the file (Finding 2), plus the unconditional-`check:governance`
  statement (organizer addition); `.claude/agents/verifier.md` regenerated to match.
- `docs/work/tickets/T324-*.md`, `docs/work/tickets/T325-*.md` (both `status: completed`).

## Gates

| Gate | Result | Evidence |
|---|---|---|
| `npm run schema:check` (post-fix) | **pass** | 94 files, 874 passed + 9 skipped (883 total), EXIT=0, 222.61s |
| `scripts/schemaCheck.test.js` non-vacuity | **pass** | round 1: planted glob removal → red naming the missing file, restored → green. In-round: confirmed the two new integration fixtures run standalone before adding them |
| touched-file focused suite (post-fix) | **pass** | 19 tests across the 4 directly-edited test files, EXIT=0 |
| `npm run check:governance` (post-fix) | **pass** | 0 blocking; 1 pre-existing unrelated advisory (`platform-state-stale`) |
| `npm run agents:check` (post-fix) | **pass** | all 13 profiles + manifest `match` |
| `npx vitest run --root <worktree> test/governance.test.js` (post-fix) | **pass** | 42/42 green |

## Verifier verdict

**PASS** — every named gate above exits 0, each reproduced in this session rather than assembled
from a prior claim, re-run after both round-1 findings were fixed. No `npm run verify` run; out of
scope by instruction, CI is the gate of record.

## Grader score

Not run this round — `grader` human-waived; two confirmed review findings (Red Hat HIGH, Code
Reviewer MEDIUM + Red Hat MEDIUM corroboration) were resolved in-round instead of via a full
Governor-loop Grader consolidation.

## Findings carried forward

- **Governor binding's dispatch discipline is a real gap**, named above, not fixed here by
  instruction. The next session touching `docs/governance/agent-bindings/governor.md` should enforce
  foreground-Maker dispatch explicitly.
- `docs/current/PLATFORM_STATE.md` is stale per `check:governance`'s pre-existing advisory, unrelated
  to this batch's footprint.
- Both round-1 findings above (schema-family glob breadth; verifier-binding policy coherence) are
  **fixed, not carried** — see "Round-1 review findings and their fixes".

## Decision

**PASS.** Not pushed, no PR opened, per instruction — orchestrator reviews, gates, and pushes.
