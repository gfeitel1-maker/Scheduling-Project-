// T202 follow-up: preserve this device's signing/identity keys across a camper purge.
//
// purgeCamperRecord (purgeSupportCommand.js) erases a camper by regenerating the Automerge
// document camper-free and then reusing rebuildProjectionFromDocumentAtPath — a whole-file SQLite
// delete+recreate that reprojects ONLY the modeled, document-replicated entities. Every host-only,
// device-local table is collateral of that rebuild (see rebuildSupportCommand.js's
// NOT_RECOVERABLE_NOTICE). For MOST of those tables that loss is an accepted, separately documented
// tradeoff — but three artifacts are load-bearing device identity, and destroying them turns a
// routine camper deletion into a silent credential/identity wipe:
//
//   - host_signing_key            — Host-only; the private key that MINTS credentials. Lose it and a
//                                    single-device Host can no longer add users or promote admins.
//   - device_identity_key         — every device; the stable libp2p PeerId key. Regenerate it and
//                                    every already-paired peer sees a stranger (peer_identity_mismatch
//                                    / 4405 trust-on-first-use rejection — see SECURITY.md).
//   - camps.signing_public_key    — the local, out-of-band mirror of the Host public key used to
//                                    VERIFY credential changes; excluded from the document
//                                    (projector.js), so it comes back genuinely empty after a rebuild.
//
// WHY PRESERVE, NOT RE-ESTABLISH. A purge is not a "device lost/reset" event: the machine stays
// alive and stays Host. docs/current/KEY_RECOVERY_STORY.md's "re-establish identity / re-pair"
// doctrine is the answer to a machine that is GONE, not to erasing one camper on a live one. The
// three artifacts are pure-random keypairs (localAuth.js ensureHostSigningKey, deviceIdentity.js
// ensureDeviceIdentity) that encode NO camper data, so preserving them resurrects nothing the purge
// meant to destroy and does not weaken camper-erasure honesty. Re-establishing instead would mint a
// NEW host_signing_key — invalidating every device token signed by the old one — and a new PeerId,
// which is strictly worse operationally and cannot be made deterministic for asymmetric keys anyway.
//
// SCOPE — exactly these three, nothing else. This is NOT a general "preserve all host-only tables"
// facility: conflicts, import_evidence, source_aliases, etc. losing state on purge is a lower-stakes,
// already-documented, already-tested tradeoff. camps.signing_secret (the retired legacy HMAC field,
// never read — connectionAuth.js) is DELIBERATELY not preserved: preserving dead key material is the
// wrong instinct, and its loss is inert. rendezvous_sequence is a disposable publish counter that
// re-establishes itself, so it is also intentionally out of scope.
//
// NOT A CREDENTIAL-ROTATION TOOL. Preserving keys removes the incidental "wipe the key" side effect
// the destructive rebuild had. If a Host is suspected compromised, the answer is device revocation +
// re-pairing (the existing flow), NEVER this command — purgeCamperRecord is a camper-erasure tool.
//
// CONCURRENCY PRECONDITION (documented, not enforced — no running-instance marker exists in this
// codebase, and the sibling support command rebuild_projection_from_document is gated the same way):
// run this only with the app / sync node STOPPED on this device. ensureHostSigningKey and
// ensureDeviceIdentity lazily mint a fresh key into an empty table on app startup; if the app were
// running concurrently it could mint an interim key into the freshly-rebuilt table before restore
// runs. restore writes the ORIGINAL bytes back with INSERT OR REPLACE by design — the original key
// is the intended survivor — but a peer that paired against the interim key in that window is the
// precondition's problem to prevent, not restore's.

import { PURGE_WIPED_TABLES } from './purgeCollateral.js'

