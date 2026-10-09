---
ticket: T352
document_type: ticket
title: Doc-aware backup restore - restoring the SQLite backup alone is silently undone by the Automerge document
status: in-progress
created: 2026-10-09
archive_when: "doc-aware restore designed and built, or explicitly declined by the owner"
task_class: database-sync
parent: ""
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/current/WHERE_DATA_LIVES.md]
related_prs: [808]
related_tickets: []
---

# T352 - Doc-aware backup restore

## The gap

`shoresh:restore-project` swaps only the SQLite file. The Automerge document is the source of truth
and SQLite is its projection, so on the next sync start `projectAll`'s delete-reconcile
(`electron/sync/automerge/syncStarter.js`, the comments at lines 214-226 and 319) re-projects the document over the
restored db. The restore is silently undone.

No UI calls `restoreProject` today (a grep of `src` finds only `localClient.js` and its mock). The
Restore button work is parked on the local branch `claude/restore-control`.

## Done so far

Backups now include the camp document: `writeUserBackup` (`electron/db/projectManager.js`) copies
`<userData>/automerge/*.automerge` to `backups/shoresh-<ts>.automerge/` with the same timestamp as
the `.db`, bytes as-is (still encrypted at rest), 0600/0700, and rotation removes the pair together.
The backup call sites in `electron/main.js` flush pending debounced document writes first.

## Known limits of the backup pair

- The db and document copies are not atomic, and the flush covers only the current in-memory
  document, so a pair can be slightly out of step.
- A failed document copy removes its partial dir and is reported (`docBackupError` from
  `shoresh:backup-project`); orphaned `.automerge` dirs whose `.db` was rotated away by other means
  are not rotated.
- The pre-restore document copy is unused until this ticket builds the doc-aware restore.

## Ruling (keeper, owner delegation 2026-10-09)

Restore rebuilds THIS device from the backup, then re-syncs; older data merges with peers' newer data (CRDT) and does not override what other devices hold.

## Acceptance

- Restore puts back the backup's `.db` and `<campId>.automerge` (bytes as-is, still encrypted); sync restarts on the restored document through the existing `syncStarterHolder` swap, and the projection follows from it.
- Refused with plain copy, nothing changed on disk: a backup with no document copy, a backup of a different camp, a document that cannot be decrypted.
- A document step failure leaves db and document untouched; a db step failure puts the document back.
- The confirm states that this computer's copy is restored and that other devices' changes sync back.
- Tests: `electron/db/backupRestore.test.js`, `src/components/layout/RestoreControl.test.jsx`.

## Open owner question (resolved above)

Relayed by the keeper: what does restore mean in a multi-device camp? CRDT merge means an old
document merges with peers' newer state rather than winning. Candidate meaning: "rebuild this device
from the backup, then re-sync". Needs an owner ruling before any build.

## Remaining

Nothing; built. Not covered: fleet-wide rollback, restoring another camp's backup, an atomic db+document snapshot.
