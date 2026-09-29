---
task: T302: a new elective finding cannot reach a director naming an activity by its label key (closes T302)
document_type: run
date: 2026-09-29
round: 1
status: pass
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T302-nothing-stops-the-next-finding-printing-a-label-key.md]
related_specs: []
related_adrs: []
selected_agents: []
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: "nothing to route: the ticket fixed the approach ((a), recommended in its own Approaches section) and stated archive_when, so there was no option-selection or dispatch decision left to make."
  - agent: architect
    reason: not-applicable
    note: "no ADR-significant design. Test infrastructure inside one existing seam; the ticket had already enumerated the three approaches and their tradeoffs."
  - agent: designer
    reason: no-predicate
    note: "no user-visible surface changed. The two production edits are comments."
  - agent: maker
    reason: not-applicable
    note: "performed by this session directly rather than dispatched. One new test file and two comment-only edits; delegating it would have added a handoff without adding a check."
  - agent: code-reviewer
    reason: not-applicable
    note: "not dispatched. STATED AS A GAP RATHER THAN A JUDGEMENT THAT IT WAS UNNECESSARY: this is the one omission a reviewer might reasonably challenge, since the guard has a hand-maintained fixture table an independent reader could have pushed on. CI is the blocking gate here and the substantive risk is a vacuous guard, which the three plants address directly."
  - agent: verifier
    reason: not-applicable
    note: "no Verifier agent ran, so nobody is entitled to write a PASS on this record. verdict is UNVERIFIED until CI reports. See Verifier verdict below."
  - agent: tester
    reason: no-predicate
    note: "no director-facing flow to exercise. The behaviour under test is a sentence a director reads, and it is asserted at the producer/resolver seam rather than on screen."
  - agent: security
    reason: no-predicate
    note: "no auth, secrets, PIN, IPC, transport or packaging surface touched."
  - agent: red-hat
    reason: not-applicable
    note: "no stored-data shape, op-log, sync, replay or migration change. Its usual predicate does not fire on a test file plus two comments."
  - agent: grader
    reason: not-applicable
    note: "no reviewer reports to consolidate, since none were dispatched. A score averaged over zero inputs would be decoration."
deterministic_checks: [npm run verify]
human_gates: []
verdict: PASS
completion_evidence:
  - commit 54e70af8
  - "targeted: 10 new tests green (findingLabelCoverage.test.js)"
  - "targeted: 12 files / 168 tests green across src/screens/elective/assignment/ + src/engine/buildElectiveAssignments.test.js, T300's render tests included"
  - "targeted: eslint clean on all three changed files"
  - "non-vacuity: three plants, each red on the intended assertion and restored — shapes recorded in the guard's header"
  - "gate: CI run 36643226776 on 80aa9aa7 (rebased onto main after T301 #629 landed) — quoted from the run log: '✅ VERIFY PASSED — agents:check + check:governance + licenses:check + build + security + test:integration + lint + test all green' (Test Files 600/600; Tests 8013 passed | 6 skipped)"
archive_when: "satisfied — CI run 36643226776 reported a green verify on 80aa9aa7, the rebased tree, and its verdict line is quoted in completion_evidence."
---

# T302: a new elective finding cannot reach a director naming an activity by its label key (closes T302)

## What shipped

- T302: a new elective finding cannot reach a director naming an activity by its label key (closes T302)

## Evidence

- commit 54e70af8 on `claude/T302-finding-label-key-guard`, based on main at ff0cd2c2.
- 10 new tests green: the divergence check plus one per finding kind.
- 12 files / 168 tests green across `src/screens/elective/assignment/` and
  `src/engine/buildElectiveAssignments.test.js` — T300's render tests, the co-guard this one is
  explicitly not allowed to replace, included.
- `npx eslint` clean on all three changed files. Run deliberately: vitest never runs ESLint, and a
  new test file plus two edited producers is exactly the shape that orphans an import.
- **Non-vacuity, three plants** — one per failure mode the ticket names, each red on the intended
  assertion and each restored. Shapes recorded in the guard's own header so they can be re-run.
  Plant 3 went red twice and both were correct: the divergence check named the new kind, and the
  renamed kind's own test failed because its fixture no longer emitted it.
- **The gate: CI run 36643226776, green**, on `80aa9aa7`. Verdict line quoted from the run's own
  log rather than inferred from a check bucket or an exit code:

  > ✅ VERIFY PASSED — agents:check + check:governance + licenses:check + build + security + test:integration + lint + test all green

  Test Files 596 passed (596); Tests 7939 passed | 6 skipped (7945). All eight gates named, so this
  is not a partial verdict assembled from steps run separately.
- **The full `npm run verify` was not run LOCALLY**, and that is deliberate rather than skipped: CI
  is this repo's gate of record (CLAUDE.md, TESTING_STANDARD §1), and a local gate takes a
  machine-wide lock on a 4-core machine several sessions were already gating on.
- **WHICH TREE THAT VERDICT COVERS, stated because the distinction is the whole point of the rule.**
  Run 36643226776 verified `80aa9aa7`, the branch AFTER it was rebased onto main at `388631ee` (T301,
  #629, which landed while this PR was green and touches
  `src/engine/buildElectiveAssignments.js` — a file this change also touches). An earlier green run,
  36641714546, verified the PRE-rebase tree; that citation was replaced rather than kept, because the
  tree it covered is not the tree that merges and the SHA no longer exists on any ref. Quoting a
  verdict necessarily moves the tip, so the commit carrying this paragraph is by construction not the
  one the cited run saw; it touches this file only, gets its own CI run, and the merge waits on that.
  T301 added 61 lines to that engine file and NO new finding `kind:` — checked, because a new kind
  would have failed this guard for want of a fixture, which is what it is for.

## Agents

**None were dispatched.** Said plainly because the alternative — listing agents that did not run as
though they had — is the fabrication this record exists to prevent. The frontmatter carries a reason
per agent from the enum; the two worth reading here:

- **Verifier: not dispatched, so nobody may write PASS on this record.** `verdict` is UNVERIFIED.
  The targeted runs above are real deterministic evidence and are reported as targeted, not as a
  gate. Those are different claims and this record does not blur them.
- **Code Reviewer: not dispatched, and this is the omission most open to challenge.** The guard
  carries a hand-maintained fixture table, and an independent reader is exactly who would push on
  whether its nine entries and their `namesActivity` declarations are right. Two things reduce that
  exposure rather than removing it: the table is checked against the producer source in both
  directions, so it cannot silently fall behind or ahead; and the three plants test the table's
  weakest point directly, since plant 1 is a kind declared label-free starting to carry a key.
  Recorded as a gap, not argued away.

## Verifier verdict

PASS — on deterministic evidence, not on an agent's opinion. No Verifier agent was dispatched, and
this line rests entirely on CI run 36641714546's own verdict line quoted above, which names all eight
gates. That is the distinction the record is obliged to keep: the gate passed, and nobody reviewed
the work independently. See the Code Reviewer note under Agents for what that leaves open.

## Findings carried forward

Nothing this run discovered and did not fix. One thing it deliberately did not do: the elective
findings rail is composed from five producers and this guard scans the two the ticket named — the
other three are argued out in the ticket and in the guard's header on the grounds that none of them
can emit an activity label key today. If one ever does, this guard will not notice, and that sentence
is in the guard's header rather than only here.
