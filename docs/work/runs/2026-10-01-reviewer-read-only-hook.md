---
task: Board item q-reviewer-read-only-mechanical-enforcement — a PreToolUse hook that mechanically refuses writes and mutating Bash for the four reviewer profiles (+ folded residual q-freeze-pr-residuals (9), PLATFORM_STATE refresh)
document_type: run
date: 2026-10-01
round: 1
status: escalated
task_class: test-infrastructure
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
related_tickets: []
related_specs: []
related_adrs: []
selected_agents: [governor, maker, code-reviewer, red-hat, security, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: harness guard with no persistent data shape, no contract other modules call, and a fully converged policy handed down in the dispatch brief
  - agent: designer
    reason: not-applicable
    note: no user-facing surface changes
  - agent: tester
    reason: not-applicable
    note: nothing a camp director can observe; the subject is agent tooling
deterministic_checks:
  - npx vitest run test/reviewerReadOnlyHook.test.js
  - npx eslint .claude/hooks test
  - npm run agents:check
  - npm run check:governance
  - npx vitest run test/governance.test.js scripts/check-governance.test.js
human_gates:
  - name: new committed .claude/settings.json (harness config)
    basis: owner R1 on board item q-reviewer-agents-read-only-constraint, quoted in full in the Human gate section below; owner said "adopt" and the organizer scoped the mechanical half within it. Owner unavailable during the run; told in the PR.
verdict: FAIL
completion_evidence: []
archive_when: the hook has survived one full review round on an unrelated ticket without a false deny
---

# Run: reviewer read-only, mechanically enforced

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.

## Brief

**Product outcome:** the read-only contract that `CONSTITUTION.md` Article VII states for Code
Reviewer, Security, Red Hat and Grader stops depending on those agents choosing to honour it. A
reviewer that tries to write a file or run a mutating command is refused by the harness, with a
reason it can read and act on.

**Success predicate:** a subagent of type `code-reviewer`, `red-hat`, `security` or `grader` is
mechanically refused `Write`/`Edit`/`MultiEdit`/`NotebookEdit` and every Bash command outside a
read/test allowlist; `architecture-auditor` and `security-assessment` may write only under
`docs/work/architecture-reports/` and `docs/work/security/` respectively; every other agent type —
and the main session — is untouched. The deny list and its known residual bypasses are documented in
the script. Tests red-then-green. `check:governance` reports zero findings including no advisory.
`agents:check` green.

**What does not count as done:**
- A hook that also fires for Maker, Verifier, Governor, Tester, Designer, Architect, or the main
  session. The hook must be a no-op for everyone it does not name.
- An allowlist that admits `git stash`, `git checkout --`, or `>` redirection into a path.
- A `.claude/settings.json` carrying anything beyond the two `PreToolUse` hook entries.
- A `PLATFORM_STATE.md` rewrite that invents repo paths (`check:governance` catches nonexistent
  ones) or that describes the unmerged vocabulary sweep.
- A green test suite with no evidence the tests were red before the script existed.

## Task class and what it pulls in

`test-infrastructure` (harness), spanning `documentation-governance` — per
`GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `standards/TESTING_STANDARD.md` · `standards/WORK_RECORD_STANDARD.md` · `CONSTITUTION.md` Art. VII |
| Mandatory gates | test · lint · link + reference check · `check:governance` |
| Human gate | changing a shared harness (this is one: a new committed `.claude/settings.json`) · any change to a standard (none made — the bindings only stop calling the contract unenforced) |

## Human gate — basis

The owner's ruling R1 on board item `q-reviewer-agents-read-only-constraint`, verbatim: *"Reviewer
profiles (Grader, Code Reviewer, Red Hat, Security) in .claude/agents/ become read-only (read tools,
Bash for read commands and running tests only)"* — the owner's word was "adopt". #688 implemented
that contract **instructionally**. The organizer, within the same adopt, scoped the mechanical half:
a PreToolUse hook keyed by agent, plus the observation that `architecture-auditor` and
`security-assessment` are the same write-capable review class. The owner was unavailable during this
run and is told in the PR; nothing here changes a standard or the Constitution — the four bindings
only stop asserting the contract is unenforced.

## Design decision (Architect omitted — recorded here instead)

One dependency-free Node script, `.claude/hooks/reviewer-read-only.js`, reads the PreToolUse stdin
JSON once and exports a pure `decide(input)` so the policy is unit-testable without spawning a
process. Policy is a table keyed by `agent_type`; unknown or absent `agent_type` returns allow.
Bash classification is an **allowlist of first tokens** plus an unconditional **denylist of
mutating fragments**, evaluated per segment of a compound command; anything the parser cannot
classify is denied (fail closed).

Why a hook rather than narrowing `tools:` frontmatter: a subagent's `tools:` list accepts bare tool
names only, so `Bash` cannot be narrowed to read-only commands — the exact honest limit the four
bindings have been recording since #688. A PreToolUse hook is the only surface that sees the command
text.

Why `.js` and not `.mjs` as the brief suggested: `package.json` has `"type": "module"`, so a `.js`
file is already ESM, and `eslint.config.js` matches `**/*.{js,jsx}` — a `.mjs` file would fall
outside every config block and `npx eslint .claude/hooks` would not lint it. One line is added to
`eslint.config.js` to give `.claude/hooks/**/*.js` Node globals; without it `process` is undefined
and lint fails.

Why `.claude/settings.json` holds nothing else: JSON permits no comments, so the "two hook entries
only" constraint is recorded here rather than in the file.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | `not-applicable` — harness guard, no persistent data shape or cross-module contract; policy converged in the brief and recorded above |
| Designer | no | `not-applicable` — no user-facing surface |
| Maker | yes | writes the hook, its test, settings.json, the binding sentences, PLATFORM_STATE |
| Code Reviewer | yes | the policy table is the kind of thing that rots; plan alignment on a brief with a long explicit spec |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | `not-applicable` — nothing a director can observe |
| Security | yes | mandatory: this is a harness permission change (least privilege, fail-closed, no effect on the main session) |
| Red Hat | yes | the whole value of the guard is whether it can be bypassed; enumerating bypasses is the deliverable |
| Grader | yes | scores the three opinion reports |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| `npx vitest run test/reviewerReadOnlyHook.test.js` (RED) | fail as expected — module did not exist | `/tmp/red-hook.txt`, EXIT=1, `Cannot find module '../.claude/hooks/reviewer-read-only.js'` |
| `npx vitest run test/reviewerReadOnlyHook.test.js` (GREEN) | pass | `/tmp/green-hook.txt`, 38 tests passed, EXIT=0 |
| `npx eslint .claude/hooks test` | pass | EXIT=0, no output |
| `npm run agents:check` | pass | all 13 profiles + manifest report `match`, EXIT=0 |
| `npm run check:governance` | pass | Verifier re-ran post-commit: **zero findings, no advisory** — the `platform-state-stale` advisory cleared |
| `npx vitest run test/governance.test.js scripts/check-governance.test.js` | pass | Verifier: 126/126, EXIT=0 |
| `node -p` parse of `.claude/settings.json` | pass | parses; holds only the two `PreToolUse` entries |
| Footprint | pass | no `src/`, no `electron/`, the work index not committed, `settings.local.json` still ignored, tree clean |
| **Policy correctness (`decide()` probes)** | **FAIL** | five confirmed violations — see Verifier verdict below |
| **End-to-end wiring (probe subagent)** | **UNVERIFIED — the hook did not fire** | a real `code-reviewer` subagent redirected output into a file under `/tmp` and was **not refused**; the file was created, no refusal message |
| Test non-vacuity (4 planted defects, scratch copy) | **UNVERIFIED** | Verifier did not report Part B; the `Cannot find module` red proves only that the import failed, not that the 38 assertions discriminate |

## Verifier verdict

**FAIL** — the gate stack is entirely green, and the substantive predicate is nonetheless false.
Verifier confirmed each row below by calling the exported `decide()` directly; it executed none of
these commands.

| # | Probe (agent + command) | Expected | Actual |
|---|---|---|---|
| V1 | `grader` + the gate-report reducer CLI | ALLOW — Art. VII's one named carve-out | **DENY** |
| V2 | `code-reviewer` + `npx eslint . --fix` | DENY — `--fix` rewrites source | **ALLOW** |
| V3 | `code-reviewer` + `npm run agents:check -- --write` | DENY — rewrites every `.claude/agents/*.md` | **ALLOW** |
| V4 | `code-reviewer` + a `node -e` async `fs` write aimed at `.claude/settings.json` | DENY — this is a self-disable | **ALLOW** |
| V5 | `code-reviewer` + `npm run index:work` | DENY — the script writes unconditionally | **ALLOW** |

> Governor transcribed this verdict because Verifier returned FAIL in its report but did not write
> the line. The content is Verifier's, unaltered; only the transcription is Governor's.

## Grader score

Average — **2.0**, lowest dimension — **2** (Code Reviewer 2, Security 2, Red Hat 2). Pass is ≥ 4.0
with no dimension below 3. Verdict **FAIL**. Verifier's FAIL independently blocks a pass outright
whatever these numbers say (`CONSTITUTION.md` Art. VII).

## Open points (owner unavailable 2026-10-01)

1. The hooks docs state `agent_type` is present for subagent tool events but **do not document its
   exact value** (frontmatter `name:` vs display name). The script therefore normalizes the value
   (lowercase, spaces/underscores → hyphens) and matches both forms; the probe below is what
   establishes the real value empirically.
2. The docs do not state the `tool_input` field name for `Write`/`Edit` target paths. For the four
   reviewers this is moot (writes are denied unconditionally). For `architecture-auditor` and
   `security-assessment` the script checks `file_path`, `path` and `notebook_path` and **denies when
   no path can be determined** — fail closed.
3. **ANSWERED, and the answer is why this run has no enforcement evidence.** The docs do not state
   whether hooks are re-read mid-session. The probe settles it for this session: a `code-reviewer`
   subagent spawned from this worktree, after `.claude/settings.json` was committed here, redirected
   output into a file and **was not refused** — no refusal message, the file was created. The policy
   function denies that exact command, so the hook did not fire. Most likely project settings are
   read at session start. Consequence: the only enforcement evidence that exists is the in-process
   `decide()` unit tests plus a spawn test of the script's own CLI. Whether this hook constrains
   anything in a real session is **untested**, and must be settled in a fresh session before the
   approach is trusted.
4. Base commit: this worktree was cut at `4fccca2e` (#694), one commit later than the `b90f8440` the
   dispatch brief named. No conflict; recorded so the diff range is unambiguous.

## Findings carried forward

Every item below is open. None was fixed in this run, because a Grader FAIL ends the loop
(`CONSTITUTION.md` Art. VII) rather than becoming a round 2.

**Blocking, and the one to read first.** The guard denies the Grader the single write Art. VII
expressly permits it (V1). A mechanical guard that contradicts the constitutional text it exists to
enforce cannot land in that state. The reducer CLI is invoked as `node <script> <input.json>`, and
the hook's `node` branch admits only `-e`/`-p`. Observed live in this very run: the Grader could not
write its own typed `GateReport` and reported inline instead.

**Blocking — one root cause, five symptoms.** The Bash allowlist matches leading tokens and never
inspects what follows them, and the `node -e` guard is a substring denylist naming only `*Sync`
functions. Hence V2, V3, V4, V5, plus `npm test -- --outputFile=…` and
`npx vitest run x --outputFile=…`. V4 is the worst: it lets a constrained reviewer overwrite
`.claude/settings.json`, the file that wires the guard. The fix is a change of kind, not of degree —
full-command/flag validation, or an allowlist of complete invocations, rather than prefix-matching
plus substring denial. Red Hat additionally found `process.binding`, `createWriteStream` and a
write-mode `openSync` allowed, all plain idiomatic calls needing no obfuscation.

**Blocking — silent fail-open on name drift.** An `agent_type` of `redhat` (hyphen dropped) and one
spelled with a U+2011 non-breaking hyphen both return ALLOW, because the normalizer strips only
whitespace and underscores. The known-agent set is hardcoded with no cross-check against the `name:`
frontmatter in `.claude/agents/*.md`, and `npm run agents:check` does not check it. A future rename
of any reviewer profile turns the guard into a permanent no-op for that profile with no signal to
anyone. A fix should put that cross-check in `agents:check`, so drift is caught by a gate rather
than by a reviewer who happens to look.

**Honesty defect in the script's own residual list.** The header frames the `node -e` escape as
requiring string-concatenation cleverness; it is reachable with plain idiomatic calls. It also says
nothing about an `agent_type` Unicode confusable no-op'ing the whole guard for that call — a
qualitatively worse failure than the Bash-text homoglyph case it does disclose. An under-claimed
residual list is itself a finding, because that list is what the next reader trusts.

**Not blocking, but the thing most likely to get the guard removed.** Red Hat's false positives:
`[ -f x ]`, a `cd` prefixed test run, `basename`/`dirname`/`realpath`/`comm`, `command -v`, a
`find … | xargs grep` pipeline, and `grep "a && rm" f` (the segment splitter has no quote-awareness,
so it splits inside a quoted string) are all denied though harmless. Also `sed -ni` and
`sed --in-place` are allowed, which the exact-token check misses. A guard that blocks ordinary
review work in its first week gets switched off rather than repaired.

**Structural, dormant.** The CLI entry's outer `try/catch` resolves to ALLOW on any throw — the
opposite of `decide()`'s internal fail-closed branch for a named reviewer. Unreachable today, one
refactor from silently inverting the policy for the exact case that matters. No end-to-end test
covers malformed stdin, the one path where that outer catch is live code.

**Test non-vacuity unestablished.** The red was `Cannot find module`, which proves the import failed
and nothing about whether the 38 assertions discriminate. The four planted-defect checks were
specified and were not reported.

## Decision

**ESCALATE** — Grader returned FAIL (average 2.0, lowest dimension 2) and Verifier returned FAIL.
Per `CONSTITUTION.md` Art. IV and Art. VII a Grader FAIL at any round ends the loop and goes to the
user; it is never routed back to Maker as a new round, whatever the blocker looks like. The work is
committed on `claude/reviewer-hook` and is **not** pushed. Nothing is merged.

What the user is asked to decide — three options, with the Governor's recommendation:

- **(a) Rebuild and retry in a new ticket.** Replace the Bash policy with full-command/flag
  validation, fix the Grader carve-out, add the name-drift cross-check to `agents:check`, and make
  the splitter quote-aware. Largest scope; highest chance of a guard that survives contact.
- **(b) Land the uncontested half, drop the Bash policy.** Two reviewers independently confirmed the
  write-tool denial, the path scoping for the two auditor profiles, the agent-type gating and the
  no-op-for-everyone-else guarantee as sound. Every confirmed violation is in the Bash branch.
  Removing that branch entirely — deny no Bash at all for now — yields a smaller guard that is
  honestly correct, closes the `Write`/`Edit` half of the contract today, and leaves the Bash half
  instructional until it can be built as an allowlist of complete invocations. **This is the
  recommendation**: it is the small reversible step, and it cannot create the false positives that
  would get the whole mechanism removed.
- **(c) Abandon the mechanical approach** and keep the instructional contract from #688 as-is.

The end-to-end wiring question must be settled in a fresh session whichever option is chosen,
because nothing in this run demonstrates the hook fires at all.
