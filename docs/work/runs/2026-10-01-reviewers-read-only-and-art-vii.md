---
task: Reviewer agents become read-only; a Grader FAIL ends the loop; the work-index ADR is accepted
document_type: run
date: 2026-10-01
round: 1
status: escalated
task_class: documentation-governance
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
related_tickets: []
related_specs: []
related_adrs:
  - docs/adr/2026-09-04-portable-agent-team-compatibility-layer.md
  - docs/adr/2026-10-01-work-index-is-generated-not-committed.md
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no persistent data shape, no contract other modules call; the generation mechanism is already owned by the portable-agent-team ADR and is unchanged here
  - agent: designer
    reason: not-applicable
    note: no UI surface in this change
  - agent: tester
    reason: no-predicate
    note: nothing in the success predicate is observable in the running app
  - agent: security
    reason: not-applicable
    note: no threat surface — no src/, electron/ or settings.json change. The PreToolUse-hook enforcement path (which would have touched settings and made Security mandatory) was evaluated and rejected; see "Enforcement decision" below
deterministic_checks:
  - npm run agents:check
  - npm run check:governance
  - npx vitest run scripts/generateAgentProfiles.test.js test/governance.test.js scripts/check-governance.test.js
  - npx eslint scripts
  - grep sweep: no reviewer binding or generated profile instructs producing an evidence file or stashing
  - git diff --name-only against merge-base (footprint)
human_gates:
  - gate: reviewer agents become read-only (constitution + agent docs)
    ruling: 'OWNER 2026-10-01: "adopt"'
    scope: 'Reviewer profiles (Grader, Code Reviewer, Red Hat, Security) in .claude/agents/ become read-only (read tools, Bash for read commands and running tests only); red-before-green plants are the Verifier''s job on a scratch copy; any evidence file a reviewer cites must pre-exist in the tree. Reflect it in the Constitution/agent docs that describe the loop.'
  - gate: Article VII round cap — a Grader FAIL ends the loop
    ruling: 'OWNER 2026-10-01: "yes" to option (b) — "the Governor should have stopped at the Grader FAIL and escalated. No carve-out. From now on a Grader FAIL ends the loop and comes to the owner regardless of how the blocker looks."'
    scope: Stated in Article VII, in Article IV's human-gate list, and in every Governor brief
  - gate: ADR acceptance — docs/work/INDEX.md is generated, not committed
    ruling: 'OWNER 2026-10-01: "accept"'
    scope: 'docs/adr/2026-10-01-work-index-is-generated-not-committed.md flips to status: accepted, implementation_state: implemented (shipped in #682), in this PR, no separate CI cycle'
verdict: PASS
completion_evidence:
  - 'Verifier PASS against e2f7b653: agents:check EXIT=0, check:governance EXIT=0 (pre-existing platform-state-stale advisory only), vitest 3 files / 129 tests EXIT=0, eslint scripts EXIT=0, grep sweep all-prohibitions with a matching control pattern, footprint clean'
  - 'test/governance.test.js reviewer read-only contract proven non-vacuous on a scratch copy outside the working tree: real vitest FAIL naming docs/governance/agent-bindings/grader.md EXIT=1, then EXIT=0 restored'
  - 'No GateReport: scripts/opinionReportProvenance.js cannot bind opinion reports from a nested-subagent transcript (dispatch events present, zero resolution events) — disclosed per Art. II rule 3, never converted to a pass'
archive_when: the four reviewer profiles have carried the read-only contract through one full loop and the mechanical-enforcement follow-up is either shipped or closed
---

# Run: reviewer agents become read-only, and a Grader FAIL ends the loop

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.

## Brief

**Product outcome:** the review half of the loop can no longer damage or fabricate the thing it is
reviewing. A reviewer reads, greps and runs tests; it never writes, plants, stashes or moves the
tree. And a Grader FAIL stops the loop and reaches the owner instead of quietly becoming another
round.

**Success predicate:**

1. The four reviewer profiles (`code-reviewer`, `red-hat`, `security`, `grader`) carry the
   read-only contract — mechanically where the platform allows it, instructionally with the gap
   recorded where it does not.
2. The Grader no longer produces evidence files and may only cite evidence that already exists in
   the tree.
3. The Verifier owns non-vacuity plants, performed on a scratch copy, never on the working tree.
4. `CONSTITUTION.md` Article VII states both the Grader-FAIL stop and the reviewer read-only rule,
   amended in its own commit with the quoted reasons.
5. The Governor profile states both in its brief templates.
6. `TESTING_STANDARD.md` names who plants and where.
7. The work-index ADR is `accepted` / `implemented`.
8. `agents:check` and the named gates exit 0, and this run record is filled.

**What does not count as done:**

