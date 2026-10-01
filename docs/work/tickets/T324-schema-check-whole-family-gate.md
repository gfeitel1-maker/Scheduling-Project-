---
title: "Schema/migration test family becomes one self-maintaining gate"
document_type: ticket
status: completed
created: 2026-10-01
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: []
related_tickets: []
archive_when: "npm run schema:check exists, runs every electron/db/*.migration*.test.js, electron/db/rollback/*.test.js, electron/ops/*parity*.test.js, electron/ipcSurfaceParity.test.js and electron/automerge/purgeCollateral.test.js in one invocation, and a drift guard fails if a glob stops matching a real family member; the one remaining bare schema-version-literal pin (electron/db/peerTombstoneReports.migration.test.js) reads CURRENT_SCHEMA_VERSION instead; the bareEqualityRollback and purgeCollateral guards' failure messages name the exact file/constant to edit when they fire; CLAUDE.md documents schema:check as the required pre-push step for electron/db/** and schema.sql changes"
---

# T324 — Schema/migration test family becomes one self-maintaining gate

Board item `q-schema-bump-family-self-maintaining`. Every schema bump (v84/v85/v86) cost a red CI
round on the same test family, one file at a time, because nothing ran the family as a unit and
nothing caught a forgotten member. #711 already fixed the three per-migration CURRENT_SCHEMA_VERSION
literal pins this family had accumulated at that point (`electron/db/localDb.js:43`, now v86). This
ticket closes the remaining gap: make the family runnable as one command, and make it resist the
next bump the same way.

## What shipped

- **`npm run schema:check`** (`scripts/schemaCheck.js`) — globs the whole family off disk
  (`SCHEMA_FAMILY_GLOBS`: `electron/db/*.migration*.test.js`, `electron/db/rollback/*.test.js`,
  `electron/ops/*[Pp]arity*.test.js`, `electron/ipcSurfaceParity.test.js`,
  `electron/automerge/purgeCollateral.test.js`) and runs it under one `vitest run` invocation. A
  `preschema:check` hook rebuilds `better-sqlite3` for Node first, matching `pretest`'s existing
  pattern.
- **`scripts/schemaCheck.test.js`** — a drift guard asserting every glob still resolves to at least
  one file, the full family includes 11 specifically-named members (one per glob, including both
  rollback guards and all four `electron/ops/*parity*` files), and the combined resolution has no
  duplicates. Verified non-vacuous: removing the ops-parity glob from the script was red before the
  fix and green after restoring it.
- **The fourth literal schema-version pin**, found by sweeping for `.toBe(86)` /
  `=== 86`/`MAX(version)` comparisons repo-wide: `electron/db/peerTombstoneReports.migration.test.js`
  (added alongside #711/#712, after that sweep had already run) asserted
  `expect(CURRENT_SCHEMA_VERSION).toBe(86)` and `expect(getSchemaVersion(db)).toBe(86)` twice — the
  exact fragile-on-next-bump shape #711 fixed elsewhere. Rewritten to the same pattern
  `camperIdentityKeys.migration.test.js` (v85, already fixed) uses:
  `expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)`, with the per-migration historical
  pin (`schema_migrations WHERE version = 86`) left untouched because that one is correct forever,
  not fragile. No other literal version-pin was found; `rollback/v78_down.test.js`'s
  `.toBe(77)` and the `WHERE version <= N` historical checks in several migration tests are
  legitimate per-migration pins, not touched.
- **Named failure messages** on the two guard assertions that previously fired silent: the rollback
  file-count assertion in `electron/db/rollback/bareEqualityRollback.guard.test.js` now says to bump
  the literal and add a dated note (matching the existing v84/v85/v86 note convention above it) when
  a new `vNN_down.js` lands; the core drift-catcher in `electron/automerge/purgeCollateral.test.js`
  now names the exact four constants (`PURGE_WIPED_TABLES` / `PURGE_LEDGER_TABLES` /
  `PURGE_PRESERVED_TABLES` / `PURGE_INFRASTRUCTURE_TABLES`) and file
  (`electron/automerge/purgeCollateral.js`) a new non-modeled table must be added to. The
  `rollbackIdentity.guard.test.js` and the four `electron/ops/*parity*` guards already named their
  fix target in every assertion message — no change needed there.
- **`CLAUDE.md`** — one line in the Commands block naming `npm run schema:check` as the required
  pre-push step for any change under `electron/db/**` or `electron/db/schema.sql`, and what it
  covers.

## Evidence

`npm run schema:check` — 74 test files, 671 tests, all green (181s).
