---
title: "A support command for the rebuild property T151 proved, not a button"
document_type: ticket
status: completed
created: 2026-09-14
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: rebuild_projection_from_document ships, refuses every documented precondition failure loudly, and the ticket's stated limitations remain accurate
---

# T161 — A support command for the rebuild property, not a button

Owner decision, 2026-09-14: "Delete this computer's SQLite and rebuild it from
the Automerge document" (T151) is a proven capability with no entry point.
Give it one — deliberately **not** a UI button.

## Why a support command, not a button

A button's worst day is worse than the problem it solves. This operation
deletes a device's entire local projection and re-derives it from the synced
document. Its failure modes are all silent-until-they-aren't: a wrong
`user_data_dir`, a document that doesn't belong to this camp, a device that
was mid-repair when someone clicked it twice. A button invites exactly the
"try clicking it and see" behaviour this procedure cannot tolerate — it is a
recovery step a person runs on purpose, or is walked through on the phone,
with someone actually looking at the refusal message and the before/after
report before deciding to proceed. `repair_projection_entity` — the nearest
precedent in this codebase — made the same call for the same reason, and this
tool follows its exact shape: `--allow-write`-gated, no renderer IPC, no
director-facing surface.

## What it does

`rebuild_projection_from_document` (`scripts/mcp/server.js` /
`scripts/mcp/tools.js`), backed by
`electron/automerge/rebuildSupportCommand.js`:

1. Reads this device's `camps` row and locates
   `<user_data_dir>/automerge/<campId>.automerge`.
2. Validates every precondition (see below) — **before** touching anything.
3. Takes a pre-rebuild backup via `writePreMigrationBackup` (reused, not
   reinvented — the exact function `electron/db/projectManager.js` already
   uses for migrations).
4. Deletes the SQLite file (and its `-wal`/`-shm` sidecars) and recreates it
   from schema alone.
5. Bootstraps the `camps` row with the matching id — T151's pinned
   precondition — then runs `projectAll`.
6. Reports row counts per modeled table, before and after, plus an explicit
   statement of what does not come back.

### Why delete-and-recreate, not wipe-in-place

`projector.js` already exports a wipe-then-reproject path
(`rebuildFromDoc(db, doc)` with no `entity` arg) that looks like the obvious
fit. It isn't: `operations` — this device's own op-log/history ledger, not a
document-tracked table — has `author_user_id REFERENCES users(id)`. Wiping
`users` in place while `operations` still points at the old rows throws a
foreign key violation on a database that has ever actually been used (proven
by writing this ticket's own test against a camp built through real write
paths, not a hand-built fixture). T151's property test never hit this because
it projects into a database that was never populated any other way.

Deleting the file and creating a fresh one — exactly the shape T151's test
already proves, camps row bootstrapped, then `projectAll` — sidesteps the
problem entirely: a fresh file's `operations` table starts empty, so there is
nothing left to conflict. It is also the more literal reading of "delete
SQLite and rebuild."

## What it refuses, and why each is destructive rather than merely wrong

- **No `camps` row at all.** Document replay never creates it
  (`projector.js`'s own comment); bootstrapping it is `bootstrapCamp`/the join
  flow's job, not this tool's.
- **No document file for this camp.** Nothing to rebuild from — most likely
  this device has never synced.
- **A document that does not share this camp's genesis**
  (`campDocument.js`'s `sharesGenesis`, the same check `syncNode.js` uses
  before merging a peer's document). Projecting a foreign-lineage document
  would not just fail to help — it would silently substitute a different
  camp's data.
- **A `camps` row id that doesn't match the document's own camp id.** Same
  class of mistake as the genesis check, caught even when the genesis
  happens to be shared (a plausible slip: the right build, the wrong
  camp's document file).

Every refusal is `RebuildRefusalError` with a message naming the next step,
never a bare throw.

## What it does not restore

Reported back in the tool's own result, not left implicit:

- **The `operations` table** — Trash contents, Restore's prior values, and
  ingest-undo history. This is this device's own history ledger, not part of
  the document (`docs/current/WHERE_DATA_LIVES.md`'s existing T151 section).
- **`signing_secret` / `signing_public_key`, and `host_signing_key` if this
  device is the sync Host.** These are host-only/device-local and were
  deliberately never written to the document (`campDocument.js`'s own
  comment on `EXTRA_MODELED_ENTITIES`) — they come back empty and must be
  re-established through the normal pairing/host flow. This is a real gap
  beyond what the owner's framing named, found while implementing; flagging
  it here rather than letting the tool's report imply full recovery.

## Files

- `electron/automerge/rebuildSupportCommand.js` — the two-layer
  implementation (pure `validateRebuildSource`/`rebuildIntoFreshDb`, plus
  the file-path orchestration `rebuildProjectionFromDocumentAtPath`).
- `electron/automerge/rebuildSupportCommand.test.js` — precondition
  refusals, the fresh-db rebuild, and the file-path wrapper's backup/delete/
  recreate behavior.
- `scripts/mcp/tools.js` — `rebuildProjectionFromDocumentTool`, gated on
  `allowWrite` exactly like `repairProjectionEntityTool`.
- `scripts/mcp/server.js` — tool registration.
- `scripts/mcp/tools.test.js` — the `--allow-write` gate and an end-to-end
  run through the MCP handler.
