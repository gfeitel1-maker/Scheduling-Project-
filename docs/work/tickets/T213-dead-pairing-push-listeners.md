---
title: "Three IPC listeners survived the Stage 6c cutover with no possible sender, and one of them is a trap on upgraded devices"
document_type: ticket
status: open
created: 2026-09-17
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: "The dead pairing-push path is removed or wired, `KNOWN_GAPS` in electron/ipcChannelParity.guard.test.js is empty, and no phase exists that a device can enter and never leave"
---

# T213 — Dead pairing-push listeners, and the phase you can enter but not leave

## How this surfaced

The `shoresh:auth-rejected` emitter was found missing and reconnected. The parity guard built
alongside it (`electron/ipcChannelParity.guard.test.js`) then found three more preload listeners
with no sender anywhere in `electron/`: `shoresh:pairing-approved`, `shoresh:pairing-denied`,
`shoresh:token-renewed`.

## What was verified, and by whom

A peer session investigating from a separate worktree on `main` (fb1ccbe) supplied the evidence
below. **Every claim was independently re-verified here before being recorded**, because the same
session had twice that day produced a finding that was right about the symptom and wrong about the
cause.

**Confirmed:**
- The live join flow is entirely the polling IPC path — `JoinByCodeScreen` drives
  `joinFindHost → joinRequestPairing → joinAwaitPairingDecision → joinLogin → joinAwaitData`, and
  the decision resolves synchronously through `joinSession.js`'s `waitForPairingDecision`.
  `syncNode.js`'s `sendPairingApproved`/`sendPairingDenied` are libp2p **wire** messages to the
  joining peer, not `webContents.send`. Nothing can fire these two channels.
- No token-renewal mechanism exists in `electron/` or `src/` — only the listener and its mock.
- `pairing_pending` / `pairing_denied` (`useDeviceMode.js:309-310`) are both gated on `joinHost`,
  whose **only** writer is `selectJoinHost` (`useDeviceMode.js:238-242`), which has no callers.
  Verified by `grep -a` across `src/`, `electron/`, `scripts/`, `test/` and by checking for dynamic
  `device[...]` access. `graphify affected "selectJoinHost"` returns **"No unique node match"** —
  inconclusive, not confirming, exactly its documented blind spot for a hook-returned property. The
  grep did the work; the graph could not.

**Corrected — the peer's "unreachable" framing is too strong, and this is the reason to act:**
`joinHost` **hydrates from localStorage** (`useDeviceMode.js:53`,
`useState(() => readJSON(JOIN_HOST_KEY))`). A device upgraded from a pre-Stage-6c build carrying a
leftover `shoresh-join-host` value enters `pairing_pending` on launch and — with these listeners
dead — **can never leave it**. Unreachable on a fresh install; a trap on an upgraded one.

## Why it stayed invisible

The Stage 6c cutover severed **directions** of a flow rather than whole flows. `shoresh:pairing-request`
(Host side) is live while these three are dead, so the channel family reads as healthy from either
end. A listener with no sender is invisible to lint, to the dependency graph, and to every test that
mocks the channel — which is how this survived. That class, not the single dead channel that
prompted it, is what `ipcChannelParity.guard.test.js` is worth keeping for.

## Scope

Removing only the three listeners is **not** the fix: it would leave `pairingStatus` able to reach
`'pending'` but never `'approved'`/`'denied'` — still a phase you can enter and never leave. The
candidate deletion set is `PairingPendingScreen`, the two `useDeviceMode` phase arms, `pairingStatus`,
`selectJoinHost`, `joinHost`/`JOIN_HOST_KEY`, and several test mocks.

That is structural work on the device phase machine. It was deliberately NOT absorbed into the
emitter change on `claude/shoresh-rendezvous-wan-handoff-5f211b`, which had a narrow approved scope.

## Does NOT count as done

- Deleting the three listeners while leaving a reachable `pairing_pending` with no exit.
- Any change that leaves a stale `shoresh-join-host` in localStorage able to strand an upgraded device.
- `KNOWN_GAPS` still non-empty with these three entries.
