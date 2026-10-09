---
ticket: T354
document_type: ticket
title: S4a — rung 1 (absorbs parked T348; PR #762 closed), remembered public reflexive candidate redialled with zero signaling, inert behind SHORESH_PUNCH_ENABLED
status: open
created: 2026-10-09
archive_when: "attemptRung1 redials a peer's remembered punch memory with zero signaling messages and reports mapping-moved, timeout or no-memory so a coordinator can escalate; the device's stable DTLS cert/key and ICE credentials live in the SQLCipher-covered database (never a plaintext file at rest); a revoked peer's memory is not redialled; schema v93 and its rollback pass; nothing activates without SHORESH_PUNCH_ENABLED"
task_class: security-auth
parent: T347
governing_docs: [docs/adr/2026-10-08-relayless-cross-network-reconnect.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: [docs/work/tickets/T347-s1-punch-transport-inert-build.md]
---

# T354 — S4a: rung 1 remembered-candidate redial (absorbs T348)

T348 (PR #762, closed unmerged) was parked and its work re-applied onto current main as this ticket;
branch `claude/s2-rung1` at 6e667c10 is the source. Differences from the T348 text below: the schema is
**v93** on top of main's v92 (the migration guard is `>= 92 && < 93`), the rollback is
`electron/db/rollback/v93_down.js`. Where the notes below say "v91" or `>= 91 && < 93`, read v93 and
`>= 92 && < 93`: they describe the parked branch.

## Context

Rung 1 of `docs/adr/2026-10-08-relayless-cross-network-reconnect.md`: reconnect with ZERO signaling
messages from what a previous punched session left behind. S1 (T347) built the transport; this slice
adds the memory and the redial. Nothing activates: no caller outside tests exists, and the transport
is still only wired behind the strict `SHORESH_PUNCH_ENABLED === 'true'` gate.

## What S2 builds

- Schema v93 (the migration guard is `>= 92 && < 93`): `punch_identity` (device singleton: self-signed DTLS cert + key, ICE ufrag/pwd, pinned
  UDP port, last learned own reflexive candidates) and `peer_punch_memory` (one row per peer: our role,
  the peer's last SDP, its fingerprint/ufrag/pwd, its candidates). `peer_punch_memory` extends the
  `peer_last_addresses` mechanism: written/forgotten/trust-filtered by `peerAddressBook.js`, and wiped
  with it (`forgetPeerAddress`). `electron/db/rollback/v93_down.js`.
- Key custody: the cert key sits in the same SQLCipher-covered database as `device_identity_key`
  (SECURITY.md "At-rest encryption"), never in a standing file. node-datachannel only accepts PEM
  file paths, so `materializePunchIdentity` writes them to a 0700 temp dir for the lifetime of a
  transport and removes them on teardown.
- `punchTransport.js`: sessions record local srflx candidates and the remote SDP/candidates; an
  `onEstablished` hook reports them; `connectFromMemory` replays a remembered remote description with
  no `sendSignal` call at all.
- `electron/sync/automerge/punchRung1.js`: `attemptRung1(peer, ...)` -> `{ok:true, connection}` or
  `{ok:false, reason:'no-memory'|'mapping-moved'|'timeout'}`.

## Not built

Gossip of own reflexive candidates (rung 2, S3), the coordinator and simultaneous-open timing (S4),
the caller of `attemptRung1` (the S4 coordinator), rung 3 (never contacted here).

## Review round 2 notes

- Pinned-port sessions are serialized in the transport (`sessionOnFreePort`); a busy port yields `timeout`, never a native abort.
- `attemptRung1` never throws: non-ICE failures return `reason: 'error'`; a connection authenticating as another peer is closed and reported `mapping-moved`; memory older than 12h or lacking public srflx candidates is `no-memory`.
- `shoresh-punch-<pid>-*` key dirs of dead processes are swept at materialize time.
- For S4: a stale peer-side memory costs the full `timeoutMs` per attempt, so the coordinator must try rung 1 once per reconnect episode, not repeatedly.

## Review round 3 (owner-approved single bounded round)

- Persistence is wired in production. `syncStarter.js` calls `materializePunchIdentity` at transport start (inside the `SHORESH_PUNCH_ENABLED` gate) and passes the cert/key files, pinned ICE and port to `punchTransport`; the key dir is removed in `shutdownPunch`. `punchTransport`'s `onEstablished` feeds `createPunchPersistence`, which holds the session until `syncNode`'s `onPeerAdmitted` (after authGate admission) and only then calls `rememberPunchMemory` and `rememberOwnReflexive`. A held session older than 60s, or for a peer that never reaches admission, is never written.
- Only the ICE-selected pair is stored (peer side as the remembered candidate; our side only when it is a srflx address).
- `attemptRung1` re-checks `isPeerTrusted` (default: the bound-peer trust) and the optional `isPeerRevoked` after the upgrade; a peer revoked mid-dial has its connection closed and returns `reason: 'revoked'`.
- Revocation goes through one hook, `forgetRevokedPeer` (explicit `revokeDevice` in `main.js` and the quorum teardown in `syncNode.js`): it deletes that peer's addresses and punch memory, then `rotatePunchIdentity` replaces our cert/key/fingerprint/ICE ufrag+pwd (port kept) so a revoked peer's stored copy of our SDP is useless. A running transport keeps the identity it materialized until it next starts; peers' remembered sessions with us also stop matching, so the next reconnect falls to a higher rung.
- X.509: the hand-rolled DER builder stays. node-datachannel has no certificate generation (`generateCertificate` throws "Not implemented"), `node:crypto` can parse but not create certificates, and the only ASN.1/PKI libraries installed (`pkijs`, `asn1js`) are dev-only transitive dependencies of electron-builder, so using them would mean a new shipped dependency for ~25 lines of code.
- `attemptRung1` still has no production caller by design (the S4 coordinator); every persistence helper now has one.
- Gate note: run on this machine under the keeper's rule - focused test files only, not `npm run verify`; CI is the gate of record.

## Review round 4 (keeper-scoped fix round)

- `sweepStalePunchDirs` only considers real directories (lstat; files and symlinks skipped) named exactly `shoresh-punch-<pid>-<6 alphanumerics>`, the shape `mkdtempSync` produces in `materializePunchIdentity`; the "predates the naming" case is dropped. Test temp files and dirs under `electron/sync/automerge/*.test.js` no longer use the `shoresh-punch-` prefix, so a parallel worker's `shoresh-punch-wiring-*` dir or `shoresh-punch-mem-*.sqlite` file can no longer be swept.
- Root cause of the CI `ra.ok` false in "two peers redialled concurrently on one pinned port": the sweep does NOT explain it. The rung1 test's db files are `shoresh-rung1-*` and its key dir is `shoresh-punch-<live pid>-*`, which the old sweep kept. The real defect is ordering in `sessionOnFreePort`: after the previous test's close both waiters (pa and the later pc, same transport) sleep until `lastCloseAt + settle` with independently computed millisecond timers, so the later caller's timer can fire first and it takes the port. pc then holds the port (or dials b with the copied memory) and pa never gets a clean slot. Fix: waiters are served in arrival order via a per-transport queue; no timeout or settle value changed.
- Confidence: medium. This is established by reading the code; the CI failure was not reproduced locally (a 4x parallel loop was too heavy for this machine and was stopped), and no deterministic test pins the queue.

## S4a keeper conditions

1. **Sweep removal failure is surfaced, not fatal.** `sweepStalePunchDirs` wraps `rmSync` in try/catch
   and logs one `console.warn` naming only the path class ("a stale punch key directory") and the error
   code - never the path, never key material. `materializePunchIdentity` carries on. Red-first test in
   `electron/sync/automerge/punchIdentity.test.js` ("stale key directory removal failure"): a dead-pid
   directory holding a read-only subdirectory makes `rmSync` throw EACCES; before the fix
   `materializePunchIdentity` threw, after it warns once.
2. **FIFO pinned-port queue is kept, with a deterministic repro.** `electron/sync/automerge/punchPortQueue.test.js`
   drives `sessionOnFreePort` with a manual clock and manual timers. Two waiters released by the same
   close compute timers to the same instant; the test fires the LATER arrival's timer first (the order
   Node's per-duration timer lists permit when timers expire together). Against the pre-round-4 loop
   (restored from c3bbcb21 for the check) the later arrival takes the port (`expected ['B'] to deeply equal []`);
   against the queue, the earlier arrival is served first. No timeout, settle value or sleep was changed.
3. **`punchTransport.sync` "a peer revoked mid-connection is cut off" - flake, cause NOT established.**
   It failed once under parallel load; the failure text was not captured. Evidence gathered: 3 sequential
   isolated runs of the file all passed (that test 4.5-5.0s, the file 13-15s idle). The test has no pinned
   port (`portRange` unset), so `sessionOnFreePort` is bypassed entirely and neither T348's queue nor its
   sweep is on its path. Its only failing shapes are the positive `waitFor`s (15s each) or the 30s test
   budget, both wall-clock bound around two real WebRTC ICE gatherings, which a loaded 4-core runner can
   stretch; the negative `expect(...).toBeUndefined()` after a fixed 500ms cannot fail by slowness, only by a
   revoked write actually landing. That last shape is the one that would be a real bug, and it has not been
   ruled out. Next step: if it recurs, capture the assertion message from the CI log first (a `waitFor: timed out`
   is load; a `revoked-write` row present is a revocation gap in the `isPeerRevoked` path).