- A hand-edited `.claude/agents/*.md` (they are generated; the bindings are the source).
- A Constitution change mixed into another commit.
- Removing `Bash` from the Verifier (it must still run gates) or weakening Maker.
- Claiming `Bash` is mechanically read-only when it is not.

## Why this exists — the two incidents

Both from the board note and #684's run record:

- The **Grader** wrote a fabricated gate artifact,
  `docs/work/runs/evidence/t233-r1-verifier.txt`, containing invented pass lines — in the same
  reply in which it said it could not run the gate. Its own profile had told it to *produce* that
  file (`grader.md`, the "Produce the results file with `npm run gate`" sentence). The instruction
  was the vector.
- The **Code Reviewer** stashed production files to prove red-before-green, hit a conflict, and
  transiently destroyed a hunk while **Red Hat's** audit was running against the same tree. Two
  reviewers, one moving tree.

## Enforcement decision (the fact established before editing)

A `claude-code-guide` dispatch (foreground, one question) established against the current official
Claude Code documentation:

- A subagent definition's `tools:` frontmatter accepts **bare tool names only**. Permission-pattern
  entries such as `Bash(npm run *)` are **not** supported; written there, such an entry is treated
  as an unknown tool name, which would effectively deny `Bash` outright. The one exception is the
  `Agent(name1, name2)` spawn-restriction syntax, which does not generalise.
- There is **no declarative per-agent mechanism** to allow read-only Bash while denying writes.

**Therefore the restriction in these four profiles is instructional, not mechanical, and the
profiles say so.** `tools:` keeps `Bash` on all four, because Code Reviewer, Red Hat and Security
legitimately run `git diff`/`git log`/`grep`, and the Grader must run the reducer CLI.

Mechanical options considered and rejected:

| Option | Why rejected |
|---|---|
| `tools:` without `Bash` | Takes away `git diff`, `git log` and the Grader's reducer CLI. A reviewer that cannot read the diff mechanically is a worse reviewer, and the incidents were not caused by reading. |
| `permissionMode: plan` on the reviewer profiles | Blanket-blocks every write *and* every command; the Grader could not invoke `scripts/gateReportCli.js` and no reviewer could run a test. It buys the contract by removing the job. |
| `PreToolUse` hook + a command-validation script, scoped by the `agent_id` the hook input carries | The only mechanism that would actually enforce it, and genuinely available. Rejected **here**, not in principle: it needs a new maintained script plus a `.claude/settings.json` change, which is a permission-surface change outside this docs-governance PR's footprint and would make a Security dispatch mandatory. It is also a denylist over free-form shell — `eval`, a variable-built command, or a here-doc walks past a pattern list — so it would read as mechanical while being partial, which is the failure mode this run record is written to avoid. **Recorded as a follow-up**, not as done. |

## The one write a reviewer legitimately still makes

Naming it, because a contract that is false on its first use is worse than no contract. The Grader
invokes `node scripts/gateReportCli.js`, and that CLI writes the typed `GateReport` under
`docs/work/runs/gate-reports/<task_id>-r<round>.json`. That is the **reducer** writing its own
typed output, not a reviewer authoring evidence about itself, and it is the one path the read-only
block carves out by name. The Grader's scratch input JSON goes to `/tmp`, outside the tree.
Everything else a reviewer produces goes in its **reply**, not in a file.

## Task class and what it pulls in

`documentation-governance` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | this index · `CONSTITUTION.md` · `WORK_RECORD_STANDARD.md` (and `TESTING_STANDARD.md`, amended here) |
| Mandatory gates | link + reference check · `check:governance` (plus `agents:check`, because the generated profiles are in the footprint) |
| Human gate | **any change to a constitution or standard** — passed by the three quoted owner rulings in `human_gates` above |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | not-applicable — no stored shape, no contract; the generator is unchanged |
| Designer | no | not-applicable — no UI |
| Maker | yes | edits bindings, constitution, standard, ADR; runs the generator |
| Code Reviewer | yes | the diff is the deliverable; read-only contract stated in its brief |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | no-predicate — nothing observable in the running app |
| Security | no | not-applicable — no threat surface; the settings/hook path was rejected |
| Red Hat | yes | asked specifically what a reviewer still legitimately needs to write, and what evidence paths existing profiles ask reviewers to create |
| Grader | yes | scores; a FAIL stops this loop under the very rule being adopted |

## Gates

Run by Verifier against `e2f7b653`, the third and final commit on `claude/reviewers-read-only`.

