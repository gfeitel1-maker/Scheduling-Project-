---
title: "Slice A — attack-hardened join secret (ephemeral, scrypt-KDF, rate-limited, both-sides)"
document_type: ticket
status: completed
task_class: security-auth
date: 2026-09-27
created: 2026-09-27
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md, docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md]
related_adrs: [docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md]
program: security-hardening
archive_when: "The permanent 40-bit deterministic join code is replaced by a Host-minted random ephemeral window-scoped secret (>=50 bits) whose rendezvous/proof tag is scrypt-derived, proof attempts are rate-limited by the Host (authority) now — the Worker-edge limiter is a REQUIRED-BEFORE-SLICE-C item (no WAN-reachable join-proof endpoint exists until T288/rendezvous lands, so there is nothing at the Worker to limit today; recorded on T288), the chosen scrypt N/r/p is MEASURED to cost ~100ms/guess (recorded, not assumed), the existing join flow (pairing/login/waitForCamp incl. T274's node-lifecycle fixes) still works, no Tier-4 trip / no internet egress in electron/sync/automerge, and Red Hat + Security have ACTUALLY RUN the six attacks in ADR 2026-09-27 §4 with a recorded verdict"
---

# T286 (Slice A) — attack-hardened join secret

Full design + six-attack plan: docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md §4, implementing docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md. Owner priority: "make sure the join secret is what we think it is — plan to attack it as much as possible." The adversarial phase (Red Hat + Security RUN the attacks) is the point, not a diff review.

## Closed (2026-09-30)

Merged in #581. `electron/sync/joinCode.js` mints a random 50-bit (10 Crockford-char) window-scoped
secret and derives its rendezvous/proof tag via scrypt (`N=32768, r=8, p=1`), measured on-machine at
107.6–112.7ms/guess, matching the in-code claim. Host-side rate limiting on proof attempts is present
now; the Worker-edge limiter is explicitly out of scope until a WAN-reachable join-proof endpoint
exists (T288/rendezvous), and its identity-churn bypass is recorded as required-before-Slice-C in
`docs/work/handoffs/2026-09-28-wan-connectivity-at-tier4-signoff-gate.md`, carried into T288 — exactly
what this ticket's `archive_when` excuses. The existing join flow (pairing/login/waitForCamp, T274's
node-lifecycle fixes) is unbroken (PR: integration 25/25). No Tier-4 trip (Tier-4 guard green,
`INTERNET_TRANSPORT_SIGNOFF=false`). Red Hat and Security actually ran the six attacks in ADR §4 with
a recorded verdict (Security 5, Red Hat Resilience 4; all six defeated or explicitly scoped out).
`electron/sync/joinCode.test.js` (20/20) passes on this branch. All `archive_when` clauses are
discharged.
