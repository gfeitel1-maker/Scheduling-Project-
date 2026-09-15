---
title: "Three keys, one event: what to do when a device is lost, reset, or replaced"
document_type: reference
authority: descriptive
status: active
date: 2026-09-15
created: 2026-09-15
archive_when: never — this is a standing recovery lookup, refreshed when the key set changes
---

# Three keys, one event

**This page exists to be looked up in one moment: a director says "I lost my laptop"
(or reset it, reinstalled the app, or restored from a backup).** That one event
touches three different cryptographic keys, and each answers differently. The point
of this page is that a director — and whoever is helping them — reads all three
answers in one place, instead of meeting them as three separate confusing flows.

It was written *before* the third key (at-rest storage encryption) shipped, on
purpose (ADR `docs/adr/2026-09-15-at-rest-encryption-scoping.md`, constraint 3): the
storage key is the one that hard-fails and the one the recovery story is mostly
*about*, so the page is built around it, and the other keys — including one that is
accepted but not yet built — are named occupants of a page that already exists.

## The one question a director actually asks: "I got a new laptop."

| | **What happens on the new/reset machine** | **Why** |
|---|---|---|
| **Host signing key** (`host_signing_key`, Ed25519) | Matters **only if the lost machine was the sync Host.** If so, it is a genuine loss: the new machine must be set up as a Host and **re-establish its identity** through the normal flow before it can mint credentials (add users, promote admins). If the lost machine was a *client*, this key was never on it — nothing to recover. | Host-only, never replicated. It is the camp's authority to sign credential changes; a new Host earns a new one. |
| **Device identity key** (T162, persistent per-device — *accepted, not yet built*) | **Re-pair.** The new machine is a new device; it pairs to the camp again and is trusted afresh. The old device's identity simply stops being used. | Per-device, established at pairing. Losing it is losing a device, and the answer to a lost device is a new pairing — never a lockout. See ticket **T162** / ADR `2026-07-28-device-identity-*`. |
| **Storage (at-rest) key** (per-device, in the OS keychain) | **The old machine's on-disk data is unreadable — and that is the feature.** The new machine does **not** recover the old bytes; it **syncs the camp fresh from a peer** (any other paired device holds the same document). No data is lost to the *camp*, only to the stolen disk. | The key lives in the OS keychain of the old machine's login, released only to this app under that user. A thief with the disk cannot read it; a new install re-syncs rather than decrypts. |

**The short version for a director:** *"You don't recover the old laptop's files —
you don't need to. Any other camp device still has everything. Set the new laptop up,
pair it (or make it the Host if the lost one was), and it fills in from the others.
The old laptop's data stays locked, which is exactly what you want if someone else has it."*

## The one case that is a real loss, spelled out

There is exactly one way this event loses something the camp can't get back from a
peer: **the lost machine was the *only* device**, or **the only Host and no client
had synced recently.** Then:

- The storage key is gone with the machine → the on-disk data is unreadable **even
  to you** (this is the accepted hard-fail; see below). There is no passphrase to
  recover it with, by design — the alternative (a director-remembered passphrase)
  was rejected because "forget it = lose the camp" is a worse day than the theft.
- If it was the Host, its signing key is gone too → a new Host must re-establish
  identity before it can mint credentials.

**Mitigation is operational, not cryptographic: keep more than one device paired and
synced.** With any second synced device, the "real loss" case does not occur — that
device *is* the backup, continuously.

## Why the storage key hard-fails (and why that is allowed here)

Every other recent decision in this codebase holds to *a missing thing must not
become a hard failure* (a reinstalled device re-pairs; an absent signing key keeps
last-known credentials; "cannot tell" is a third answer, never a lockout). **At-rest
encryption inverts that on purpose: no key means no readable data, and there is no
graceful version — that is what encryption *is*.** It is the codebase's first
deliberate hard-fail, accepted in the ADR because the alternatives are worse and the
mitigations make it humane:

- the key is minted and sealed **automatically** — no passphrase to forget;
- it **survives app reinstalls** (it is in the OS keychain, not in app files a
  reinstall would wipe);
- the loss cases are exactly the ones in the table above, and the answer to almost
  all of them is "sync from a peer," not "recover the key."

## What the rebuild support command can and cannot do here

`rebuild_projection_from_document` (T161) rebuilds this device's SQLite setup/schedule
from its **own** synced document. Once the document is encrypted under the storage
key, that command's reach narrows, and its report must distinguish two situations a
support person handles **oppositely**:

- **No document file at all** → nothing to rebuild from on this device; re-sync from
  a peer. (Existing `NOT_RECOVERABLE_NOTICE` territory.)
- **Document file present but undecryptable** (keychain entry gone) → the bytes are
  there but the key is not; rebuild cannot help, and the answer is again *re-sync from
  a peer / re-pair*, not "repair this file." This is the storage-key row of the table
  above, reached from the support path.

See ADR `2026-09-15-at-rest-encryption-scoping.md` constraint 2. The rebuild command's
refusal check will be updated to name this case when the storage key is wired live.

## Where each key actually lives (for the check-it-yourself reader)

| Key | Storage | Replicated? | Recovery |
|---|---|---|---|
| Host signing key | `host_signing_key` table (Host only) | Never | New Host re-establishes identity |
| Device identity (T162) | per-device secret (not yet built) | Never | Re-pair |
| Storage / at-rest key | OS keychain (`safeStorage`), sealed file `db.key.enc` | Never | None — re-sync from a peer |

Related: `docs/current/WHERE_DATA_LIVES.md` (which copy of the *data* wins),
`SECURITY.md` (the trust model and the at-rest boundary), and
`docs/adr/2026-09-15-at-rest-encryption-scoping.md` (the decision and its constraints).