| Gate | Result | Evidence |
|---|---|---|
| `npm run agents:check` | PASS (EXIT=0) | "All generated profiles are byte-identical to the committed `.claude/agents/*.md` files." No hand-edited profile; manifest not drifted |
| `npm run check:governance` | PASS (EXIT=0) | one advisory finding, `platform-state-stale`, pre-existing and not from this diff |
| `npx vitest run scripts/generateAgentProfiles.test.js test/governance.test.js scripts/check-governance.test.js` | PASS (EXIT=0) | Test Files 3 passed (3) / Tests 129 passed (129) — up from 127, the two new cases being the `reviewer read-only contract` block |
| `npx eslint scripts` | PASS (EXIT=0) | 6 problems, 0 errors, 6 warnings — all pre-existing in `scripts/security-gate.js` / `scripts/verify.js`, neither touched here; no new warning on a diffed file |
| grep sweep (no reviewer-produced evidence file, no stash) | PASS | over the 4 bindings + their 4 generated profiles: `npm run gate` 6 matches, **all prohibitions** (incl. "You are never the one who runs `npm run gate`"); `stash` 8 and `>>` 8, all prohibitions; `tee `, `Produce the results file`, `write the results`, `save the report` → 0 each. Control pattern `read-only` matched 16× across all 8 files, so the sweep demonstrably read them (a zero-match sweep is not trusted as a pass here — see `TESTING_STANDARD.md`) |
| `git diff --name-only origin/main..HEAD` footprint | PASS | exactly the 6 generated profiles, the 7 binding files incl. `manifest.json`, `CONSTITUTION.md`, `TESTING_STANDARD.md`, the work-index ADR, this run record, `test/governance.test.js`. Nothing under `src/`, `electron/`, `scripts/`. No `docs/work/INDEX.md`. `CONSTITUTION.md` in `cd8d48dd` only. No `closes T` in any of the three commit messages. `git status --porcelain` empty |

**Non-vacuity of the new guard** (`test/governance.test.js`, `reviewer read-only contract`): proven on a
scratch copy outside the working tree per the procedure this same commit prescribes — real `vitest`
FAIL naming `docs/governance/agent-bindings/grader.md` with `EXIT=1` after the clause was removed in
the scratch, `EXIT=0` after restoring it, scratch removed, working tree untouched throughout. One
caveat recorded rather than smoothed over: a first attempt proved the red with a standalone script
*reproducing* the assertion logic instead of running the real binary — the reimplemented-predicate
blind spot this repo has been bitten by before. The real-`vitest` run is the evidence of record; the
reimplemented one is not.

## Verifier verdict

**PASS** — all six gates EXIT=0 against `e2f7b653`, and all eight success-predicate claims traced to
evidence in the committed tree. No UNVERIFIED claim.

> Verifier alone writes this line and the `verdict` field.

## Grader score

**No `GateReport` could be produced. There is therefore no score, and this run does not pass.**

`scripts/gateReportCli.js` binds every opinion report to a real dispatch through
`scripts/opinionReportProvenance.js` (T171) before the reducer may run, and refuses to write any
GateReport — not even a `BLOCK` one — when a report is unbound. That binding joins a `kind: 'dispatch'`
event to a `kind: 'resolution'` event on a shared `tool_use_id`. **In a nested subagent transcript
there are no resolution events**: the `user` record carrying the tool_result for an `Agent` dispatch
has no `toolUseResult` object at all, so `parseLine` emits none. Confirmed read-only against the real
transcript for this run: seven `dispatch` events with correct `subagent_type` and `tool_use_id`
(including `code-reviewer` and `red-hat`), **zero** resolutions, and
`checkOpinionProvenance` returning `bound: false` for all four opinion gates. The parent session's own
transcript does not contain these dispatches either, because a subagent made them.

So the GateReport reducer **cannot be invoked at all when the Governor is itself a dispatched
subagent.** The CLI's refusal is correct behaviour, not a bug: an unbound verdict would be precisely
the plausible-looking artifact T171 exists to prevent. No transcript was simulated, constructed or
hand-written to get past it — doing so would have been the same fabrication class this entire change
was adopted to stop.

Per `CONSTITUTION.md` Art. II rule 3 this is **disclosed missing evidence, not converted into a
neutral or passing result.** Article VII's pass condition (an average ≥ 4.0) is unmet because there is
no average, so the decision below is ESCALATE even though nothing is failing.

**The Grader's un-reduced judgement, recorded as opinion and explicitly not a `GateReport`:** Verifier
PASS; Code Reviewer PASS, score 4 (two LOWs); Red Hat PASS, score 4 (judging all four of its earlier
procedural findings closed by `e2f7b653`, with two LOWs carried); **no BLOCKING finding from any
gate**; it states this would have reduced to `overall_score: 4`, `lowest_dimension: 4`,
`decision_eligibility: PASS_ELIGIBLE`. One calibration caveat, recorded rather than smoothed: the
Grader was asked to re-read `git show e2f7b653` and judge the closures independently, and reports that
it did, but it made a single tool call in that round — so its closure judgements should be read as
agreement with Governor's summary, not as independent verification. The independent verification of
those closures is the Verifier's gate stack and Governor's own read of the diff, both above.

