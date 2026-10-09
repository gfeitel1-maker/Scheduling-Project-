// The camp-shared rendezvous address-body encryption key.
// docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, Section 3, point 1.
//
// The key is one part of the single `camps.rendezvousSecrets` tuple (rendezvousNamespace.js), so it
// can never pair with a namespace from a different rotation. It propagates to every paired device
// through ordinary Automerge document sync; a device that has never synced the document cannot see
// it. A legacy camp's `camps.rendezvousAddressKey` field is read as a fallback until the next mint
// or rotation writes the tuple.
//
// Deliberately the raw 32-byte secret itself, not a key already narrowed by HKDF — rendezvousRecord.js
// derives the actual AES key from this via HKDF-SHA256 with a fixed, versioned info string, so a
// future v3 can derive a different key from the same underlying secret without rotating it.
import { readRendezvousSecrets, mintRendezvousSecrets } from './rendezvousNamespace.js'

/** Read the camp's address key (64 lowercase hex chars), or null if v2 rendezvous was never enabled. */
export function readRendezvousAddressKey(doc, campId) {
  return readRendezvousSecrets(doc, campId)?.addressKey ?? null
}

/**
 * Mint the camp-shared key the first time v2 rendezvous is enabled (minting the rest of the tuple
 * if it is missing too). Never overwrites an existing key.
 */
export function mintRendezvousAddressKey(doc, campId, opts = {}) {
  const { doc: next, secrets, minted } = mintRendezvousSecrets(doc, campId, opts)
  return { doc: next, addressKey: secrets.addressKey, minted }
}
