# Phase 2 implementation plan — Centralized authorization layer

Design: `docs/superpowers/specs/2026-07-21-phase2-authorization-layer-design.md`. Execute via the GOVERNOR loop, one Maker round-trip per task, full Tester+Security+Red Hat review every round (Tester's UX/Visual dimensions are N/A for Tasks 1-3, genuinely applicable again only if any renderer-visible behavior changes — it should not for this phase, per the design doc, so expect N/A throughout).

Depends on Phase 1 (`docs/superpowers/plans/2026-07-21-phase1-architecture-cleanup.md`) having completed first.

**Standing reminder for every task's Maker brief in this plan (from project memory — do not let this recur):**
- Any module that parses/trusts data crossing a process or privilege boundary (which `authorize()` inherently is) needs: reject non-object/malformed input before touching properties, validate types not just presence, default-deny on anything unrecognized.
- `authorize()` must be called AT the mutation entry point (IPC/WS handler), never folded into lower-level shared primitives like `appendOp`/`syncClient.write` — see design doc's explicit warning on this.
- A round-N fix that touches this module later needs the SAME full adversarial review as a new task, not a lighter diff-only pass, if it changes what `authorize()` checks or how it's called.

## Task 1 — Build `authorize()` and the permission matrix

**Success predicate:** `electron/auth/authorize.js` and `electron/auth/permissions.js` exist per the design doc's shape; all 4 unit-test categories from the design doc's testing-plan item 1 pass; `authorize()` is NOT yet wired into any handler (that's Task 2) — this task is the primitive in isolation, fully tested.
**Not done if:** role is read from the token payload anywhere instead of re-queried from `users` on every call — this is the single property the whole phase exists to guarantee; a Maker round that gets this wrong must be treated as a full re-review, not a nit.
**Files:** new `electron/auth/authorize.js`, `electron/auth/permissions.js`, `electron/auth/authorize.test.js`.

## Task 2 — Wire `authorize()` into every IPC handler in `electron/main.js`

**Success predicate:** every mutating and read handler in `electron/main.js` (confirm full list from the file, not from this plan's guess) calls `authorize()` with an appropriate named action before proceeding; a denied result returns a clear, existing-shape-consistent rejection to the renderer (check how other IPC handlers currently signal failure — e.g. `{ error: ... }` vs throwing — and match that convention, don't invent a new one); `createUserHandler`'s existing admin gate is now expressed via `authorize()` + the permission matrix rather than its own inline check (no behavior change, just routed through the new central mechanism).
**Not done if:** any handler is left unaudited (silently still trusting the renderer) — the design doc's default-deny requirement means an unrecognized/unwrapped handler is a gap, not an acceptable omission.
**Depends on:** Task 1.
**Files:** `electron/main.js`, `electron/main.test.js`.

## Task 3 — Wire `authorize()` into every mutating WebSocket handler in `electron/sync/syncServer.js`

**Success predicate:** `submit_op`, `acquire_lock` (confirm full list from the file) call `authorize()` using the connection's already-verified `ws.userId`/`ws.deviceId` (set during `authenticate`, per existing code) before proceeding; `login`/`authenticate` themselves are NOT wrapped (design doc is explicit these are how a token is obtained, not actions requiring one); a denied result is handled the same way existing malformed-message rejections are handled in this file (check the established convention, don't invent a new wire-message shape).
**Not done if:** `authorize()` re-derives device/user identity from client-claimed WS message fields instead of the already-authenticated `ws.userId`/`ws.deviceId` set at handshake time — that would reopen exactly the device_id-spoofing gap this project's Task 4/5 already closed once (see project memory).
**Depends on:** Task 1.
**Files:** `electron/sync/syncServer.js`, `electron/sync/syncServer.test.js`.

## Task 4 — Role-change and existing-behavior regression tests

**Success predicate:** design doc's testing-plan items 2 (per-handler tests), 3 (role-change-takes-effect test), and 4 (existing-behavior-preserved test) are all present and passing, covering the FULL set of handlers wrapped in Tasks 2 and 3 — not a sampling. Item 3 (role-change test) is the single most load-bearing test in this whole phase per the design doc; it must genuinely flip a role in the DB mid-test and reuse the SAME already-issued token, not mint a fresh one.
**Not done if:** the "existing behavior preserved" tests are skipped as "obviously fine" — Red Hat/Grader should treat an assumed-not-tested regression here as a real finding, since accidentally admin-gating a staff-used feature is a product break equivalent in severity to the original renderer-only-trust gap.
**Depends on:** Tasks 2 and 3.
**Files:** likely additions to `electron/main.test.js`, `electron/sync/syncServer.test.js`, or a new dedicated `electron/auth/authorize.integration.test.js` — Maker's call on organization, but coverage must be traceable to every handler from Tasks 2/3, not just a few examples.

---

## Notes for the GOVERNOR loop operator

- Expect Resilience/Security review to be the dominant risk dimension here, same as every other auth-adjacent task in this project's history — Tester's contribution is confirming nothing user-visible broke (should be "no visible change" / N/A on UX dimensions, not a deep UI review).
- If a round-2 failure recurs on the SAME specific gap twice (e.g., role still read from token payload after a claimed fix), treat it as the project's established 2-consecutive-failed-rounds threshold and escalate per GOVERNOR's normal rule — do not keep patching silently past that point.
- On completion of all 4 tasks: run `update-state` to refresh `PLATFORM_STATE.md` (new permission matrix location, authz model), write a project/feedback memory entry summarizing what was built and any new patterns Maker/reviewers surfaced, and report a summary back covering both Phase 1 and Phase 2 together as one hardening pass.
- Device pairing/revocation (hardening doc §5) and raw-PIN handling (§6.3) remain explicitly out of scope — do not let any reviewer's finding pull this plan into building them; note such findings as deferred-to-a-future-phase in the final report instead.
