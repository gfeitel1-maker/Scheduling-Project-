---
title: T103-location-disambiguation-suffix-namespace
document_type: ticket
status: open
created: 2026-08-20
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-15-locations-concurrent-create-collision.md]
archive_when: the location disambiguation suffix cannot collide with a deriveLocationId of a literal name, and the free-suffix scan is bounded, with a test — or the risk is documented as accepted
---

# T103 — Location `${base}:${n}` disambiguation suffix shares deriveLocationId's namespace (Red Hat, T101)

**Surfaced by Red Hat during T101 review (2026-08-20). NON-corrupting — recorded as a follow-up.**

`deriveLocationId(campId, name) = location:${campId}:${trimmedName}`. T101's recollide fallback mints
`${base}:${n}`. Because `deriveLocationId` never escapes/rejects colons in names, a location literally
named `Pool:2` derives the SAME string as the recollide fallback for base name `Pool`. The
name-equality guard in `resolveLocationCandidateId` means this NEVER causes silent overwrite/data-loss
(Red Hat confirmed), but it can produce confusing (non-corrupting) id assignment — a real `Pool:2`
forcing a `Pool` recollide to `:3`, or a later `Pool:2` import skipping to `Pool:2:2`.

Also (LOW): the free-suffix scan `for (let n=2;;n++)` in `locationId.js` has no upper bound — inert at
realistic camp scale, adversarial-only.

## Definition of done
- The disambiguation suffix uses a delimiter/scheme that cannot coincide with a `deriveLocationId` of a
  literal trimmed name (e.g. a delimiter illegal in a trimmed name, or escaping), with a test; OR the
  coincidence is documented as accepted (it's non-corrupting).
- The suffix scan is bounded (a ceiling / UUID fallback), with a test.

## Related
- T101 (the mitigation this refines). T81 (deterministic importer ids).
