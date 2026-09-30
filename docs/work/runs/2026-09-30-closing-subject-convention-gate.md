---
task: Board q-closing-subject-convention-defeats-gate — a closing commit subject that does not say `closes T<n>` skips both the status-drift and run-record gates
document_type: run
date: 2026-09-30
round: 1
status: in-progress
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T283-board-truth-audit-gate.md]
related_specs: []
related_adrs: []
selected_agents: [governor, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: no new persistent data shape and no contract other modules call — the change is one regex, one pure predicate, and the standard section that governs them
  - agent: designer
    reason: not-applicable
    note: no UI surface
  - agent: tester
    reason: not-applicable
    note: no director-facing surface; the deliverable is a build-time gate with no runtime path in the app
  - agent: security
    reason: not-applicable
    note: no auth, secrets, IPC, wire protocol or packaging surface touched
deterministic_checks: [test, lint, build]
human_gates: ["Amending a standard is a human gate (GOVERNANCE_INDEX.md §3-8, documentation-governance row: 'any change to a constitution or standard'; CONSTITUTION.md Art. IV). Treated as passed FOR THIS ITEM ONLY on the owner's verbatim ruling of 2026-09-29 on board item q-closing-subject-convention-defeats-gate — 'it needs to do that after it is done' — given on a board note whose stated fix shape was 'widen the pattern to close(s|d)? or fix the convention in WORK_RECORD_STANDARD'. The standard edit is confined to WORK_RECORD_STANDARD.md §3.2/§3.3 vocabulary, the documented regex, and the new finding. It carries no licence to amend any other standard or section."]
verdict: null
completion_evidence: []
archive_when: "the two offending historical subject shapes produce a blocking finding, the standard and the script carry the same regex text, and the T309 run-record question is settled either by a filed honest record or by a recorded reason it cannot be filed"
---

# Run: a closing subject that does not name what it closes stops being invisible

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** a session that closes a ticket can no longer skip the two gates the repo built
for closing commits by phrasing the subject as "close the ticket" instead of "closes T309". Today
that phrasing reaches neither `checkStatusDrift` nor `run-record-missing`, so the gate reports green
on precisely the commits it exists to check.

**Success predicate:** on the committed branch —

1. `parseCompletionRefs` matches `close`/`closed` as well as `closes`/`Merge`, so the nine historical
   `close T<n>` subjects on `origin/main` parse.
2. A subject that literally claims to close a ticket (`close the ticket`, `closes the ticket`,
   `close ticket`, …) but yields zero completion references produces a blocking
   `closure-claim-without-id` finding, wired into `checkAll` so it runs in `npm run check:governance`.
3. `WORK_RECORD_STANDARD.md` §3.2 carries the same regex text as the script, plus the vocabulary
   audit that widening it requires, plus the new finding.
4. Every named gate exits 0, with red-then-green evidence for both new behaviours.
5. This record is filled, and T309's missing run record is either filed honestly or refused with a
   recorded reason.

**What does not count as done:**

- The regex widened without the standard amended, or the standard amended without the script — §3.2
  says the standard governs if they disagree, so a divergence is a defect, not a nit.
- A fabricated T309 run record. A reconstructed agent roster asserted as the frozen pre-dispatch set
  is the exact failure the run-record standard exists to prevent.
- Any flip of any ticket's `status`. This item closes no ticket and takes no ticket number.
- A green run on tests that never had a red. Both new behaviours must be shown failing first.
- A phrase list widened until it over-fires. A marker that also appears in ordinary prose is a
  suppressor, not a marker; the same logic applies to a finding that fires on prose that makes no
  closure claim.

## Task class and what it pulls in

`documentation-governance`, spanning `test-infrastructure`. Per §4 of the work-record standard a
span takes the **stricter** list from both, so the gate list is the union.

| | |
|---|---|
| Standards | `GOVERNANCE_INDEX.md` · `CONSTITUTION.md` · `WORK_RECORD_STANDARD.md` §3.1–3.3, §5 · `TESTING_STANDARD.md` |
| Mandatory gates | link + reference check · `check:governance` · test · lint · build |
| Human gate | **any change to a constitution or standard** — see `human_gates` above: satisfied for this item only by the owner's 2026-09-29 board ruling, and recorded rather than assumed |

Integration is not in the list: nothing here touches sync, auth or schema, which is
`TESTING_STANDARD.md`'s trigger for the harness.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | `no-predicate` — no persistent shape, no cross-module contract |
| Designer | no | `not-applicable` — no UI surface |
| Maker | yes | writes the tests first, then the regex, the finding, and the standard parity |
| Code Reviewer | yes | spec fidelity and script/standard parity — the one defect class §3.2 names as governing |
| Verifier | yes | always — the only deterministic evidence source; owns the red-then-green evidence |
| Tester | no | `not-applicable` — no director-facing surface |
| Security | no | `not-applicable` — no auth, secrets, IPC, protocol or packaging surface |
| Red Hat | yes | the live question is what still evades and what newly over-fires; this is its subject exactly |
| Grader | yes | calibrated read across the three reviewer reports |

Every one of the ten appears here. An omission needs a reason from the enum; "seemed unnecessary"
is not one, it is a rule 8 challenge.

## The audit the widening requires

§3.2 states that "widening the regex without a corresponding audit of the commit vocabulary actually
in use is how a gate stops meaning anything." The audit, run on this branch against `origin/main`:

```
git log origin/main --format=%s | grep -iE "close(s|d)?\s+[TS][0-9]+" \
  | grep -viE "closes\s+[TS][0-9]+|merge\s+[TS][0-9]+"
```

Ten subjects. Nine are genuine closure claims the current regex cannot see. The tenth is a **false
positive the widening would newly admit**, and it is a possessive, not an adjective:

> `T233: signed purge-tombstone erasure (close T202's stale-peer reintroduction gap) (#515)`

That closes a gap *named by* T202; it does not close T202. Under a bare widening the gate would
demand T202's closure — the hazard §3.2's own duplicate-number comment describes, where the obvious
way to make a red gate green is to flip a status that should not move. Hence the design carries a
`(?!')` guard so a possessive is not read as a claim.

Two further shapes the widening admits and under-captures, both already covered by §3.2's existing
multi-ID convention rather than by new parsing: `close T215, T217 item 3` (captures `T215` only, and
"T217 item 3" is a partial closure) and `close T53-T60` (captures `T53` only — a range the standard
declines to parse).

**The second finding's targeting was measured, not assumed.** Across all of `origin/main`,
`clos(e|es|ed)\s+(the\s+)?ticket` matches **eleven** subjects — every one a real ticket closure that
names its ticket in a `docs(T<n>):` prefix rather than as `closes T<n>`, i.e. eleven true positives
and zero false positives. `close out` was **excluded** deliberately: it matches seven more subjects,
of which two (`docs(handoff): close out force-subagent-skill-invocation`, `docs: close out
doc-staleness remediation`) close no ticket at all, so a finding that told their authors to write
`closes T<n>` would prescribe a ticket that does not exist. That is a known, recorded gap rather
than a silently narrow pattern.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| `npx vitest run --no-file-parallelism scripts/check-governance.test.js test/governance.test.js` | PASS | exit 0, `Test Files 2 passed (2)`, `Tests 103 passed (103)` |
| `npm run check:governance` | 1 pre-existing finding, unrelated | exit 1, `index-stale` only. Confirmed pre-existing and out of this change's scope: `git stash push -u` (stashing both this branch's code edits and the untracked run-record doc) → re-run → `check:governance — no findings.` (exit 0). Re-applying the stash restores the `index-stale` finding — it is produced by the untracked `docs/work/runs/2026-09-30-*.md` file that already existed before this session touched anything, not by the regex/predicate change. `docs/work/INDEX.md` is out of this item's file scope (not in the allowed-files list), so it is left unregenerated and reported here rather than silently fixed. |
| `npx eslint scripts/check-governance.js scripts/check-governance.test.js` | PASS | exit 0, no output |
| `npm run agents:check` | PASS | exit 0, `All generated profiles are byte-identical to the committed .claude/agents/*.md files.` |
| red-then-green (widened verb + possessive guard) | RED→GREEN | RED: `npx vitest run --no-file-parallelism scripts/check-governance.test.js` → exit 1, 9 failed, including `parseCompletionRefs > matches "Close T##" as a bare claim…`, `> matches "closed T##"`, `> does not treat a possessive as a claim…` (54 passed). A first implementation using a bare `(?!')` lookahead then failed a 10th, separately-added test — `the possessive guard must not backtrack into a shorter, wrong id` — with `expected [] to deeply equal ['T20']`, because `\d+` backtracks past the apostrophe; fixed by widening the lookahead to `(?![a-z0-9'])`. GREEN: full suite exit 0, `Tests 64 passed (64)`. |
| red-then-green (`closure-claim-without-id`) | RED→GREEN | RED: same run as above — `checkClosureClaimWithoutId is not a function` on all 7 new tests in that `describe` block. GREEN: same run as above, all 7 pass alongside the rest (64/64). |

## Verifier verdict

PASS / FAIL / UNVERIFIED —

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average — , lowest dimension — . Pass is ≥ 4.0 with no dimension below 3.

## Findings carried forward

- `docs/work/INDEX.md` is stale (`index-stale`, blocking per §7's severity list) at the time this
  record was written. Confirmed pre-existing and unrelated to this item's code — it is produced by
  the untracked run-record doc this item's brief supplied, not by the regex/predicate change (see
  the `check:governance` gate row above for the stash-based confirmation). Regenerating it
  (`npm run index:work`) is out of this item's file scope, so it is surfaced here rather than fixed
  silently. Whoever lands this change next should run `npm run index:work` as part of normal
  landing hygiene.
- This item's own two closure shapes remain: `close T215, T217 item 3` (captures `T215` only) and
  `close T53-T60` (captures `T53` only) are both still under-captured by design, per §3.2's existing
  multi-ID convention (documented in this record's "The audit the widening requires" section above,
  not a new gap introduced here).
- The real main-side, going-forward board-truth audit gate (a merged `T<n>:` commit whose ticket
  never flips to `completed`) remains unbuilt. Tracked as `T283`, not touched by this item per the
  brief's explicit instruction.

## Decision

PASS / RETRY / ESCALATE —

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
