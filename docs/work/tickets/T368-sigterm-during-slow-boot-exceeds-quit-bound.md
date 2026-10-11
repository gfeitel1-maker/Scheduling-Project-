---
title: T368-sigterm-during-slow-boot-exceeds-quit-bound
document_type: ticket
status: open
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
