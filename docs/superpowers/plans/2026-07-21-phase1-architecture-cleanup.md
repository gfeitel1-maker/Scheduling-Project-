# Phase 1 implementation plan — Architecture cleanup

Design: `docs/superpowers/specs/2026-07-21-phase1-architecture-cleanup-design.md`. Execute via the GOVERNOR loop (`agents/GOVERNOR.md`), one Maker round-trip per task, same granularity as the fresh-client-first-login and shared-camp-signing-secret plans. Full Tester+Security+Red Hat review every round — no skipping any reviewer role even though these are low-risk doc/config changes (established rule: see memory `feedback-governor-maker-resilience` region on process discipline — this repo's explicit instruction is "use the workflow. always").

Tester's UX Friction/Visual Fidelity dimensions are N/A for every task in this phase (no UI changes) — same accepted pattern as the original 10-task rebuild's backend-only tasks: still dispatch Tester, have it report N/A rather than skip it.

## Task 1 — Inventory active Supabase usage

**Success predicate:** a written, accurate list of every file under `src/` and `electron/` that imports from `@supabase/supabase-js` or from `src/supabase.js`/`src/hooks/useSession.js` (or confirms there are none), committed as a short markdown note (`docs/superpowers/notes/2026-07-21-supabase-inventory.md` or inline in the commit message if trivially short) — NOT a code change to those files yet.
**Not done if:** any active call site is missed and only discovered in Task 2 or 3 when something breaks.
**Files likely touched:** none (read-only), except the inventory note itself.

## Task 2 — Move legacy Supabase files, remove dependency, update docs

**Success predicate:**
- `src/supabase.js` and any confirmed-orphaned Supabase-only hooks are at `legacy/supabase/` with a short `legacy/supabase/README.md`.
- `supabase/migrations/` is at `legacy/supabase/migrations/`.
- `@supabase/supabase-js` is removed from `package.json` dependencies and `package-lock.json` is regenerated.
- `README.md` and `CLAUDE.md` are updated per the design doc's §5 (Documentation reconciliation).
- `npm run build` and `npm run test` both pass.
**Not done if:** any active import from Task 1's inventory is left unmigrated (build/test would likely fail — do not silently work around a failure by leaving the import in place; report it instead per the design doc's explicit "stop and surface a contradiction" instruction).
**Depends on:** Task 1's inventory.

## Task 3 — Automated lint ban on active Supabase imports

**Success predicate:** `npm run lint` fails when a Supabase import is present under `src/` or `electron/`, and passes on the current (post-Task-2) tree. A test or documented manual verification proves the rule actually fires (not just "the config exists").
**Not done if:** the rule only bans the literal string `src/supabase.js` (which no longer exists after Task 2) rather than the package import itself — must ban `@supabase/supabase-js` imports broadly, so a *new* file re-introducing the dependency is also caught.
**Depends on:** Task 2 (dependency removed, so the "passes on current tree" half of the predicate is meaningful).

---

## Notes for the GOVERNOR loop operator (whoever runs this — background agent or live session)

- This phase carries essentially zero product-behavior risk (no runtime logic changes), so expect Resilience review to focus on "did the move actually not break anything importable" rather than concurrency/crash scenarios — don't force Red Hat to manufacture unrelated risk scenarios.
- If Task 1 turns up an active import that isn't a trivial migration (e.g., something still genuinely needs Supabase for some reason not yet understood), stop and do not proceed to Task 2 — this is exactly the kind of contradiction the hardening doc says to surface rather than guess past.
- On completion of all 3 tasks, run the `update-state` skill to refresh `PLATFORM_STATE.md`, then proceed to Phase 2 (`docs/superpowers/plans/2026-07-21-phase2-authorization-layer.md`).
