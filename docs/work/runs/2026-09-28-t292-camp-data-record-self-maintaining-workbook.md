---
task: T292 — self-maintaining openable workbook of the camp's data (spec slices S1 + S2)
document_type: run
date: 2026-09-28
round: 2
status: pass
task_class: architecture
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/standards/DESIGN_STANDARD.md
  - docs/current/WHERE_DATA_LIVES.md
  - SECURITY.md
related_tickets: [docs/work/tickets/T292-database-document-view.md]
related_specs: [docs/work/specs/2026-09-28-t292-database-document-view.md]
related_adrs:
  - docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
selected_agents: [governor, designer, maker, verifier, security, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: "Spec section 3 doubles as the mini-ADR for where the hook lives (op-apply/projection seam); owner approved with recommendations. No new stored data shape, no changed contract — a read-only consumer of listEntities() plus filesystem IO. Architect concerns folded into the Maker brief and covered on risk by Red Hat."
  - agent: tester
    reason: no-predicate
    note: "Deliverable is a file on disk written by the main process, not an in-app screen (non-goal: no button, no grid). No director-facing UI to evaluate; correctness is deterministic (unit + integration) and adversarial (Red Hat)."
deterministic_checks: [npm run verify]
human_gates: []
verdict: PASS
completion_evidence:
  - "npm run verify exit 0 — all 8 steps green (/tmp/t292_verify4.log)"
  - "Verifier PASS: showstopper tests confirmed (campDataRecord 10/10, syncStarter 8/8, buildCampDataWorkbook 14/14)"
  - "Grader PASS: average 4.33, lowest dimension 4"
archive_when: "S1 + S2 shipped on branch claude/T292-database-document-view with a green gate and Grader pass; leaves docs/work/ when the owner confirms the file behaviour against the spec."
---

# Run: T292 — Camp data record, a self-maintaining openable workbook

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, updated as agents return.

## Brief

**Product outcome:** A director always has one file on their computer —
`~/Documents/Shoresh/<camp> data.xlsx` — that shows the camp's data as a
workbook, one sheet per thing, always current, with no button and no action.
Created when a camp first exists; refreshed automatically on every data change.

**Success predicate:** (spec §1) From the moment a camp exists the file exists
with no director action; after any camp-data change it reflects it on next open
(writes coalesced, not one-per-op); one sheet per director-facing entity with
human columns (app words, FKs as names, formatted dates/times), **no plumbing**
(ids, `*_id`, timestamps, bookkeeping/auth) and **credentials structurally
unreachable**; every cell through `aoaToSanitizedSheet`; a refresh failure never
blocks the real edit (best-effort, retried).

**What does not count as done:** an in-app grid or a download button (both
explicitly rejected); the enrichment round-trip (`exportWorkbook.js` — hidden
`shoresh_id`/`Status`/`_shoresh_meta` baseline); anything that can throw into or
block the op/write path; any sheet that emits an `id`/`*_id`/`client_write_id`/
credential/bookkeeping column.

## Task class and what it pulls in

`architecture` — attaches to the op-apply/projection seam and does filesystem IO
on every change.

| | |
|---|---|
| Standards | ARCHITECTURE_STANDARD, TESTING_STANDARD, DESIGN_STANDARD (§4 curation), SECURITY.md (no-leak seam), WHERE_DATA_LIVES (projection is a copy) |
| Mandatory gates | `npm run verify` (8 steps), `npm run check:governance`, `npm run index:work` |
| Human gate | none (owner already approved the spec + recommendations) |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing (this run, flat/direct — well-scoped, approved spec) |
| Architect | no | not-applicable — spec §3 is the mini-ADR; no new data shape/contract |
| Designer | yes | §4 sheet + column relabel vocabulary, empty states (DESIGN_STANDARD) |
| Maker | yes | build S1 pure builder + S2 refresh hook, test-first at the no-leak seam |
| Code Reviewer | yes | plan/spec fidelity + maintainability |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | no-predicate — deliverable is a file, no in-app UI to evaluate |
| Security | yes | no-leak seam (credentials unreachable), sanitizer routing |
| Red Hat | yes | non-blocking best-effort, coalescing never drops last change, atomic write |
| Grader | yes | consolidated score from the review reports |

## Round 1

Maker built S1 + S2 test-first; focused suites green (13/13 builder, 7/7 writer).
Parallel review found showstoppers the green tests missed (both suites mock/bypass
the real read seam and the real sync signals). Governor independently confirmed
each by reading the source:

- **CRITICAL (Code Reviewer):** `campDataRecord.js` routes `camps` through
  `listEntities`, but `camps` is in neither `DIRECT_CAMP_ENTITIES` nor
  `PARENT_SCOPED_ENTITIES` → `listEntities(db,'camps')` throws `Unrecognized
  entity: camps`; `fireOnce`'s try/catch swallows it → **the workbook is never
  written in the real app** (only in tests, which pass a hand-built `camps` array
  / mock `listEntities`). Confirmed: `DIRECT.has('camps')=false`, `'camps' in
  PARENT=false`.
- **HIGH (Red Hat):** incoming sync ops never trigger the writer. `notifyOpApplied`
  fires only from `write()`/`writeBulkReplace()` (localWriteClient.js:125,148 —
  local writes only); remote ops flow through `syncNode` `onRemoteOps`
  (syncStarter.js:301, after `projectAll`). And `fullSyncAppliedListeners` is
  pushed (localWriteClient.js:162) but **never invoked** — the hook is dead. So a
  receive-only device's file freezes. Contradicts spec §1.2.
- **HIGH (Red Hat):** no flush/dispose on quit → last debounced write dropped if
  the director quits within debounceMs. `will-quit` flushes Automerge but not this
  writer.
- **HIGH/MED (Red Hat):** `notifyOpApplied` fan-out has no per-listener try/catch;
  the writer's `schedule()` is registered AFTER the renderer-push listener, so a
  push throw starves the writer for that op.
- **MED (Red Hat):** `reinitialize()`/restore close the db without disposing the
  old writer → stale timer fires on a closed db.
- **MED (Red Hat + Code Reviewer):** `writing`/`pendingAgain` re-entrancy guard is
  dead code (fireOnce is fully synchronous, no yield point) — untested/false
  assurance; and the synchronous main-thread I/O can stall the app on a large camp.
- **LOW (Code Reviewer + Security):** the builder IS a genuine field allowlist
  (Security CONFIRMED, no-leak 5/5) but the no-leak *test* uses a denylist —
  harden to a structural check.

Security: 5/5 (no-leak seam, sanitizer routing, path-traversal all confirmed).
Red Hat resilience: 2/5. Code Reviewer: not-ready (green tests, broken feature).

Gate (`npm run verify`) not scored round 1 — the feature is non-functional
regardless; deferred to round 2 after the fixes.

## Round 1 decision: RETRY

Round-2 Maker brief dispatched with the seven fixes above.

## Round 2

Maker applied all seven fixes test-first (focused suites green: builder 14/14,
campDataRecord 10/10 incl. a REAL listEntities/camps integration test,
syncStarter 8/8 incl. the onRemoteOps trigger, main.test.js 193/193). Also fixed
a hazard it found: under VITEST, writes go to os.tmpdir() instead of the real
~/Documents. Governor read every fix diff and confirmed each:
- FIX 1 (CRITICAL): `camps` removed from ENTITY_NAMES; `entities.camps` built
  from the local `SELECT id, name FROM camps` row fireOnce already fetches; the
  Camp sheet still emits only `name`. Credentials doubly unreachable.
- FIX 2 (HIGH): syncStarter.js onRemoteOps → `getLiveHandlers()?.scheduleCampDataRecord?.()`
  (fires after projectAll; unconditional, even with no window). Dead
  onFullSyncApplied hook removed.
- FIX 3 (HIGH): synchronous `flush()` wired into `will-quit`.
- FIX 4 (HIGH): writer's onOpApplied listener registered first.
- FIX 5 (MED): `disposeCampDataRecord()` called before db.close() in
  reinitialize() and restore (liveHandlers still points at the OLD handlers;
  control flow fully synchronous, race-free by construction).
- FIX 6 (MED): dead re-entrancy guard removed; sync-write cost documented as an
  accepted tradeoff (no realistic camp approaches a problematic size).
- FIX 7 (LOW): no-leak test hardened to a structural /(^id$)|(_id$)|(_at$)/i check.

### Round 2 review dispositions
- **Security: 5/5** — re-review found no new vulnerability; credentials still
  structurally unreachable, no remote-controlled data reaches the builder/
  filename/path, VITEST redirect not production-exploitable, flush() fail-safe.
- **Red Hat: 4/5** — all five round-1 findings FIXED at the mechanism level
  (three with direct tests). One point docked for a TEST-COVERAGE gap: the
  will-quit flush wiring, the listener-order wiring, and the reinitialize/restore
  dispose wiring live in main.js integration code with no regression test — a
  future refactor could silently drop one. Not a reproducible bug. Carried
  forward as a follow-up.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| npm run verify (8 steps) | PASS (exit 0) | /tmp/t292_verify4.log: "✅ VERIFY PASSED — agents:check + check:governance + licenses:check + build + security + test:integration + lint + test all green" |
| check:governance | green | advisory only (platform-state-stale) |
| index:work | green | INDEX.md regenerated |

Note: the first gate attempt failed (exit 1) at the `security` step — the privacy
scanner flagged a fabricated camp name used in the test fixtures (23 findings, not a
vulnerability). Fixed by swapping to an allowlisted synthetic camp name; re-run
passed clean.

## Verifier verdict

**PASS** — raw gate `VERIFY_EXIT=0`, "✅ VERIFY PASSED" (all 8 steps). Both round-1
showstoppers confirmed fixed by running their tests:
- camps/listEntities seam: `campDataRecord.test.js` "fireOnce (via a real db + the
  REAL listEntities) never throws for any entity the writer reads" — 10/10; source
  confirms 'camps' not in ENTITY_NAMES, entities.camps built from the local SELECT.
