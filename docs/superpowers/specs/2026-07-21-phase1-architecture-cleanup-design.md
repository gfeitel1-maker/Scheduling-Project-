# Phase 1 — Architecture cleanup (remove Supabase ambiguity)

Source: `SHORESH_LOCAL_FIRST_HARDENING.md` §3, §12 (Phase 1 of the hardening plan). Scope agreed with user 2026-07-21: this phase only. Device pairing/revocation (hardening plan §5) is explicitly deferred to a later phase. Raw-PIN-over-WebSocket (§6.3) is explicitly NOT being changed in this phase — see "Out of scope" below.

## Problem

`PLATFORM_STATE.md` and the rewritten `CLAUDE.md` (2026-07-20/21) already document the Electron/SQLite architecture as current and flag `src/supabase.js`/`src/hooks/useSession.js` as legacy in prose. But nothing *enforces* that boundary in code: `@supabase/supabase-js` is still an active dependency, `src/supabase.js` and any Supabase-era hooks/screens still exist unmarked at the file level, and there is no automated check preventing a future change (by a human or an agent) from importing the Supabase client into a new active module. `README.md` has not yet been checked/updated at all.

## Solution

### 1. Inventory (Maker's first sub-step, not a separate task)

Before moving anything, grep the entire active `src/` and `electron/` tree for:
- `from '.*supabase` / `require(.*supabase` imports
- Any component/hook that only makes sense under the old auth model (candidates already known: `src/supabase.js`; `src/hooks/useSession.js` is referenced in the *old* CLAUDE.md text but must be confirmed to still exist and be checked for current callers before moving anything — don't assume the file list from the prior doc pass is still accurate)
- Confirm whether anything in `src/screens/`, `src/App.jsx`, or `src/hooks/` still imports from `src/supabase.js` today. If something does, that import must be migrated or the file cannot simply be moved — this is a real risk to check, not a formality.

### 2. Move, don't leave in place

Preferred approach from the hardening doc: move legacy Supabase-era files into `legacy/supabase/` at repo root (sibling to `electron/`, `src/`), rather than the "mark deprecated in place" alternative — this repo has no active migration tooling depending on the old path, so there's no reason to keep it interleaved with active code.

- Move `src/supabase.js` → `legacy/supabase/supabase.js`.
- Move any confirmed-orphaned Supabase-only hook(s) (e.g. `useSession.js`, if confirmed unused by current active code) → `legacy/supabase/`.
- Move `supabase/migrations/` → `legacy/supabase/migrations/` (the directory, not the MCP integration — Supabase MCP tools remain available for reference/inspection but the migrations directory is legacy artifact, not an active schema source).
- Add a one-line `legacy/supabase/README.md`: what this is, why it's kept (historical reference for the pre-rebuild schema/RLS design, in case it's ever needed to answer "what did we used to do"), and that it is not wired into the build.

### 3. Remove the dependency from the active bundle

- Remove `@supabase/supabase-js` from `package.json` `dependencies` once step 2 confirms nothing active imports it.
- Run `npm install` to update the lockfile.
- If anything active still needs it (discovered in step 1), stop and report — do not silently leave it half-migrated. This is exactly the kind of "stop and surface a contradiction rather than guess" case the hardening doc calls for in its own §15.

### 4. Automated ban on future active imports

Add an ESLint rule (this repo already runs `eslint .` per `package.json`'s `lint` script) that fails if any file under `src/` or `electron/` imports from `@supabase/supabase-js` or a `legacy/` path. `eslint-plugin-import`'s `no-restricted-paths`, or a simpler `no-restricted-imports` rule scoped by glob, both fit — Maker should pick whichever requires the least new tooling given what's already in `devDependencies` (check before adding a new plugin dependency; prefer zero-new-dependency `no-restricted-imports` if it can express "ban this package name" without needing path-based zone config).
- Add a test (or confirm the lint rule itself is enough, run via CI/`npm run lint`) proving: a fresh `import { createClient } from '@supabase/supabase-js'` added to any file under `src/` or `electron/` causes `npm run lint` to fail non-zero. This is the actual acceptance-criteria proof, not just "the rule exists in config."

### 5. Documentation reconciliation

- `README.md`: read it first (not yet reviewed in this doc-cleanup effort). Update or add a section describing Shoresh as local-first/desktop/Electron+SQLite, matching the language already in `PLATFORM_STATE.md`'s architecture note and `CLAUDE.md`. Remove any claim that Supabase/Postgres/RLS is the current production path if such a claim exists in README today.
- `CLAUDE.md`: already rewritten 2026-07-20 to describe the Electron/SQLite path as primary and Supabase as legacy — after this phase's file moves, update its "Legacy Supabase path" section to point at `legacy/supabase/` instead of `src/supabase.js`, since the file will have moved.
- `PLATFORM_STATE.md`: after this phase, its "Known Deferred Items" line about CLAUDE.md being stale is resolved (already fixed 2026-07-20) — add a line noting the Supabase code has been moved to `legacy/supabase/` and is lint-banned from active use, so this doesn't need re-discovery in a future `update-state` pass.

## Out of scope for this phase (explicit, do not attempt)

- Device pairing/approval flow, device revocation, session token lifetime changes (hardening plan §5) — deferred, not blocking this or later phases.
- Raw PIN transmission over the unauthenticated login WebSocket message (hardening plan §6.3) — user has explicitly chosen to scope this down for now rather than resolve it in this pass. Do not remove or alter `syncServer.js`'s `login` message's PIN handling. If Security or Red Hat flag it during review, the correct response is: note it as an already-known, already-documented accepted tradeoff (see `docs/superpowers/specs/2026-07-20-fresh-client-first-login-design.md`'s "Security tradeoff" section) — not a defect to fix in this task.
- Any change to the authorization model (permission matrix, centralized `authorize()`) — that is Phase 2, a separate plan.

## Testing plan

1. A lint run with a deliberately reintroduced Supabase import under `src/` (temporarily, in a throwaway test file or via an ESLint rule-tester unit test) fails.
2. `npm run build` and `npm run test` both succeed after the move + dependency removal, proving nothing active silently depended on the moved code.
3. Manual grep confirms zero remaining `supabase` references under `src/` or `electron/` (excluding comments/docs referencing the legacy path by name).
4. `npm run electron:dev` still boots to the mode-select/login flow correctly (this phase should not change any runtime behavior at all — it is a pure file-move + doc + lint-rule change).
