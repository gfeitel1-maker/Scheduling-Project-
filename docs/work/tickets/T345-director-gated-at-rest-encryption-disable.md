---
ticket: T345
document_type: ticket
title: Director-gated at-rest encryption disable with verified decrypt-back
status: open
created: 2026-10-08
archive_when: "a director/host can disable at-rest encryption on a device through authorize() with a consequence-stating confirm, a verified decrypt-back of the document and SQLite, and key shred, with the guard test-covered"
task_class: security-auth
parent: ""
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-10-08-at-rest-encryption-sticky-no-ambient-disable.md, docs/adr/2026-09-28-at-rest-encryption-disable-control.md]
related_prs: []
related_tickets: []
---

# T345 - Director-gated at-rest encryption disable

T175 makes encryption default-on and sticky once a device is keyed, with no disable offered. This
ticket designs the deliberate disable: an `authorize()`-gated IPC, a consequence-stating confirm, a
verified backup, document decrypt plus `PRAGMA rekey=''`, and key-file shred, failing closed on any
unknown state. See docs/adr/2026-09-28-at-rest-encryption-disable-control.md.

## Pulled into v1 2026-10-11 (owner)

The 2026-10-11 park is withdrawn; the work is on branch `claude/t345-encryption-disable-v1`. The Grader's three blockers and where each is closed:

1. **Real-driver proof of `PRAGMA rekey = ''`.** `electron/db/sqliteCipher.integration.test.js` now runs the decrypt and the whole disable through the real driver, and never skips on CI (`CI=true` turns a missing driver into a failure with the load error). Also confirmed against the driver source and by hand under the Electron ABI. Found and fixed on the way: the driver refuses to rekey a WAL-mode db, so the disable now switches the copy to `journal_mode = DELETE` first.
2. **Re-review of the quiesce fix.** The order flush, stop sync, flush, block saves, close db, disable is now its own module (`electron/atRestDisableRunner.js`) with a runner-level order test.
3. **Kill mid-rekey.** Redesigned so no live file is edited in place: journal, staged plaintext copies, atomic swap, marker, then key removal, with boot-time recovery. Crash-point table in docs/adr/2026-09-28-at-rest-encryption-disable-control.md ("Amendment 2026-10-11 (b)"); `electron/db/disableAtRestEncryption.crash.test.js` kills the run before every step.

Closure is the Grader's call.
