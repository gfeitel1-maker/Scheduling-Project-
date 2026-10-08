---
title: "At-rest encryption default-on, sticky once keyed, no ambient disable"
document_type: adr
authority: normative
status: accepted
implementation_state: implemented
date: 2026-10-08
program: security-hardening
related_adrs:
  - docs/adr/2026-09-15-at-rest-encryption-scoping.md
  - docs/adr/2026-09-28-at-rest-encryption-disable-control.md
related_tickets:
  - docs/work/tickets/T175-at-rest-encryption-activation.md
---

# At-rest encryption: default on, sticky once keyed, no ambient disable

## Decision

1. `SHORESH_AT_REST_ENCRYPTION` is on unless it is exactly `off`. A typo resolves to on.
2. Once a device holds its key file (`db.key.enc` in userData), encryption is latched on for the process
   (`latchEncryptionIfKeyPresent`, called in `electron/main.js` right after `app.whenReady()` and before
   key acquisition). The environment variable cannot turn it off. A stat error other than ENOENT also
   latches on: an unknown state never reads as safe to disable.
3. No in-app, IPC or UI disable is offered in this slice. The only exits are out-of-band: restore from a
   paired device or a backup, or deliberately delete the key file and data.
4. `'off'` remains a pre-activation and test escape (`vitest.setup.js` pins it for the suite).

## Why

A flag-off launch against an already-encrypted device does not fall back to plaintext; it bricks the
device's own data access. A verified decrypt-back plus key shred is a data-loss-prone path and is not
needed to remove the ambient flip.

## Rejected

- Director-gated disable IPC with decrypt-back migration: deferred to a follow-up ticket (T345).
- A persisted policy row in SQLite or the document: unreadable exactly when needed, since the DB is encrypted.
- Removing the env var: roughly 270 tests and dev workflows need an off switch.

## Headless processes

Headless tools (MCP, CLI) have no userData plumbing for the latch, but the default is now on, so the
`openLocalDb` guard fires. Setting `off` there cannot make an encrypted file readable; it yields an
opaque SQLite error (fail-closed by physics). An on-disk-header refusal is optional hardening, out of scope.
