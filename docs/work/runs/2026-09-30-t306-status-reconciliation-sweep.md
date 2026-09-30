---
task: "Board item q-t306 — STATUS RECONCILIATION SWEEP: flip every ticket whose work merged but whose frontmatter status never moved"
document_type: run
date: 2026-09-30
round: 2
status: pass
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets:
  - docs/work/tickets/T209-rendezvous-worker-phase-a.md
  - docs/work/tickets/T215-libp2p-3x-upgrade.md
  - docs/work/tickets/T217-libp2p-3x-residual-findings.md
  - docs/work/tickets/T222-update-on-open.md
  - docs/work/tickets/T237-attention-rows-open-the-reconciliation-flow.md
  - docs/work/tickets/T260-name-key-acquisition-failure.md
  - docs/work/tickets/T261-ci-minutes-duplicate-main-runs.md
  - docs/work/tickets/T278-import-agnostic-elective-preferences.md
  - docs/work/tickets/T279-preference-etl-canonical-record-and-residue.md
  - docs/work/tickets/T281-remembered-axis-binding-per-camp.md
  - docs/work/tickets/T284-mixed-version-replication-unenforced.md
  - docs/work/tickets/T286-join-secret-hardening.md
  - docs/work/tickets/T287-v2-encrypted-record.md
  - docs/work/tickets/T299-identical-submissions-are-not-one-camper.md
  - docs/work/tickets/T304-a-staff-session-can-see-what-the-import-left-unnamed.md
  - docs/work/tickets/T305-a-whole-sheet-planner-grid-imports-through-the-panel.md
  - docs/work/tickets/T306-the-director-can-name-an-unnamed-submission.md
related_specs: []
related_adrs: [docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md]
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no schema, contract or module boundary changes — this run edits only documents under docs/
  - agent: designer
    reason: not-applicable
    note: no UI surface in scope; nothing under src/ is touched
  - agent: tester
    reason: not-applicable
    note: nothing is observable in the running app; the deliverable is frontmatter and prose
  - agent: security
    reason: not-applicable
    note: no auth, secret, IPC, wire-protocol or packaging surface is touched; the security-auth tickets in scope are being read, not changed
deterministic_checks: [test, lint]
human_gates:
  - "Any clause of an archive_when that this run finds genuinely unmet and owner-gated stays open with a stated residual rather than being adjudicated here (CONSTITUTION.md Article IV — a product-judgement question)."
  - "The owner's mixed-version ruling is applied verbatim; no ADR status is changed, because amending an accepted ADR is a human gate."
verdict: pass
completion_evidence:
  - "npm run check:governance — exit 0, 'check:governance — no findings.' (status-drift ran; no skip line)"
  - "npx vitest run test/governance.test.js — exit 0, 39/39 including link integrity"
  - "npm run agents:check — exit 0, all generated profiles byte-identical"
  - "npx vitest run test/callerDeclaredArrival.test.js test/preferenceEtlResolve.test.js — exit 0, 38/38 and 57/57, matching the counts the closure notes claim"
  - "npm run index:work then git status --porcelain docs/work/INDEX.md — empty; the committed index matches"
  - "git diff --name-only origin/main..HEAD — 20 paths, every one under docs/; no .js changed, so eslint is not applicable"
  - "commit 086079d2 — closes-list extracted by the gate's own regex equals the ten flipped tickets in both directions, keyword repeated per ID, on exactly one commit"
archive_when: "the board (docs/work/INDEX.md) no longer lists as open any of the thirteen tickets whose work is on origin/main, every ticket left open carries a stated reason, and the branch's gates are green"
---

# Run: board item q-t306 — status reconciliation sweep

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** the board tells the truth. A person opening `docs/work/INDEX.md` sees as open
only work that is actually outstanding, and every ticket still listed open says in one line what is
outstanding about it. Today thirteen tickets whose work is merged on `origin/main` still read `open`
or `in-progress`, so the board over-reports the remaining queue — and, worse, a reader cannot tell
which of those thirteen are stale labels and which are genuine residuals.

