---
task: "board item 9b — i-t301-bundle-preference-and-choice-id-gaps (five defects, incl. two T318 fold-ins)"
document_type: run
date: 2026-09-30
round: 2
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets: [docs/work/tickets/T301-linked-elective-choices-never-reach-the-solver.md, docs/work/tickets/T318-a-run-names-the-day-and-never-invents-a-rank.md]
related_specs: []
related_adrs: [docs/adr/2026-09-29-linked-elective-bundles.md, docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
selected_agents: [governor, architect, maker, code-reviewer, red-hat, tester, verifier, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: no new or changed UI surface; the single director-visible change is one finding string, which Tester reviewed as copy.
  - agent: security
    reason: no-predicate
    note: "nothing touches auth, PIN handling, secrets, the libp2p transport, packaging, or any IPC surface shape; no new handler, no authorize() change, no new entity needing PROJECTIONS registration. The only added SQL is camp-scoped reads of the device's own single-camp db. Grader scored the omission's soundness 5."
  - agent: design-auditor
    reason: not-applicable
    note: no UI sweep in scope; this is a write-path and parser item.
  - agent: architecture-auditor
    reason: not-applicable
    note: periodic audit agent, does not plug into this loop.
  - agent: security-assessment
    reason: not-applicable
    note: periodic, not per-diff; no milestone touching auth, sync, wire protocol, or the transport boundary.
deterministic_checks: [npm run verify, "npx vitest run --no-file-parallelism electron/electiveAcceptance*", npx eslint, npm run check:governance, npm run agents:check, npm run build, npx vitest run no-literal-nul.test.js]
human_gates: []
verdict: pass
completion_evidence:
  - commit f26495c1
  - commit 3d67e98d
  - commit 7825b793
  - commit 0b267042
  - "gate: ✅ VERIFY PASSED — agents:check + check:governance + licenses:check + build + security + test:integration + lint + test all green (exit 0)"
  - "grader: 4.17 average, no dimension below 3 (spec 5, maintainability 4, UX 3, security 5, operational 3, evidence 5)"
archive_when: T301 is closed
---

# Board item 9b — bundle preference and choice_id gaps

## What shipped

Five verified defects in the elective-bundle preference path, all in T301's seam.

1. **A bundle can now be preferred by its own name.** `buildPreferenceCatalog`
   (`src/ingest/preferenceImport.js`) accepts `bundles` and merges their names into the catalogue's
   `activities`, and `scripts/preferenceSheetCli.js` — which hand-rolled a second catalogue — now
   calls that one function. Both doors read bundles camp-wide, so they cannot resolve against
   different sets.
2. **A linked choice's `choice_id` reaches `elective_assignments` in a tier-divisioned camp.** A new
   pure module, `electron/ops/camperElectiveIdentity.js` (`makeCamperIdentityResolver`), holds one
   definition of the sheet/roster/tier precedence rule established by #670 — the sheet sets, the
   roster fills, the roster never overrides — plus division→tier resolution ahead of group→tier.
   `commitElectiveRun` and `AssignmentPanel` both consume it.
3. **A preference row is no longer dropped.** A camper a bundle's tier scope genuinely does not
   cover keeps their ranked row, bound to a flat choice minted on demand for that label, *and* still
   produces `BUNDLE_TIER_NOT_COVERED`. Both halves — Art. V, surface never absorb.
4. **`setElectiveAssignment` binds the right per-tier choice** by resolving from
   `elective_choice_offerings` on `(occurrence_id, activity_id)`, with the label map as a fallback
   restricted to choices that have no offerings rows.
5. **`resolvePreferenceCoordinates` binds per-cell preferences to the camper's own tier's
   occurrence**, falling back to first-at-cell when the tier is unknown.

Closing these switched on linked-choice clustering in the exports end to end for the first time, so
five acceptance-suite assertions that pinned the old behaviour were **inverted to MET, not deleted**
(commit `7825b793`), and a stale explanation left behind by that pass was corrected (`0b267042`).

## Evidence

- `f26495c1` — the fix and its tests
- `3d67e98d` — the one director-visible string corrected (it said the ranking was kept "instead of
  as part of the set"; the thing it is not part of is the *bundle*)
- `7825b793` — five acceptance-suite gaps inverted to MET
- `0b267042` — stale `unordered_count` rationale corrected, plus a sweep for other drifted citations
- Gate: `✅ VERIFY PASSED — agents:check + check:governance + licenses:check + build + security +
  test:integration + lint + test all green`, exit 0
- Acceptance suite 72/72; Governor independently re-ran it and independently reproduced one
  non-vacuity plant (4 tests red on reverting the fix).

## Agents

**Ran:** Governor (routing, ruling, independent verification), Architect (design; invoked
`codebase-design`, declined `adhd` with a stated reason and contradicted the brief's premise on
defect 4 — the offerings table answers exactly, so no camper-tier inference is needed there),
Maker (four passes), Code Reviewer, Red Hat, Tester, Verifier, Grader. Omissions and their
reasons are in the frontmatter.

**Governor rulings recorded here because they are judgement, not mechanism:**

- **No new ADR.** `docs/adr/2026-09-29-linked-elective-bundles.md` D6 says a plain choice is minted
  "only for a label no bundle claims", which defect 3 narrows. D6 was written on the premise that a
  camper's tier is always derivable and does not adjudicate the uncovered-tier case at all; it also
  explicitly defers the UI/copy consequence to slice 3 as out of its own scope. A dated amendment
  note was appended beneath D6 rather than editing it. **The owner may overturn this.**
- **Red Hat's two HIGH findings were downgraded after Governor traced them independently** — see
  "Known limits" in T301's ticket.

## Round 2

Round 1 ended with Verifier FAIL on one step of nine. Governor traced all five failures rather than
routing them back verbatim: every one was mechanically forced by the fix closing a gap the
acceptance suite had pinned (three self-declared `GAP —` tests; two whose own comments stated they
were exact "because this camp produces no linked cluster"). Round 2 inverted them and corrected a
stale rationale the inversion pass left behind.
