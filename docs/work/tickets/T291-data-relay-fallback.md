---
title: "Slice F — capped, configurable data-relay fallback (Option B)"
document_type: ticket
status: parked
task_class: architecture
date: 2026-09-27
created: 2026-09-27
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md, docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md]
related_tickets: [docs/work/tickets/T290-dcutr-holepunch.md]
program: security-hardening
archive_when: "A capped, configurable, self-hostable/disable-able circuit-relay-v2 data-relay connects symmetric-NAT/CGNAT-both-ends pairs by forwarding ciphertext only (Noise end-to-end through it), with owner-set bandwidth/duration caps, the Tier-4 guard updated — merged ONLY after INTERNET_TRANSPORT_SIGNOFF, and deployed under the owner's own infrastructure"
---

# T291 (Slice F) — data-relay fallback — OWNER-GATED (Tier-4 + owner infra)

PARKED. Owner ACCEPTED Option B (2026-09-27): a capped, configurable data-relay is in scope for CGNAT-both-ends pairs the hole-punch cannot reach. It forwards ONLY ciphertext (Noise e2e) — an untrusted encrypted-bytes forwarder, not a confidentiality risk; real costs are owner-hosted bandwidth + an availability dependency. Needs its OWN caps (rung-3's coordination caps are too small). Design + owner decision: docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md (Section 2, the relay decision).