**Success predicate:** on this branch, every one of T209, T237, T260, T261, T278, T279, T284, T286,
T287, T299, T304, T305 and T306 either

- reads a closed `status` (`completed`, `closed`, or `wont-fix`) **and** carries a dated closure
  note citing the pull request that discharged its `archive_when`; or
- is left `open`/`in-progress` **and** carries a one-line stated reason naming the undischarged
  `archive_when` clause;

and additionally: T284 reads `wont-fix` carrying the owner's mixed-version ruling verbatim;
T215, T217 and T222 keep their existing `closed` status and gain a dated one-line note recording
that same ruling as the reason their mixed-version leftovers are declined; T281 is resolved against
what T312 (#648) actually shipped; the T250 description in `docs/current/PLATFORM_STATE.md` reflects
what #667 shipped; `docs/work/INDEX.md` is regenerated by `npm run index:work`; this record is filled
in; and the final commit's subject carries `closes T<n>` for **exactly** the set whose status this
change flips.

**What does not count as done:**

- Flipping a ticket whose `archive_when` still has an undischarged clause — a premature `completed`
  is a false claim the next reader inherits (`WORK_RECORD_STANDARD.md` §3.3).
- Flipping a ticket whose body carries a `Remaining` / `stays open` / `Known limit at close` section
  that names an `archive_when` clause as outstanding. The disqualifier is usually in the body, past
  the success predicate, not in the frontmatter.
- Paraphrasing, trimming or tidying the owner's ruling. It is quoted verbatim or it is not used.
- Hand-editing `docs/work/INDEX.md` (it is generated; `WORK_RECORD_STANDARD.md` §6).
- Deleting reasoning to make a field fit (§2).
- Any change outside `docs/`. No ticket number is taken and no schema version is taken by this run.
- A `closes T<n>` in the commit subject for a ticket left open — that fires `status-drift`, which is
  the gate working.

## Task class and what it pulls in

`documentation-governance` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `GOVERNANCE_INDEX.md` · `CONSTITUTION.md` · `docs/governance/standards/WORK_RECORD_STANDARD.md` (§2, §3.1–3.3, §5, §6) |
| Mandatory gates | link + reference check (`npx vitest run test/governance.test.js`) · `npm run check:governance` |
| Human gate | any change to a constitution or standard — therefore **out of scope by construction**: this run changes no standard and no ADR status |

The full `npm run verify` and `npm run test` are deliberately **not** run here. They are ~11 and
~17 minutes and CI is the gate of record (`CLAUDE.md`, `TESTING_STANDARD.md` §1); a docs-only change
touching nothing under `src/`, `electron/` or `scripts/` cannot move the test, build or integration
gates. Verifier is scoped to the named checks above plus `npm run agents:check`, `npx eslint .` if
any `.js` file changed, and greps proving the flipped set equals the commit subject's closes-list.
Per `feedback_never_assemble_a_gate_verdict`, this is stated plainly as **a scoped set of named
checks, not an equivalent of the wrapper** — there is no `✅ VERIFY PASSED` line in this run's
evidence and none is claimed.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing, the brief, this record, the pass/retry/escalate decision |
| Architect | no | `not-applicable` — no schema, contract or module boundary is touched |
| Designer | no | `not-applicable` — no UI surface; nothing under `src/` changes |
| Maker | yes | the only agent that writes; here it writes documents |
| Code Reviewer | yes | spec fidelity: is every flip justified by a discharged `archive_when`, is every quote verbatim, is no reasoning deleted |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | `not-applicable` — nothing observable in the running app |
| Security | no | `not-applicable` — no auth, secret, IPC, wire or packaging surface changes |
| Red Hat | yes | the central risk of this run is a *false* closure; Red Hat's job is to name which flip a next reader would inherit as untrue |
| Grader | yes | calibrated score over the three opinion reports |

Every one of the ten appears here. An omission needs a reason from the enum; "seemed unnecessary"
is not one, it is a rule 8 challenge.

## Known traps this run was briefed against

Recorded before dispatch, because each one has already cost this project a reverted commit:

1. **The disqualifier is in the body.** `T233` was flipped on a discharged clause 1 while its body
   said in bold that it stayed open for clause 2. Every ticket in scope is grepped for
   `remaining|deferred|stays open|follow-up|known limit` and every hit read.
2. **A benign "Out of scope" section is not a disqualifier.** Work deferred to *another* ticket does
   not block a flip; "this ticket stays open for X, where X is an `archive_when` clause" does.
3. **Multi-clause `archive_when` joined by "and" needs every clause discharged**, each verified
   first-hand rather than on a relayed assurance.
4. **`_Prior:` entries in `PLATFORM_STATE.md` are dated historical layers.** A stale claim inside one
   is marked closed in place (strikethrough + `CLOSED by …`), never silently rewritten and never
   deleted; current state is added as a new entry at the top.
5. **A run record that cites its own gate verdict is self-invalidating.** All prose here was written
   before dispatch; only the verdict lines are filled afterwards, and the record is not touched again.
6. **Link integrity is not in `check:governance`.** A relative link to a ticket that has not merged
   goes red in the vitest governance suite; the remedy is merge order, never deleting the link.

## Gates

Run by Verifier against commit `086079d2`, in the foreground, round 2.

| Gate | Result | Evidence |
|---|---|---|
| `npm run check:governance` | exit 0 — PASS | `check:governance — no findings.` The status-drift check **ran**; no "skipped (no origin/main)" line was printed |
| `npx vitest run test/governance.test.js` | exit 0 — PASS | 39/39, including "every relative markdown link in an active document resolves" |
| `npm run agents:check` | exit 0 — PASS | all generated profiles byte-identical to the committed `.claude/agents/*.md` |
| `npx eslint .` | not applicable | no `.js` in `git diff --name-only origin/main..HEAD`; all 20 paths under `docs/`. Recorded as not-applicable, **not** as a pass |
| every flipped ticket reads a closed status | PASS | nine `completed` (T237, T260, T279, T286, T287, T299, T304, T305, T306) and one `wont-fix` (T284); T209 `in-progress`, T261/T278/T281 `open`; T215/T217/T222 still `closed` with no `status:` line in the diff |
| commit subject's closes-list equals the flipped set | PASS | extraction by the gate's own regex `/(?:closes\|merge)\s+([TS]\d+[a-z]?)/gi` yields exactly those ten, set-equal in both directions, keyword repeated per ID, on exactly one commit |
| cited tests exist and match their claimed counts | exit 0 — PASS | `npx vitest run test/callerDeclaredArrival.test.js test/preferenceEtlResolve.test.js` → 38/38 and 57/57, the counts the round-2 closure notes claim |
| `docs/work/INDEX.md` is a clean regeneration | PASS | `npm run index:work` then `git status --porcelain docs/work/INDEX.md` → empty |
| round-2 delta introduced no status change | PASS | `git diff 01a2303e 086079d2 -- docs/work/tickets/` contains no `status:` line; the delta touches only `PLATFORM_STATE.md` and the T279/T299 tickets |
| no reasoning deleted | PASS | 29 removed vs 288 added lines across `docs/work/tickets/`; every removed line reappears inside `~~strikethrough~~` or is the replaced `status:` field. No outright deletion of prose |

## Verifier verdict

**PASS** — round 2, against HEAD `086079d2`, over the named scope above and nothing beyond it.

Verifier stated the caveat itself and it is repeated here because it matters: this run holds **no**
`✅ VERIFY PASSED` wrapper verdict, and the scoped checks above are not offered as an equivalent of
one. Governor does not hold one either — nobody in this run ran `npm run verify`. CI is the gate of
record for the merge.

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Round 1: average **4.0**, lowest dimension **4** (Code Reviewer 4, Red Hat 4; Security and Tester had
no reporter and Grader did not impute a number for them). Pass is ≥ 4.0 with no dimension below 3, so
round 1 was already pass-eligible — Grader nonetheless recommended a round 2 for four corrections
fixable inside this change's own files, and Governor took it rather than shipping known-legible
defects. Grader found no false claim on the board, and specifically weighed the T279 unverified-clause
gap and the T299 mis-citation and judged them evidence-presentation defects rather than false completions.

Round 2 was not re-scored: the four fixes were each a named, verifiable correction, all four landed,
and Verifier re-gated the result. Two Grader artefact paths cited in the round-1 report
(`docs/work/runs/evidence/…`, `docs/work/runs/gate-reports/…`) and two ticket filenames it used do
not exist; they are not relied on anywhere in this record.

## Findings carried forward

This run takes no ticket number, so everything real that it did not fix is reported to the board
worker rather than filed. Listed most consequential first.

- **The mixed-version ADR is now inconsistent with the ticket that carried its question.** Red Hat
  rated this HIGH. `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` remains
  `status: accepted` / `authority: normative`, already carrying a 2026-09-26 blockquote conceding that
  its safety argument no longer holds and naming an Architect decision (Security + Red Hat mandatory)
  as the resolution path. T284 — the ticket holding exactly that question — is now `wont-fix` on the
  owner's ruling, so that path is foreclosed by fiat on a different document, and the ADR's
  Consequences section still describes T222 as filed-and-open. The distinction that matters: the
  owner's ruling is an operational guarantee about **his** deployment ("devices on different versions
  is not possible. i am in production, no users"), not the property the ADR needs (that nothing in the
  code allows it). The same ruling says "once this goes it is open source", so a fork maintainer
  inherits an unenforced silent-merge hazard with no code-level protection and no single document
  saying it was permanently declined. **Amending an ADR is a human gate** (Article IV), so nothing
  here was changed; this needs an owner decision.