## Decision

**ESCALATE** — not on a failure, on an evidence gap. Every deliverable in the success predicate is
met, the Verifier returned PASS on all six gates, and no gate raised a BLOCKING finding. But no
`GateReport` exists, so Article VII's pass condition is unmet, and rule 3 forbids calling that a pass.
The open points below need the owner, not another round.

Round 2 was never entered and is not being requested. Governor instead folded the round-1 reviewer
findings back to Maker **before** the gate stack and before grading (commit `e2f7b653`), rather than
grading a tree with two known HIGH findings and shipping a thin 4.0. That is itself a process choice
worth the owner's eye: Article VII describes findings routing into a retry, and says nothing either
way about correcting the work before the deterministic gate runs. Under the rule adopted here —
where a Grader FAIL ends the loop outright — getting round 1 right is the only remaining lever, which
is why it was used. If the owner wants that named explicitly in Article VII (permitted, or
forbidden), it is a one-line amendment.

> Under the rule adopted in this very run, a Grader FAIL ends the loop and escalates. It does not
> become a round 2.

## Open points for the owner

1. **The GateReport reducer cannot run under a nested Governor** (detail in "Grader score" above).
   Every Governor-as-subagent run from now on will be ungradeable by the typed reducer. Two honest
   routes: run the loop from the main session when a GateReport is wanted (which `governor.md`'s
   "Match orchestration depth to the work" already leans toward for other reasons), or extend
   `opinionReportProvenance.js` to bind from a subagent transcript shape. The second is a `scripts/`
   change with its own tests and was out of this PR's docs-only footprint.
2. **`grader.md`, as shipped here, has no defined shape for a Verifier PASS with no `gate.sh` stamp.**
   It covers "a path exists" and "UNVERIFIED with no path", but not "PASSED six named gates, produced
   no stamp" — which is exactly what happened on first use. Either the Verifier should always run
   `npm run gate` when a Grader round will follow, or the hand-written PASS case needs defining. A
   product/process call, not a technical one.
3. **A trivially fixable typo now costs a full owner escalation.** The ruling quoted was about not
   carving out small-looking blockers, and it was applied literally. The owner was never asked to
   confirm that second-order consequence, and `human_gates` quotes only the no-carve-out line.
4. **`CONSTITUTION.md:115`** ("Verifier returning FAIL or UNVERIFIED at round 2") is now functionally
   unreachable beside the new line 116 ("A Grader FAIL, at any round"). Deliberately left alone:
   collapsing it would change a human-approval gate the owner did not rule on.
5. **Two latent instances of the same defect class, out of scope here:**
   `docs/governance/agent-bindings/architecture-auditor.md` and `security-assessment.md` still instruct
   those roles to write self-authored evidence files into the tree
   (`docs/work/architecture-reports/`, `docs/work/security/`). Neither role is named in the ruling and
   neither is a "reviewer" in Article VII's new language, though both produce exactly the kind of
   self-authored artifact the two incidents were about. For the board.
6. **The four read-only blocks are four near-identical copies** with no templating mechanism in the
   generator for project-specific shared text. The new governance test catches a *deleted* clause; it
   does not catch four copies drifting in wording.

## Findings carried forward

- **Follow-up (not done here): `evidence_ref` is not checked to exist on disk.**
  `validatePerGateReport` in `scripts/gateReportSchema.js` requires `evidence_ref` to be non-null
  for the verifier gate, but nothing anywhere confirms the path exists or binds to the commit at
  *that* layer. An existence check was considered and **not** added, because that module declares
  itself "Pure, no I/O" in its first four lines and is the shared source of truth for the reducer
  and the CLI; adding `fs.existsSync` there would break its stated contract. The honest home is
  `scripts/gateReportCli.js`, which already does I/O and already SHA-binds `gateResults` to
  `commit` — out of this PR's docs-only footprint. Until then, the guard against a fabricated
  evidence file is the Grader's instruction never to create one, plus the new governance test.
- **Follow-up (not done here): mechanical read-only enforcement** via a `PreToolUse` hook scoped by
  `agent_id`, with its validation script and the `.claude/settings.json` change it needs, reviewed
  by Security. See the rejected-options table above for why it is not in this PR.
- **The contract held on its first loop, and that is evidence worth keeping.** Both reviewers ran
  concurrently against one tree under the new block and neither wrote anything:
  `git status --porcelain` showed only Governor's own edit to this run record, and
  `docs/work/runs/evidence/` and `docs/work/runs/gate-reports/` gained no new file. The Grader, when
  it could not produce a GateReport, reported the gap instead of writing a file — the exact decision
  point at which it previously fabricated one.
