---
task: "q-work-index-append-collisions — parallel PRs stop colliding on docs/work/INDEX.md"
document_type: run
date: 2026-10-01
round: 1
status: pass
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
verdict: pass
completion_evidence:
  - "Verifier round 2 — nine named gates, every one EXIT=0: 143 tests across scripts/check-governance.test.js, scripts/build-work-index.test.js and test/governance.test.js; check:governance with the index present, absent, and stale; test/governance.test.js returning an identical 40-test count with the index absent vs present; index:work; agents:check; eslint scripts test; npm run build"
  - "Bidirectional drift guard reproduced red in both directions by Verifier — a path deleted from the README block fails as missing, docs/work/nonesuch added fails as extra, restored green"
  - "git ls-files docs/work/INDEX.md returns empty; git check-ignore -v docs/work/INDEX.md resolves to .gitignore line 55"
  - docs/adr/2026-10-01-work-index-is-generated-not-committed.md
  - docs/work/README.md
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

## What was built

Round 1 (`1a910885`) — `docs/work/INDEX.md` removed from version control and added to `.gitignore`
with a comment naming the ADR; `checkIndexFreshness` and both the `index-stale` and `index-missing`
findings deleted from `scripts/check-governance.js` along with exactly the two dead imports
(`generate`, `INDEX_PATH`); the three unit cases pinning them deleted outright rather than skipped;
a new committed `docs/work/README.md` entry point; a drift guard in `scripts/build-work-index.test.js`
and an "is not tracked" guard in `test/governance.test.js`; the two `GOVERNANCE_INDEX.md`
"Current-state reference" cells turned from code spans into real markdown links to
`../work/README.md` so the reference is gated rather than unchecked prose; `WORK_RECORD_STANDARD.md`
§6 rewritten.

Round 2 (`033c6c27`) — Red Hat's three findings discharged: the generated artifact excluded from
`test/governance.test.js`'s audited corpus in one place inside the shared `walk()` helper; the drift
guard made bidirectional against a delimited block in the README, so a directory *removed* from
`SOURCE_DIRS` now fails too; a committed link from the root `README.md`, the only file GitHub renders
on the repository home page, into `docs/work/README.md`.

`check:governance` stays **compare-only and non-writing** — a gate that mutates the tree is a
different contract from every other check in that script, and with no committed copy there is
nothing to compare against. The generator is untouched: `npm run index:work` still builds the board
for anyone who wants it locally.

## Gates

All run on named files; `npm run verify` and the full `npm run test` were out of scope by
instruction (the suite is ~11 min, past the foreground ceiling). Verifier ran the stack twice,
once per round; the row below is round 2.

| Gate | Result | Evidence |
|---|---|---|
| `vitest run scripts/check-governance.test.js scripts/build-work-index.test.js test/governance.test.js` | **pass** | 143 tests, EXIT=0 |
| `check:governance`, file present | **pass** | EXIT=0, no blocking finding (pre-existing `platform-state-stale` advisory only) |
| `check:governance`, file **absent** | **pass** | EXIT=0, no finding whose code begins `index-` |
| `check:governance`, file present and **stale** | **pass** | EXIT=0, no `index-` finding |
| `vitest run test/governance.test.js`, file absent vs present | **pass** | **40 tests in both states** — the audited corpus no longer depends on local build state |
| `vitest run test/governance.test.js`, artifact replaced by garbage | **pass** | the round-1 HIGH, now fixed; EXIT=0 |
| bidirectional drift guard, both directions | **pass** | path deleted from the README block → red naming it **missing**; `docs/work/nonesuch` added → red naming it **extra**; restored → green. Reproduced by Verifier, not taken from Maker's report |
| `index:work` | **pass** | EXIT=0, rebuilt (331 lines) |
| `agents:check` | **pass** | EXIT=0, every profile byte-identical |
| `eslint scripts test` | **pass** | EXIT=0, 0 errors (6 pre-existing warnings elsewhere) |
| `build` | **pass** | EXIT=0 |
| footprint vs merge base | **pass** | 12 paths, all authorized; nothing under `src/`, `electron/`, or `.github/` |
| commit subjects | **pass** | neither carries a completion reference |

## Verifier verdict

**PASS** — all nine round-2 gates exit 0, with no UNVERIFIED claims.

