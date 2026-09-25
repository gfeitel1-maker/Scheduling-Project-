---
title: "Sidebar readiness ticks go stale after an import undo"
document_type: ticket
status: completed
created: 2026-09-25
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-17-onescreen-reconciliation-undo.md]
archive_when: undoing an accepted import refreshes the sidebar readiness ticks and counts on this device without a reload, proven by a regression test on the onLocalWrite fan-out
---

# T259 — Sidebar readiness ticks go stale after an import undo

Same class of bug as T123, reopened for one path. `useSetupCounts`
(`src/hooks/useSetupCounts.js`) refreshes the sidebar's readiness ticks and
counts on two channels: `onOpApplied` (an op arriving from another device) and
`onLocalWrite` (this director's own write, fired by the `announcing()` wrapper
in `src/localClient.js`).

Every mutating localClient method is wrapped in `announcing()` — except
`ingestUndo`, which was left out. `ingestUndo` writes: it reverts the import's
field-updates and deletes the rows the import created
(`docs/adr/2026-08-17-onescreen-reconciliation-undo.md`, U1+U2). So undoing an
accepted import changed the data but fired no local-write signal, and the
sidebar stayed on its post-import ticks and counts until something else forced
a refetch (a reload, a subsequent write). `ingestReconcile`, its neighbour, is
a read-only dry run and correctly stays unwrapped.

## Done
- [x] `ingestUndo` wrapped in `announcing()` in `src/localClient.js`, so its
  resolve fires `onLocalWrite` exactly as `ingestCommit`/`deleteRecord`/
  `restoreEntity` already do. A rejected undo still notifies nothing (the
  wrapper notifies only after the promise resolves) — a failed undo changed
  nothing.
- [x] Regression test in `src/localClient.localWrite.test.js` ("notifies after
  an import undo"), against the mock's real `ingestUndo` (which mutates and
  returns), added to the same suite that pins the write/delete/merge/restore
  channels. Non-vacuity: red before the wrapper, green after.

## Scope
Renderer-only. Reuses the existing `onLocalWrite` channel; adds no
main→renderer IPC channel, touches no `electron/` code. The caller
(`src/hooks/useGraceWindowUndo.js`) still receives the same awaited result
object — `announcing` returns it unchanged.
