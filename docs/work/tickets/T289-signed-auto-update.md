---
title: "Slice D — signed auto-update (code-signing + signed update feed)"
document_type: ticket
status: parked
task_class: security-auth
date: 2026-09-27
created: 2026-09-27
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md, docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md]
related_tickets: []
program: security-hardening
archive_when: "The packaged app is code-signed and updates only from a signed feed (electron-updater or equivalent), verified end-to-end, and this is confirmed a hard prerequisite before any real camp is online — gated on the owner provisioning signing certificates"
---

# T289 (Slice D) — signed auto-update — OWNER-GATED (cert provisioning)

PARKED, parallel track (no dependency on A/B/C). Unsigned update = RCE once the app talks to the internet. Confirmed unbuilt today: `mac.identity: null`, `electron-updater` not installed. Needs an OWNER ACTION — provisioning code-signing certificates (Apple Developer ID + Windows cert as applicable). Design: docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md (Section 5). Surface the exact cert/provisioning requirements to the owner when D is scheduled.