- **T297 may now be closeable and nobody has looked.** This run marked T297's cold-regenerate known
  limit CLOSED in `PLATFORM_STATE.md` (#667 shipped it), and T297's own ticket names that gap as its
  sole stated reason for staying open — yet T297 is outside the thirteen, so its status was not
  re-evaluated and stays `open`. Red Hat reports this as **undecided**, not resolved: T297 is either
  trivially closeable or open for a reason nobody has captured.
- **T312 reads `status: open` although its work merged in #648.** The board item's brief states T312
  was flipped in #654; #654 flipped **T313** only. T312 is therefore a fourteenth unflipped ticket.
  Outside this item's verified thirteen-ticket scope, so reported rather than flipped here
  (`CONSTITUTION.md` Article II rule 2 — no silent scope expansion).
- **T279's `archive_when` is a single ~30-line sentence** and was the hardest thing in this run to
  audit. Round 2 itemised it clause-by-clause with a citation each, and recorded one sub-clause ("no
  test in the set asserts on a hand-built parsed fixture", established for
  `test/preferenceEtlResolve.test.js` but not re-audited across every other test file #579 touched) as
  a **named residual** rather than presenting it as checked. An `archive_when` that cannot be read in
  one pass is a standing hazard for the next person who has to close one.
- **T261 is held open on elapsed wall-clock time** ("a week of run history"), verified correct — it
  merged 2026-09-25 and today is 2026-09-30, five days. Leaving it open was the right call. Whether a
  ticket should ever be gated on a date passing rather than on a measurement is a process question for
  the owner.

Known before dispatch, and deliberately **not** acted on in this run:

- **T312 reads `status: open` although its work merged in #648.** The board item's brief states T312
  was flipped in #654; #654 flipped **T313** only. T312 is therefore a fourteenth unflipped ticket.
  It is outside this item's verified thirteen-ticket scope, so it is reported to the board worker
  rather than flipped here (`CONSTITUTION.md` Article II rule 2 — no silent scope expansion).
- **T212's real-network clause is owner-gated** and T212 stays open; it is named here only because
  T284 and T286 point at it.

## Decision

**PASS**, at round 2, on commit `086079d2`.

Verifier returned PASS with no unresolved UNVERIFIED claim; Grader's round-1 average was 4.0 with
lowest dimension 4; every round-1 finding fixable inside this change's own files was fixed in round 2.
The findings that remain are out of this item's scope or sit behind a human gate, and are recorded
above and reported to the board worker rather than acted on here.

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
