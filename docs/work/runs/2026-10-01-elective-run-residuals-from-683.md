---
task: Residuals from #683 — the tier-blind join, raw camper ids, and a response-only finding
document_type: run
date: 2026-10-01
round: 2
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_tickets: []
related_specs: [docs/work/specs/2026-09-25-t250-run-state-surface.md]
related_adrs: [docs/adr/2026-09-30-elective-run-durability.md, docs/adr/2026-09-29-linked-elective-bundles.md]
selected_agents: [governor, architect, maker, verifier, red-hat, code-reviewer, security, tester, grader]
omitted_agents:
  - agent: designer
    reason: no-predicate
    note: "no new screen, component or visual idiom. The only copy that changed is a degraded fallback sentence, written to match wording the owner already reviewed in #683 (\"a camper who is no longer on the roster\"). The one copy QUESTION this loop raised (identical repeated bullets) is recorded below as an open owner decision rather than redesigned here."
  - agent: architecture-auditor
    reason: not-applicable
    note: periodic audit agent; runs independently of this loop, not per-diff.
  - agent: security-assessment
    reason: not-applicable
    note: "periodic, threat-model-level agent, explicitly not per-diff (Constitution Art. VI). Security (per-diff) ran instead, across both this PR's range and the #684 code the organizer added to scope."
  - agent: design-auditor
    reason: not-applicable
    note: invoked by the /design-audit skill, not by this loop.
deterministic_checks: [test, lint, build, integration, governance, security, licenses, agents]
human_gates:
  - "ESCALATED, NOT DECIDED — Security's HIGH on #684's second commit: a purged camper's id survives in cleartext in elective_assignment_runs.snapshot_digest. This contradicts a guarantee stated in SECURITY.md, which is a listed Constitution Art. IV stop (\"Code found to contradict a standard\"). The fix has several shapes with different migration consequences. Not fixed here; see \"Open, escalated\" below."
  - "ESCALATED, NOT DECIDED — the acceptance pin lands at 1, not the 0 the board brief asked for. The brief's stated premise (duplicate same-label rows mis-binding) is measurably false; the residue is a different defect. Forcing the number would have meant a contract change on a false premise."
verdict: pass
completion_evidence:
  - commit 340cafd9  # item 1 — buildPreferenceLookup derives tier from the run's own assignment rows
  - commit 67e0d943  # item 2 — no raw camper UUID at any run-screen sibling site
  - commit 6331e422  # item 3 — persist BUNDLE_TIER_NOT_COVERED through elective_run_findings
  - commit 6b48c0e0  # round 2 — F1 mismatch identity, F2 null-label copy, F3 tier derivation, F5 guard
  - commit c6211d96  # round 2 — F4 tripwire pin, F6 FALLBACK-numbering comment cleanup
  - gate: see "Gate verdict" below
archive_when: the elective run seam's assignment-to-preference join is next substantially reworked
---

# Residuals from #683

Three scoped fixes at the elective-run seam, plus a read-only re-read of #684's
second commit that the organizer added to scope mid-loop.

## What shipped

**(1) The tier-blind read-side join.** `buildPreferenceLookup`
(`src/screens/elective/run/camperElectiveWeek.js`) called
`resolvePreferenceCoordinates` without `tierIdByCamperId`, while the solve/commit
path passed it. Where two tiers hold an occurrence in the same (day, period) cell,
the tier-blind fallback bound a camper's preference to whichever occurrence sorted
first — the wrong tier — and the occurrence-aware join missed. It now derives the
tier from the run's own assignment rows (row → occurrence → `tier_id`), which is
the tier the solver actually used rather than a second reading of the roster. The
resolver itself is untouched: it was already correct when given the information.

**(2) Raw camper ids.** #683 fixed only the instance it introduced. The same class
survived at the dangling-placement rows, the placement table, three `aria-label`s,
and `listRunCampers` — which is FinalRunView's vector, via `CamperWeekPanel`. All
now degrade to one exported `UNKNOWN_CAMPER_LABEL` rather than three copies of a
string literal.

