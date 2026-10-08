---
ticket: T344
document_type: ticket
title: Shard/isolate heavy real-libp2p suites away from the jsdom tests so load flakes stop
status: open
created: 2026-10-08
archive_when: "the gate no longer co-schedules the heavy real-libp2p integration suites (electron/sync/**, electron/**/*.integration) concurrently with the jsdom browser-env tests on the same runner, proven by the formerly-flaky tests (q-assignmentpanel-flake-under-libp2p-load, q-relay-revoke-security-assertion-flakes-under-load) passing a stress run (>=20 isolated + >=10 under artificial load) with zero failures and no raised asyncUtilTimeout/testTimeout (T188/T308 stand)"
task_class: test-infrastructure
parent: ""
governing_docs: [docs/governance/standards/TESTING_STANDARD.md]
related_prs: []
related_tickets: []
---

# T344 — Test isolation / sharding so load flakes stop

## Context

Two CI reds on #741 (and earlier on #736/#737) were runner-contention load flakes, not product
defects: a timing-sensitive test loses when the gate co-schedules the heavy real-libp2p integration
suites (the `syncNode`/`redial` noise, `electron/sync/**`, `electron/**/*.integration`) concurrently
with the lighter jsdom browser-env tests on the same runner, saturating CPU so a `waitFor` or a
network-timing-dependent assertion occasionally misses its (already measured, T188) budget. See the
two characterized board lines:

- `q-assignmentpanel-flake-under-libp2p-load` — AssignmentPanel confirm-modal `waitFor` hits the
  3000ms wall (~13% even near-isolation on a loaded dev box).
- `q-relay-revoke-security-assertion-flakes-under-load` — the T337 relay revoke-cutoff security
  assertion's race-prone sender-side signal loses under extreme CI oversubscription.

The immediate per-test fragility is being fixed test-side in a separate small PR (receiver-side
assertion for the relay test; parse-signal/lighter-fixture for AssignmentPanel). **T344 is the
STRUCTURAL fix:** stop the heavy suites and the jsdom tests from fighting for the same CPU.

## What it is (NOT a timeout bump)

T188/T308 forbid raising `testTimeout`/`asyncUtilTimeout` (measured, load-justified). This is about
SCHEDULING: shard the vitest run (e.g. a project/pool split or separate CI jobs) so the real-libp2p
integration suites run in their own lane, not interleaved with the jsdom tests; or cap concurrency so
the runner is not oversubscribed (~130× core count was measured on CI, T308). Prior art: T121
`sync-test-load-fragility`, T164 `libp2p-sync-tests-fail-under-load`.

## Not built

Filed per the board-keeper 2026-10-08; not started. Design before build (how to shard without
lengthening wall-clock unduly; the gate is already the long pole). Owner/organizer sequences it.
