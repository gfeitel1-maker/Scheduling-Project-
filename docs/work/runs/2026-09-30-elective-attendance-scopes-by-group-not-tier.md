---
task: "Elective attendance scopes by group, not just tier"
document_type: run
date: 2026-09-30
round: 2
status: pass
task_class: scheduling-engine
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets: [docs/work/tickets/T197-projection-and-export.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
selected_agents: [governor, architect, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: "No visual or interaction design. Two new finding messages were added, but they render through the existing findings list with no new component, layout, or token."
  - agent: tester
    reason: no-predicate
    note: "This change DOES alter director-visible copy, which normally routes to Tester. The states the two new messages appear in need a bespoke Electron camp - one whose preference sheet names a division that disagrees with the roster's group, or whose group carries the set nowhere. A Tester pointed at the :5200 browser mock cannot reach either, and this project has a recorded history of a Tester fabricating screenshots for a state it could not reach. Recorded as an OMISSION, not as coverage. The copy was reviewed by reading instead: Code Reviewer was briefed on it explicitly and returned two LOW findings, both fixed in the third Maker pass."
  - agent: security
    reason: not-applicable
    note: "No change to auth, secrets, PIN handling, the libp2p protocol, IPC handlers, or packaging. The one new data read uses the existing generic list handler under the existing explicit campers.read grant (electron/auth/permissions.js)."
deterministic_checks: [npm run verify]
human_gates: []
verdict: pass
completion_evidence:
  - commit a13417e4
  - commit 94e0a6b8
  - commit 3982357c
  - "gate: VERIFY PASSED — agents:check + check:governance + licenses:check + build + security + test:integration + lint + test all green; Test Files 621 passed (621), Tests 8364 passed | 10 skipped (8374)"
archive_when: T197's export-gap limits are all discharged and the ticket leaves docs/work/
---

# Elective attendance scopes by group, not just tier

Board item 8 — the remaining half of `i-t197-export-gaps-tier-occurrence-and-exceptions`. The
exception-bucket half shipped separately as T320 part 1 and is untouched here. Recorded as a defect
fix under T197's export gaps and T244/T248's occurrence model rather than as a new ticket; T197's
status is unchanged.

## The defect

An elective occurrence is keyed `(day, time_block, tier)`. Several **groups** of one tier placing
the set at one cell therefore collapsed into a single occurrence, and `buildAttendance` admitted a
camper to **every** occurrence of their matched tier. Nothing anywhere checked whether the camper's
own group's template actually carried the elective set at that day and block.

The consequence was visible in the T251 acceptance camp. On the generated route, `Older 1` carries
the elective set at Monday's elective period while `Older 2` carries Boating. Older 2's campers were
placed into the elective anyway, and `splitAroundBlocked` in `electron/ops/electiveRunOuterSchedule.js`
then correctly suppressed the inherited Boating span underneath the placement it should never have
had — one placement per block. The child export lost a real cell. The acceptance suite pinned this
as an explicit GAP against spec condition (6).

## What shipped

**A derived, never-persisted `group_ids` per occurrence.** `deriveOccurrences.js` already reads
`slot.group_id` on the line that reads the day, block and tier; it now accumulates the distinct
groups whose slots created or joined each cell and returns them sorted. The field is derived at
solve time and must never reach storage — both `elective_occurrences` writers build their row from
an explicit field list, and `deriveElectiveOccurrenceId` takes five explicit scalars, so nothing
spreads an occurrence object into a write. Verifier confirmed this by reading, not by inference.

**Attendance scoped by group.** `buildAttendance.js` lost its `distinctTierIds.size <= 1` fast path.
That path was the old rule wearing an optimization's clothes: it returned "attend everything"
whenever occurrences spanned at most one tier, and the acceptance camp's Older 1 / Older 2 shape is
*one tier*, so the shortcut alone would have preserved the bug in the exact case this item exists to
fix.

**The camper's group comes from the roster, not the sheet.** This was the round-1 blocker and the
most important thing the loop learned. The preference sheet's Division column names a *tier*
("Older"), never a bunk ("Older 2"), so `makeDivisionResolver` returns `groupId: null` and the
sheet can never answer "which group is this child in". `campers.group_id` is roster-owned — the
repository already says so in its own words in `electron/ops/commitElectiveRun.js`, which writes
`group_id: c.group_id ?? undefined` precisely so a sheet may SET a group it resolved and may never
CLEAR one it merely failed to resolve. The roster is now threaded `ScheduleElectivesScreen` →
`ElectiveSetDetail` → `AssignmentPanel` and joined onto the parsed campers at the solve call site
only, with the identical precedence: the sheet's own resolved group wins, the roster fills the gap,
the roster never overrides. It is deliberately **not** written back into `parsed`, because the
sheet-review surfaces must keep showing what the sheet actually said.

**Two disjoint diagnoses where the narrowing places nobody.** Narrowing eligibility created a new
way for a camper to vanish: `buildElectiveAssignments` only ever iterates campers per-occurrence, so
a camper who attends zero occurrences appears in no loop and no export, with no cause shown.
Constitution Art. V forbids exactly that. The third Maker pass splits the empty result into `noCells` (the
camper's group's own tier agrees with their division; the set simply is not offered to that group)
and `divisionMismatches` (the sheet's division and the roster's group disagree about which tier the
child is in). Reporting the second as the first is what Red Hat caught: it names the wrong group and
blames a rotation that was never the problem.

## The rule, as implemented

A camper attends an occurrence iff the occurrence's `tier_id` matches the tier their
`division_label` resolved to **and**, when their group is known, that occurrence's derived
`group_ids` contains it. A camper whose group is unknown — the sheet named only a tier and the
roster has no group either (T279 §12.2a) — keeps tier-wide admission. A camper whose division is
unmatched or ambiguous keeps owner rule R1 and is considered for every occurrence, still counted.
A camper who *was* correctly identified and whose group carries the set nowhere legitimately
attends nothing; that is not an R1 violation, never increments `unmatchedCount`, and is now named
to the director rather than absorbed.

## Rounds

`round: 2`, and the number needs saying plainly because there were **three Maker passes**. Article
VII bounds *review* rounds — Maker implements, the review agents run, Governor decides. The first
Maker pass never reached a review panel: it self-blocked and returned before any reviewer ran, so no
round was consumed. Review round 1 is the panel over `94e0a6b8`; review round 2 is the corrective
pass `3982357c` and the Verifier/Grader gate over it. The field is not rounded down to fit the enum
— the three passes are described below.

**Maker pass 1** implemented the derived field and the three-branch rule, then stopped and reported that
it could not honestly invert the acceptance test: with `group_id` sourced from the sheet, every
camper took the tier-wide fallback and the GAP persisted by the rule's own design. Refusing to write
an assertion it knew was false was the correct call, and it is why the roster question surfaced at
all. Governor re-verified every fact of the finding independently before accepting it.

**Maker pass 2** added the roster as the group source and inverted the acceptance test to a MET condition.

**Maker pass 3** answered Red Hat by splitting the two diagnoses and dropping the
`tierOccurrences.length > 0` guard, which also closed a silent case for group-resolved campers.

Three Maker passes rather than the customary two. Round 1 never reached a review panel — it
self-blocked — so the review loop itself ran twice, which is what Art. VII bounds.

## Findings for the board, not fixed here

- A director cannot correct a camper's bunk mid-import: leaving the screen to fix the roster
  unmounts it and discards the parsed sheet and every mapping decision. Pre-existing screen IA;
  Red Hat raised it and scoped it out itself.
- A camper with a **null** group_id whose matched tier has zero occurrences is still silent. That is
  the tier-wide fallback branch, untouched by this change.
- Regenerating a draft run created before this change now solves against the live roster and freshly
  derived `group_ids`, so it can narrow placements the original run had. Each mechanism is working
  as designed; the combination is not signalled to the director.
- `electron/ops/commitElectiveRun.js`'s `resolveWriteChoiceId` reads `group_id` from the same
  unenriched parsed campers the commit payload carries, so T301 bundle-tier routing still has this
  item's root cause on a different path. Predates this work.
- `buildElectiveAssignments`'s `attendance = null` "attend everything" default is now unreachable
  from its only production caller. Still a valid public-API default and still exercised by unit
  tests, so not dead code — but a reader could believe it is live in the solve path when it is not.

## Verdict

Grader: **pass**, average 4.3, no dimension below 3 (correctness 5, maintainability 4, resilience 4,
UX/copy 4, operational safety 4.5). Verifier: **PASS** on all three success predicates, including
two read-only checks — that `group_ids` reaches no persisted row or id derivation, and that the
inverted acceptance test guards against a vacuous pass and asserts a positive property rather than
an absence.
