---
title: "Three IPC listeners survived the Stage 6c cutover with no possible sender, and one of them is a trap on upgraded devices"
document_type: ticket
status: completed
created: 2026-09-17
resolved_by: [8e66547, 4d6af5a]
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: "The dead pairing-push path is removed or wired, `KNOWN_GAPS` in electron/ipcChannelParity.guard.test.js is empty, and no phase exists that a device can enter and never leave"
---

# T213 — Dead pairing-push listeners, and the phase you can enter but not leave

## RESOLVED — verified on `main`, no further code change required

Closed 2026-09-18 after re-deriving each verdict against the tree rather than inheriting the
peer's. `8e66547` (#470) removed the dead cluster; `4d6af5a` emptied `KNOWN_GAPS`. All three
`archive_when` clauses hold on `main` at `25dc06e`:

- The three channels are gone from `electron/preload.js` (`grep -ran` over `src electron scripts
  test` returns only wire-protocol `pairing_pending`/`pairing_denied` message types under
  `electron/sync/automerge/`, the unrelated `pairing_status` DB column in `DeviceManagerScreen.jsx`,
  and `_Prior:` historical comment lines).
- `KNOWN_GAPS` is `[]`, and the guard is **non-vacuous with it empty** — planting
  `ipcRenderer.on('shoresh:planted-orphan', …)` in `preload.js` fails
  `ipcChannelParity.guard.test.js` (1 failed / 1 passed); tree restored.
- No phase can be entered and not left: `useDeviceMode.js`'s derivation is now
  `error → loading → mode-select → bootstrap → join → login → session`, and every arm has a
  reachable exit (`retry`, `chooseHost`/`chooseJoin`, `bootstrapCamp`, camp creation, `login`,
  `logout`).

### Per-channel verdict, each traced separately

| Channel | Verdict | Evidence |
|---|---|---|
| `shoresh:pairing-approved` | **(a) dead — correctly removed** | The decision is delivered by the live polling path: `JoinByCodeScreen.jsx:99,123` sets `STEP.signIn` on `status === 'approved'` from `joinRequestPairing`/`joinAwaitPairingDecision`. `syncNode.js`'s `sendPairingApproved` is a libp2p **wire** message, never `webContents.send`. |
| `shoresh:pairing-denied` | **(a) dead — correctly removed** | Same live path carries denial: `JoinByCodeScreen.jsx:111,118-119` → `STEP.denied`, with a real rendered denial screen at line 226. |
| `shoresh:token-renewed` | **(a) dead — correctly removed, and never severed** | Distinct from the other two: this listener was for a feature **that was never built**. `TOKEN_TTL_MS = 24h` (`electron/auth/localAuth.js:151`) with the comment "Renewal (sub-task 3) is out of scope here; a token past this window simply stops verifying." `grep -rniE "renew\|reissueToken\|refreshToken"` over `electron src` returns only that comment and a `syncNode.js:520` comment. Expiry → `verifySession` fails → `clearSessionState(null)` → `login` phase, benign by design. |

### Why this is NOT the `shoresh:auth-rejected` case

`auth-rejected` was case (b) because it was the **sole** carrier of a class of authoritative
refusals — nothing else told the director. These three are the opposite: the pairing outcomes have
a second, live carrier that already renders both outcomes, and token renewal has no outcome to
carry. **No director-facing message was silently dead.** The dead channels were a redundant severed
*direction* of an outcome the polling path still delivers.

### The trap, stated precisely

The trap was **`pairing-approved` and `pairing-denied` jointly, not any one channel** — they were
the only two writers of `pairingStatus` other than `'pending'`, so they were the entire exit set of
the `pairing_pending` phase.

The mechanism is worth correcting: the body below implies a stale `shoresh-join-host` hydrates
straight into `pairing_pending`. It does not — `pairingStatus` was `useState(null)` and never
hydrated. The reachable path (`8e66547^:src/hooks/useDeviceMode.js:137-152`) is that a stale
`joinHost` satisfied `else if (mode === 'client' && joinHost)`, which then called
`getDevicePairingStatus()` and, on `!isPaired`, ran `setPairingStatus('pending')` **during init**.
Phase `pairing_pending` (line 296) followed, and with both exits dead the device stayed there
across every restart.

The load-bearing half was the inverse defect on the same dead gate, and it hit the **larger**
population: a device that joined *by code* had **no** `joinHost`, so it matched neither startup
branch and skipped `chooseMode` entirely on every restart — never handing its locally-verified
token to the libp2p node (`main.js:716`), silently voiding the T87 Part 1 re-auth guarantee. The
stale-key trap stranded upgraded devices; the missing-key defect degraded every joined-by-code
device.

`getDevicePairingStatus` remains in place deliberately — an `invoke` with a live handler, outside
this guard's scope.

## Numbering

This ticket and its siblings are **T207–T213**, renumbered from T192–T198 on 2026-09-17 after all
seven collided with tickets other sessions landed on `main` after this branch was cut. The block was
chosen from a fetch at that moment (main's highest was T205; T206 reported in flight). **It needs
re-verification before merge** — the duplicate scan reads the working tree, so it cannot see a number
claimed on `main` after we branched until the rebase brings both sets into one tree. See the handoff.

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
