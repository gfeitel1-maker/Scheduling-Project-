---
title: T376-shared-signed-device-roster
document_type: ticket
status: open
created: 2026-10-12
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-10-12-shared-signed-device-roster.md]
related_tickets: []
archive_when: "with the Host off and the 24h token lapsed, two joined clients admit each other and sync, a removed device is refused by every peer that has seen the removal and can never be readmitted, and a forged or unsigned roster entry admits nothing, proven by the rewritten hostOffRoster.integration.test.js plus the revocation, forged-entry, revoked-everywhere and stale-view tests named in the ADR"
---

# T376: shared signed device roster

**Owner ruling (2026-10-12):** the approved-device list lives in the camp document, signed so it cannot be forged. Any two approved, unrevoked devices admit each other with or without the host. The host is needed only to add brand-new devices.

**Why.** `hostOffTokenExpiry.integration.test.js` (565dc85f) shows that with the host off two clients refuse each other at once, and that the 24h host-signed token lapses with no renewal.

**Design.** `docs/adr/2026-10-12-shared-signed-device-roster.md`: host-signed `device_roster` entity, device-local `roster_cache` projection, admission by roster plus the libp2p Noise key proof (no token), removal through the existing T331 revoke.

**Scope.** The ADR's section 6 tests (flip tests 0, A-D; add E-K) and section 7 files. Schema bump for `roster_cache`; fresh camps only, no migration.

**Non-goals.** No expiry or lease, no new UI, no change to host handoff, no role in the roster, no cross-version compatibility.

**Constraints for the maker.** One test file at a time with `--no-file-parallelism`; no `npm ci`, build, verify or packaged runs locally; CI is the gate. Run `npm run schema:check` family reasoning through CI. Start with `graphify affected "issueCampToken()"`.
