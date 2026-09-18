---
title: "Persistent per-device libp2p identity; bind session tokens to the presenting peer"
document_type: ticket
status: in-progress
created: 2026-09-14
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-09-14-device-identity-and-token-binding.md, docs/adr/2026-09-06-libp2p-membership-mapping.md]
archive_when: a token replayed from a libp2p peer other than the one bound to its device_id is rejected end-to-end (syncNodeAuthGate.test.js), an ordinary reconnect across a process restart still succeeds, and SECURITY.md/PLATFORM_STATE.md state the closed property alongside the accepted reinstall re-pairing cost
---

# T162 — Persistent per-device libp2p identity; bind session tokens to the presenting peer

Owner decision, 2026-09-14: close the bearer-token property T155 characterized
(`docs/work/tickets/T155-admission-gate-characterized-limits.md`) — "a camp token is a bearer
credential... nothing binds it to the libp2p peer presenting it." Design: see
`docs/adr/2026-09-14-device-identity-and-token-binding.md`. This ticket does not re-derive the
design; each slice below cites the ADR section it implements.

## 0. Implementation note, 2026-09-17 — the slice text's schema version is STALE

Slices 1–4 were implemented on `claude/shoresh-rendezvous-wan-handoff-5f211b`. The ticket and its
ADR were written when the schema was at v59 and say to add **v60**. By the time the work ran, v60
was already taken (`users.auth_sig`), as were v61–v65. **The work landed as v66**: guard
`>= 65 && < 66`, `CURRENT_SCHEMA_VERSION` 66, rollback `electron/db/rollback/v66_down.js`. Fifteen
sibling migration tests assert the version by literal and were all bumped. Nothing else in the ADR
was found stale — the table shape, the `@libp2p/crypto` protobuf/hex encoding, lazy creation before
`startTransport`, TOFU semantics and the `4405` code were all verified against the installed
`@libp2p/crypto@5.1.23` / `@libp2p/peer-id@5.1.9` / `libp2p@2.10.0` and matched.

Slice 5 (docs) is not done. Archiving still requires it, plus a green `npm run verify`.

Two invariants were checked independently of the implementing agent's report: `authorize.js` still
contains zero references to `libp2p_peer_id`, and `device_identity_key` appears in none of
`PROJECTIONS`, `campDocument.js`, or `campScopedEntities.js`.

## 0.1 Review outcome, 2026-09-17 — what was fixed, and what is deliberately left

`security` scored 5 and found no exploitable vulnerability; it confirmed by tracing the real code
that the bound peer id is the Noise-established `connection.remotePeer`, never a client-asserted
field, and that the never-synced and `authorize()` invariants hold and are pinned by tests.
`red-hat` scored 3. Every finding below was re-confirmed in the file before being acted on.

**Fixed in this change:**
- `bindOrVerifyPeerIdentity` did its first-bind `UPDATE` with no error handling, so the
  two-devices-one-peer-id collision the ADR calls "correctly rejected" was in fact a raw
  `SQLITE_CONSTRAINT` thrown out of an admission decision — skipping the caller's audit record. It
  now returns `{ ok: false, reason: 'peer_identity_mismatch' }` for a constraint violation and
  re-throws everything else, matching `recordLibp2pPeerId`'s documented posture one function above.
  Two tests cover it, including that a genuine `SQLITE_BUSY` still throws.
- An `ensureDeviceIdentity` failure was indistinguishable from a transport failure in
  `main.js`'s catch-all, whose comment frames such failures as safe to shrug off. Identity failure
  is not that class of event, and `startSyncNode` now re-throws with a message saying so.
- `SECURITY.md` now documents `device_identity_key` — custody, what it buys, the accepted re-pair
  cost, and the `4405` behaviour.

