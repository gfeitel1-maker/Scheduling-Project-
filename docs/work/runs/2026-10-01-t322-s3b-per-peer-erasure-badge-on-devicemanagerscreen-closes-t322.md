---
task: T322 S3b — per-peer erasure badge on DeviceManagerScreen (closes T322)
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: security-auth
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T322-per-peer-erasure-state-ui.md]
related_specs: [docs/work/specs/2026-10-01-t233-s3-per-peer-erasure-state-ui-design.md]
related_adrs: [docs/adr/2026-09-19-multi-device-erasure-propagation.md]
selected_agents: [governor, maker, verifier, security, red-hat, code-reviewer]
omitted_agents:
  - agent: grader
    reason: human-waived
    note: per the organizer's standing ruling (2026-10-01, carrying owner authority on defaults) the board loop gate is "Verifier PASS + the written reviews + CI green" and does not block on the Grader, whose reducer historically cannot bind foreground-dispatched reviews. "A Grader FAIL is a stop, not a round" — it is not run as a routine gate here.
  - agent: architect
    reason: not-applicable
    note: design fixed by the organizer-ruled scoping note (#706) and the ADR addendum (2026-10-01, from S3a). S3b is a read-only implementation of an already-ruled design — no new architectural decision.
  - agent: designer
    reason: not-applicable
    note: additive read-only flag on an existing admin table, in the existing chip vocabulary; no new screen, no new layout. Copy is the product and is governed by the four never-claims, which are pinned by tests, not by a visual spec.
  - agent: tester
    reason: not-applicable
    note: the badge is a status flag fully determined by the self-report data — there is no running-app UX distinct from what the jsdom UI tests and db-backed logic tests already pin, and this environment has no Electron/libp2p to drive a real two-device purge-and-propagate walk. Same basis as S3a's tester omission.
deterministic_checks: [electron/ops/peerErasureState.test.js, src/screens/DeviceManagerScreen.test.jsx, electron/ipcSurfaceParity.test.js, npm run lint, npm run check:governance]
human_gates: []
verdict: PASS (pending CI as the gate of record)
completion_evidence:
  - electron/ops/peerErasureState.js + .test.js (11/11; red-before-green — module absent → import failure → green)
  - electron/main.js + preload.js + src/localClient.js + src/localClient.mock.js (read-only IPC shoresh:list-peer-erasure-state)
  - src/screens/DeviceManagerScreen.jsx + .test.jsx (11/11; 5 new erasure-badge tests)
  - electron/ipcSurfaceParity.test.js 17/17 (caught the missing mock implementation, now fixed)
archive_when: CI green on the S3b PR and the T322 success predicate observable end to end
---

# T322 S3b — per-peer erasure badge on DeviceManagerScreen (closes T322)

## What shipped

The director-facing half of T233 S3. S3a (#711) added `peer_tombstone_reports`
(a peer self-reports, over the authenticated `authenticate` handshake, the set of
`(tombstone id, version)` pairs it has verified-and-projected). S3b turns that into a
read-only per-peer badge on the Device Manager.

- **Pure verdict** — `electron/ops/peerErasureState.js`:
  `computePeerErasureStates({ tombstones, reports, peerDeviceIds })`. A peer is
  `LOGICALLY_ERASED` only when, for **every** real purge-tombstone, it has reported an
  applied `version >= tombstone.version`; otherwise `UNKNOWN`. Per-id, never
  scalar-vs-max (`tombstones.version` is per-camper-id, not a global sequence — the
  soundness point S3a's ADR addendum established).
- **db read** — `listPeerErasureStateFromDb(db, { localDeviceId })`: reads only real
  tombstones (`version >= 1`, excluding the `version 0`/empty-sig projection placeholder),
  the self-report rows, and the peer device ids the Device Manager renders (same
  `pairing_status IS NOT 'unknown'` filter as `listDevices`, minus the local device).
  Returns `{ hasErasure, states, localDeviceId }`.
- **Read-only IPC** — `shoresh:list-peer-erasure-state` → `listPeerErasureState` in
  `electron/main.js`, same `devices.read` gate as `listDevices`. Wired through
  `preload.js`, `src/localClient.js`, `src/localClient.mock.js`. No write path;
  `revokeDevice` untouched.
- **UI** — `src/screens/DeviceManagerScreen.jsx`: a "Record purge" column on the All
  Devices table, rendered only when `hasErasure` (no purge → no column, no noise). Peer
  rows show `Hidden` (`LOGICALLY_ERASED`, a muted neutral chip — deliberately not a
  success-green reassurance) or `Not confirmed` (`UNKNOWN`, warning-tinted). The local
  device shows a plain "This device".

## The four never-claims (acceptance criteria) — all met

1. **Never deleted/gone/wiped.** The `Hidden` title: *"suppressed, not deleted — its raw
   data may remain in sync history."* Test asserts the phrase and the absence of
   "wiped"/"gone".
2. **Never cryptographic/physical.** Same title: *"guess-resistant logical erasure, not
   cryptographic."* Asserted.
3. **Never certainty about an unreachable peer.** A peer with no row, or behind on any one
   tombstone, reads `UNKNOWN` (*"unknown, never silently treated as erased"*). Asserted at
   both the pure-logic layer (reports=[] → UNKNOWN; missing one tombstone → UNKNOWN) and
   the UI layer.
4. **Never a count it cannot back.** Only per-peer states the self-report supports are
   rendered; the local device and phantom `pairing_status='unknown'` rows are excluded, not
   fabricated. Asserted against a real db (local-exclusion and phantom-exclusion tests).

## Evidence

- `electron/ops/peerErasureState.test.js` — 11/11. Red-before-green: the suite failed to
  import (`Cannot find module './peerErasureState.js'`) before the module existed, green
  after. Pure-function edge cases (caught-up-on-all, reported-nothing, behind-on-one,
  higher-version-satisfies-lower, no-tombstones, malformed-rows) + db-backed cases
  (no-real-tombstone, version-0-placeholder-excluded, local-excluded, phantom-excluded,
  authorized-but-behind).
- `src/screens/DeviceManagerScreen.test.jsx` — 11/11 (6 pre-existing + 5 new): no column
  until a purge; caught-up peer shows `Hidden` with the not-deleted/not-cryptographic
  copy; unreached peer shows `Not confirmed`; local row shows "This device"; a peer with
  no verdict falls back to `Not confirmed`.
- `electron/ipcSurfaceParity.test.js` — 17/17. **This gate earned its keep**: it caught
  that `listPeerErasureState` had no `src/localClient.mock.js` implementation (would throw
  `shoresh.<name> is not a function` under `npm run dev`). Fixed, then green.
- `npm run lint` — 0 errors. `npm run check:governance` — no findings.
- CI is the gate of record and runs the full `npm run verify` on the PR.

## Notes carried from S3a, confirmed inert here

- A brand-new paired device has no `peer_tombstone_reports` row until its first subsequent
  `authenticate` (S3a flag). In S3b that device simply reads `UNKNOWN` — the honest state,
  not a bug.
- `peer_tombstone_reports` is never written on this path; the only writer remains S3a's
  authenticated-handshake persistence. S3b is read + render only.
