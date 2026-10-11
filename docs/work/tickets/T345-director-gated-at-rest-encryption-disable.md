---
ticket: T345
document_type: ticket
title: Director-gated at-rest encryption disable with verified decrypt-back
status: parked
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

## Parked 2026-10-11: post-v1 (keeper ruling)

v1 keeps the sticky no-disable posture of docs/adr/2026-10-08-at-rest-encryption-sticky-no-ambient-disable.md, which is safe and has an out-of-band exit. The built work is on branch `claude/t345-encryption-disable` (commits 13b0d43e and b1726979, pushed for reference, no PR). The Grader blocked it on three open items:

1. **Real-driver proof of `PRAGMA rekey = ''`.** `electron/db/sqliteCipher.integration.test.js` skips where the encrypting driver will not load. It must run for real, on CI Linux or a machine with the driver.
2. **Security and Red Hat re-review of b1726979.** That commit suspends doc saves before the key shred, closing the HIGH where a late save re-encrypts the document after the key is gone. It has not been reviewed.
3. **Recovery when the app is killed mid-rekey.** There is no design for a kill partway through the rekey. Every in-sequence failure rolls back.