**Deliberately NOT fixed, with reasons:**
- **No director-facing message for a `4405` refusal.** A director whose device stops syncing after
  an ordinary reinstall sees nothing explaining why, and the fix (revoke from a *different* device)
  is non-obvious. This is real and it is a **product decision**, already named as an open question
  in the ADR. Inventing an error surface inside the auth seam is the wrong place to decide it.
  **Owner decision needed.**
- **The fleet-wide TOFU window.** The migration nulls every `libp2p_peer_id` at once, so a stale
  token for a rarely-used device could claim that device's identity before the real machine returns,
  and the legitimate device is then the one forced to re-pair. This is inherent to combining TOFU
  with the clean cutover the owner chose; narrowing it means abandoning the clean cutover. Recorded,
  not silently absorbed.
- **The rollback round trip** destroys the rolled-back device's own identity, not merely its peers'
  bindings — a larger blast radius than the ADR states. Noted here so the ADR's cost line is not
  read as complete.
- **`lanTopologyTrust` is still `() => true`.** T162 removes the technical reason it had to be, but
  changing it is T208's follow-on and was kept out so the identity work could be gated on its own.

## Global constraints (apply to every slice)

- Never put `device_identity_key` contents in the Automerge document, `PROJECTIONS`,
  `campScopedEntities.js`, or `campDocument.js`'s `MODELED_ENTITIES`. Same exclusion class as
  `host_signing_key` (ADR §1).
- `authorize.js` must never reference `libp2p_peer_id` (ADR §4) — the existing guard test in
  `electron/db/libp2pPeerId.migration.test.js` enforces this; keep it green throughout.
- `better-sqlite3` ABI: run `npm rebuild better-sqlite3` before `npm run test` and
  `npx electron-rebuild -f -w better-sqlite3` before `npm run electron:dev`, if either has drifted
  (`electron/db/**` is touched by slice 2).
- Each slice ends green on `npm run verify` before moving to the next.

## Slice 1 — Schema v60: `device_identity_key` table + clean-cutover migration

**Goal:** the new local-only table exists, migrates cleanly, and the guard invariants around it are
pinned by tests — with zero behavior change yet (nothing reads or writes it outside tests).

**Files:**
- Modify: `electron/db/localDb.js` — add the v60 migration block (ADR §5, exact SQL given there),
  bump `CURRENT_SCHEMA_VERSION` to `60`, add `device_identity_key`'s `CREATE TABLE` to `schema.sql`
  verbatim (both-places DDL, v56/v57 precedent).
- Create: `electron/db/rollback/v60_down.js` — mirror `v59_down.js`'s shape exactly: drop
  `device_identity_key`, delete `schema_migrations WHERE version >= 60`, state plainly that the
  nulled `libp2p_peer_id` values are not restorable (ADR §5).
- Create: `electron/db/deviceIdentityKey.migration.test.js` — mirror
  `electron/db/libp2pPeerId.migration.test.js`'s structure: fresh-install shape, pre-v60-db
  migrates-forward shape, fresh-vs-migrated column parity, idempotent re-run, and a test asserting
  a devices row that had a non-NULL `libp2p_peer_id` before migration is NULL after it.

**Steps:**
- [ ] Write `deviceIdentityKey.migration.test.js`'s "fresh install has the table" and "clean-cutover
  nulls existing libp2p_peer_id" tests first (they will fail — no v60 block exists yet).
- [ ] Run: `npm test -- electron/db/deviceIdentityKey.migration.test.js` — expect FAIL (table missing
  / version mismatch).
- [ ] Implement the v60 migration block in `localDb.js` and the `schema.sql` addition, per ADR §5.
- [ ] Run the same test file — expect PASS. Also run
  `npm test -- electron/db/libp2pPeerId.migration.test.js` to confirm the v57 test's own
  "fresh install lands on CURRENT" assertions still pass once `CURRENT_SCHEMA_VERSION` moves to 60
  (that file's literal `expect(CURRENT_SCHEMA_VERSION).toBe(59)`/`toBe(58)` assertions will need
  updating to 60 — this is an expected, deliberate touch of that file, not scope creep, since it
  asserts the version number by name).
