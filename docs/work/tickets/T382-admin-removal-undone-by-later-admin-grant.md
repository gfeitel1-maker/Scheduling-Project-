---
title: T382-admin-removal-undone-by-later-admin-grant
document_type: ticket
status: open
created: 2026-10-13
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-10-02-distributed-revocation-authority.md]
archive_when: a removed admin device stays removed when a later grant raises the admin count, pinned by a test against electron/automerge/authorityReplay.js
---

# T382 — An admin's removal can be undone by a later admin grant (post-v1, known limitation)

**Found 2026-10-13** while investigating audit step 19b (the second removed device not learning). Not that bug.

## What it is

`stateAt` in `electron/automerge/authorityReplay.js` decides a removal by comparing the distinct revoke signers against
`quorumThreshold(grantedSet.size)`, recomputed from the admin count at the current position. Once a camp has two or more
granted admin devices, an admin removed by a vote that met quorum when the admin set was small can fall back below quorum
after a later grant enlarges the set, so the removed admin is silently admin again.

## Why it is post-v1

Unreachable in v1: no screen grants device admin. `src/localClient.js` calls `approveDevice` with only the device id,
so `makeAdmin` is never true and no grant entry beyond the founder genesis is minted by the app. Recorded in SECURITY.md,
Known limitations. Owner's v1 rule (via the keeper): no new items unless they break a camp.

## Direction

Make a removal final once quorum was met at its own causal position (evaluate each target's quorum at the position the
deciding vote was cast, not at the current heads), consistent with the 2026-10-13 rule that a removed device id is never
granted again. Red-first test: two admins, remove one, grant a third, assert the removed one stays removed.