**(3) `BUNDLE_TIER_NOT_COVERED` persists.** It lived only in the commit response,
so a cold-reopened draft showed no grouped bundle rows at all. It now writes to
`elective_run_findings` through a loop parallel to `SHEET_CAMPER_WITHOUT_PREFERENCE`
— deliberately not inside the `ELIGIBILITY_FINDING_KINDS` loop, which gates the
engine's own `solverFindings` — and is read back, generation-filtered, with the
label recovered by a `LEFT JOIN` on `elective_choices`. **No new column.**

This is classed `database-sync`, whose human gate is "ADR + migration/rollback plan".
No migration or rollback plan is filed because there is no schema change to migrate:
the only diff to `electron/db/schema.sql` is comment text, `localDb.js` and
`electron/db/rollback/` are untouched, and the table, its columns and its rollback
(`v83_down.js`) already exist under
[`docs/adr/2026-09-30-elective-run-durability.md`](../../adr/2026-09-30-elective-run-durability.md)
item 4. That ADR gained a dated note recording that this kind writes through a
parallel loop rather than `ELIGIBILITY_FINDING_KINDS`, and why `tier_id` is not
persisted; its status and decision are unchanged. Verifier confirmed the absence of
a schema or migration diff rather than taking it on assertion.

## What the loop caught that the tests did not

Round 1 ended with Verifier PASS, 327 green tests, lint clean and a clean
governance run. Red Hat and Code Reviewer then independently confirmed four defects
in that green tree, three of them agreed by both:

1. **The merge Map dropped real findings.** `DraftRunView`'s bundle-mismatch merge
   keyed on `camper_id` alone, so a camper with two distinct mismatches collapsed to
   one — a scenario the write side's own test pins as supported.
2. **The literal string `"null"` reached a director.** For an assignment-only
   mismatch `choice_id` is null by design, so the label join recovers nothing and
   the sentence read `"null" does not cover Seniors`.
3. **The tier derivation could be poisoned.** Its comment justified first-row-wins
   with "a camper is only ever placed in their own tier's occurrences". That premise
   is denied in this repo's own code: `electron/ops/setElectiveAssignment.js` states
   that division/tier attendance is not checked. A manual foreign-tier placement
   sorting first poisoned the camper's whole week — and Red Hat traced it past a
   wrong label to a wrong WRITE, the edit affordance offering ADD where the director
   meant CORRECT.
4. **The UUID guard did not describe what it caught.** A real sheet-ingested camper
   id is a composite derived string, not a bare UUID; the guard worked only because a
   `camp_id` UUID happens to be embedded in it.

## The round-2 fix had its own defect, caught before commit

Worth recording because it is the same class as the bug it was fixing. The first
F1 key was `camper_id::choice_id ?? label ?? ''`. The session finding's label is the
raw labelKey and the persisted one's is null, so for an assignment-only mismatch the
two copies of **one** mismatch keyed differently and rendered as two rows — one
naming the bundle, one degraded. A regression against the key it replaced. Found by
reading the uncommitted diff, corrected to `camper_id::choice_id ?? ''`, and pinned
by a new test that went red at length 2 before going green.

This was a Governor-directed correction inside round 2, not a third round.

## Deliberately not fixed

**F4 — an assignment-only mismatch persists with no identity.** It is the single
root cause behind the null label, the merge residual, and a derived-id collision
that silently loses one of two mismatches. The obvious fix — pre-scanning
assignments so a flat choice is minted — is not a bugfix: a non-null choice would
also flow into the assignment loop's `choice_id`, which an earlier round deliberately
set to null to close a real outage, and it would move the acceptance numbers. Pinned
instead by a tripwire test that reproduces the collapse and states what the correct
value becomes, following the idiom the acceptance pin already uses.

## Open, escalated — for the owner

