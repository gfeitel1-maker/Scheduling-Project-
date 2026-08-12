---
task: vitest-load-induced-flakiness
document_type: run
date: 2026-08-12
round: 1
status: completed
risk: medium
task_class: test-infrastructure
created: 2026-08-12
governing_docs: [docs/governance/standards/TESTING_STANDARD.md]
---

# Full-suite non-determinism under load — investigation and fix

## Symptom

`npx vitest run --no-file-parallelism` (166 files, ~2411 tests) failed a
*different* subset of jsdom/React test files on different runs on a 4-core /
8 GB machine while several agent sessions ran the same suite concurrently. Every
named file passed when run in isolation. Observed flaky-under-load files
included `useSlotMutations`, `useClipboardSelection`, `useScheduleData`,
`LoginScreen`, `ReadinessHub`.

## Root cause (proven)

React Testing Library's `waitFor` / `findBy` share one async-utility budget
(`asyncUtilTimeout`) that defaults to **1000 ms and is independent of the
20000 ms `testTimeout`** already raised in `vite.config.js`. A test can sit well
inside its 20 s test budget yet still fail because a single `waitFor` blew its
own 1 s.

The heaviest async settle in the suite is the schedule initial load. The
`useScheduleData` hook behind it resolves in ~130 ms idle. `vite.config.js`
already documents ~8× contention under concurrent agent sessions, and
130 ms × 8 ≈ **1040 ms** — the default 1000 ms sits exactly on the edge under
the load the repo already documents. Whichever `waitFor`-heavy test is running
when contention spikes loses, which is the "different subset each run"
signature. `ScheduleScreen.test.jsx` had already discovered this locally and set
`configure({ asyncUtilTimeout: 3000 })` for itself; the other ~340 `waitFor`
call sites (including `useScheduleData`, which drives that same load) were left
at 1000 ms.

### How it was proven

- Forced `asyncUtilTimeout` low (50 ms) via a global setup file: exactly the
  `waitFor(() => …loading === false)` tests in `useScheduleData` failed, with the
  stack rooted in `@testing-library/dom/dist/wait-for.js`. The two pure-`act`
  files (`useSlotMutations`, `useClipboardSelection`) — which contain **no**
  `waitFor` — did **not** fail, so they are not part of this mechanism.
- `waitFor` appears 341× across `src`; `vi.waitFor` (a separate 1000 ms budget
  RTL's `configure` does not govern) appears once, in `ReadinessHub`.

## Ruled out (with evidence)

- **Memory accumulation / GC pressure.** `--logHeapUsage` showed flat per-file
  heap (~85–139 MB peak) across all 166 files — `isolate: true` resets cleanly.
  Re-running the whole suite with the fork capped at `--max-old-space-size=640`
  produced the identical 51 baseline failures and never approached the cap.
- **A shared global / leaked handle unique to the named files.** Under two and
  three concurrent full-suite "noise" runs (4× core oversubscription), the named
  files passed 5/5 and 12/12 iterations at the real 1000 ms default — the
  synthetic contention on this hardware (~3–4×) never reached the ~8× needed to
  tip the 1000 ms edge, but the mechanism above fully accounts for it.

## Fix

- `vitest.setup.js` (new) — global `configure({ asyncUtilTimeout: 3000 })`,
  wired via `test.setupFiles` in `vite.config.js`. Makes the 3000 ms that the
  heaviest screen already needed the floor for every `waitFor` call site. 3000 ms
  clears the documented ~8× contention with headroom and stays far below
  `testTimeout`, so a genuinely stuck async still fails deterministically via
  `testTimeout` rather than hanging.
- `ScheduleScreen.test.jsx` — removed the now-redundant local
  `configure({ asyncUtilTimeout: 3000 })`.
- `ReadinessHub.test.jsx` — the lone `vi.waitFor` (not governed by RTL's
  `configure`) given an explicit `{ timeout: 3000 }`.

Behaviour-preserving: full suite before and after the fix shows the **same 51
baseline failures**, all pre-existing and unrelated to load (see below).

## Also fixed — the `ImportScreen` mock gap (deterministic, was 49 reds)

Not load flakiness; failed every run. The real call site is
`useSetupCounts.js:76`, which calls `localClient.getCamp().then(…)` in a **mount
effect** — so every `ImportScreen` render hit it, and each `ImportScreen.*` test
uses an inline `vi.mock('../localClient', …)` that omitted `getCamp`, throwing in
that passive effect. Added `getCamp: vi.fn().mockResolvedValue({ id, name })` to
all five inline mocks. Recovers **46 of the 49**.

## Still red after both fixes — separate findings, NOT flakiness

1. **`ImportScreen.test.jsx` — 3 tests (T35 "inferred activity rules").** These
   assert Swim infers `priority: 'high'` and that the Adjust editor exposes a
   selected "High" option. They fail identically whether `getCamp` resolves a
   camp or `null`, so this is independent of the mock fix — a pre-existing issue
   in the T35 rule-summary path (inference and/or the Adjust editor), masked
   until now by the `getCamp` throw. Given the recent D1–D4 rework of this
   screen, these may be stale assertions or a real regression; needs a product
   decision, not a mock change.
2. **`test/governance.test.js` (2 tests).** Pre-existing doc-governance
   assertions (documents missing `document_type` / `governing_docs`). Baseline.