One honest limit, stated by Verifier rather than papered over: in round 1 the pre-change *live* red
was not independently reproduced in a checkout of the merge base; Verifier instead showed that
`origin/main`'s `scripts/check-governance.js` contains `checkIndexFreshness`, `index-stale` and
`index-missing` and that HEAD's does not. Round 2's reds (the corrupt-artifact failure and both
directions of the drift guard) *were* reproduced live.

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average **4.5**, lowest dimension **4** (resilience — a HIGH existed in round 1 and needed a second
round to discharge; the fix is complete and independently verified). Pass is ≥ 4.0 with no dimension
below 3.

## Deviations from the brief, recorded rather than absorbed

- **`check:governance` does not regenerate the index.** The board item's sketch of this option had
  the gate rebuild the file on every run. Architect was asked to settle whether that makes the gate
  a writer and concluded it should not: nothing reads the file as input, so there is nothing the
  regeneration would serve, and a check that mutates the tree interacts badly with `gate.sh`'s
  SHA-stamping. The consequence is explicit — a fresh clone and a CI runner simply have no board
  until someone asks for one, and `docs/work/README.md` names the command.
- **`test/governance.test.js` was amended**, as the brief permits with a stated reason, twice: the
  basename-uniqueness test now exempts the basename `README.md` (the rule exists so a slug cannot be
  ambiguous between directories; `README.md` is a filename whose meaning is defined per-directory by
  GitHub's own rendering, which is the only reason the owner's constraint is satisfiable by this
  file), and the generated artifact is excluded from the audited corpus.
- **Maker edited this run record** to fix frontmatter Governor had malformed — `>-` folded scalars
  that this repository's hand-rolled `scripts/frontmatter.js` does not support — to add `governor`
  to `selected_agents`, and to reword one sentence that literally contained a bracket-paren pair the
  link-integrity regex matched as a link. Code Reviewer confirmed those edits are mechanical and did
  not alter the brief, the success predicate, the selection rationale, or the substance of
  `human_gates`.
- **The root `README.md` was touched**, which was not in the brief's footprint list. Red Hat showed
  the owner's constraint was only half delivered without it: the chain into the work records existed
  but its front door was silent. One line, as a real markdown link, so the link-integrity gate
  resolves it.

## Findings carried forward

- **Round 1's HIGH and both MEDIUMs are fixed**, not carried. Nothing from Red Hat is outstanding.
- Code Reviewer's two LOW observations both conclude "correctly left alone", and are recorded here so
  the reasoning is visible rather than rediscovered: `WORK_RECORD_STANDARD.md` §3.3's sentence and
  its reference-field note remain literally true (generation still happens; only committing stopped),
  and `docs/work/tickets/T283-board-truth-audit-gate.md`'s claim that nothing structurally keeps the
  board truthful is still true and independent of whether the file is tracked.
- Red Hat corrected Governor's own sweep on a point worth keeping: the guarantee that
  `scripts/nextTicketNumber.js` and `checkAll` are unaffected by this file is `readDocs()`'s
  **directory scope** (`docs/work/INDEX.md` sits at `docs/work/` top level, outside every
  `SOURCE_DIRS` entry), not the `EXCLUDED` set Governor had cited. Same conclusion, sounder reason.
- **What decays now that nothing checks.** The old gate guaranteed a fresh board existed in the
  repository. It no longer does, and no gate will ever notice a board that is absent or behind. That
  is the deliberate trade: a generated file that does not exist cannot be wrong, and the committed
  README is what carries a reader instead. If the board is later wanted GitHub-browsable with no edit
  lag, the ADR's rejected Option B is where that conversation restarts — and T283 remains the ticket
  for making board-truth structurally enforced rather than a discipline.

## Open points for the owner

- **The ADR needs acceptance.** `docs/adr/2026-10-01-work-index-is-generated-not-committed.md` is
  `status: proposed` / `implementation_state: in-progress`. `accepted` is a human gate
  (`CONSTITUTION.md` Article IV) and was deliberately not taken here.
- The owner's constraint named two acceptable mechanisms — a committed README pointer, or an index
  regenerated on `main` by a post-merge action. This run chose the README and rejected the action on
  T261's own measured numbers. If live GitHub-browsability is worth a standing `contents: write`
  workflow and a per-merge main-side run, that is a product preference this run could not resolve.
- Two standards sentences were amended on the basis of the board ruling "yes, let the second worker
  take it", read as approval of the outcome. If the owner intended something narrower, the edits are
  `GOVERNANCE_INDEX.md`'s two table cells and `WORK_RECORD_STANDARD.md` §6 — nine lines in total.

## Decision

**PASS** — Verifier PASS with no unresolved UNVERIFIED claims, Grader 4.5 with no dimension below 3.
Not pushed, no PR, no merge, per instruction.

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