// Reads the three preservable artifacts out of an OPEN db. Read-only — safe to call inside the same
// transaction as (or before) the purge deletes, which never touch these tables. Any absent row
// comes back null (a Client holds no host_signing_key) and is simply skipped on restore.
export function readPreservableKeys(db) {
  const hostSigningKey =
    db.prepare('SELECT public_key, private_key, created_at FROM host_signing_key WHERE id = 1').get() || null
  const deviceIdentityKey =
    db.prepare('SELECT peer_id, private_key, created_at FROM device_identity_key WHERE id = 1').get() || null
  const campsSigningPublicKey =
    db.prepare('SELECT signing_public_key FROM camps LIMIT 1').get()?.signing_public_key ?? null
  return { hostSigningKey, deviceIdentityKey, campsSigningPublicKey }
}

// Writes the preserved artifacts back into the freshly-rebuilt db, byte-identical. Called AFTER the
// rebuild completes and BEFORE the pre-migration backups are shredded, so that a crash in this
// narrow window leaves the backup (which still holds the original keys) as a manual recovery source
// — the reorder purgeSupportCommand.js depends on. Idempotent (INSERT OR REPLACE / UPDATE), and both
// the host public key AND camps.signing_public_key are written explicitly rather than relying on
// ensureHostSigningKey's lazy backfill, so a Host can verify its own tokens immediately after.
// Returns which artifacts were actually restored — never the key bytes themselves.
export function restorePreservableKeys({ dbPath, key = null, preservedKeys, openLocalDb }) {
  const restored = { hostSigningKey: false, deviceIdentityKey: false, campsSigningPublicKey: false }
  const db = openLocalDb(dbPath, { key })
  try {
    db.transaction(() => {
      if (preservedKeys.hostSigningKey) {
        const k = preservedKeys.hostSigningKey
        db.prepare(
          'INSERT OR REPLACE INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)'
        ).run(k.public_key, k.private_key, k.created_at)
        restored.hostSigningKey = true
      }
      if (preservedKeys.deviceIdentityKey) {
        const k = preservedKeys.deviceIdentityKey
        db.prepare(
          'INSERT OR REPLACE INTO device_identity_key (id, peer_id, private_key, created_at) VALUES (1, ?, ?, ?)'
        ).run(k.peer_id, k.private_key, k.created_at)
        restored.deviceIdentityKey = true
      }
      if (preservedKeys.campsSigningPublicKey != null) {
        db.prepare('UPDATE camps SET signing_public_key = ?').run(preservedKeys.campsSigningPublicKey)
        restored.campsSigningPublicKey = true
      }
    })()
  } finally {
    db.close()
  }
  return restored
}

// The purge-specific "what did not come back" notice. Distinct from rebuildSupportCommand.js's
// NOT_RECOVERABLE_NOTICE, which is now ACTIVELY WRONG for a purge: that notice says the signing keys
// "come back empty and must be re-established", which is exactly the behavior this module reverses.
// Relaying it unchanged would send a support operator into an unnecessary re-pairing/re-bootstrap.
//
// The wiped-table enumeration is DERIVED from purgeCollateral.js (the single source of truth pinned
// to the schema by purgeCollateral.test.js), so a newly-added host-only table cannot silently drop
// out of this notice while staying in the schema.
export const PURGE_NOT_RECOVERABLE_NOTICE =
  "This purge emptied this device's operations table — its own history ledger — for the whole " +
  'ledger, not just the purged camper: Trash contents, Restore\'s prior values, and ingest-undo ' +
  'history are gone for good. This device\'s signing and identity keys ARE preserved across the ' +
  'purge: the host_signing_key (if this device is the Host), the device_identity_key, and ' +
  'camps.signing_public_key all survive, so this device keeps its ability to mint and verify ' +
  'credentials and keeps its stable libp2p identity — no re-pairing or re-bootstrap is needed. ' +
  'camps.signing_secret (the retired legacy HMAC field, never read) is intentionally NOT preserved; ' +
  'its loss is inert. This is a camper-erasure tool, NOT a credential-rotation or ' +
  'compromised-device-remediation tool — to rotate a Host\'s keys or remediate a suspected-' +
  'compromised device, use device revocation and re-pairing, not this command. Other host-only ' +
  'tables (' + PURGE_WIPED_TABLES.join(', ') + ') lose their device-local state camp-wide, as an ' +
  'ordinary rebuild does.'
