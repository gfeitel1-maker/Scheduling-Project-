---
title: T373-harness-joined-device-change-not-relayed
document_type: ticket
status: closed
created: 2026-10-11
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md]
archive_when: in test/integration a joined client's appendOp-path write reaches the other joined client through the Host without a restart, scenario 39 drops its restart-and-reconnect, and the cause is stated (harness or product)
---

# T373: in the integration harness, a joined device's commit reaches the Host but not the other client

**Problem.** In scenario 39 (`test/integration/scenarios/39-locked-seat-unmerged-regeneration.automerge.js`), clientA's `commitElectiveRun` reaches the Host but never reaches clientB, so the scenario restarts clientB and reconnects it to pull the base state. That reconnect reset the connection on CI once (PR #949, `read ECONNRESET`); the scenario now retries the reconnect up to three times. Scenario 34 appears to relay the same kind of commit to clientB, and scenario 36's note says the local-write broadcaster is wired in `start()` and not `join()`, so the two observations disagree and the cause is not known.

**Direction.** Find why the Host does not relay a joined client's change to the other client in scenario 39 but does in 34. If it is a harness gap, fix the harness and drop the restart. If the Host really does not relay in the product, that is a sync bug and moves to the sync owner.

Source: T264 / PR #949 CI failure, 2026-10-11.

**Update (PR #949 CI, three runs).** The failure is earlier than the restart: under 1.1s into scenario 39, on Linux CI only (the full suite passes 29/29 locally), the first join's outbound Noise handshake is reset: `EncryptionFailedError: read ECONNRESET` at `libp2p/dist/src/upgrader.js:289` (`_encryptOutbound`) from `@libp2p/tcp` `dial`. Scenario 39 runs right after scenario 38 and uses the same `setupTwoJoinedDevices` as scenarios 34 and 38, which pass. The scenario now retries its setup once on that error alone. Whether production's join can hit the same reset (and whether the join UI recovers) is part of this ticket.

**Resolution (two causes, both found and fixed; the retry and the restart-and-reconnect are gone from scenario 39).**

1. *The join reset (CI only).* libp2p refuses an inbound connection once one remote host has opened `inboundConnectionThreshold` (default 5) in a second, by destroying the socket; the dialer sees `EncryptionFailedError: read ECONNRESET` from `_encryptOutbound`. Every harness device is 127.0.0.1, so a whole camp counts as one host, and scenario 39 (4 nodes, mDNS-driven mutual dials plus the joins) peaks at exactly 5 per second on macOS and passes the limit on a faster Linux runner. Reproduced locally by lowering the limit (same stack as CI). Fix: `startSyncNode` forwards the existing test-only `inboundConnectionThreshold`, and the harness sets it to 1000 (`electron/sync/automerge/syncNode.js`, `test/integration/harnessAutomerge.js`); pinned by `syncNodeInboundThreshold.test.js`. Production is exposed only when one IP opens 6 connections to a device inside a second (same machine, or devices behind one NAT); the join screen then shows the raw error and the director retries by hand.
2. *The Host not relaying a joined device's commit (a product sync bug, not a harness gap).* Each sync message rides its own stream; libp2p allows 32 inbound streams per protocol per connection and counts one until both halves close. The receiving handlers in `electron/sync/automerge/transport.js` never closed their half, so a connection carried exactly 32 sync messages in a direction and then reset every later one (`TooManyInboundProtocolStreamsError`), while the sender had already advanced its sync state, so nothing was re-offered. Scenario 39's seed writes used up the slots before clientA's commit. Fix: both handlers close their half when the frame is read; pinned by `transportSyncStreamLeak.test.js` (red: delivered 32 of 80).
