// Mint the camp-shared rendezvous address-body encryption key.
// docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, Section 3, point 1.
//
// Pure document-layer code, same shape and same trust boundary as rendezvousNamespace.js's
// `rendezvousDiscovery` field: one scalar document field (`camps.rendezvousAddressKey`, 64 lowercase
// hex chars = 32 random bytes), generated once by whichever device first enables v2 rendezvous and
// propagated to every paired device for free via ordinary Automerge document sync. A device that has
// never synced the document (a not-yet-paired joiner) cannot see it.
//
// This is a NEW field, not a new distribution channel — no SQLite column, no migration, no
// PROJECTIONS registration, exactly like rendezvousDiscovery (see that module's file-level comment
// for why this bypasses campDocument.js's applyWrite/PROJECTIONS allowlist).
//
// Deliberately the raw 32-byte secret itself, not a key already narrowed by HKDF — rendezvousRecord.js
// derives the actual AES key from this via HKDF-SHA256 with a fixed, versioned info string, so a
// future v3 can derive a different key from the same underlying secret without rotating it.
import * as A from '@automerge/automerge'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { recordKey, readRecord } from '../../automerge/campDocument.js'

const ENTITY = 'camps'
const FIELD = 'rendezvousAddressKey'
const ADDRESS_KEY_PATTERN = /^[0-9a-f]{64}$/

function writeField(doc, campId, value) {
  return A.change(doc, (d) => {
    if (!d[ENTITY]) d[ENTITY] = {}
    d[ENTITY][recordKey(campId, FIELD)] = value
  })
}

/** Read the camp's address key (64 lowercase hex chars), or null if v2 rendezvous was never enabled. */
export function readRendezvousAddressKey(doc, campId) {
  const row = readRecord(doc, ENTITY, campId)
  const value = row?.[FIELD]
  if (value == null) return null
  if (typeof value !== 'string' || !ADDRESS_KEY_PATTERN.test(value)) {
    throw new Error(`rendezvousAddressKey: malformed ${FIELD} value: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Mint a fresh camp-shared address key the first time v2 rendezvous is enabled. Idempotent-safe:
 * if a key already exists, it is returned unchanged — minting never overwrites an existing key.
 * Like mintRendezvousNamespace, this is idempotent only against SEQUENTIAL calls: two devices
 * minting concurrently both see "no existing key" and both write, so one write wins the Automerge
 * merge (last-writer-wins on a scalar field) and the other's minted:true does not survive — a
 * genuine concurrent-mint race, not a bug this module hides.
 */
export function mintRendezvousAddressKey(doc, campId, { randomBytes = nodeRandomBytes } = {}) {
  const existing = readRendezvousAddressKey(doc, campId)
  if (existing) {
    return { doc, addressKey: existing, minted: false }
  }

  const addressKey = randomBytes(32).toString('hex')
  const next = writeField(doc, campId, addressKey)
  return { doc: next, addressKey, minted: true }
}