- [ ] Create and smoke-test `v60_down.js` against a throwaway db file (mirror how `v59_down.js` is
  invoked directly).
- [ ] Commit: `git add electron/db/localDb.js electron/db/rollback/v60_down.js electron/db/deviceIdentityKey.migration.test.js electron/db/schema.sql electron/db/libp2pPeerId.migration.test.js`.

## Slice 2 — `ensureDeviceIdentity`: generate and persist the per-device keypair

**Goal:** a device can get its own persistent libp2p `PrivateKey`/`PeerId`, generated once and
stable across calls, with zero wiring into the transport yet.

**Files:**
- Create: `electron/auth/deviceIdentity.js`
- Create: `electron/auth/deviceIdentity.test.js`

**Interfaces:**
- Produces: `ensureDeviceIdentity(db) => { peerId: string, privateKey: PrivateKey }` — `privateKey`
  is a `@libp2p/interface` `PrivateKey` object (the exact shape `createLibp2p({ privateKey })`
  expects; NOT the hex string stored in the table). Idempotent: a second call against the same db
  returns the same `peerId`/`privateKey` material, loaded from the table rather than regenerated.

**Steps:**
- [ ] Write the failing test: `ensureDeviceIdentity` on a fresh db creates a row in
  `device_identity_key`, returns a `peerId` string and a `privateKey`; calling it again on the same
  db returns the identical `peerId`.

```js
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { ensureDeviceIdentity } from './deviceIdentity.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})
function tmpDb(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

describe('ensureDeviceIdentity', () => {
  it('creates a persistent identity on first call and returns a peerId string', async () => {
    const db = tmpDb('identity-fresh')
    const { peerId, privateKey } = await ensureDeviceIdentity(db)
    expect(typeof peerId).toBe('string')
    expect(peerId.length).toBeGreaterThan(0)
    expect(privateKey).toBeDefined()
    const row = db.prepare('SELECT peer_id, private_key FROM device_identity_key WHERE id = 1').get()
    expect(row.peer_id).toBe(peerId)
    expect(typeof row.private_key).toBe('string')
    db.close()
  })

  it('is idempotent: a second call returns the identical peerId, not a fresh one', async () => {
    const db = tmpDb('identity-idempotent')
    const first = await ensureDeviceIdentity(db)
    const second = await ensureDeviceIdentity(db)
    expect(second.peerId).toBe(first.peerId)
    expect(db.prepare('SELECT COUNT(*) c FROM device_identity_key').get().c).toBe(1)
    db.close()
  })
})
```

