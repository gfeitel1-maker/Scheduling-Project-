---
title: "A removed device can clear itself: Start fresh on this computer"
document_type: adr
authority: normative
status: accepted
implementation_state: implemented
date: 2026-10-13
program: device-removal
related_adrs:
  - docs/adr/2026-09-28-at-rest-encryption-disable-control.md
  - docs/adr/2026-07-25-device-trust-revocation.md
  - docs/adr/2026-07-28-explicit-userdata-directory.md
affects:
  - electron/main.js
  - electron/db/localReset.js
  - electron/localResetRunner.js
  - electron/sync/automerge/selfRemoval.js
  - electron/preload.js
  - src/components/StartFreshOnThisComputer.jsx
  - SECURITY.md
---

# A removed device can clear itself: Start fresh on this computer

## Status

Accepted 2026-10-13. Owner ruling, approved by the board keeper with delegated authority: the removed-device
screen says "This computer was removed from the camp." and offers "Start fresh on this computer", with a second
explicit "Yes, start fresh" confirmation. The old "ask your director to re-approve it" text goes. A removed device
cannot be added back (see the revocation ADR), so the way to reuse the computer is to clear it and join again as a
new device.

## Decision

1. **Gate.** The action is offered and executable only when `isLocallyRemoved(db, deviceId)` holds: (a) a row in
   `applied_authority_log` with `kind = 'revoke'` and `target_device_id` = this device (that table is written only
   after `isEntryTrusted`), AND (b) `authority_cache` says revoked for this device (a revoked-then-re-granted device
   keeps its revoke row, so this is still needed), AND (c) `isRemovedFromCamp(db)`. Neither the cache nor the mark
   is enough alone: one forged, unsigned entry targeting a device plus a bare refusal sets both. A healthy device
   is refused with `not_removed` before anything is touched. The same check runs before and after the quiesce, and
   the renderer shows the button from `getSyncStatus().startFreshAvailable` (the same function), never from a
   close-code string; a peer-identity mismatch (4405) gets no button.
2. **Handler.** `startFreshOnThisComputer({ confirm: 'START_FRESH' })`, channel
   `shoresh:start-fresh-on-this-computer`. No token: a removed device is signed out and the revoke is the gate.
   Single-flight. The runner re-checks the gate on the quiesced database (a re-grant can land while sync stops);
   if it no longer holds, nothing is wiped and the app restarts.
3. **What is cleared** (userData only; the list is `LOCAL_RESET_FILES` plus in-userData project databases):
   `shoresh.sqlite` and its `-wal`/`-shm` (device identity and libp2p key live in it), `automerge/`, `db.key.enc`
   (first), `backups/`, `tool-authorizations.enc`, `recent-projects.json`, `current-project.json`,
   `encryption.disabled`, `encryption.disable-journal`, `tcp-listen-port.json`, `port-mapping-grant.json` and the
   `punch-*.json` stores. The app-wide OS "Safe Storage" keychain item is not touched. Nothing outside userData is
   touched, including through a symlinked folder.
4. **Crash safety: move aside, finish forward.** A fsynced `local-reset.journal` lists the targets; each is renamed
   into `.reset-<stamp>/`; the journal becomes `moved`; the app restarts. Before any database opens, the next launch
   deletes the staged key first, then the staging directory, then the journal last. A kill at any step leaves
   either the untouched device (the journal never became durable) or a state the next launch completes.
5. **Other camps are named first (owner ruling).** The confirm step lists every other camp this computer remembers
   (recent projects; the stored camp name, else the file name) through the read-only, identically gated
   `shoresh:start-fresh-preview`. For each: "Before you continue, use Save whole camp in <camp> so you can open it
   again." A project database outside userData is named with its path, is never touched, and will no longer open
   (its key is cleared). The director still chooses. `sessions-valid-after.json` is also cleared;
   `encryption.disabled` is cleared too, so a fresh join comes back encrypted.
6. **Not a sync mechanism.** This clears one computer. It says nothing to the camp, and the camp's information
   remains on the other computers.

## authority_cache writer

`authority_cache` is written only by `upsertCampAuthorityLogEntity` in `electron/automerge/projector.js`, which
re-derives it on every projection pass through the verified entry trust (`createVerifiedEntryTrust`). Its
fail-safe also labels a device that an entry targets but that is not in the granted set as `revoked`, even when
the entry itself fails verification; that is correct for admission (deny), which is why this gate also requires
the removed mark, which is recorded only after verified revocation evidence.

## Consequences

The removed-device sidebar flag is text only and reads "sign out, then Start fresh"; it no longer links to Pair again.
