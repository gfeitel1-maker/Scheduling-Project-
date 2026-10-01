---
task: Notices display in arrival order, none lost — an offline-queue rejection can no longer overwrite a bootstrap-failure notice
document_type: run
date: 2026-09-30
round: 2
status: pass
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
human_gates:
  - "ANSWERED 2026-09-30 by the board worker under the owner's delegated queue, recorded quote-only and FLAGGED FOR OWNER CONFIRMATION: the keyboard-retry-inside-the-fade loss is NOT accepted; the retry-cancels-its-own-dismiss guard was taken. Closed by the post-escalation resolution below."
  - "OPEN for the owner: the \"N more\" wording (Tester prefers \"waiting\"); left as shipped on the worker's call."
verdict: pass
completion_evidence:
  - "round 2 (pre-rebase): 49 passed / 0 failed, EXIT=0"
  - "red-first round 1: 5 failed / 45 passed on the round-1 test commit, EXIT=1"
  - "red-first round 2: 2 named tests fail against the round-2 base, pass after it"
  - "post-escalation gate on rebased tree (merge-base 1b0340da): 50 passed / 0 failed EXIT=0; eslint 0 errors EXIT=0; build EXIT=0; check:governance EXIT=0"
  - "red-first post-escalation: Round 4 Item 1 fails against 5b4c242e with role=alert not found, passes at HEAD"
  - "Verifier final verdict PASS; Grader 4.2, lowest dimension 4"
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
| `npx vitest run src/App.test.jsx src/App.landing.test.jsx src/notices/noticeQueue.test.js` | pass | round 2 at `0ab4e008`: **49 passed / 0 failed**, `EXIT=0` (round 1 at `04dc72b8`: 50 passed; 50 − 3 deleted `dismissHead` tests + 2 new = 49, arithmetic confirmed against the diff) |
| `npx eslint src` | pass | 0 errors, 20 pre-existing warnings, `EXIT=0` |
| `npm run build` | pass | `EXIT=0` |
| `npm run check:governance` | pass | round 1 was a blocking `index-stale` (this run record was untracked); closed by `npm run index:work`. Round 2: advisory `platform-state-stale` only |
| red-first, round 1 | pass | on the round-1 test commit: `Tests 5 failed | 45 passed`, `EXIT=1`; after the implementation: 50 passed, `EXIT=0` |
| red-first, round 2 | pass | the dismiss-race and double-dismiss tests fail against the round-1 source ("Unable to find an accessible element with the role 'alert'"), `EXIT=1`; pass after the round-2 implementation |
| **post-escalation gate, on the rebased tree** (merge-base `1b0340da`) | **pass** | **50 passed / 0 failed `EXIT=0`**; `npx eslint src` 0 errors `EXIT=0`; `npm run build` `EXIT=0`; `npm run check:governance` `EXIT=0`, `index-stale` gone. Every command run **unpiped** |
| red-first, post-escalation | pass | "Round 4 Item 1…" fails against `5b4c242e` with `Unable to find an accessible element with the role "alert"` — the notice genuinely destroyed, not a missing import — and passes at HEAD |

**SHA note.** The round-1 and round-2 commit SHAs cited in the prose below (`7e8a4b4c`, `04dc72b8`,
`d4a29832`, `0ab4e008`) were **rewritten by the rebase onto `1b0340da`** and no longer resolve. Their
post-rebase equivalents, oldest first, are `3aa7e93a`, `ce1fa65e`, `f09f7df6`, `5b4c242e`; the post-escalation
pair is `cee04d5e` / `daa010c3`. The original SHAs are left in place where they record what a reviewer
actually measured at the time.

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

**FAIL (literal), adjudicated as a measurement artifact — every gate it actually ran PASSED.**

