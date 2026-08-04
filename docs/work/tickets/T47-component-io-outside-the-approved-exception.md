---
title: T47-component-io-outside-the-approved-exception
document_type: ticket
status: open
created: 2026-08-04
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-08-04-repository-layer-policy.md]
archive_when: resolved — no component under src/components/ performs domain reads
---

# T47 — Two components read domain data directly, outside any approved exception

**Risk:** Low to ship, medium structurally. The components work; the boundary they cross is the one
the amended layering rule depends on to mean anything.
**Found:** Phase E (R5 conformance audit), 2026-08-04.

## What is wrong

`ARCHITECTURE_STANDARD.md` §6 states components are presentational and do not perform IO, with
exceptions approved explicitly and listed. Phase E's audit enumerated every `localClient` call site
in `src/`. Two components perform domain data access and are covered by **no** exception:

1. **`src/components/layout/Sidebar.jsx`** — the substantial one.
   - `:57` — `localClient.list(AREA_TABLE[area])`, a fan-out read across **every** setup table, to
     compute the setup-gap badges.
   - `:65` — `localClient.list('template_slots')`.
   - `:127` — `localClient.getCamp()`.
   These use a module-scope import, not injected props, so the component cannot be tested without
   module mocking. (Its `getSyncStatus` / `onSyncStatusChanged` / `onOpApplied` subscriptions at
   `:92, :95, :101-102` are infrastructure, not domain reads, and are fine.)

2. **`src/components/RecordHistory.jsx`**
   - `:22` — `localClient.list(entity)` to resolve foreign-key labels.
   - `:98` — `localClient.getEntityHistory(entity, entityId)`.
   Also a module-scope import.

## Why it matters

The approved component-IO exception covers **confirmation dialogs owning their own destructive
call** — `DeleteWeekDialog` and `DeleteRecordDialog`. That exception rests on a specific argument:
the dialog is the only thing that knows the user confirmed, and routing the call back through the
parent buys nothing.

**That argument does not extend to these two.** They perform reads for display, which is precisely
what props exist for. A parent can fetch and pass down; nothing is lost. Treating them as covered
would turn a narrow, reasoned exception into "components may do IO when convenient," which is the
rule dissolving rather than being applied.

Sidebar is the one worth acting on: a layout component reading every setup table means the sidebar
re-queries the whole catalog independently of whatever screen is mounted, and no test can render it
without mocking the client module.

## Scope

**In:** extract both into hooks under `src/hooks/` — a `useSetupCounts()` (or similar) for Sidebar's
gap badges, and a `useRecordHistory(entity, entityId)` for RecordHistory. Both are conforming
**simple-domain** shapes (`Hook → localClient`); **neither needs a repository**, and creating one
would be exactly the pass-through the ADR forbids. Components then receive data as props.

**Out:** the two approved confirm-dialogs. Any repository creation. Any visual change — the badges
and history panel must render identically.

**Boundaries:** no change to what is queried or when, only to where the query lives. Preserve
Sidebar's existing refresh-on-`onOpApplied` behavior.

## Completion evidence

1. No `localClient` import remains in `src/components/**` except the two approved confirm dialogs.
2. Sidebar and RecordHistory render from props; both are testable without mocking the client module.
3. Setup-gap badges and record history show identical values before and after.
4. `ARCHITECTURE_STANDARD.md` §6's "not covered by any exception" paragraph is removed once both are
   resolved.
5. Full `npm run test`, `npm run lint`, `npm run build` pass.