- incoming-sync trigger: `syncStarter.test.js` "calls getLiveHandlers().
  scheduleCampDataRecord() when onRemoteOps fires" — 8/8; source confirms the
  onRemoteOps → getLiveHandlers()?.scheduleCampDataRecord?.() wiring.
- no-leak structural guard: `buildCampDataWorkbook.test.js` — 14/14.

## Grader score

**PASS** — average **4.33**, lowest dimension **4** (threshold ≥ 4.0, none below 3).
Spec fidelity 5, Security 5, Resilience 4, Maintainability 4, UX/legibility 4.

## Findings carried forward

- **Test-coverage gap (Red Hat, MEDIUM, not a bug):** the will-quit flush wiring,
  the writer-listener-order wiring, and the reinitialize/restore dispose wiring
  all live in `electron/main.js` integration code with no regression test — all
  three mechanisms are verified correct by direct reading, but a future refactor
  could silently drop one without a red build. Deferred as a post-merge follow-up
  (integration-test harness for these listener/lifecycle interactions).
  **RESOLVED (2026-09-28):** the will-quit flush and the reinitialize/restore
  dispose-before-close sequences were lifted out of the non-exported entry-point
  IIFE into two exported helpers (`flushCampDataRecordOnQuit`,
  `disposeCampDataRecordThenCloseDb` in `electron/main.js`) so the mechanism is
  behaviorally testable; the writer-listener order is reachable through
  `makeHandlers`. New suite `electron/campDataRecordWiring.test.js` (11 tests):
  a behavioral test that a throwing renderer-push does not starve the writer's
  `schedule()` (wiring 2), behavioral tests of the flush/dispose helpers incl.
  the dispose→close ordering (wirings 1, 3), and three structural checks that the
  call sites route through the helpers. Each guard was confirmed red against a
  planted defect (listener reorder, dropped flush, close-before-dispose, dropped
  call site) before revert.
- **Perf tradeoff (accepted):** the debounced write path is synchronous fs I/O on
  the main thread; documented in campDataRecord.js as acceptable at realistic camp
  sizes. Revisit only if a real camp's write time is shown to matter.

## Decision: PASS

Round 2 (final round) passes: green gate + Verifier PASS + Grader 4.33. Both
round-1 showstoppers fixed and covered by new tests. Shipped as commits on
claude/T292-database-document-view (PR #585); not merged — CI is the gate of
record and the owner merges on green.
