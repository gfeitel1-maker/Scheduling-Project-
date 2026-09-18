---
title: "Residual findings from the libp2p 3.x migration: stream-close race, dead it-pipe dependency, and what same-version tests cannot see"
document_type: ticket
status: open
created: 2026-09-17
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T215-libp2p-3x-upgrade.md]
related_adrs: [docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md]
archive_when: "The cross-version interop run has happened, the authenticateWith close race is either proven benign or fixed, and it-pipe is removed or its retention justified"
---

# T217 — Residual findings from T215

**Item 3 closed 2026-09-18, items 1 and 2 remain open.** `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md`
records the owner's decision that Shoresh does not promise mixed-version replication, which removes
the premise of item 3 below (cross-version interop is now out of scope rather than untested) — see
the ADR for why this is a decision, not a demonstration, and for two side findings (a pairing
join-approval race, and a same-version harness hang) that surfaced during the one cross-version
interop attempt made and are recorded there rather than here, since neither is specific to this
ticket's residual-findings scope. Items 1 (`authenticateWith` close race) and 2 (dead `it-pipe`
dependency) are unaffected by that decision and stay open; this ticket's `status` therefore stays
`open` until they close too.

Raised by `red-hat` on the libp2p 3.x migration. The one **HIGH** finding it found —
an unbounded `onDrain()` wait that wedged a sender forever when a peer stopped reading — was fixed
in T215 itself (`DRAIN_TIMEOUT_MS`, bounded via the `AbortSignal` that `onDrain` already accepts,
with a test proving a never-draining stream now rejects rather than hangs). These are what is left.

## 1. `authenticateWith`'s `finally { await stream.close() }` may race an in-flight reader — MEDIUM

`transport.js`. The outer promise resolves on the **first decoded frame**, but `receiveFramed`'s
`for await` over `decode(stream)` is a separate, unawaited iteration still running underneath. The
`finally` closes the stream immediately on settle, so a close can land while the reader is still
mid-iteration.

Benign today: `AUTH_PROTO` responses are a single frame. It stops being benign the moment anything
pipelines a second frame on that stream. Two swallowed errors stack on the same teardown — the
`.catch(() => {})` on `close()` and the `.catch()` on `receiveFramed` — so the failure would be
silent.

Note `security` reviewed the same code and reached the opposite conclusion (that `await` on the
try's return value means close cannot truncate). **Both readings are recorded deliberately rather
than one being picked** — they disagree about whether the unawaited iterator matters, and that is
the question to settle, with a test that sends two frames on one `AUTH_PROTO` stream.

## 2. `it-pipe` is now a dead dependency — LOW

`wireProtocol.js` was its only consumer; the migration removed that import. Confirmed by grep: no
file under `electron/`, `src/`, `scripts/` or `test/` imports it. Left in `package.json` during T215
to avoid lockfile churn on a security fix. Remove it, or record why it stays — a future engineer
auditing the stream model will otherwise reasonably infer the pipe-based model is still live
somewhere.

## 3. What same-version tests structurally cannot see — the honest list — CLOSED, out of scope

**Closed 2026-09-18, not demonstrated.** `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md`
decided that Shoresh does not promise 2.x↔3.x interop, so the gap this section describes is out of
scope rather than an open risk to close by testing. The list below is left as-is as the historical
record of what was known at the time; do not read its continued presence as an open item.

Every test in T215 runs 3.x against 3.x, and once `package.json` carries only the 3.x line, **2.x↔3.x
interop is not testable in this repo at all**. Blind spots, stated so nobody mistakes a green suite
for coverage:

- **Real Yamux v8 flow-control/window behaviour.** `wireProtocol.test.js` exercises hand-written
  fakes matching the test author's understanding of the v3 `Stream` interface — not a real stream,
  real Noise, or a real socket. Yamux's initial window size is negotiated in-band *after* protocol
  selection, so it is invisible to the protocol-ID equality check that the upgrade's safety argument
  rests on. **This is the most likely "connects, then misbehaves" shape.**
- **2.x↔3.x interop**, including whether a 3.x sender's backpressure accounting matches a 2.x peer's
  window-update cadence. The dangerous shape: the connection stays up, some frames stall behind
  `onDrain()`, and Automerge — designed to tolerate a lossy transport — reports nothing wrong
  because from its point of view a message simply never arrived. Silent non-convergence.
- **Real close/reset races** during an in-flight `receiveFramed` (finding 1).
- **Real backpressure under OS socket pressure** near `MAX_FRAME_BYTES`; the large-payload test uses
  an in-memory array.
- **Connection-upgrade ordering and identify payload differences** across the major.

## The test that settles most of this already exists

`test/integration/harnessAutomerge.js` exports `setupTwoJoinedDevices` / `partitionClients` /
`healPartition`, and **`startSyncNode` is injectable per node** — so device A and device B can be
constructed from different checkouts. That is exactly the seam a cross-version run needs: two
checkouts at different versions, two node processes, one machine over loopback. It is exercised in
anger by `test/integration/scenarios/31-derived-id-convergence.automerge.js`.

**Sequenced deliberately after T215 merges**, not before: the upgrade closes a live HIGH advisory and
should not wait on an interop harness.

## Evidence from T194's gate (added 2026-09-17 by T194, not by this ticket's owner)

T194 (the participant data substrate) rebased onto `8825015` and gated: all seven `verify` steps
green. Relevant here, **scenario 31 passes under libp2p 3.3.11** — two devices, real partition,
concurrent writes of the same logical row, heal, converge — exercising the
dial / framed-exchange / close / reconnect lifecycle the bump changed.

It is worth something because the harness drives **real `startSyncNode` nodes and fakes no
streams**: a sweep of `test/**` for callable sinks and unawaited iterators found none on T194's
side, so this is the real transport rather than a fake that could have gone stale against the new
interface. It is also a different exercise from T215's own suite — a schema-bearing branch with
seven new synced entities at v66 replicating a document through the new transport. T215's suite
proves the transport works; this proves it works carrying a payload it had not carried before.

**The limit, as plainly as the result:** it is single-version throughout, 3.3.11 on both nodes. It
says nothing about 2.x↔3.x, and it does not touch the Yamux in-band window-negotiation question in
section 3 — which remains the most likely "connects, then misbehaves" shape. The cross-version run
still needs a second checkout at `08e971b` with its own `npm ci`, and it is **open and unowned**:
the session that claimed it has ended. The seam it needs is the one already named above.

## Does NOT count as done

- Declaring interop verified on the strength of a same-version suite.
- Resolving finding 1 by picking whichever of the two reviewers sounds more confident, instead of
  writing the two-frame test that distinguishes them.
