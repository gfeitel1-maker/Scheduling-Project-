---
title: "A stalled dial/authenticate attempt is never cancelled, so a later re-announce races its own late settlement"
document_type: ticket
status: completed
created: 2026-09-18
task_class: concurrency
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
archive_when: "The dial/authenticateWith promise underlying a stalled attempt is actually cancelled or abandoned when ATTEMPT_STALLED fires, so a later re-announce for the same peer starts a genuinely independent attempt rather than racing a still-running one for the same connection"
---

# T230 — a stalled dial/authenticate attempt is never cancelled

## Problem

`electron/sync/automerge/mutualAuth.js`'s `tryAuthenticate` starts a watchdog timer
(`attemptTimeoutMs`, default 30s) when it begins dialing/authenticating a peer. When that timer
fires, `ATTEMPT_STALLED` is emitted and `peerId` is removed from the `attempted` dedupe Set so a
later discovery can retry (see the comment at mutualAuth.js ~143-153).

What the watchdog does **not** do is stop the underlying work. `syncNodeHandle.dial(peerId)` and
`syncNodeHandle.authenticateWith(peerId, ...)` are ordinary `await`ed promises with no
`AbortController` or cancellation wired to them. Firing the timeout only clears the *bookkeeping*
(`attempted`); the original dial/authenticate call keeps running to whatever conclusion it reaches
on its own.

Consequence: once `attempted.delete(peerId)` happens on stall, a later mDNS re-announce for the
same peer is free to start a **second, fully independent** `tryAuthenticate(peerId)` call — its own
attempt id, its own dial, its own stall timer — while the **first** call's `dial`/`authenticateWith`
promise is still pending somewhere in the background. Whichever one settles later can:

- delete `attempted` out from under the newer, still-in-flight attempt (both calls delete the same
  key on their own failure/rejection paths), letting a third re-announce start yet another attempt
  concurrently instead of being deduped;
- (before T212's instrumentation fix landed alongside this ticket) emit a terminal connectivity
  event for the stale attempt after ATTEMPT_STALLED had already been emitted for it, double-counting
  in the exact data the WAN measurement program (T212) depends on being one-event-per-real-outcome.

T212 closed the *observability* half of this on the instrumentation side (a per-attempt correlation
id, and suppressing a terminal event for an attempt that already emitted `ATTEMPT_STALLED`) without
touching the underlying dial/authenticate cancellation — that surgery is real sync-behavior work,
out of scope for an instrumentation-only slice, and is what this ticket tracks.

## Why it matters

Two concurrent attempts against the same peer sharing one dedupe Set is a live-connection race, not
just a metrics nuisance: a "stale" attempt that eventually resolves can still call
`authenticateWith` and mutate shared state (`attempted`, `deniedRecently`) based on an outcome for a
dial the newer attempt has already superseded. On a flaky network — exactly the WAN conditions T212
exists to measure — repeated stalls are the expected case, not an edge case.

## Scope

- Give the watchdog a way to actually abandon (not necessarily hard-cancel at the libp2p layer,
  if that surface doesn't support it — investigate `AbortSignal` support on
  `syncNodeHandle.dial`/`authenticateWith` first) the in-flight promise when it fires, so a later
  attempt for the same peer is not racing a zombie one.
- If the underlying libp2p call genuinely cannot be aborted, at minimum make the stale promise's
  eventual settlement a no-op against shared state (`attempted`, `deniedRecently`) rather than
  letting it mutate bookkeeping a newer attempt now owns — an attempt-id guard on every mutation,
  not just on the emitted event (which T212 already added).
- Add a test that plants two overlapping attempts for the same peer (one stalled-then-late-settling,
  one started after the stall) and demonstrates the newer attempt's own bookkeeping survives the
  older one's late settlement.

## Does NOT count as done

- Suppressing the connectivity *event* for a stale settlement (that part is already done, T212).
- A fix that only prevents the log-level double-count without addressing that `attempted`/
  `deniedRecently` can still be mutated by a stale attempt.

## Cross-reference

Spun off from `docs/work/tickets/T212-wan-connectivity-measurement.md` round 2 (Red Hat finding).
