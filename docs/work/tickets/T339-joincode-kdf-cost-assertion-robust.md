---
ticket: T339
document_type: ticket
title: Make joinCode.test.js's KDF-cost assertion work-factor-based, not single-sample wall-clock
status: open
created: 2026-10-03
archive_when: "electron/sync/joinCode.test.js's KDF-cost test no longer fails on fast/variable CI hardware — it asserts the scrypt WORK FACTOR / parameters (as the companion test already does) and/or averages N derivations or uses a widened floor, rather than asserting a single-sample wall-clock derivation exceeds a tight 50ms floor"
task_class: test-infrastructure
parent: ""
governing_docs: [electron/sync/joinCode.test.js, electron/sync/joinCode.js]
related_prs: []
---

# T339 — joinCode KDF-cost assertion: work-factor-based, not single-sample wall-clock

## Context

During the T336 gate, PR #737's CI went red on ONE unrelated test:
`electron/sync/joinCode.test.js` → "join-tag KDF cost — measured, not assumed" →
`AssertionError: expected 46.051259 to be greater than 50`. It passed on re-run. Root cause: the
test measures a SINGLE scrypt derivation via `process.hrtime` and asserts `50ms < elapsed < 600ms`;
a fast/variable shared CI core did it in ~46ms, 8% under the floor. The scrypt **work factor was
provably intact** — the companion test asserting `JOIN_TAG_SCRYPT_PARAMS === {N:32768, r:8, p:1,
maxmem: 64MiB}` passed — so a fast core doing the same work in 46ms is fast hardware, not a weaker
KDF. The test's own comment already acknowledges "CI hardware varies."

This is the **third wall-clock/timing CI flake this session** (T337 rendezvous load-flake;
`AssignmentPanel.test.jsx` `waitFor` timeout; this KDF floor), all instances of the standing lesson
that wall-clock measurement manufactures false results on shared/variable hardware
(`feedback_cpu_time_not_wall_clock_on_this_machine`). Worth closing the pattern for this one.

## What to do

The real security property is the **work factor** (the scrypt params), which the companion test
already pins. Make the cost assertion robust rather than single-sample wall-clock:
- Prefer: keep the params assertion as the authoritative check; drop or widen the fragile
  single-sample wall-clock floor (e.g. average N≥5 derivations, or lower the floor well below the
  slowest plausible fast-CI single sample while still catching an order-of-magnitude regression to
  ~1ms).
- The intent to preserve: still catch a params typo / Node-libuv change that made scrypt ~1ms (the
  order-of-magnitude regression the test was written to guard), WITHOUT failing on 2x single-sample
  timing variance.

## Not in scope

No change to `joinCode.js` or the scrypt parameters themselves — they are correct. Test-only change.