1. **The acceptance pin is 1, not 0.** Measured both ways: `origin/main` reports 4,
   this tree reports 1. The three rows the brief described were the tier-blind join.
   The fourth is a different defect — a linked-bundle preference binds to the cell
   where its label appears on the sheet while the bundle's assignment is anchored at
   another occurrence of the same bundle. Closing it needs a new read of
   `elective_choice_offerings` in `getElectiveRun` plus a field threaded through three
   call sites — a contract change, on a premise the board brief got wrong. Reported
   rather than forced.
2. **#684's erasure gap (Security HIGH).** See the human gate above. Not reachable
   through the app's UI or IPC today; it is live, replicated at-rest state. The
   denylist comment claiming it "covers every camper_id-bearing table in the schema"
   is now false, and has been left visibly false rather than tidied, so the owner sees
   the real state.
3. **A copy question.** With several unresolvable campers, a disclosure reads
   "2 campers" expanding to two identical bullets. True, and useless. Collapsing it is
   a terminology/copy judgement, which Art. IV reserves for the owner.

## Evidence

One real frame, captured against the dev mock and reviewed by the Governor
personally: `docs/work/evidence/board-elective-residuals/scene1-draft-run-mismatches-and-sheet-only.png`.
It is distinguishing — it shows the fallback wording in three separate surfaces and
two distinct grouped bundle rows ("Ropes", "Climbing"), which is the F1 fix
rendering. The Tester could not reach the cold-reopen comparison or the finalized
run (Playwright navigation timed out) and said so rather than inferring from source;
that is the correct answer here, and the reason it is worth stating is that two
earlier Tester runs in this repo were rejected for fabrication. Items 2 and 3 are
otherwise covered by render tests, not by frames.

Note that the dev mock is not the real stack: nothing about persistence under
Electron, auth, or sync is verified by that frame.

## graphify

The repo graph (`~/dev/shoresh/graphify-out/graph.json`, built 2026-09-18) returns
"No unique node match" for `resolvePreferenceCoordinates()`, `buildPreferenceLookup()`
and even `commitElectiveRun()` — this module family is unindexed, so the result is an
abstention, not an answer, and was not read as one. Blast radius was established by
`grep -rn` sweeps over `electron/`, `src/` and `test/` instead, and each reviewer
derived its own regression file list rather than inheriting the Maker's.

## #684 second-commit re-read

Added to this PR's scope by the organizer: Security and Code Reviewer had never seen
the per-camper erasure-aware completeness digest
(`electron/ops/electiveRunSnapshotCompleteness.js`) or its single write site
(`electron/ops/finalizeElectiveRun.js`).

**Security — one HIGH, escalated, not fixed.** `computeExpectedSnapshotDigestByCamper`
builds a per-camper map whose **keys are raw camper ids**, `JSON.stringify`s it, and
stores it in `elective_assignment_runs.snapshot_digest` — a replicated projection
field. `elective_assignment_runs` is absent from `TOMBSTONE_DENYLISTED_ENTITIES` and
from `purgeCamperRecord`'s delete set, and `seedAllFromSqlite` rebuilds the fresh
post-purge document from SQLite, so a purged camper's id is carried into the document
that is described as purged-clean and re-synced fleet-wide. The digest *value* is a
one-way hash and is not the problem; the map *key* is. Confirmed independently by the
Governor by reading all four sites. Clean on everything else checked: corrupt peer
digests fail closed with no SQL or copy path, the single write site is genuinely
single and inside `requireAuthorized`, and nothing leaks through IPC today.

**Code Reviewer — one LOW, fixed here.** `FALLBACK 1` and `FALLBACK 3` with no
`FALLBACK 2`, reading as though a branch had been deleted; the branches are now named
rather than numbered. Everything else held up, with a specific checklist: single write
site confirmed by grep, no duplicated serialization rule, the field-arrival-order race
handled as its own case, the "never silently complete" posture symmetric, and
erasure-awareness reading the same `tombstones` fact the projector's denylist reads
rather than a second definition.

## Gate verdict

The full `npm run verify` verdict line for the final rebased tree is recorded in the
pull request description, together with CI's result — which is the gate of record for
merging.
