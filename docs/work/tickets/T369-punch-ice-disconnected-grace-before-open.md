---
title: T369-punch-ice-disconnected-grace-before-open
document_type: ticket
status: completed
created: 2026-10-11
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md]
archive_when: a decision is recorded on whether a transient ICE 'disconnected' before the data channel opens fails the punch attempt immediately or after a bounded grace, and if changed, the change is security-reviewed and pinned by a test
---

# T369: punch transport fails an attempt on a transient ICE 'disconnected' before open

## Observation

- `electron/sync/automerge/punchTransport.js` (the session's `onStateChange` handler) rejects the pending open with `PunchConnectionFailedError` the moment the peer connection reports `failed`, `closed` **or `disconnected`**, before the data channel has opened.
- In libdatachannel / ICE, `disconnected` can be transient: consent checks miss under load, then the connection recovers. `failed` and `closed` are terminal.
- CI on #921 failed `punchTransport.sync.test.js` "a camp peer is admitted over the punch transport and Automerge sync completes" with "punch: connection failed before the data channel opened", on real WebRTC over loopback on a loaded runner. #925 made the test retry that one error a bounded number of times, mirroring production.

## Why this is a question, not a bug

Production's reconnect coordinator retries the ladder, so a failed attempt is retried and correctness holds. The cost of failing fast on `disconnected` is latency and wasted attempts, likely on lossy real networks (two campers' laptops on different Wi-Fi), not wrong behaviour.

## Options

1. **Keep as is.** It's simplest, and the ladder covers it.
2. **Bounded grace for `disconnected` before open.** Wait up to N ms (well inside `connectTimeoutMs`) for a recovery to `connected` before failing. `failed` and `closed` stay immediate.

## Constraints

- The punch transport is security-reviewed (T347 / S1). Any change goes through Security and Red Hat, and must keep the pre-Noise limits, the authGate path and the open-timeout bound unchanged.
- Decide with evidence: measure how often `disconnected` precedes a successful open on real two-network hardware (the owner's two-laptop test) before changing anything.
