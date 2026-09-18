---
title: "Residual findings from the libp2p 3.x migration: stream-close race, dead it-pipe dependency, and what same-version tests cannot see"
document_type: ticket
status: closed
created: 2026-09-17
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T215-libp2p-3x-upgrade.md]
related_adrs: [docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md]
archive_when: "All three items are closed: item 3 by ADR 2026-09-18 (mixed-version replication out of scope), item 1 by the two-frame experiment proving the close race does not occur, item 2 by removing it-pipe from package.json"
---

# T217 — Residual findings from T215

**CLOSED 2026-09-18. All three items resolved.** Item 3 by owner decision (below); item 1 by
experiment — the close race **does not occur**, and the concern is proven unfounded rather than
fixed; item 2 by removing the dependency. See each section for the evidence.

**Item 3 closed 2026-09-18.** `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md`
records the owner's decision that Shoresh does not promise mixed-version replication, which removes
the premise of item 3 below (cross-version interop is now out of scope rather than untested) — see
the ADR for why this is a decision, not a demonstration, and for two side findings (a pairing
join-approval race, and a same-version harness hang) that surfaced during the one cross-version
interop attempt made and are recorded there rather than here, since neither is specific to this
ticket's residual-findings scope. Items 1 (`authenticateWith` close race) and 2 (dead `it-pipe`
dependency) were unaffected by that decision and were closed separately, below.

Raised by `red-hat` on the libp2p 3.x migration. The one **HIGH** finding it found —
an unbounded `onDrain()` wait that wedged a sender forever when a peer stopped reading — was fixed
in T215 itself (`DRAIN_TIMEOUT_MS`, bounded via the `AbortSignal` that `onDrain` already accepts,
with a test proving a never-draining stream now rejects rather than hangs). These are what is left.

## 1. `authenticateWith`'s `finally { await stream.close() }` may race an in-flight reader — CLOSED, NOT REAL

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

### Settled 2026-09-18: the race is not real. `security`'s conclusion held; the reasoning did not.

The two-frame test was written first, against real libp2p 3.3.11 nodes over loopback —
`electron/sync/automerge/transportAuthCloseRace.test.js`. It is **green**, and no production code
changed as a result. The second frame survives the close in every variant tried, including the
strictly harder one where it is sent 300ms AFTER the dialer has already closed.

**Why it cannot occur**, which is the part neither review had. `AbstractStream.close()`
(`@libp2p/utils/dist/src/abstract-stream.js`) closes the **writable half only**: it sets
`writeStatus`, waits for the write queue to idle and drain, calls `sendCloseWrite()`, and returns.
It never assigns `readStatus` and never touches `readBuffer`. The method that discards unread
inbound data is the *separate* `closeRead()`, whose first act is
`this.readBuffer.consume(this.readBuffer.byteLength)` — and `close()` does not call it. The read
side ends only when the **remote** closes its write half
(`remoteWriteStatus === 'closed'` → `maybeDispatchEnd`). So there is no window to race: a local
close does not and cannot terminate the local iteration.

Note this is *not* `security`'s stated reason. `security` argued that the `await` on the try's
return value means close cannot truncate. That argument is about ordering, and ordering is not what
saves this code — the 300ms-delayed-frame case shows the reader still receiving data long after the
close has both been called and returned. Right conclusion, wrong mechanism; had the mechanism been
the ordering, `red-hat` would have been correct.

**The test is non-vacuous, and that is asserted rather than assumed.** Two control cases exercise
teardowns that DO truncate: `closeRead()` drops a later frame, and `abort()` drops it and surfaces
an error to the reader. Both are asserted in the same file. Without them the green result would be
compatible with a test that could never fail.

**Why the test stays even though nothing was fixed.** `AUTH_PROTO` responses are one frame, so this
property is invisible through `authenticateWith`'s public API — a future libp2p upgrade could
change `close()`'s semantics, or a future protocol change could pipeline a second frame, and either
would be silent (both error paths on that teardown are swallowed by design). The test is the thing
that would notice. A short comment at the `finally` in `transport.js` points to it.

**No fix was manufactured to justify the ticket.** The correct outcome of a characterization
experiment that comes back green is a characterization, not a change.

## 2. `it-pipe` is now a dead dependency — CLOSED, REMOVED

`wireProtocol.js` was its only consumer; the migration removed that import. Confirmed by grep: no
file under `electron/`, `src/`, `scripts/` or `test/` imports it. Left in `package.json` during T215
to avoid lockfile churn on a security fix. Remove it, or record why it stays — a future engineer
auditing the stream model will otherwise reasonably infer the pipe-based model is still live
somewhere.

### Removed 2026-09-18, after an independent three-tool sweep

The ticket's premise held. Re-verified against the current tree rather than taken on trust, using
three tools with three different blind spots, per the repo's standing rule:

1. **graphify** (`--graph ~/dev/shoresh/graphify-out/graph.json`): the only `it-pipe` node in the
   graph is the `package.json` dependency entry itself, with no importer edges into it.
   `graphify affected "it-pipe"` returns *"No unique node match"* — an **abstention**, not a
   clearance, and recorded as such rather than counted as agreement.
2. **`grep -a`** across the **whole repo**, not just the four directories the finding named (the
   `-a` matters; a plain `grep` has silently returned zero hits on this repo's NUL-bearing files
   before). Hits: `package.json`, `package-lock.json`, four documentation files — one of which is
   `experiments/future-arch/ENGINE_SELECTION.md`, prose describing a libp2p 2.x pattern, not code —
   and the two generated `electron/third-party-licenses.{json,html}` artifacts. **No source file
   anywhere in the tree references it** — as an import, a `require`, or a string.

   One caveat, recorded rather than resolved: this sweep covers the tree, not other branches. The
   parked `shoresh-future-architecture-364e03` branch is outside it, and
   `docs/work/plans/2026-09-06-stage4-libp2p-transport-design.md` names `it-pipe` as a dependency of
   a `test-cr4-live.mjs` that does not exist in this checkout. If that branch is ever revived it
   should re-add the dependency itself rather than rely on transitive hoisting.
3. **The gate**, run in this worktree after its own `npm ci`.

Removed from `package.json` `dependencies`; `npm install --package-lock-only` produced a
**two-line diff** (one line in each file). `it-pipe` remains in `node_modules` as a transitive
dependency of `@libp2p/utils` and `datastore-core`, so nothing that needs it loses it and
`electron/third-party-licenses.{json,html}` are unchanged — which is why the licenses drift gate
does not fire.

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

Both were honoured. Item 3 was closed by an owner decision that removed its premise, not by a
same-version suite. Item 1 was settled by the two-frame test, written before any production code
was touched, and the test's controls prove it can distinguish the two readings.
