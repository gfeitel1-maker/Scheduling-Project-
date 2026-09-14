---
title: "PIN hash cost raised, and hashes made self-describing"
document_type: ticket
status: completed
created: 2026-09-13
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a new PIN hash carries the scrypt parameters it was produced with, legacy bare-hex hashes still verify at the old cost, and SECURITY.md states plainly what the cost does and does not buy
---

# T150 — PIN hash cost raised, and hashes made self-describing

From the external architecture review of 2026-09-13 (item 9), which expected to
find no weakness. The hygiene is in fact sound — unique 16-byte salt per user,
`timingSafeEqual`, plaintext never persisted, 5-attempt lockout. The weakness is
the combination the review did not multiply out:

`scryptSync(pin, salt, 64)` ran at **Node's default cost** (N=2^14), the PIN is
effectively **four numeric digits**, and `pin_hash`/`pin_salt` are **modeled
document fields** — they replicate to every approved device and sit in a
plaintext `.automerge` file on each one. Ten thousand candidates against a hash
anyone holding the file can grind offline, where the lockout does not apply.

## What changed

- `SCRYPT_PARAMS` = N=2^16, r=8, p=1 (with `maxmem` raised, since 2^16 needs
  64MB and Node's default ceiling is 32MB). Measured ~430ms per hash, paid once
  at login.
- New hashes are stored as `scrypt$N=..,r=..,p=..$<hex>`, so the cost can be
  raised again without a flag day — the parameters travel with the hash.
- `verifyPin` parses the stored format and verifies at the cost the hash was
  **produced** with. A legacy bare-hex hash still verifies at Node's defaults,
  so no existing login breaks. A malformed stored hash is a failed login, never
  a throw.

## What this deliberately does not claim

Raising the cost turns a few minutes of offline work into a few hours. **No KDF
parameter makes a four-digit PIN safe.** What actually bounds the risk is the
trust model: whoever has the document already has the camp's data, because the
document *is* the data — cracking a PIN buys impersonation (authorship, and
`staff` -> `admin` escalation), not access. The open questions are PIN length and
role separation, and both are product decisions, recorded in SECURITY.md rather
than decided here.

There is no automatic re-hash of a legacy hash on successful login: `attemptLogin`
has no write callback, and adding one couples authentication to the replication
path for a benefit that only lands on next login anyway. A PIN change re-hashes
at the current cost.
