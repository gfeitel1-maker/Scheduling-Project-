---
task: 2A — a persisted label_key keeps two null-choice_id bundle mismatches for one camper distinct through commit, rekey, and cold-reopen display (q-elective-finding-id-collision-rekey-safe)
document_type: run
date: 2026-10-02
round: 1
status: pass
task_class: scheduling-engine
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T301-linked-elective-choices-never-reach-the-solver.md]
related_specs: [docs/work/specs/2026-10-02-elective-run-mismatch-null-identity-and-anchor-design.md]
related_adrs: [docs/adr/2026-09-30-elective-run-durability.md, docs/adr/2026-09-19-multi-device-erasure-propagation.md]
selected_agents: [governor, maker, verifier, red-hat]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: the design is fixed by the organizer-accepted design note (#719) and the organizer's explicit split ruling (schema column + id discriminator + rekey sites); no new architectural decision.
  - agent: designer
    reason: not-applicable
    note: no UI layout change — the display fix is a grouping/count correctness fix that reuses existing copy.
  - agent: tester
    reason: not-applicable
    note: no running-app UX distinct from what the Node tests pin, and no Electron/libp2p here to drive; the cold-reopen path is exercised by the rekey + grouping tests.
  - agent: code-reviewer
    reason: human-waived
    note: the organizer scoped this item's independent review to "Red Hat on the rekey seam" (2026-10-02, carrying owner-delegated authority), consistent with the owner pacing budget (route the lowest capable review, cut duplicate gates).
  - agent: security
    reason: human-waived
    note: same organizer review-scoping; no auth/secret/PIN/sync-protocol change. label_key carries the canonical label key only, into the already name-free, host-local elective_run_findings table; choice_id stays null, so the T318 erasure/outage posture is unchanged.
  - agent: grader
    reason: human-waived
    note: the board loop gate is "Verifier PASS + the written reviews + CI green" (standing organizer ruling); the Grader is not run as a routine gate.
deterministic_checks: [npm run schema:check (x2), electron/ops/commitElectiveRun.bundleChoices.test.js, electron/ops/attributeElectiveSubject.rekeyDependents.test.js, electron/db/rollback/v87_down.test.js, electron/db/localDb.migrations.test.js, src/screens/elective/run/runStateCopy.test.js, electron/ops/getElectiveRun.test.js, npm run lint, npm run check:governance]
human_gates: []
verdict: PASS (pending CI as the gate of record)
completion_evidence:
  - commit 9a67076b (schema v87 label_key + id discriminator + write + both rekey sites)
  - commit c23b0aa7 (Red Hat HIGH read-side fix: disclosure groups by label_key + dedupes campers)
  - schema:check green twice (95 files, 879 passed); F4 tripwire flipped 1->2; new cold-reopen rekey tripwire green; display split/dedupe tests red-before-green
archive_when: CI green on #722 and the two mismatches observably survive commit, rekey, and cold-reopen display
---

# 2A — rekey-safe finding identity for assignment-only bundle mismatches

Builds the 2A fix the organizer split out of q-elective-residuals-round-2 (parts 1A+2B
shipped in #720). Two assignment-only `BUNDLE_TIER_NOT_COVERED` findings for one camper
on two different bundle labels both carry `choice_id: null` — the deliberate T318 outage
behaviour (`f6c4014a`/#663), **unchanged here** — so their derived finding id was
identical and the second collapsed into the first, lost on cold reopen (the F4 known
defect). Because `elective_occurrences` has no `activity_id`, the two labels can share an
occurrence, and the id is re-derived on camper re-attribution from persisted columns
only — so the discriminator had to be persisted.

## What shipped

- **Schema v87** — nullable `elective_run_findings.label_key` (`schema.sql` + a guarded
  `>= 86 && < 87` idempotent ALTER in `localDb.js`; `SCHEMA_ONLY` in
  `migrationDomainState.js`; rollback `v87_down.js` + test; `projections.js` registers the
  field; `MOCK_WRITE_ALLOWLIST` + the durability column-order test updated;
  PLATFORM_STATE `schema_version` doc-fact 86→87).
- **`deriveElectiveRunFindingId`** — an optional 7th `labelKey` component appended **only
  when non-null**, with **no version bump**: `join` is length-prefixed and injective over
  variable-length component lists, so every finding without a labelKey (every non-bundle
  kind, and the ranked case where `choice_id` already disambiguates) keeps a byte-identical
  id and no row is orphaned.
- **Write + rekey** — `commitElectiveRun` carries `labelKey` on the mismatch record,
  persists `label_key`, and passes it to the id (the assignment/preference WRITE loops are
  untouched; `choice_id` stays null). Both camper-rekey sites (`attributeElectiveSubject`,
  `camperIdentityResolver`) select and re-pass `f.label_key`, so the id is stable across
  re-attribution.

## Red Hat (rekey seam) — one HIGH, fixed; everything else confirmed clean

Red Hat confirmed the DB/rekey layer: both rekey sites carry `label_key` through SELECT →
id → write; the no-version-bump injectivity holds; `choice_id` stays null (T318 intact);
the v87 guard/rollback/projection/classification are correct.

It caught one real **HIGH**: once both findings survive, the cold-reopen disclosure
exposed a pre-existing grouping weakness as a *visible* regression — `getElectiveRun`'s
finding read did not carry `label_key`, and for an assignment-only mismatch `choice_id` is
null so the LEFT-JOIN label is null, so `groupBundleTierNotCoveredFindings` keyed both
findings on `[null, tier]`, collapsed them, and pushed the **same camper twice** → "2
campers" where one child is affected by two bundles (before 2A this was an invisible
undercount; after, a visible overcount). Fixed read-side: `getElectiveRun` selects
`label_key`; the disclosure keys on `[label, label_key, tier]` and dedupes campers by id —
so one camper hit by two bundles reads as two rows, one camper each. Red-before-green
against the old `[label, tier]` key.

**Accepted residual** (organizer-confirmed): pre-v87 rows have `label_key` null and already
lost their colliding finding at pre-fix write time — unrecoverable (the lost row's label was
never stored), but harmless (nothing left to re-collide) and self-healing on the next run
regenerate, which re-commits with `label_key` set.

## Part (3) of q-elective-residuals-round-2 — closed here

The #685 Governor's residual (3) was a copy defect: with several unresolvable campers a
disclosure read "2 campers" expanding to **two identical bullets** — true and useless. That
is the same double-count this PR's Red Hat read-side fix removes: the disclosure now groups
by `label_key` and dedupes campers, so one camper is named once and two distinct bundles
read as two rows rather than one row with a repeated bullet. Organizer 2026-10-02:
"the Red Hat read-side fix also closes part (3)'s duplicate-bullet copy defect" — **part
(3) is done**, no separate DraftRunView copy change needed.

## Evidence

- `npm run schema:check` green twice (95 files, 879 passed | 9 skipped) — before push.
- `commitElectiveRun.bundleChoices.test.js` F4 tripwire flipped `toHaveLength(1)` →
  `toHaveLength(2)` (both rows persist); `attributeElectiveSubject.rekeyDependents.test.js`
  new tripwire — two null-choice_id mismatches for one camper, both survive the re-attribution
  after a cold reopen. Both red-before-green (ran red before the write/rekey/id edits).
- `runStateCopy.test.js` — the split-by-label_key and dedupe tests, red-before-green against
  the old `[label, tier]` key; `getElectiveRun.test.js` selects `label_key`.
- `npm run lint` 0 errors; `npm run check:governance` no blocking findings. CI is the gate
  of record.
