---
task: Notices display in arrival order, none lost — an offline-queue rejection can no longer overwrite a bootstrap-failure notice
document_type: run
date: 2026-09-30
round: 1
status: in-progress
task_class: ui-ux-design
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/DESIGN_STANDARD.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
related_tickets:
  - docs/work/tickets/T200-two-bootstrap-failures-show-one-notice.md
  - docs/work/tickets/T201-transient-bootstrap-failure-is-never-retried.md
  - docs/work/tickets/T204-notice-banner-misses-two-design-standard-requirements.md
related_specs:
  - docs/work/runs/2026-08-15-locations-m3c-merge.md
  - docs/work/runs/2026-09-17-fix-meet-design-standard-5c-on-the-op-rejected-notice-banner.md
related_adrs:
  - docs/adr/2026-08-15-locations-concurrent-create-collision.md
selected_agents: [governor, designer, maker, code-reviewer, red-hat, tester, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: React component state shape only — no persisted data, no schema version, no IPC or wire contract, no module boundary other code calls.
  - agent: security
    reason: no-predicate
    note: no auth, PIN, token, IPC handler, secret, packaging or transport surface in the footprint; the change is renderer-local display ordering of strings the renderer already composes.
deterministic_checks:
  - npx vitest run src/App.test.jsx src/App.landing.test.jsx src/notices/noticeQueue.test.js
  - npx eslint src
  - npm run build
  - npm run check:governance
human_gates: []
verdict: null
completion_evidence: []
archive_when: the queue behaviour is covered by the pinned tests in src/ and T200's round-4 section is merged to main
---

# Run: the notice surface becomes an ordered queue

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** when two things go wrong close together — the camp's default weekdays fail to
seed, and an offline change is rejected when the queue flushes — the director sees both, one at a
time, in the order they happened. Today the second silently replaces the first, and the first one's
"Try again" button disappears with it.

**Success predicate:** an offline-queue rejection can no longer overwrite a bootstrap-failure
notice; notices display in arrival order, one on screen at a time, none lost; the bootstrap notice
keeps its retry affordance regardless of what else arrives; the red-first test the board names
passes; the existing App tests pass; the named gates exit 0.

**What does not count as done:** a second visible surface; stacked/simultaneous notices; auto-dismiss
timers; any help text or explainer; a queue that drops a bootstrap notice when the bootstrap
resolves clean while a different notice is at the head (it must remove only its own entry).

## Owner ruling

2026-09-29, verbatim: "yes to t200". Board note, verbatim: "The offline-queue rejection notice could
overwrite a bootstrap-failure notice, losing it. Previously ruled out three times; owner now says
yes. Notices display in order, none lost."

The owner was not available during this run. Product questions were self-answered from this brief and
the repo per the dispatching session's instruction; anything genuinely unresolvable is recorded under
"Open points" below rather than guessed at in code.

## Task class and what it pulls in

`ui-ux-design` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `docs/governance/standards/DESIGN_STANDARD.md` (§5c recoverable-error notice, §8 motion/reduced-motion) |
| Mandatory gates | test · lint · build (plus `check:governance`, because this run adds docs) |
| Human gate | changing a token *value* — **not triggered**; no token value is changed, only existing tokens are consumed |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | `not-applicable` — component state shape, no persisted data, no contract other modules call |
| Designer | yes | the change alters what a director sees (a waiting-count token, and dismiss now advances rather than clears) |
| Maker | yes | implementation |
| Code Reviewer | yes | the single-scalar invariant is load-bearing across three writers and a fade-timer; plan alignment matters |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | yes | director's-eye on the advance-on-dismiss behaviour and the count token |
| Security | no | `no-predicate` — no auth/IPC/secret/transport surface in the footprint |
| Red Hat | yes | the whole point is a sequence that loses a notice; adversarial sequencing is the core risk |
| Grader | yes | calibrated score |

Every one of the ten appears here. An omission needs a reason from the enum; "seemed unnecessary"
is not one, it is a rule 8 challenge.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| `npx vitest run src/App.test.jsx src/App.landing.test.jsx src/notices/noticeQueue.test.js` | pending round-2 Verifier | round 1 at `04dc72b8`: 50 passed, `EXIT=0` |
| `npx eslint src` | pass | 0 errors, ~20 pre-existing warnings, `EXIT=0` |
| `npm run build` | pass | `EXIT=0` |
| `npm run check:governance` | round 1 FAIL → re-run | `index-stale` (this run record was untracked); closed by `npm run index:work` |
| red-first, round 1 | pass | at `7e8a4b4c`: `Tests 5 failed | 45 passed`, `EXIT=1`; at `04dc72b8`: 50 passed, `EXIT=0` |
| red-first, round 2 | pass | the dismiss-race and double-dismiss tests fail at `04dc72b8` ("Unable to find an accessible element with the role 'alert'"), `EXIT=1`; pass at `0ab4e008` |

**Evidence note.** Maker's round-1 report claimed `EXIT=0` on a vitest run with 5 failures. Verifier
re-ran it and measured `EXIT=1`. `npx vitest run` does exit non-zero on failure; the round-1 exit code
was mis-captured, not an anomaly in the tool. Caught because the governing session treated a green
exit code on a failing run as the first thing to settle rather than as a curiosity.

## Rounds

**Round 1** (`7e8a4b4c` tests-red, `04dc72b8` implementation) — the queue landed and the board's own
scenario went red-then-green, but reviewers found that dismissal was implemented **positionally**
(`dismissHead` = `queue.slice(1)`) while every other mutator was id-keyed, and dismissal is also the
only path deferred by the §5c 140ms fade. Red Hat CONFIRMED the loss by running the real module: with
an offline notice queued behind a bootstrap notice, dismiss the bootstrap head, let the still-pending
bootstrap write resolve cleanly inside the fade window (`recompose()` removes the bootstrap entry by
id), and the deferred dismiss then slices off whatever has *since* become head — the unread offline
rejection. The change's single purpose, defeated by its own dismiss path. RETRY.

**Round 2** (`d4a29832` tests-red, `0ab4e008` implementation) — dismissal is now id-keyed: the handler
captures the dismissed notice's id and calls `removeById`, so a dismiss of an already-removed entry is
a no-op. `dismissHead` was deleted from the module (exported surface is now `enqueue`, `upsertById`,
`removeById`) and the header comment records *why* the queue is id-keyed throughout. Also fixed: a
pending dismiss timer is cleared before a new one is armed and the deferred callback is guarded (two
reviewers flagged that round 1 deleted the pre-existing stale-timer guard without replacement — and
`pointerEvents: 'none'` does not block keyboard activation of the Dismiss button, nor does jsdom
honour it); and `bootstrapNoticeIdRef` is now nulled when its entry leaves the queue, so rule (f)'s
id comparison does real work instead of silently collapsing into `source === 'bootstrap'`.

## Verifier verdict

PASS / FAIL / UNVERIFIED —

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average — , lowest dimension — . Pass is ≥ 4.0 with no dimension below 3.

## Findings carried forward

- **A two-document ticket mis-citation.** `src/App.jsx`'s notice comments credit "(T12)" with
  establishing the single-scalar notice slot, and `docs/work/tickets/T200-two-bootstrap-failures-show-one-notice.md`'s
  own `depends_on` makes the same claim — but `docs/work/tickets/T12-schedule-grid-dnd-degraded.md` is
  about drag-and-drop in the installed app. The notice slot was actually introduced in the remediation
  round recorded by `docs/work/runs/2026-08-15-locations-m3c-merge.md`, under
  `docs/adr/2026-08-15-locations-concurrent-create-collision.md`. Left untouched deliberately: fixing
  it means editing a completed ticket's `depends_on` and several code comments on a claim this run
  could not independently resolve to the right number.
- **The duplicate-name rejection may not reach the notice it was written for.** Tester triggered a
  duplicate location name in the `:5200` dev mock and saw the generic "That location could not be
  added. The reason was not something the app recognised…" rather than the
  `onOpRejected` handler's "A location named "X" already exists and wasn't created." Either the mock's
  `UNIQUE_FIELD_ENTITIES` path did not fire `opRejectedListeners`, or another handler catches first.
  Outside this footprint (`src/localClient.mock.js`), not chased. If real, the specific wording this
  notice surface was built to deliver is unreachable in dev.
- **An uncapped queue is the owner's stated requirement and has a cost.** A reconnect storm that
  flushes many rejections enqueues one notice per rejection, each needing its own dismiss (~140ms fade
  apiece). No cap and no de-duplication, because "none lost" forbids both. Recorded, not mitigated.
- **Untested-but-correct-by-inspection:** rule (h) (`bootstrapBusy` cannot render "Retrying…" on a
  non-bootstrap head) has no test for the one interleaving where it does work — an offline notice ahead
  of an in-flight bootstrap retry. Code Reviewer rated this LOW and trivially correct by inspection.

## Open points

Self-answered from the brief and the repo where the code settled the question; these are the ones it
could not. None blocks the success predicate.

1. **Is `N more` the right wording for the waiting count?** Designer specified it (one text token, no
   inflection, never shown at depth 0). Tester, reading as a director, found it terse — "1 more what?"
   — and suggested `1 waiting` as clearer in the same number of words. Not changed: it is product
   wording, no help text or tooltip is permitted, and the token is `aria-hidden` so nothing is lost to
   assistive tech either way. Owner's call.
2. **Should the count be available to assistive tech at all?** Designer deliberately put it outside the
   `role="alert"` live region (`aria-hidden="true"`) because `role="alert"` is implicitly atomic, so a
   queue-depth change would re-announce the whole message and retry label for information the user
   cannot act on. The consequence is that a screen-reader director learns of a waiting notice only by
   dismissing the current one. Defensible, but it is an accessibility tradeoff made without the owner.
3. **Does a many-notice backlog want a different affordance?** Designer flagged, separately from its
   spec, that FIFO-with-count gives no way to skip a stale notice blocking a more urgent one, and that
   if depth regularly exceeds 2 the owner may want to revisit. Not sized, not specced, correctly kept
   out of the spec.
4. **Branch naming.** The brief asked for branch `claude/t200-notice-queue`. That branch already
   existed and was checked out in the dispatching session's own worktree
   (`.claude/worktrees/epic-feistel-0fa079`) at the same base commit `2641abfb`, so git refused a
   second checkout. The work is on this worktree's branch
   `worktree-agent-af5849f4010b76963`, which shares that base and has not diverged — the dispatching
   session can fast-forward `claude/t200-notice-queue` onto it.

## Decision

PASS / RETRY / ESCALATE —

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
</content>
</invoke>
