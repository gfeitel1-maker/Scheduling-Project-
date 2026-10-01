---
task: A finalized run's digest map no longer carries a purged camper's id (board digest-keys-privacy)
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: security-auth
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
  - SECURITY.md
related_tickets: []
related_specs: []
related_adrs:
  - docs/adr/2026-09-30-elective-run-durability.md
selected_agents: [governor, architect, maker, verifier, security, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: no user-visible surface changes; the defect and its fix are entirely in a replicated stored value (elective_assignment_runs.snapshot_digest) and in three documents, and nothing reachable through the UI changed appearance or behaviour.
  - agent: tester
    reason: no-predicate
    note: nothing is reachable via UI or IPC today — the defect was found by reading the stored field, not by using the app — so there is no director-facing flow to walk; the one user-visible invariant (erase a camper, export still succeeds and excludes them) is pinned mechanically by electiveRunSnapshotErasure.test.js's two-device tests, which Verifier ran.
deterministic_checks:
  - npm run verify
  - npx eslint on the five changed JS files
  - npx vitest run electron/ops/electiveRunSnapshotCompleteness.test.js electron/ops/electiveRunSnapshotErasure.test.js test/governance.test.js
human_gates:
  - gate: CONSTITUTION.md Art. IV — contradiction with SECURITY.md
    outcome: escalated and ruled before this run began; the owner's standing position "privacy before public" applied and the ruling was to fix it.
verdict: PASS
completion_evidence:
  - commit 4faf80c4
  - 'gate: ✅ VERIFY PASSED — agents:check + check:governance + licenses:check + build + security + test:integration + lint + test all green (642 files, 8652 passed | 10 skipped)'
archive_when: superseded by a change to camper-id minting that makes every creation path high-entropy, which is what would close the confirmation oracle this record documents as a known limit.
---

# A finalized run's digest map no longer carries a purged camper's id (board digest-keys-privacy)

## What shipped

`computeExpectedSnapshotDigestByCamper` keyed its per-camper map on the raw
`camper_id`. That map is stored in `elective_assignment_runs.snapshot_digest`, a
replicated TEXT field on the run row — correctly in neither
`TOMBSTONE_DENYLISTED_ENTITIES` nor `purgeCamperRecord`'s delete set, because it
is the run, not camper data — and `seedAllFromSqlite` carries the field into the
fresh post-purge document. A purged camper's id therefore survived in cleartext,
fleet-wide, contradicting SECURITY.md's camper-record-purge guarantee. The hash
values were never the problem; the keys were.

Keys are now `sha256(run_id + ':' + camper_id)`, run-scoped so one camper's hash
cannot be correlated across two runs. The read side hashes each held row's
`camper_id` and each tombstoned camper's id the same way. Three read branches,
not two: a legacy plain-hex digest still compares whole-set; a per-camper map
whose keys are not all 64-hex (the raw-id shape written in the dev-only window
between #684 and here, no live users) is treated exactly like legacy whole-set
and never erasure-aware; an all-hex-keyed map takes the erasure-aware path. No
migration, no schema change.

## The correction the review round forced

An earlier draft of the ADR amendment justified the unkeyed hash by asserting
`camper_id` is a `randomUUID()` with 122 bits of entropy. Security and Red Hat
independently found that false: on the elective-sheet import path
`deriveCamperId` returns a length-prefixed concatenation — its own comment says
"NOT a hash" — embedding the canonicalized display name, which
`commitElectiveRun.js` writes as `campers.id`.

The hash is still the right shape. Every device must recompute the key from a
`camper_id` it holds in order to subtract an erased camper, so any derivation a
device can perform a camp peer can perform; an HMAC's key would have to be
replicated to stay recomputable, and no fleet secret survives a genesis rebuild.
The confirmation oracle is structural, not a weakness of sha256. SECURITY.md,
the ADR amendment and the `digestMapKey` comment now say so plainly: this is
guess-resistance, not erasure, and closing it would require a camper-id format
change well outside this work. Recorded as a known limit rather than implied
away.

## Evidence

- commit 4faf80c4
- gate: ✅ VERIFY PASSED — agents:check + check:governance + licenses:check + build + security + test:integration + lint + test all green (642 files, 8652 passed | 10 skipped)
- Verifier: PASS on all six success predicates, with a red-before-green plant on
  a scratch copy — with raw-id keys the load-bearing test fails (`['c1','c2']`
  found in the stored map), with hashed keys it passes. 111 tests green across
  the two touched files and 14 dependent files; `test/governance.test.js` 40
  green; eslint clean.
- Grader: 4.4 average (Spec Fidelity 5, Security 4, Resilience 5,
  Maintainability 4, Test Quality 4), PASS.

## Agents

Ran: Governor, Architect (read-only design note, confirmed the shape and caught
that `computeExpectedSnapshotDigestByCamper` needed a `runId` parameter because
the derived rows do not carry `run_id`), Maker (test-first), Verifier, Security,
Red Hat, Code Reviewer, Grader. Designer and Tester were omitted for the reasons
recorded in the front matter.

Every reviewer ran read-only; the red-before-green plants were the Verifier's,
on scratch copies. Graphify abstained for this module family (MCP server failed
to connect this session; the graph is stale since 2026-09-18), so every
blast-radius claim in this run rests on grep sweeps, stated as such in each
report.
