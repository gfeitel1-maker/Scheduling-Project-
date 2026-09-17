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

## The live defect underneath the dead code

Found by the peer session, and it is the half that actually hurt a user. The startup effect's client
branch was `else if (mode === 'client' && joinHost)`. Nothing has written `joinHost` since the Stage
6c cutover, so a device that joined **by code** matched neither branch and **skipped `chooseMode`
entirely on every restart** — and therefore never handed its locally-verified token to the libp2p
node via `setAuthToken` (`main.js:716`). That is precisely the re-auth-on-restart guarantee T87
Part 1 exists to provide, silently not happening for every joined-by-code device.

**Why the tests did not catch it:** `seedClientDevice` in `useDeviceMode.test.js` hand-seeded the
dead `shoresh-join-host` key, so four T87 tests were passing against **a device shape the app can no
longer produce**. The peer rewrote the helper to the real shape and proved non-vacuity by planting
the skip (4 fail). This is the repo's own standing lesson arriving again: build a fixture from what
the app actually produces, not from what makes the test pass.

## Can the class be guarded? — asked explicitly, answered no

The cutover severed **directions** of flows, and both halves stayed invisible for the same reason:
each end looks healthy alone. `ipcChannelParity.js` catches the **channel** half — a listener with no
sender. Nothing catches the **gate** half — a condition gated on state nothing writes any more.

**A cheap sibling guard is not feasible, and the reason is precise.** The channel guard works because
it compares *presence of a literal*: the same channel string appears in `ipcRenderer.on` and in
`.send(`, both greppable. The gate half fails on a different property. `joinHost` **does** have a
writer (`setJoinHost`, `useDeviceMode.js:242`) — it is simply **unreachable**. Every cheap syntactic
parity check keys on presence, so a reader/writer-parity guard over `useState` setters or
localStorage keys would have passed this file. The distinguishing property is **reachability from an
entry point**, which is call-graph analysis, not grep.

Reachability is exactly what `graphify` is for — and here it **abstained**: `graphify affected
"selectJoinHost"` returned *"No unique node match"* because the symbol is **not indexed at all**
(a `useCallback` const, the same family as the documented object-literal-method blind spot). The
graph was silent, not agreeing. A concrete instance of the standing rule that **a negative result is
a claim about the measurement**: read as "nothing depends on it", that output would have been a
false confirmation of a true conclusion — right answer, no evidence.

**So the actionable improvement is not another guard, it is the graph.** Making `graphify` index
`useCallback`/arrow-const exports turns this question from a manual grep sweep into a mechanical one
and retires a whole blind-spot family. Until then the honest procedure stands and is what the peer
used: graph for edges, `grep -ran` for string and dynamic references, then the full gate — three
tools, three different blind spots, none sufficient alone.

## Scope

Removing only the three listeners is **not** the fix: it would leave `pairingStatus` able to reach
`'pending'` but never `'approved'`/`'denied'` — still a phase you can enter and never leave. The
candidate deletion set is `PairingPendingScreen`, the two `useDeviceMode` phase arms, `pairingStatus`,
`selectJoinHost`, `joinHost`/`JOIN_HOST_KEY`, and several test mocks.

That is structural work on the device phase machine. It was deliberately NOT absorbed into the
emitter change on `claude/shoresh-rendezvous-wan-handoff-5f211b`, which had a narrow approved scope.

**The deletion is shipping on the peer's own branch off `main`**, covering the three preload
listeners, the localClient/mock wrappers, `pairingStatus`, `selectJoinHost`,
`joinHost`/`JOIN_HOST_KEY`/`readJSON`, both pairing phase arms, `PairingPendingScreen`, and the
descriptive-doc claims (marked `_Prior:_` per the governance rule). It leaves `getDevicePairingStatus`
alone — an invoke with a live handler, a separate question.

**Therefore `KNOWN_GAPS` stays populated on this branch.** The three entries can be removed once the
peer's deletion lands on `main`, at which point the guard enforces for real with an empty allowlist.
Removing them in anticipation would leave this branch asserting against code that still exists on
`main`. Expect merge conflicts in `useDeviceMode.js`, `CLAUDE.md` and `PLATFORM_STATE.md` — both
branches touch them; keep edits here narrow.

## Does NOT count as done

- Deleting the three listeners while leaving a reachable `pairing_pending` with no exit.
- Any change that leaves a stale `shoresh-join-host` in localStorage able to strand an upgraded device.
- `KNOWN_GAPS` still non-empty with these three entries.
