---
title: "Slice E — DCUtR hole-punch (relay-coordinated, capped)"
document_type: ticket
status: parked
task_class: architecture
date: 2026-09-27
created: 2026-09-27
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md, docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md]
related_tickets: [docs/work/tickets/T288-rendezvous-client-v2.md]
program: security-hardening
archive_when: "DCUtR hole-punching connects full/restricted/port-restricted-cone NAT pairs using @libp2p/dcutr + @libp2p/circuit-relay-v2 for brief coordination only (within the package's own duration/byte caps, re-verified at build), the Tier-4 guard is updated, and it degrades cleanly to the next rung — merged ONLY after INTERNET_TRANSPORT_SIGNOFF"
---

# T290 (Slice E) — DCUtR hole-punch — OWNER-GATED (Tier-4)

PARKED behind `INTERNET_TRANSPORT_SIGNOFF`. Adds `@libp2p/dcutr` + `@libp2p/circuit-relay-v2` (NOT installed today — verify caps against the actual installed source at build; the cited 2min/128KiB caps came from a different install). Coordination-only (already allowed by 2026-09-17 Decision 3). Design: docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md (ladder, rung 3).
