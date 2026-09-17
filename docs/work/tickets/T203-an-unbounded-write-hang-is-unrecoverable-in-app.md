---
title: "An unbounded localClient.write hang leaves the camp bootstrap unrecoverable without an app restart"
document_type: ticket
status: open
created: 2026-09-17
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
depends_on: "T200/T201 (PR #464, merged 2d49c55) narrowed the bootstrap failure surface to this residue and documented it as an accepted limit. Deliberately kept out of that renderer-scoped PR."
archive_when: "a hung localClient.write cannot strand the camp bootstrap — either because write carries a bounded timeout whose expiry surfaces as a normal write failure, or because days_of_operation gains a UNIQUE constraint making a retry safe without the in-flight guard — the chosen option is recorded in an ADR, and `npm run verify` is green"
---

# T203 — a hung write is the one bootstrap failure the director cannot clear

## Confirmed against code at 2d49c55

`localClient.write` has **no timeout**. It returns `{ status }` on success or refusal, and throws on
error — but a handler that never answers (dead IPC channel, crashed main process, a write blocked
indefinitely on a locked SQLite file) simply never settles.

T200/T201 handled every *settling* failure: both bootstrap failures now compose into one notice, and
"Try again" re-runs them. A **hang** is the residue. `bootstrapInFlight` is held for the life of the
hung promise, so every retry click correctly refuses to start a concurrent run and says so — which is
honest, and still leaves the director stuck. The only recovery is restarting the app.

Restart *is* a genuine recovery path (`seededForCamp` is a per-instance `useRef`, so a fresh
`AppShell` re-runs the bootstrap — verified during T201 review, against a reviewer's claim to the
contrary). Nothing in the UI tells the director to do it, beyond one sentence on the refused-retry
notice.

## Why this needs an ADR rather than a renderer patch

Both candidate fixes cross out of the renderer:

1. **A bounded timeout on `localClient.write`** — the general fix. It makes a hang indistinguishable
   from any other write failure, so T201's existing retry handles it with no new UI. But it changes
   the IPC contract for **every** caller, and picking the bound is a real decision: too low turns a
   slow-but-fine write into a spurious failure, and the write may still land afterwards, so the
   timeout must be an *answer* to the caller, not a cancellation.
2. **A `UNIQUE` constraint on `days_of_operation`** — narrower. It is what `cohorts` already has, and
   it would let a retry run concurrently with a hung attempt without risking the 10-day duplication,
   because the loser would collide rather than duplicate. This is a schema migration with a
   fresh-vs-migrated equivalence obligation, and `seedDays`'s header comment records that two stale
   comments already *claim* such a constraint exists when it does not — so this would also settle a
   known documentation defect.

They are not exclusive; (1) is the general fix and (2) removes a latent duplication hazard
independent of hangs. Recommend (1) first: it is the one that closes the reported symptom for every
caller, and (2) can follow as its own migration.

## Required work

An ADR choosing between/among the above, then the implementation it specifies. Per
`GOVERNANCE_INDEX.md` §3–8 this is `architecture` (and `database-sync` if (2) is chosen): ADR
approval is a **human gate**, and option (2) additionally requires a migration/rollback plan and the
mandatory integration gate.
