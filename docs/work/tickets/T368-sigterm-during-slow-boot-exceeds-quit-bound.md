---
title: T368-sigterm-during-slow-boot-exceeds-quit-bound
document_type: ticket
status: completed
created: 2026-10-11
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md]
archive_when: SIGTERM delivered at any point during boot exits the packaged app within verify:packaged's 10s bound (bound not widened), with the cause identified and pinned by a test, and 20 consecutive verify:packaged sigterm runs under load passing
---

# T368: SIGTERM during a slow boot can exceed the 10s quit bound

## Observation

- On the packaged build of main 51604858, verify:packaged failed in its plain `sigterm` mode, with no camp seeded: "packaged app did not exit within 10s of SIGTERM". Machine load was about 90.
- The keeper reproduced it by hand. SIGTERM sent at +12s took about 11s to exit. Two more runs exited in about 1s.

So it is intermittent and load-sensitive, and it is a real exit delay, not a measuring artefact.

## Hypothesis (unconfirmed)

A SIGTERM that arrives during a slow boot waits on startup work before the app quits. The boot is still in progress if the window or the renderer heartbeat hasn't settled yet.

Suspect paths:

- #895 (6994848e), "keep a window alive": reload on renderer-gone and recreate on macOS activate. A quit that lands while a window is being reloaded or recreated could trigger another window instead of a quit.
- The vetoed will-quit in `electron/willQuit.js` with its deferred re-quit and 5s race. Boot-time work may still be pending when the race starts.
- Smoke-ready/heartbeat handling in `electron/main.js`. In `sigterm` mode the script waits for the heartbeat before signalling, so the window has painted. Background boot work, such as db open, migrations, sync start or the port-mapping start, may still be running.

## Constraints

- Do not widen the 10s bound.
- Low priority. It was filed by the keeper on 2026-10-11 as a flake write-up, not a release blocker. The rule is that every flake seen is investigated or written up.

## Next step

Instrument the quit path. Log timestamps at SIGTERM receipt, at will-quit, at the veto, at the re-quit and at exit. Then reproduce under load, with SIGTERM at increasing delays after the heartbeat. Find which await holds the exit.

## Fix (2026-10-11, PR pending) — two holders closed, cause not yet confirmed on a packaged build

- **A window came back during the quit.** `recoverFromRendererGone` (and macOS `activate`) reloaded or recreated a window whenever a renderer died, including while the app was quitting (a SIGTERM reaching the renderer, or a window torn down mid-boot). `electron/main.js` now sets `appQuitting` on `before-quit`, and `electron/windowLifecycle.js` does nothing once it is set.
- **A sync start in flight outlived the quit.** `syncStarterHolder.shutdown()` stopped only a node that had finished starting; a start still in flight at quit landed its node (and the punch transport's native handle) afterwards. The quit path now calls `close()`, which waits for the in-flight start (inside will-quit's existing 5s race) and refuses any later start. A db swap still uses `shutdown()` and starts again.
- Pinned by `electron/windowLifecycle.test.js` and `electron/sync/automerge/syncStarterHolder.test.js` (red first). The 10s bound is unchanged.

Not done here: the packaged repro under load and the 20-run check in `archive_when`. Which of the two (or neither) held the 11s exit is confirmed only by that run.

## Closed (2026-10-11)

Shipped in #952: once quitting starts, no window comes back and no late sync node starts (`electron/windowLifecycle.js`, `electron/sync/automerge/syncStarterHolder.js`), pinned by `electron/windowLifecycle.test.js` and `electron/sync/automerge/syncStarterHolder.test.js`. Closed on the keeper's ruling; the 20-run packaged SIGTERM check is the keeper's.
