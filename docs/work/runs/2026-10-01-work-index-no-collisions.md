---
task: "q-work-index-append-collisions — parallel PRs stop colliding on docs/work/INDEX.md"
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
  - docs/governance/standards/WORKING_COPY_STANDARD.md
related_tickets:
  - docs/work/tickets/T261-ci-minutes-duplicate-main-runs.md
  - docs/work/tickets/T283-board-truth-audit-gate.md
related_specs:
  - docs/work/specs/2026-07-30-typed-run-records-and-compiled-work-index-design.md
related_adrs:
  - docs/adr/2026-10-01-work-index-is-generated-not-committed.md
selected_agents: [governor, architect, maker, code-reviewer, red-hat, verifier, grader]
omitted_agents:
  - agent: designer
    reason: no-predicate
    note: documentation-governance task class; no UI surface exists in the footprint
  - agent: tester
    reason: not-applicable
    note: nothing a camp director can see changes; the whole footprint is build tooling and docs
  - agent: security
    reason: not-applicable
    note: "conditional on the chosen option. No workflow with write permissions is added under the chosen design (A); had option B been chosen, a main-side committing workflow would have made Security mandatory."
deterministic_checks: [test, lint, build]
human_gates:
  - "Amending docs/governance/standards/WORK_RECORD_STANDARD.md §3.3 and §6, and docs/governance/GOVERNANCE_INDEX.md §3–8, where they describe INDEX.md's mechanics (CONSTITUTION.md Article IV, 'a standard that would need to change to accommodate the work'). Basis: owner ruling 2026-10-01 on board item q-work-index-append-collisions, verbatim 'yes, let the second worker take it'. Edits confined to the sentences that become false."
  - "Deleting a tracked file (docs/work/INDEX.md leaves git and becomes a gitignored generated artifact). Same owner ruling is the basis; the file's content is reproducible on demand by npm run index:work, so nothing is destroyed."
  - "The new ADR is written status: proposed / implementation_state: in-progress. accepted is a human gate and is NOT taken in this run — the worker carries acceptance to the owner."
  - "NOT taken: no change to .github/workflows/**. The chosen option adds no workflow and modifies none. Recorded here because the brief named it as a gate to name rather than silently pass."
verdict: null
completion_evidence: []
archive_when: "the ADR is accepted by the owner and two subsequent parallel PRs have each filed a run record without a docs/work/INDEX.md conflict"
---

# Run: the work index stops being a merge-conflict surface

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** a session that files a run record or flips a ticket no longer has its PR
bounced, rebased, and fully re-gated because a sibling PR merged first and moved the same 327-line
generated file. The owner's concern — that this repository goes public and `docs/work/` is a
reader's entry point on GitHub — is met by a committed pointer that leads a reader to the tickets,
runs, specs, ADRs and handoffs without depending on a generated file being fresh in git.

**Success predicate:** all of the following, each independently checkable.

1. Two PRs that each add a run record cannot conflict on `docs/work/INDEX.md`, because no PR
   commits that file.
2. A public reader starting at `docs/work/` finds the five source directories, what each holds,
   and the one command that builds the index.
3. `npm run check:governance` exits 0 both with and without a local `docs/work/INDEX.md` present.
4. Link integrity (`test/governance.test.js`) is green, with an explicit, tested stance on the
   generated file rather than an accidental one.
5. The ADR records the choice and the rejected options.
6. `WORK_RECORD_STANDARD.md` and `GOVERNANCE_INDEX.md` describe the new mechanics truthfully.
7. Every named gate exits 0.

**What does not count as done:**

- A diff-gate on a committed generated file. That is the status quo and it is the cause.
- A `.gitattributes` union merge driver. GitHub's server-side merge does not apply merge drivers,
  so this fixes nothing where the conflicts actually happen.
- Broken or now-false references left for the next reader to find.
- A workflow added without a least-privilege `permissions:` block.
- Narrowing the problem to "regenerate more carefully" — a discipline is not a fix for a
  structural collision.

## Task class and what it pulls in

`documentation-governance`, spanning `test-infrastructure` (the footprint is `scripts/*.test.js`
and `test/governance.test.js`). Per `WORK_RECORD_STANDARD.md` §4 a span takes the **stricter**
gate list from both.

| | |
|---|---|
| Standards | `GOVERNANCE_INDEX.md` · `CONSTITUTION.md` · `WORK_RECORD_STANDARD.md` · `TESTING_STANDARD.md` |
| Mandatory gates | link + reference check · `check:governance` · test · lint · build |
| Human gate | any change to a constitution or standard; changing a shared harness or gate budget |

No `integration` gate: nothing in the footprint touches sync, auth, or schema.
`npm run verify` and the full `npm run test` are out of scope by instruction — Verifier runs
named files.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | yes | structural change to a gated artifact, with an ADR requirement |
| Designer | no | `no-predicate` — documentation-governance; no UI surface |
| Maker | yes | the only agent that writes code |
| Code Reviewer | yes | every reference to the file must be accounted for; standards edits minimal and true |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | `not-applicable` — nothing a director can see changes |
| Security | no | `not-applicable` — no workflow with write permissions is added (see `human_gates`) |
| Red Hat | yes | fresh clone, shallow CI checkout, a reader on GitHub, the file absent/present/stale |
| Grader | yes | scores the opinion reports |

Every one of the ten appears here. An omission needs a reason from the enum; "seemed unnecessary"
is not one, it is a rule 8 challenge.

## Measured problem statement

Carried in from the organizer's measurement, 2026-09-30/10-01, and confirmed against this tree:

- `docs/work/INDEX.md` is 327 lines, generated by `scripts/build-work-index.js` from frontmatter in
  five directories, committed, and gated by a BLOCKING `index-stale` finding in
  `scripts/check-governance.js` that rebuilds and byte-compares.
- Therefore every PR filing a run record or flipping a ticket must commit a regenerated copy, and
  every pair of in-flight PRs edits the same sections.
- Tonight: #672 bounced twice; #675, #676, #677, #678 and #681 each needed a rebase and a full CI
  re-run purely for this file.

Two facts verified in this tree that the brief did not have exactly right, and that bear on the
choice:

- **`.github/workflows/gate.yml` has no `push: branches: [main]` trigger.** T261 removed it
  deliberately; the triggers are `pull_request`, a daily `schedule`, and `workflow_dispatch`. Any
  option that writes the index on main would be adding back the per-merge main-side run T261 cut.
- **Nothing links to `docs/work/INDEX.md` as a markdown link.** Every one of the references is an
  inline code span naming the path in prose. The link-integrity test matches a closing bracket
  immediately followed by a parenthesized target, so it has no opinion on this file today — which
  is exactly the accidental stance the success predicate requires be made explicit.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| | | |

## Verifier verdict

PASS / FAIL / UNVERIFIED —

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average — , lowest dimension — . Pass is ≥ 4.0 with no dimension below 3.

## Findings carried forward

<Anything real that this run did not fix.>

## Open points for the owner

<One line each. Product questions this run could not answer without the owner.>

## Decision

PASS / RETRY / ESCALATE —

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
