---
title: "Slice B — v2 encrypted rendezvous record (camp-shared key, AES-256-GCM address body)"
document_type: ticket
status: in-progress
task_class: security-auth
date: 2026-09-27
created: 2026-09-27
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md, docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md]
related_adrs: [docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md]
related_tickets: [docs/work/tickets/T288-rendezvous-client-v2.md]
program: security-hardening
archive_when: "The v2 rendezvous record encrypts ONLY the address body with AES-256-GCM under a key HKDF-derived from a camp-shared camps.rendezvousAddressKey (namespace/peerId/timestamps/signature stay plaintext), a v1 verifier rejects a v2 record (anti-downgrade version byte), the record+worker wire shapes are reconciled to the single v2 shape in one pass (Q5), a namespace-holder without the camp key CANNOT read addresses and the worker sees only ciphertext, no Tier-4 trip / no internet egress, and Security + Red Hat have probed key custody and run the v2-ciphertext attack"
---

# T287 (Slice B) — v2 encrypted rendezvous record

Design is authoritative in docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md Section 3 (lines ~167-266, incl. the org-interface-contracts checklist). Reuses T175's AES-256-GCM/HKDF pattern (electron/db/atRestEncryption.js). The rendezvous CLIENT is Slice C (T288, held) — Slice B reconciles the RECORD (rendezvousRecord.js) + WORKER (workers/rendezvous/worker.js) to the v2 shape; do NOT build or resurrect the client. Carry into T288: Slice A finding-1 (Host rate-limiter identity-churn bypass) is required-before-Slice-C.
