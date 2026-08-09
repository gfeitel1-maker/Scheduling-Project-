---
title: T74-dev-mock-ingest-fidelity
document_type: ticket
status: completed
created: 2026-08-08
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs:
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md
  - docs/adr/2026-08-08-t73-held-import-resolution-recommit.md
program: onboarding-reconciliation
archive_when: the dev mock reproduces recognition/update/held-conflict/resolution so the reconciliation UI is exercisable at localhost:5200
---

# T74 — Dev mock ingest fidelity for the reconciliation flow

**Status: open.** Surfaced during T73 verification.

## Problem

`src/localClient.mock.js`'s `ingestCommit` (the localhost:5200 dev path, used when there is no
Electron `window.shoresh`) is a **separate, older implementation** of the import commit. It does NOT
mirror the reconciliation behavior that has since landed on the real `electron/ops/ingest.js`
committer:

- no recognition (S1a: name-match → `unchanged`),
- no field-level update or Policy-A hand-edit protection (S2b),
- no HELD outcome (`{ held:true, conflicts:[...] }`),
- no `resolutions` parameter (T73).

Consequence: the entire reconciliation UI — the recognition/update behavior, and specifically the
**T73 held-conflict resolution flow** (banner, queue, confirm-identity + stale cards, re-commit) —
**cannot be exercised at all in the dev environment.** T73 was verified by unit + component tests and
code review; its live visual/interaction pass had to be deferred because the dev server can't produce
a held state, and Electron isn't runnable in the build environment.

This is the mock/real divergence `TESTING_STANDARD.md §2` and the `dev mock fidelity` governance test
warn about — "when the mock and the real client diverge, the dev environment silently lies" (it has
already cost a blocking bug once).

## What to do

Bring `mock.ingestCommit` up to parity with the real committer for the reconciliation flow: recognition
(→ unchanged), field diff → update, the Policy-A gate against a mock `source` marker, the HELD outcome
shape, and the `resolutions` re-commit. It need not replicate the op-log internals — only the
director-observable *contract* (the same outcome shapes the renderer branches on), enough that
`ImportScreen`'s recognition/update/held/resolution paths run truthfully at localhost:5200.

## Acceptance

- [ ] A dev-session re-import of an already-present camp shows recognition (no duplicates).
- [ ] A dev-session re-import that would change a hand-edited field HOLDS and surfaces the stale card;
      accepting/keeping behaves as the real backend does.
- [ ] An ambiguous-identity case surfaces the confirm-identity card and resolves.
- [ ] The `dev mock fidelity` governance test stays green (no new divergence).
- [ ] The T73 live visual/motion pass (emphasis-swap, queue auto-advance) can be done at localhost:5200.
