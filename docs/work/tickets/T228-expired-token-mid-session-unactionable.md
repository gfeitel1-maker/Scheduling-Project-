---
title: "A token that expires mid-session leaves the director retrying an unactionable error forever"
document_type: ticket
status: completed
created: 2026-09-18
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T213-dead-pairing-push-listeners.md]
archive_when: "A locally-expired session discovered at write time routes the director to the login screen with an honest reason, rather than returning the unrecognised-error copy, and a test covers the mid-session expiry path"
---

# T228 — An expired token discovered at write time is an unactionable dead end

## How this surfaced

Spun off from T213 during its closure review. T213 concluded — correctly — that
`shoresh:token-renewed` was a listener for a feature that was never built, and that deleting it was
right. But the closure also claimed the absence of renewal was **benign**, because expiry falls
through to `verifySession` and a clean login prompt. Red Hat attacked that claim and broke it. Every
step was then independently re-verified against the tree before being recorded here.

The removal verdict stands. The *safety claim attached to it* did not.

## The defect

`verifySession` only runs inside `useDeviceMode.js`'s mount-time `init()` effect
(`src/hooks/useDeviceMode.js:118-134`). It does not re-run mid-session, and `onAuthRejected`
(`src/hooks/useDeviceMode.js:184-188`) fires only on an authoritative *Host* rejection over the
wire — not on a local authorization denial. So for a device that stays open, expiry is never
discovered by the session machine at all. `phase` stays `'session'`.

It is discovered instead at the next **write**:

1. `authorize()` calls `verifySessionToken`, which fails on the expired token and returns
   `deny(..., 'invalid_token', ...)` (`electron/auth/authorize.js:21-23`).
2. `requireAuthorized` maps every non-`forbidden` reason to `throw new Error('invalid session')`
   (`electron/main.js:122-130`).
3. `writeErrorMessage` matches only `/admin role required/i`; `describeWriteFailure` then tests
   `UNIQUE`, `FOREIGN KEY`, `NOT NULL`, `WRITE_TIMED_OUT` and `TRANSPORT`
   (`src/utils/writeErrorMessage.js:38-58`). The string `invalid session` matches none of them.

The director gets the genuinely-unrecognised fallback: *"The reason was not something the app
recognised — try again, and if it keeps happening the details are in the log."*

Retrying cannot work — the token is still expired — and nothing on this path calls
`clearSessionState`, so there is no route back to the login screen. The app tells a director to
retry, forever, an action that can never succeed, and never names the one fix (sign out and back
in).

## Why it matters

`TOKEN_TTL_MS` is 24 hours (`electron/auth/localAuth.js:151`). A camp office device left signed in
overnight — the normal case, since nobody logs out — crosses that boundary during the next working
day. The failure lands mid-edit, with copy that gives the director no next step, at exactly the
moment they are least able to absorb a mystery.

This is the same defect *class* as `shoresh:auth-rejected` (T213's precedent): an authoritative
refusal that the director cannot act on because nothing translates it into words plus a route. The
difference is that `auth-rejected` was invisible, and this one is visible but unactionable.

## Candidate shape — not yet decided

Two seams, and the choice between them is real:

- **Narrow:** teach `describeWriteFailure` to recognise `invalid session` and return honest copy.
  Cheap, but leaves the device sitting in a `session` phase it can no longer act in.
- **Whole:** treat a local `invalid session` write denial the way `onAuthRejected` is treated —
  `clearSessionState(BENIGN_SESSION_ENDED_REASON)`, dropping the director to `login` with the
  existing "Your session ended. Please sign in again." string, which already exists and already
  reads correctly for this case (`src/hooks/useDeviceMode.js:19`).

The whole-seam option is the one that matches the existing design intent, but it means a write
failure reaching up into the device-mode hook, which is a new edge. **Architect should settle this
before any implementation** — T213's lesson was that the cheap half of a severed flow reads healthy
on its own.

Building renewal itself (the `localAuth.js:149` "sub-task 3" deferral) is a **separate and larger**
question and is explicitly NOT in this ticket's scope.

## Does NOT count as done

- Recognising `invalid session` in the error mapper while leaving the device stuck in a `session`
  phase with no route to sign in again.
- Any fix without a test that plants a mid-session expiry and asserts the director reaches the
  login screen — the four T87 tests that passed against a device shape the app could no longer
  produce are the standing reason this repo does not accept an untested auth-path claim.

## Resolution

The **whole seam** was chosen (Architect, high confidence): `requireAuthorized`
(`electron/main.js`) — the single chokepoint every mutating handler already passes through — now
also pushes the existing `shoresh:auth-rejected` IPC channel for the `authorize()` denial reasons
that mean the session/device can no longer act (`invalid_token`, `user_not_found`, `device_not_found`,
`device_not_authorized`, `device_revoked`). `useDeviceMode`'s existing `onAuthRejected` listener then
runs `clearSessionState`, dropping the director to the login screen with an honest reason. The
`throw new Error('invalid session')` is unchanged, so the write still rejects and the per-screen
`describeWriteFailure` path still runs (non-swallow). `db_error`, `invalid_action` and
`device_token_not_valid_for_authorization` deliberately do **not** route — they are transient or
caller-bug conditions, not session-ended ones. `describeWriteFailure` also learns `invalid session`
for the residual cases the push cannot cover. No new IPC channel and no renderer state-machine change
were needed; no ADR (extends the T87/T162 reason-code pattern already documented).

Tests: a real mid-session expiry (real login + fake timers past `TOKEN_TTL_MS`) asserts both the
preserved throw and that the routing push fires; a source-derived drift guard asserts every
`authorize()`/`deviceTrust` denial reason is explicitly classified; `describeWriteFailure`'s new
branch is covered with a negative assertion against the fallback. Reviewed by Security (no
vulnerabilities), Red Hat, and Code Reviewer; their round-1 findings (a self-referential drift guard,
and the undocumented `user_not_found`→4401 fallback) were fixed in-loop before merge.
