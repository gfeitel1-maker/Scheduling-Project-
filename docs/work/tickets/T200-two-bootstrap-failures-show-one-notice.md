---
title: "Two simultaneous camp-bootstrap failures collapse into one notice, so the director is told about only one of them"
document_type: ticket
status: completed
created: 2026-09-17
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
depends_on: "T12 (established the single-scalar notice slot this ticket revisits). T190 (added the second of the two concurrent writers to that slot). Sibling of T201, which fixes the retry half of the same seam."
archive_when: "A camp bootstrap in which both seedDays and ensureCohort fail on the same tick produces one notice naming BOTH failures, covered by a test proven to fail without the fix, and `npm run verify` is green"
---

# T200 — two simultaneous bootstrap failures show one notice

## Confirmed problem (verified against `main` at 340c995)

`src/App.jsx:226-250` dispatches `seedDays(campId)` and `ensureCohort(campId)` together in one
effect. Each `.catch` calls `setOpRejectedNotice` — a **single scalar** state slot
(`src/App.jsx:187`). The two promises are concurrent by construction, so a cause that fails both
(a dead IPC channel, a disk error, a camp-id mismatch — all three of which are shared failure modes
of the pair) fires both catches on the same tick. The second `setOpRejectedNotice` replaces the
first. The director is told the cohort could not be set up and never learns the weekdays failed
too, or the reverse.

This is the first-mount path for every new camp, so the failure mode is not exotic: it is what a
director sees the first time anything goes wrong at bootstrap.

## This ticket revisits a documented accepted tradeoff

The single-scalar behaviour is deliberate, not an oversight. `src/App.jsx:184-186` records it:

> Single scalar, not a queue: a second rejection while one is already showing replaces it rather
> than stacking. Accepted as adequate for this minimal notice (T12) — a real queue is out of scope
> here.

**What changed is the premise, not the code.** T12 accepted last-writer-wins when the notice had
exactly **one** source: the offline-queue flush (`localClient.onOpRejected`), an event that arrives
alone and asynchronously. There are now **three** sources — that subscription, plus the two
bootstrap catches added by the seedDays fix and T190 — and two of the three fire *concurrently by
construction* on every first mount of a camp. Last-writer-wins is sound when writers are serialised
by their nature; it is not sound when two writers race by design. The tradeoff was correct for its
premise; the premise no longer holds.

## What this ticket is NOT

It does not license building the toast/queue framework T12 explicitly refused. The target is the
**minimum that makes two concurrent bootstrap failures both legible**. If the honest fix turns out
to be a real queue, that is an escalation to the owner, not something to land under this ticket.

## The open design question this ticket must answer

Is replacement still correct for the *unrelated* offline-queue rejections, which are not part of
the bootstrap pair? Answer it explicitly in the implementation, with reasoning, rather than
changing that path by accident.

## Success predicate

- A bootstrap in which **both** calls reject produces a single notice that names **both** failures,
  each with its own `describeWriteFailure` cause.
- A bootstrap in which **one** rejects is unchanged in wording from today.
- The offline-queue (`onOpRejected`) path's behaviour is unchanged unless the ticket argues
  otherwise on the record.

## Does not count as done

- Stacking notices / a notice queue / a toast framework.
- A combined message that drops either failure's specific cause in favour of a generic summary.
- A test that passes with the fix reverted.

## Known limits accepted in round 2

Round 2 review (Red Hat) flagged that an unrelated `onOpRejected` notice (the offline-queue
rejection path) can still replace a live bootstrap-failure notice — including one with a retry
affordance still pending — because both still write into the same single-scalar notice slot under
last-writer-wins.

This is accepted, not fixed, here. It is the T12 last-writer-wins limit this ticket already
narrowed, not reopened: the bootstrap pair (seedDays + ensureCohort) no longer races *itself* — that
was this ticket's whole premise — but the bootstrap pair and the offline queue are still two
independent sources sharing one scalar, and building real isolation between them (a notice queue,
or per-source slots) is exactly the toast/queue framework T12 and this ticket's "What this ticket is
NOT" section both explicitly ruled out of scope. See `src/App.jsx`'s `runBootstrap` comment for the
in-code pointer to this limit.

## Known limits accepted in round 3