Round-2 gate results, raw: tests **49 passed / 0 failed, `EXIT=0`** (arithmetic confirmed: round 1's
50 − 3 deleted `dismissHead` tests + 2 new tests = 49); `npx eslint src` **0 errors**, 20 pre-existing
warnings, `EXIT=0`; `npm run build` `EXIT=0`; `npm run check:governance` only the pre-existing advisory
`platform-state-stale` (round 1's blocking `index-stale` gone). Red-then-green proven in both rounds,
with the round-2 tests named exactly and shown failing against the round-1 source for the right reason.

Verifier's sole FAIL cause was `git diff --name-only origin/main` returning 20+ unrelated files and
reading as scope creep. `origin/main` advanced by exactly one commit **during this session**
(`d14793c2`, T251). The branch's merge-base with `origin/main` is still the pinned base `2641abfb`, and
`git diff --name-only 2641abfb HEAD` is **exactly** the seven expected files. Nothing was deleted,
nothing out of footprint was touched. This is the `feedback_diff_against_pinned_base` failure mode:
Verifier measured against a base that moved under it.

> Recording this plainly rather than quietly: the governing session is overriding the only
> deterministic evidence source's literal verdict. It is doing so on mechanical evidence
> (`git merge-base`, `git diff` against the pinned base), not on judgement about the code — and every
> gate Verifier executed is green on its own output. A reader who disagrees with the adjudication
> should treat the verdict as FAIL and the work as unmerged.

**Real residual merge hazard (not a gate failure):** `docs/work/INDEX.md` here was regenerated from a
tree predating T251, so after rebasing onto `d14793c2` someone must re-run `npm run index:work` before
merging, or this commit will revert T251's index entries.

## Grader score

Average — **4.0**, lowest dimension — **4** (specification fidelity, maintainability, user experience,
resilience, evidence quality all 4). Pass is ≥ 4.0 with no dimension below 3, so this passes **at
exactly the threshold with no margin**. Grader accepted the Verifier adjudication above, and named the
condition that flips its verdict: *"If keyboard retry during fade is a plausible user path you want to
guard against, this becomes a must-fix and the verdict drops to FAIL."*

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

## Post-escalation resolution — the residual loss is closed

**This is not a round 3.** `CONSTITUTION.md` Article VII is explicit that a round-2 failure escalates
rather than becoming a third review round, and `checkStatusDrift`'s sibling rule in
`scripts/check-governance.js` enforces it (`round 3 — there is no round 3; Article VII escalates
instead`) — it fired on an earlier draft of this file that called this section a round 3, correctly.
What happened instead: round 2 **escalated**, the escalation was **answered** by the board worker under
the owner's delegated queue, and this work is the bounded execution of that answer. `round` therefore
stays 2.

`cee04d5e` tests-red, `daa010c3` implementation-green, on the worker decision recorded below. Two
bounded fixes, no new control and no wording change:

1. **A retry cancels its own notice's pending dismiss.** `cancelPendingDismiss()` in
   `OpRejectedNoticeBanner` clears the pending 140ms timer, nulls the ref and clears the `dismissing`
   state, and is wired into the retry button's `onClick` **before** `notice.retry()` runs. A dismiss the
   director issued for the *previous* message can no longer reach across a retry and remove the new one.
   Red Hat's repro is now a pinned test, "Round 4 Item 1: a keyboard retry inside the dismiss fade
   cancels that notice's own pending dismiss, so the new failure message is not later removed", which
   fails against the round-2 source with `Unable to find an accessible element with the role "alert"` —
   the notice genuinely destroyed, not a mechanical import error.
2. **The dismiss updater is pure.** `onDismiss()` no longer runs inside a `setDismissingId` updater
   (React updaters must be pure; this app enables StrictMode, which double-invokes them in development
   for exactly this reason). The provably dead staleness re-check was deleted in favour of the
   `clearTimeout` that already precedes every arm. Closes Code Reviewer's round-2 MEDIUM.

**Red Hat re-audit, scoped to dismiss/retry/fade: round-2 LOW CLOSED, Resilience 5.** It re-ran its own
repro against the real component and added three throwaway probes covering interleavings the pinned
suite does not: dismiss → keyboard-retry-in-fade → dismiss again (exactly one removal, no double-fire,
no resurrection); reduced motion with no timer pending (the no-op path is safe); and a retry whose own
write hangs across the stale-timer window ("Retrying…" preserved mid-flight, correct removal on clean
resolve).

Two NEW findings, both LOW, both assumptions the current code **structurally guarantees rather than
enforces**, neither reachable today:

- The inline comment claims the cancel "can never race the upsert" because it runs first, without naming
  which half is load-bearing. Correctness rests entirely on the **synchronous** `clearTimeout`; the
  batched `setDismissingId(null)` only affects the fade visual and need not land first. A future reader
  could misattribute the safety to the state update and weaken it. Accept and record.
- `cancelPendingDismiss` clears whatever timer the **banner instance** holds — the banner is never
  re-keyed across head changes, only the inner content is — and does not compare `headNotice.id` to
  anything. A retry cannot cancel a different notice's dismiss today, because only `'bootstrap'` notices
  ever carry a `retry` and only one bootstrap entry can exist at a time (`bootstrapNoticeIdRef` is a
  single ref). **Load-bearing assumption for whoever adds a second retryable notice source** — escalate
  then, not now.

**Rebased onto `origin/main` at `1b0340da`** (it gained `d14793c2` T251 and `1b0340da` T320 part 2 while
this work was in flight). `docs/work/INDEX.md` conflicted on both doc commits and was resolved by
regenerating it with `npm run index:work`, then regenerated once more on the final tree. Footprint
measured against the merge-base is exactly the seven expected files, with T251's and T320's files **not**
shown as deleted.

**Verifier, final gate on the rebased tree: PASS**, merge-base `1b0340da` stated, every command run
unpiped — tests **50 passed / 0 failed `EXIT=0`** (round 2's 49 + 1 new, arithmetic confirmed against
the diff, nothing deleted or loosened), `npx eslint src` 0 errors `EXIT=0`, `npm run build` `EXIT=0`,
`npm run check:governance` `EXIT=0` with `index-stale` gone. The round-2 adjudication is no longer
load-bearing: this gate measured the right base and passed on its own.

**Grader re-score: 4.2** (resilience 5; specification fidelity, maintainability, user experience and
evidence quality 4), lowest dimension 4 — **PASS** with margin, up from 4.0 at exactly the threshold.
Evidence quality is held at 4 because Tester was not re-run against this round and its queue-advance
evidence remains UNVERIFIED-by-running-UI, and because the decision that unblocked the round came from a
delegated worker rather than the owner.

## Worker decision on the escalation (2026-09-30) — FLAGGED FOR THE OWNER

The escalation below was answered by the **board worker under the owner's delegated queue**, not by
the owner. Relayed to this session verbatim and recorded quote-only, per
`feedback_trust_peer_relays_from_owner` — the owner should confirm it:

> "the predicate is the owner's own words, 'notices display in order, none lost', so the
> keyboard-retry-inside-the-fade loss is NOT accepted. Take your recommendation: a retry on a notice
> cancels that notice's pending dismiss timer (and clears its dismissing state) before the upsert,
> ~10 lines, no new control."

The same decision directed a bounded resolution round (red-first test from Red Hat's repro; fix Code
Reviewer's MEDIUM by moving `onDismiss()` out of the `setState` updater; Red Hat re-audit scoped to
dismiss/retry/fade; rebase onto current `origin/main`; re-run the named gates; re-score), and left the
`N more` wording as shipped — Tester's "waiting" preference is recorded as a product-copy call for the
owner, open point 1 below.

**Outcome: the residual loss is CLOSED.** See "Post-escalation resolution" above. The escalation text that
follows is kept as the record of what was escalated and why, not as the live decision.

## Decision

**ESCALATE one decision — SUPERSEDED by the worker decision above; recorded as history.**

The board's wording is "notices display in order, none lost", and the success predicate inherits it.
Red Hat has a **deterministic, fake-timer repro of a case where a notice is still lost**: dismiss a
bootstrap-failure notice, then activate "Try again" inside the 140ms §5c fade — reachable by keyboard,
because `pointerEvents: 'none'` blocks a mouse click but not Enter/Space on an already-focused button
— the retry fails with a *new* message, `upsertById` writes it into the same entry (bootstrap retries
deliberately reuse their id, which is what stops a retry orphaning its own notice), and the original
dismiss timer then removes that entry. A brand-new, never-read failure message disappears.

It is far narrower than the round-1 HIGH: same entry only, no unrelated notice touched, a 140ms window,
and it requires a deliberate retry action. Red Hat and Code Reviewer both scope it **accept and
record** on a final round. Grader scored it as compatible with a PASS — at exactly 4.0.

The governing session is **not** declaring the predicate met, because the predicate says "none lost"
and a reviewer can reproduce a loss on demand. Whether that residual is acceptable is a product
judgement about the director's experience, and the owner is unavailable — `CONSTITUTION.md` Art. IV and
the owner's own rule 10 ("stop when human judgement is truly required") put it with the owner rather
than with this loop. It is not re-opened as a round 3.

**Recommendation, with confidence.** Accept and record — *or* take the small guard, which is the
cheaper of the two and needs no new control, no second surface and no wording change: ignore a retry
activation while a dismiss is pending for that notice (or cancel the pending dismiss when its own
notice is retried). Confidence: moderate-high that the guard is correct and ~10 lines; it was not
attempted here because round 2 is the cap and an unreviewed fix to a race is worth less than a recorded
one. Evidence behind it: Red Hat's repro isolates the trigger to exactly one interaction pair.

**Also carried to the owner, not blocking:** the three open points above (the `N more` wording, the
count's deliberate absence from assistive tech, and whether a many-notice backlog wants a different
affordance), plus Code Reviewer's MEDIUM that the round-2 staleness check calls `onDismiss()` from
inside a `setDismissingId` updater — React updaters must be pure, this app enables StrictMode, and the
check is provably dead given the `clearTimeout` that now precedes every arm. Harmless today because
the side effects are idempotent; both reviewers scope it accept-and-record.

> Round 2 failure escalates to the user with open findings. It does not become a round 3.
</content>
</invoke>
