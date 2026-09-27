---
title: "Slice C — rendezvous client built fresh to the v2 encrypted-record shape"
document_type: ticket
status: parked
task_class: security-auth
date: 2026-09-27
created: 2026-09-27
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md, docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md]
related_tickets: [docs/work/tickets/T211-wire-rendezvous-into-discovery-path.md]
program: security-hardening
archive_when: "A rendezvous client built to the v2 encrypted-record shape publishes and fetches/decrypts records against the reconciled worker contract, treats every GET field as adversarial, imports no libp2p internet-transport package, and the Tier-4 guard is updated per the boundary rules — merged ONLY after the owner flips INTERNET_TRANSPORT_SIGNOFF"
---

# T288 (Slice C) — rendezvous client, v2 — OWNER-GATED (Tier-4)

PARKED behind the owner's `INTERNET_TRANSPORT_SIGNOFF` flip. First slice that trips the Tier-4 guard. Build fresh to the **v2** shape (Slice B) — do NOT merge T270's held v1 `rendezvousClient.js` on `claude/dreamy-williams-da94cb` (superseded by v2). Design + boundary rules: docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md (the ladder, rung 2) and docs/adr/2026-09-17-wan-rendezvous-seam.md §58/§128.