- [ ] Run: `npm test -- electron/auth/deviceIdentity.test.js` — expect FAIL (module doesn't exist).
- [ ] Implement `electron/auth/deviceIdentity.js`:

```js
// electron/auth/deviceIdentity.js
//
// Per-device persistent libp2p transport identity (ADR:
// docs/adr/2026-09-14-device-identity-and-token-binding.md §1/§2). Distinct from
// host_signing_key (localAuth.js): that key is Host-only and signs tokens; this key
// belongs to EVERY device (Host or Client) and is what makes that device's libp2p
// PeerId stable across restarts, which is the precondition the ADR's token-binding
// design depends on. Generated lazily, once, the first time a device runs a sync
// node — see syncNode.js's startSyncNode, which calls this before startTransport.
//
// Never synced: same exclusion class as host_signing_key. This table must never be
// registered in PROJECTIONS, campScopedEntities.js, or campDocument.js's
// MODELED_ENTITIES.
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

export async function ensureDeviceIdentity(db) {
  const existing = db.prepare('SELECT peer_id, private_key FROM device_identity_key WHERE id = 1').get()
  if (existing) {
    const privateKey = privateKeyFromProtobuf(Buffer.from(existing.private_key, 'hex'))
    return { peerId: existing.peer_id, privateKey }
  }

  const privateKey = await generateKeyPair('Ed25519')
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const privateKeyHex = Buffer.from(privateKeyToProtobuf(privateKey)).toString('hex')

  db.prepare(
    'INSERT INTO device_identity_key (id, peer_id, private_key, created_at) VALUES (1, ?, ?, ?)'
  ).run(peerId, privateKeyHex, new Date().toISOString())

  return { peerId, privateKey }
}
```

  Verify the exact import path (`@libp2p/crypto/keys` vs `@libp2p/crypto`) against
  `node_modules/@libp2p/crypto/package.json`'s `exports` map before committing — the ADR confirmed
  the functions exist in `@libp2p/crypto@5.1.23`'s `dist/src/keys/index.d.ts` but did not pin the
  exact public subpath export string; resolve it the same way (read the installed package, not
  memory) per `org-source-verification`.
- [ ] Run the test file again — expect PASS.
- [ ] Commit: `git add electron/auth/deviceIdentity.js electron/auth/deviceIdentity.test.js`.

## Slice 3 — `bindOrVerifyPeerIdentity`: TOFU bind-or-reject on `devices.libp2p_peer_id`

**Goal:** the pure decision function the admission path will call — no wiring into
`connectionAuth.js`/`syncNode.js` yet, so this slice is testable and reviewable in isolation
(ADR §3/§4).

**Files:**
- Modify: `electron/sync/automerge/peerIdentity.js` — add `bindOrVerifyPeerIdentity`, alongside the
  existing `recordLibp2pPeerId` (which `joinSession.js` keeps calling unchanged — do not remove or
  rename it).
- Modify: `electron/sync/automerge/peerIdentity.test.js` — add coverage for the new function.

**Interfaces:**
- Consumes: nothing new (raw `db`, `deviceId`, `peerId` strings — same shape `recordLibp2pPeerId`
  already takes).
- Produces: `bindOrVerifyPeerIdentity(db, deviceId, peerId) => { ok: true, bound: 'first' | 'match' }
  | { ok: false, reason: 'peer_identity_mismatch' }` — this exact shape is what Slice 4 wires into
  `connectionAuth.js`'s new `4405` return.

**Steps:**
- [ ] Write the failing tests:

```js
// added to electron/sync/automerge/peerIdentity.test.js
describe('bindOrVerifyPeerIdentity', () => {
  it('first contact for a device with no bound peer id: binds and returns ok', () => {
    const db = freshDb() // existing helper in this test file
    db.prepare("INSERT INTO devices (id, name) VALUES ('d1', 'Device 1')").run()
    const result = bindOrVerifyPeerIdentity(db, 'd1', 'peer-a')
    expect(result).toEqual({ ok: true, bound: 'first' })
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBe('peer-a')
  })

  it('reconnect with the same bound peer id: matches, ok, no error', () => {
    const db = freshDb()
    db.prepare("INSERT INTO devices (id, name, libp2p_peer_id) VALUES ('d1', 'Device 1', 'peer-a')").run()
    const result = bindOrVerifyPeerIdentity(db, 'd1', 'peer-a')
    expect(result).toEqual({ ok: true, bound: 'match' })
  })

  it('a different peer id than the one bound: rejected, devices row untouched', () => {
    const db = freshDb()
    db.prepare("INSERT INTO devices (id, name, libp2p_peer_id) VALUES ('d1', 'Device 1', 'peer-a')").run()
    const result = bindOrVerifyPeerIdentity(db, 'd1', 'peer-b')
    expect(result).toEqual({ ok: false, reason: 'peer_identity_mismatch' })
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBe('peer-a')
  })
})
```

- [ ] Run: `npm test -- electron/sync/automerge/peerIdentity.test.js` — expect FAIL (function
  undefined).
- [ ] Implement in `peerIdentity.js`:

```js
// bindOrVerifyPeerIdentity (ADR: docs/adr/2026-09-14-device-identity-and-token-binding.md §3/§4).
// Trust-on-first-use: the FIRST peer id ever presented for a device_id becomes that
// device's bound identity; every later presentation must match exactly, or is
// rejected. Unlike recordLibp2pPeerId (routing convenience, always overwrites, never
// a trust signal — kept for joinSession.js's Client-side Host-routing use, unchanged),
// this function IS part of the admission decision and is called only from
// connectionAuth.js's evaluateAuthenticate/evaluateLogin call sites.
export function bindOrVerifyPeerIdentity(db, deviceId, peerId) {
  const row = db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(deviceId)
  const bound = row?.libp2p_peer_id ?? null

  if (bound === null) {
    db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run(peerId, deviceId)
    return { ok: true, bound: 'first' }
  }
  if (bound === peerId) {
    return { ok: true, bound: 'match' }
  }
  return { ok: false, reason: 'peer_identity_mismatch' }
}
```

- [ ] Run the test file again — expect PASS.
- [ ] Commit: `git add electron/sync/automerge/peerIdentity.js electron/sync/automerge/peerIdentity.test.js`.

## Slice 4 — Wire into `connectionAuth.js` and `syncNode.js`; new `4405` reason

**Goal:** the actual admission path enforces the bind. This slice makes the T155 replay test in
`syncNodeAuthGate.test.js` flip — the observable success predicate (ADR §6).

**Files:**
- Modify: `electron/auth/connectionAuth.js` — `evaluateAuthenticate(db, { token, device_id, peerId
  })` and `evaluateLogin(db, { device_id, device_secret_identifier, name, pin, peerId })`: after the
  existing trust/revocation check passes (and, for login, after `attemptLogin` succeeds), call
  `bindOrVerifyPeerIdentity`; on `{ ok: false }` return `{ ok: false, code: 4405, reason:
  'peer_identity_mismatch' }` (authenticate) / `{ ok: false, reason: 'peer_identity_mismatch' }`
  (login, matching that function's existing no-code convention), and call `recordAuditEvent` with
  `outcome: 'deny'`, `reason: 'peer_identity_mismatch'`, mirroring the existing trust-denial audit
  call exactly.
- Modify: `electron/auth/connectionAuth.test.js` — unit coverage for the new parameter and the
  4405/mismatch path, isolated from libp2p (pass arbitrary `peerId` strings, same as existing tests
  pass arbitrary `device_id` strings).
- Modify: `electron/sync/automerge/syncNode.js` — `onAuthenticate`/`onLogin` pass `peerId:
  fromPeerId` into `evaluateAuthenticate`/`evaluateLogin`; replace their
  `recordLibp2pPeerId(db, msg.device_id, fromPeerId)` calls with reliance on
  `evaluateAuthenticate`/`evaluateLogin`'s own internal `bindOrVerifyPeerIdentity` call (do not call
  it twice) — `startSyncNode` also calls `ensureDeviceIdentity(db)` once at startup and passes the
  returned `privateKey` into `startTransport`.
- Modify: `electron/sync/automerge/transport.js` — accept and forward a `privateKey` option into
  `createLibp2p({ privateKey, ... })`.
- Modify: `electron/sync/automerge/syncNodeAuthGate.test.js` — invert the T155 block per ADR §6
  (title, comment, and the `replayed` assertion from `toEqual({ type: 'auth_ok' })` to
  `expect(replayed.type).toBe('auth_failed')`); add a new test asserting an ordinary reconnect —
  same device, same persisted identity, simulated by calling `ensureDeviceIdentity` against the same
  db twice — still succeeds.
- Modify: `electron/db/libp2pPeerId.migration.test.js` — update the existing guard describe block's
  comment (ADR §4: explain admission-vs-authorization, not delete the assertion) and add the new
  sibling describe block asserting `connectionAuth.js` references `libp2p_peer_id` and that
  reference is scoped to `bindOrVerifyPeerIdentity`'s call, not any role/permission grant.

**Steps:**
- [ ] Write the failing `connectionAuth.test.js` cases first (mismatch rejected with 4405 for
  authenticate; mismatch rejected without a code for login; matching peerId still succeeds; a
  device with no bound peer id yet still succeeds and binds).
- [ ] Run: `npm test -- electron/auth/connectionAuth.test.js` — expect FAIL.
- [ ] Implement the `connectionAuth.js` changes.
- [ ] Run again — expect PASS.
- [ ] Write the failing `syncNodeAuthGate.test.js` inversion + reconnect-survives-restart test.
- [ ] Run: `npm test -- electron/sync/automerge/syncNodeAuthGate.test.js` — expect FAIL (old
  assertion still says `auth_ok`).
- [ ] Implement the `syncNode.js`/`transport.js` wiring.
- [ ] Run again — expect PASS.
- [ ] Update `libp2pPeerId.migration.test.js`'s comment + new sibling block; run
  `npm test -- electron/db/libp2pPeerId.migration.test.js` — expect PASS (the pre-existing
  assertion is unchanged in behavior, only its framing comment and a new sibling test are added).
- [ ] Run the full integration scenarios: `npm run test:integration` — LAN-sync join/pairing flows
  must still pass (a brand-new device's first pairing now also performs its first TOFU bind; this is
  the scenario most likely to regress if `ensureDeviceIdentity`/`bindOrVerifyPeerIdentity` are wired
  in the wrong order relative to `startTransport`).
- [ ] Run: `npm run verify` — full gate green.
- [ ] Commit: `git add electron/auth/connectionAuth.js electron/auth/connectionAuth.test.js electron/sync/automerge/syncNode.js electron/sync/automerge/transport.js electron/sync/automerge/syncNodeAuthGate.test.js electron/db/libp2pPeerId.migration.test.js`.

## Slice 5 — Docs: SECURITY.md, PLATFORM_STATE.md (owner-flagged), T155 cross-reference

**Goal:** the closed property and its accepted cost are stated where the next reader looks, not left
implicit in commit history.

**Files:**
- Modify: `SECURITY.md` — update the section that currently states "a camp token is a bearer
  credential" (the exact sentence T155's ticket and this ADR both quote) to state the closed
  property and the accepted reinstall/re-pairing cost (ADR §3), in the same plain-statement style
  the existing PIN-KDF section uses ("no KDF parameter makes a four-digit PIN safe" — match that
  register: state the boundary, don't oversell it).
- Do NOT modify `docs/current/PLATFORM_STATE.md` in this ticket — the owner stated they will do
  this themselves.
- Modify: `docs/work/tickets/T155-admission-gate-characterized-limits.md` — do not reopen (`status:
  completed` stands; it correctly characterized the gap at the time). Add a one-line pointer:
  "Closed by T162 (`docs/work/tickets/T162-device-identity-and-token-binding.md`),
  2026-09-14-decided." per ADR §6's guidance not to edit its substance.
- `docs/work/INDEX.md` is generated, not hand-edited — `npm run index:work` (`scripts/build-work-index.js`)
  derives it from this ticket's and the ADR's frontmatter. Do not edit it directly.

**Steps:**
- [ ] Update `SECURITY.md`'s bearer-token sentence.
- [ ] Add the one-line pointer to `T155-admission-gate-characterized-limits.md`.
- [ ] Run: `npm run index:work` — regenerates `docs/work/INDEX.md` with T162 and the ADR present.
- [ ] Run: `node scripts/check-governance.js` — expect a clean pass (no stale-doc/status-drift/
  index-stale findings).
- [ ] Commit: `git add SECURITY.md docs/work/tickets/T155-admission-gate-characterized-limits.md docs/work/INDEX.md`.

## Archive condition

Per the frontmatter `archive_when`: mark this ticket `status: completed` only once Slice 4's
end-to-end test (replay rejected, reconnect-after-restart succeeds) is green under `npm run verify`
and Slice 5's doc updates have landed.
