---
title: T373-harness-joined-device-change-not-relayed
document_type: ticket
status: open
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
