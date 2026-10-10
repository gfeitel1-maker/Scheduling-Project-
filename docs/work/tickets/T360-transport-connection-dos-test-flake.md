---
title: T360-transport-connection-dos-test-flake
document_type: ticket
status: completed
created: 2026-10-09
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md]
archive_when: electron/sync/automerge/transportConnectionDos.test.js passes 30 consecutive runs under load on a 4-core machine, with its timing dependency replaced by a deterministic clock or condition waits, and a planted defect still turns it red
---

> **COMPLETED** — fixed by #848 and #851. Cause: 300–400 ms handshake deadlines raced a loaded scheduler,
> and the tests watched the attacker side, which hears of a remote abort late. #848 observes the target
> side, replaces sleeps with condition/event waits and uses a 1500 ms deadline. #851 makes test 1 unable to
> false-green: its deadline is beyond the test, so only the cap can reduce an uncapped flood (deadline
> survival moved to test 1b). Plant-check: disabling the cap in `electron/sync/automerge/transport.js`
> turns test 1 red. 30 consecutive full-file runs on #851's tree, 12/12 each, at 1-min load 6.8–27 on the
> 4-core Mac. Test 4 decision: its guaranteed part (refused at exactly maxConnections without the floor)
> is deterministic; the "lands via turnover" part stays a documented best-effort with a 10 s budget, as the
> ADR's honest guarantee states — it passed in all 30 runs.

# T360 — `transportConnectionDos.test.js` is flaky under load (pre-existing on main)

**Owner: the security session** (routed by the board keeper, 2026-10-09). Surfaced while building
#844 (Pair again); reproduced on `main` at `6c931339`, so **not introduced by #844**.

## Evidence

Node v22.23.2, run by path, one file at a time, on the 4-core Mac with load averages ≈ 10–16.

| Tree | Runs | Failing runs | Tests that failed (titles under `T340 connection-manager DoS hardening`) |
|---|---|---|---|
| `main` 6c931339 | 5 | 4 | `4: at exactly maxConnections an admitted reconnect is refused without the floor, and likely lands via authGate-deadline turnover with it (likely, not guaranteed under a sustained flood)`; `1: an un-admitted flood never evicts an established admitted connection and is capped to maxConnections - reservedFloor`; `5: a held-open authGate stream is aborted at the deadline`; `9: the exemption is keyed to the pairing connection and clears when it closes`; `10: a SECOND connection from the same pending peer id is not exempt and is aborted at the deadline` |
| #844 head f0a063a9 | 5 | 3 | tests 4, 5 and 9 (same titles as above) |

The failing set changes from run to run, and some runs fail two or three tests. The one assertion captured
(test 4 on `main`) is `AssertionError: expected false to be true // Object.is equality`. The tests drive the
transport directly with short wall-clock deadlines (e.g. 300 ms in test 10), so the likely cause is real-time
waits racing a loaded scheduler. That is unproven.

## What done looks like

1. Run the file repeatedly under load and capture the assertion and the timing for every failing test.
2. Replace the wall-clock dependency (fake timers / injected clock / condition waits) so the outcome does not
   depend on scheduler latency. Raise a timeout only if that is the honest fix.
3. Plant-check: break the connection limit or the deadline abort and confirm the relevant test goes red.
4. 30 consecutive green runs under load.

Test 4's own title already says "likely, not guaranteed under a sustained flood"; decide whether that
assertion is deterministic at all, or should be split into a guaranteed part and a documented best-effort
part.
