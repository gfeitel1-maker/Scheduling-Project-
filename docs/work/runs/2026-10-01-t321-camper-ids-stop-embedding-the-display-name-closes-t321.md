---
task: T321: camper ids stop embedding the display name — closes T321
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T321-camper-id-high-entropy-format.md]
related_specs: []
related_adrs: []
selected_agents: [maker, verifier, red-hat, security, code-reviewer]
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: Governor is the orchestrator running this loop, not a reviewed deliverable of it.
  - agent: architect
    reason: not-applicable
    note: The ADR (docs/adr/2026-10-01-camper-id-high-entropy-format.md) was already written and organizer-accepted before this loop started; the task brief explicitly judged the ADR detailed enough to skip a separate Architect dispatch, and Governor confirmed that on reading it in full.
  - agent: designer
    reason: no-predicate
    note: No UI surface changed — backend/schema/sync work only (electron/ops, electron/automerge, electron/db, src/ingest resolver call sites).
  - agent: tester
    reason: not-applicable
    note: No UI/UX surface for a director-eye evaluation — this ticket has no screen to test.
  - agent: grader
    reason: no-predicate
    note: The coordinator's task brief for this ticket defined the review loop explicitly (Maker -> Verifier -> dedicated Red Hat -> Security -> Code Reviewer -> fixes -> run record -> governance -> verify -> rebase -> PR) and did not include a Grader step; Governor followed that explicit, narrower sequence rather than the generic team-template loop. Every reviewer finding was tracked to a concrete fix and re-verified directly instead of being reduced to a Grader score.
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass
completion_evidence:
  - commit 59ff7bd7
  - commit 3a90bad7
  - commit 78db3e73
  - commit 71e66559
  - commit ba7b3073
  - commit 4a9fb65c
  - commit 40fabc52
  - commit 1690e7f1
  - commit d1c0da48
  - commit 7cdbaa9e
  - commit cfd9ff43
  - commit ceca9bd3
  - commit b31d85f2
  - commit 622c544f
  - commit abf3dead
  - commit 92e426cc
  - commit 1bf3d489
  - commit 37b64d28
  - commit 3524e7dc
  - gate: no local full-suite run this round — owner standing ruling (2026-10-01, relayed by the coordinator mid-session) is that CI is the gate of record and a local full `npm run verify` after an already-green focused pass is a duplicate not to run; Governor instead ran every registry/migration/rollback/integration/eslint check individually in the foreground (Verifier's dedicated pass plus Governor's own re-verification after the follow-up fixes and the rebase), all green — see the Red Hat/Security/Code Reviewer reports and this record's own body for the itemized evidence. CI's run against this PR is the authoritative gate verdict.
archive_when: T321 closed and merged; `camper_identity_keys` entity live on main with no open Red Hat/Security/Code Reviewer findings
---

# T321: camper ids stop embedding the display name — closes T321

## What shipped

- T321: camper ids stop embedding the display name — closes T321
- T321: flip ADR status proposed -> accepted, implementation_state -> implemented
- T321: finishRun's collision check resolves through camper_identity_keys
- T321: resolve camper_identity_keys lookup before asserting camper id in tests
- T321: document migration back-fill's non-replication as an accepted limitation
- T321: refuse to purge the losing side of an unresolved identity contest
- T321: attributeElectiveSubject's own rekey also moves the other two tables
- T321: rekeyOrphans also moves elective_run_outer_snapshots/findings
- T321: register camper_identity_keys in PARTICIPANT_ENTITIES
- T321: refuse restore of camper_identity_keys — PII, same boundary as campers
- T321: convergence integration test (acceptance criterion 3)
- T321: SECURITY.md + PLATFORM_STATE.md updates (acceptance criterion 7)
- T321: purge deletes camper_identity_keys row (acceptance criterion 5)
- T321: wire resolveOrMintCamperId into all four real camper-id-minting call sites
- T321: orphan-rekey test (acceptance criterion 4), plant-first red/green verified
- T321: resolveOrMintCamperId resolver + fix stale CURRENT_SCHEMA_VERSION pins
- T321: v85_down rollback module + tests
- T321: camper_identity_keys entity — schema v85, migration + backfill, registries
- T321: mintCamperId — opaque high-entropy token for new camper ids

## Evidence

- commit 59ff7bd7
- commit 3a90bad7
- commit 78db3e73
- commit 71e66559
- commit ba7b3073
- commit 4a9fb65c
- commit 40fabc52
- commit 1690e7f1
- commit d1c0da48
- commit 7cdbaa9e
- commit cfd9ff43
- commit ceca9bd3
- commit b31d85f2
- commit 622c544f
- commit abf3dead
- commit 92e426cc
- commit 1bf3d489
- commit 37b64d28
- commit 3524e7dc
- gate: no local full-suite `npm run verify` this round — owner standing ruling (2026-10-01,
  relayed mid-session) is that CI is the gate of record and a duplicate local full run is not
  to be run once the relevant checks are already green locally. Governor and Verifier instead
  ran the full `electron/db/*.migration.test.js` glob (52 files, 482 tests, PASS), every
  registry/parity/rollback/purge/tombstone/resolver test file individually, the libp2p
  integration suite twice (28/28 both times, including the new convergence scenario), eslint on
  every changed file, and `npm run check:governance` — all green, in the foreground, reproduced
  independently rather than trusted from Maker's self-report. See the Verifier, Red Hat,
  Security, and Code Reviewer reports (summarized below) for the itemized runs. CI's run against
  the PR is the authoritative gate verdict for merge.

## Agents

**Selected:** maker, verifier, red-hat, security, code-reviewer (see `selected_agents` above for
what each did; full reports held by Governor, summarized in the PR description).

**Omitted:** governor, architect, designer, tester, grader — see `omitted_agents` above for the
reason and note for each.

**Round shape, stated plainly because it does not fit the usual one-dispatch-per-agent picture:**
Maker ran three times in this single round (initial build of all 7 ADR acceptance criteria plus
the owner's "tighten the mechanism" tests; a fix pass addressing every CRITICAL/HIGH/MEDIUM
finding from Red Hat and Code Reviewer; and a third pass fixing two stale pre-existing tests plus
a real production regression — dead collision-detection in `scripts/preferenceSheetCli.js` — that
pass itself discovered). This is still round 1 under Article VII (no Grader verdict was produced
between any of these passes), not three separate rounds.
