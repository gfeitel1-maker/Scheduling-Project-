---
title: "docs/work — entry point"
document_type: reference
status: active
---

# docs/work

This directory holds the project's work records: tickets, specs, ADRs, run records, and
handoffs. The sections below split them into the five directories a generated board is built
from, and the other directories here that are not board inputs.

## Source directories (what `npm run index:work` reads)

These five directories are scanned by `scripts/build-work-index.js` to build the board:

- **`docs/adr`** — Architecture Decision Records: accepted or proposed structural decisions.
- **`docs/work/tickets`** — scoped, ticket-numbered (`T<n>`) units of work, open or closed.
- **`docs/work/specs`** — design specs for a feature or subsystem, ahead of or alongside
  implementation.
- **`docs/work/runs`** — per-task run records: brief, agents dispatched, gates, verdict.
- **`docs/work/handoffs`** — what a new session needs that the repository cannot tell it on its
  own, written when context would otherwise be lost between sessions.

## Other directories here (not board inputs)

These hold real project material, but `build-work-index.js` does not read them, so they will
never appear on the generated board:

- `docs/work/architecture-reports` — periodic architecture-audit output.
- `docs/work/evidence` — raw evidence captured for a specific finding or claim.
- `docs/work/onboarding-reconciliation` — onboarding/reconciliation program material.
- `docs/work/plans` — longer-lived plans that are not ticket-shaped.
- `docs/work/security` — dated security assessments.
- `docs/work/testing` — testing-program material.

A handful of loose top-level `.md` files in this directory (dated explorations and one-off
baselines) are likewise not board inputs — they're read directly, not through the index.

## Building the board

`docs/work/INDEX.md` — open work by task class, decisions with their inverted backlinks,
orphans, and dangling references — is generated on demand, not committed:

```
npm run index:work
```

It is gitignored and deliberately never committed: every PR that filed a run record or flipped
a ticket's status was touching the same regenerated sections of that one file, which meant a
constant stream of rebases and full CI re-runs for PRs that otherwise didn't conflict. See
[`docs/adr/2026-10-01-work-index-is-generated-not-committed.md`](../adr/2026-10-01-work-index-is-generated-not-committed.md).
