---
task: Reviewer agents become read-only; a Grader FAIL ends the loop; the work-index ADR is accepted
document_type: run
date: 2026-10-01
round: 1
status: in-progress
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
verdict: null
completion_evidence: []
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

| Gate | Result | Evidence |
|---|---|---|
| `npm run agents:check` | | |
| `npm run check:governance` | | |
| `npx vitest run scripts/generateAgentProfiles.test.js test/governance.test.js scripts/check-governance.test.js` | | |
| `npx eslint scripts` | | |
| grep sweep (no reviewer-produced evidence file, no stash) | | |
| `git diff --name-only` footprint vs merge-base | | |

## Verifier verdict

PASS / FAIL / UNVERIFIED —

> Verifier alone writes this line and the `verdict` field.

## Grader score

Average — , lowest dimension — . Pass is ≥ 4.0 with no dimension below 3.

## Findings carried forward

- **Follow-up (not done here): `evidence_ref` is not checked to exist on disk.**
  `validatePerGateReport` in `scripts/gateReportSchema.js` requires `evidence_ref` to be non-null
  for the verifier gate, but nothing anywhere confirms the path exists or binds to the commit at
  *that* layer. An existence check was considered and **not** added, because that module declares
  itself "Pure, no I/O" in its first four lines and is the shared source of truth for the reducer
  and the CLI; adding `fs.existsSync` there would break its stated contract. The honest home is
  `scripts/gateReportCli.js`, which already does I/O and already SHA-binds `gateResults` to
  `commit` — out of this PR's docs-only footprint. Until then, the guard against a fabricated
  evidence file is the Grader's instruction never to create one.
- **Follow-up (not done here): mechanical read-only enforcement** via a `PreToolUse` hook scoped by
  `agent_id`, with its validation script and the `.claude/settings.json` change it needs, reviewed
  by Security. See the rejected-options table above for why it is not in this PR.

## Decision

PASS / RETRY / ESCALATE —

> Under the rule adopted in this very run, a Grader FAIL ends the loop and escalates. It does not
> become a round 2.