Round 2's self-reopen-after-dismiss defect (dismissing the notice while one of the two writes was
still pending, then having that write settle and silently reopen the notice) is now FIXED — a
`dismissedRef`, reset at the start of each `runBootstrap` invocation, makes `recompose()` a no-op
once the director has dismissed that invocation's notice; a brand new retry starts undismissed.

What remains accepted, not fixed: an unbounded IPC hang still cannot be retried away from within the
app. `localClient.write` is `ipcRenderer.invoke` with no timeout (`src/localClient.js:61-62`), so if
`seedDays` or `ensureCohort` never settles, `bootstrapInFlight` never clears and every subsequent
"Try again" click can only report that the previous attempt has not finished — it cannot cancel or
route around the hang. The only recovery is restarting the app (a fresh `AppShell` instance gets a
fresh `seededForCamp` ref, so the mount-time bootstrap genuinely retries — see the code comment at
`seededForCamp`'s declaration in `src/App.jsx`). A real fix — a client-side IPC timeout, or a
`UNIQUE` constraint on `days_of_operation` so a duplicate seed after a hang is harmless instead of
dangerous — is a schema/IPC change out of scope for this ticket.

## Round 4 (owner ruling 2026-09-29: yes to t200)

**The limit accepted in round 2 is now closed.** Round 2 recorded that an unrelated `onOpRejected`
notice could still replace a live bootstrap-failure notice — retry affordance and all — because both
sources wrote into one single-scalar slot under last-writer-wins, and that building real isolation
between them meant the notice queue this ticket's "What this ticket is NOT" section had ruled out of
scope. That section also said a real queue would be an escalation to the owner. The owner ruled on
2026-09-29, verbatim: "yes to t200". Board item `q-t200-notice-queue`, note verbatim: "The
offline-queue rejection notice could overwrite a bootstrap-failure notice, losing it. Previously
ruled out three times; owner now says yes. Notices display in order, none lost."

**How it was closed.** The single scalar (and the separate `noticeRetry` slot) became one ordered FIFO
queue of `{ id, message, retry, source }` entries in `AppShell` state, with the pure operations in
`src/notices/noticeQueue.js` so the reducer is pinned without React. The banner renders the **head
only** — one notice on screen at a time, the same §5c visual and motion — and Dismiss advances to the
next. A bootstrap `recompose()` upserts its own entry by id (so days-then-cohort composition still
yields one bootstrap notice, in its arrival position) and removes only that entry when the bootstrap
resolves clean; an offline-queue rejection appends. The retry now lives **on the notice object**, so
nothing arriving ahead of or behind a bootstrap notice can strip its "Try again". When notices are
waiting behind the head, the banner shows a plain `N more` text token in its existing actions row —
one token, no new control, no second surface, no explainer.

**The queue is id-keyed throughout, deliberately.** Round 1 of this work implemented dismissal
positionally (`queue.slice(1)`) while every other mutator was id-keyed, and the dismiss path is also
the only one deferred — by the §5c 140ms fade. Red Hat confirmed the resulting loss: dismiss a
bootstrap notice that has another notice queued behind it, let the still-pending bootstrap write
resolve cleanly inside the fade window (which removes the bootstrap entry by id), and the deferred
dismiss then removes whatever has *since* become head — an unread offline-queue rejection, gone. That
is the exact failure this ticket exists to prevent, so `dismissHead` was deleted and dismissal now
removes the captured notice **by id**, making a dismiss of an already-removed entry a harmless no-op.
Both the race and a rapid double-dismiss are pinned by tests proven to fail against the round-1
implementation.

**What remains accepted, not fixed.** The round-3 limit is unchanged: an unbounded IPC hang still
cannot be retried away from within the app. New to this round: because "none lost" is the owner's
stated requirement, the queue is **uncapped and does not de-duplicate** — an offline queue flushing
many rejections at reconnect enqueues one notice per rejection, each needing its own dismiss. A cap or
a de-duplicating fold would violate the ruling, so the consequence is recorded rather than mitigated.
Whether `N more` is the clearest wording for the waiting count, and whether a many-notice backlog
wants a different affordance, are product questions left for the owner; see the run record's open
points.

Run record: `docs/work/runs/2026-09-30-t200-notice-queue.md`.
