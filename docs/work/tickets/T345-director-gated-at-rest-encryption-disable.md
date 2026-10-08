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
