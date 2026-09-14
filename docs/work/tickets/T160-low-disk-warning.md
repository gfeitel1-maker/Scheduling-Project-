---
title: "Warn about a nearly full disk before it is full"
document_type: ticket
status: completed
created: 2026-09-14
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a device whose disk is nearly full says so in the sidebar on every sync state, and the suite does not pay production PIN-hashing cost on every user it creates
---

# T160 — Warn about a nearly full disk before it is full

Owner decision, 2026-09-14, option (c) of row 5 in the open-decisions brief.

## Why this is the only useful lever

T148 made every way a write can miss the Automerge document leave a durable
trace. It also found the limit of that: **every safeguard that records a failed
write is itself a write, to the same disk that just refused one.** On a full disk
the mechanism degrades to console lines. It now tags them so one incident's lines
tie together and says plainly when nothing durable landed — but it cannot fix
itself with no room to write into.

Nothing can. What works is not being surprised. So: notice the disk getting low
while there is still room to act, and put it where the director already looks.

## What changed

- `electron/db/diskSpace.js` — a threshold (500 MB) and a throttled reader
  (60s), both injectable, no Electron. **500 MB** because this app's writes are
  measured in megabytes: much lower arrives too late to act on, much higher nags
  on a normally-loaded laptop, and a warning that gets ignored is worse than none
  because it looks like coverage.
- "Could not measure" is **not** low. A null answer renders as silence, never as
  reassurance — the same discipline `documentWriteFailureRecorded` follows.
- `getSyncStatus` reports `lowDisk` on **every** state, including standalone and
  host. A computer about to run out of room is about to stop being able to save,
  whether or not anyone else is reachable.
- `syncStatusLabel` shows it in the existing one-line slot beside Devices — not a
  banner. It yields to an unshared write: what has already gone wrong outranks
  what might.

## The test-suite change that came with it

Raising scrypt to N=2^16 (T150) is right for a login a person waits on once and
wrong for a suite that creates users constantly. `localAuth.test.js` went from
seconds to three minutes and one test began **timing out** on six hashes; every
file that seeds a camp pays the same toll. Unaddressed, the pressure is always to
raise the timeout, and the end of that road is a suite nobody runs.

`setScryptParamsForTests` lowers the cost suite-wide from `vitest.setup.js`. Safe
because hashes are self-describing — one minted cheaply still verifies at the
cost it was minted with — and guarded two ways: a test pins the production
default, and one test mints at the **real** cost end to end so the shipped
parameters are proven to work rather than merely asserted.

A third fix came from the same place. `parentScoped.test.js`'s 480-slot scale
test had already raised its own ASSERTION ceiling to 60s, with a comment
explaining that machine load must not masquerade as an algorithmic regression —
but left itself running under the suite's 20s `testTimeout`. So under exactly the
load it was written to tolerate it died before reaching its own assertions:
three gate runs failed there at 26s, 35s and 53s, none for the reason the test
exists. It now carries a per-test timeout larger than its tripwire, so the thing
that fails first is the tripwire with its explanatory message rather than an
anonymous timeout. Scoped to that one test — raising the global budget would hide
genuinely stuck tests everywhere else.

`attemptLogin` also gained an injected clock. Not convenience: the lockout is a
wall-clock window, and at the raised cost five failed attempts took long enough
on a loaded machine that the window **expired mid-test** — so the test reported
"the lockout does not work" when what happened was "this machine was too slow".
A security test that fails for a reason other than the security property is worse
than no test. With time held still, the property under test is the only thing
that can fail, and the expiry half (previously untested, because it would have
meant sleeping 30 seconds) is now covered too.
