---
title: "The gate is 88% one step, and lints the tree twice"
document_type: ticket
status: open
created: 2026-09-16
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
archive_when: "Either a tiered gate exists with a fast tier that is structurally incapable of being read as the merge gate, or the owner has decided tiering is not wanted; and the duplicate full-tree ESLint pass inside the test suite is resolved either way; and docs/governance/standards/TESTING_STANDARD.md §1 lists the gate steps that scripts/verify.js actually runs"
---

# T188 — The gate is 88% one step, and lints the tree twice

**This ticket proposes a change to a gate budget. Per
[`GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md) §3–8 (`test-infrastructure` row),
"changing a shared harness, setup file, or gate budget" is a human gate. Nothing here is
implemented. It is a measurement and a recommendation awaiting the owner's decision.**

---

## 1. The premise in the request was wrong, and that matters

The investigation was asked to find what runs the suite "on every commit." **Nothing does.**

| Candidate mechanism | Evidence | Verdict |
|---|---|---|
| CI workflow | `.github/` **does not exist** in the repository | Not it |
| `pre-commit` hook | `.git/hooks/` contains only `post-checkout` and `post-commit` (plus `.sample`s) | Not it |
| Claude Code hook | `.claude/settings.local.json` has no `hooks` key; `~/.claude/settings.json` has only a `SessionStart` hook that loads the superpowers skill | Not it |
| `post-commit` hook | Real, but it launches a **detached graphify code-graph rebuild**. It runs no tests, and `git commit` returns immediately | Not it |

**The trigger is session convention, not machinery.** Agents and sessions run `npm run verify`
before opening a PR because the constitution and `TESTING_STANDARD.md` make it the evidence of
record. There is no automation to disable and no hook to scope — so the lever is *what the gate
costs*, not *when it fires*. Any proposal framed as "stop running tests on commit" would have been
fixing a mechanism that does not exist.

Corroborating the "per PR, not per commit" picture: 107 commits landed in the last 7 days against
25 recorded gate reports total (`docs/work/runs/gate-reports/`, spanning since August).

## 2. Where the wall-clock actually goes — measured

Measured 2026-09-16 on the main checkout at `d920ce8`, 4 cores / 8 GB, each step invoked directly
and timed individually. **The suite run was green (`rc=0`, 5888 passed / 0 failed / 5 skipped
across 439 files, 5893 tests).**

| Step | Wall clock | Share of gate |
|---|---:|---:|
| `lint` | **131.3s** | 10.2% |
| **`test`** | **1131.9s (18.9 min)** | **87.7%** |
| `test:integration` | 20.6s | 1.6% |
| `security` | 5.9s | 0.5% |
| `check:governance` | 1.2s | 0.1% |
| `agents:check` | 0.2s | <0.1% |
| `ensure-abi` (warm, per invocation) | **0.3s** | <0.1% |
| **Total** | **~1291s (21.5 min)** | |

### Two hypotheses in the brief, both refuted by measurement

- **`pretest`/`ensure-abi` is *not* a large fixed cost.** It is a **0.3s** no-op when the binary
  already matches (measured twice consecutively). It is designed to be: it probes the compiled
  `.node` and skips the rebuild when the marker and the binary agree. Only an actual Node↔Electron
  switch pays. This is not a target.
- **`lint` is far more expensive than anyone assumed** — 131s, the second-largest line item, and
  never previously called out.

**Measurement conditions, stated because they bound the claim.** The machine was heavily
oversubscribed by other concurrent sessions for much of the run (1-minute load average ranged
~20 → ~191 on 4 cores; it fell to ~41 by the end). Per `scripts/verify.js`'s own T178 doctrine,
that is squarely "oversubscribed" territory. **Treat 1131.9s as an upper bound on a quiet machine,
not as the quiet-machine figure.** The *relative* breakdown and the per-file concentration below
are far more robust than the absolute seconds, because every file competed for the same cores.
**Re-measuring the full gate on a genuinely quiet machine is the first task of this ticket**, and no
budget should be set from the absolute number alone.

## 3. The single largest finding: the gate lints the whole tree twice

Per-file timings (vitest JSON reporter) put one file at the top by a wide margin:

```
193.1s  eslint.supabase-ban.test.js      <- 10.7% of ALL test file-time, in one file
 90.7s  electron/main.test.js
 51.4s  electron/ops/ingest.test.js
 46.2s  scripts/mcp/tools.test.js
 44.7s  src/screens/ScheduleScreen.test.jsx
```

`eslint.supabase-ban.test.js` spawns a real `ESLint` instance and lints the tree. Its middle test —
`does not flag any real file under src/ or electron/ for a Supabase import` — lints
`src/**/*.{js,jsx}` and `electron/**/*.js` through the ESLint API. **The file's own header comment
already says so:** "this is redundant with the repo's own `npm run lint`."

It is not merely redundant, it is **strictly weaker**. `npm run lint` runs the same config with the
same `no-restricted-imports` rule at `error` severity over a **superset** of those paths, and its
failure fails the gate. Any violation that test could catch, `lint` catches first — and `lint` runs
earlier in `VERIFY_STEPS`.

So the gate pays for ESLint over the tree twice: **131s (`lint`) + ~190s (inside `test`) ≈ 321s,
about 25% of the entire gate.**

**The other two tests in that file are worth keeping and are cheap.** The probe test (writes a
file importing `@supabase/supabase-js`, asserts the rule fires) is the non-vacuity test that proves
the rule actually works — exactly the kind of guard this repo has learned to insist on. The
`legacy/supabase/` test pins the scope exemption. Only the redundant full-tree pass should go.

> **Deleting a test is a governed act, not a cleanup.** It goes through the loop with Code Reviewer
> and Red Hat, and the reasoning above ("strictly weaker than an earlier gate step") is the claim
> they should attack. It is recorded here as a recommendation, not done.

## 4. The suite's cost is concentrated, which is what makes tiering possible

| Cumulative | Share of total file-time |
|---|---:|
| Top 10 files | 33.7% |
| Top 25 files | 54.4% |
| Top 50 files | 69.5% |
| Top 100 files | 84.5% |

| Directory | File-time | Files |
|---|---:|---:|
| `electron/` | 1115.5s (61.7%) | 179 |
| `src/` | 434.2s (24.0%) | 226 |
| `eslint.supabase-ban.test.js` | 193.1s (10.7%) | 1 |
| `scripts/` | 56.0s (3.1%) | 19 |
| `test/` | 8.2s (0.5%) | 13 |

`src/` is half the files and a quarter of the time; `electron/` is the reverse. A UI-only change
pays the full `electron/` bill today.

One observation worth a quiet-machine check rather than a conclusion: 1808s of summed per-file time
completed in 1132s wall — a **1.6× speedup on 4 cores**. That is low, but the run was contended by
other sessions throughout, so it is not yet evidence about vitest's configuration.

## 5. Recommended tiering

**Recommendation: two tiers, with the fast tier structurally unable to impersonate the merge gate.**
Confidence: **high** on the diagnosis and on the ESLint duplication; **medium** on the exact fast-tier
composition, which should be tuned after a quiet-machine baseline.

### Tier 1 — `npm run check` (fast, advisory, per-commit)

Target well under 60s:

- `agents:check` (0.2s) + `check:governance` (1.2s) + `security` (5.9s) — all deterministic, all
  already cheap, all catching the governance failures that currently surface late.
- ESLint **on changed files only** rather than the full tree.
- `vitest run --changed <base>` — verified working on this tree: on a 9-file commit it selected
  2 test files; on a 22-file commit, 2.

### Tier 2 — `npm run verify` (unchanged, the merge authority)

Exactly what it is today. **No step is removed from it by this proposal** (the ESLint duplication in
§3 is a redundancy inside `test`, not a reduction in coverage).

### The guarantee that must not be weakened, and how

**`--changed` is blind to a large, load-bearing part of this suite.** It selects from vitest's
module graph. **64 test files** read source with `readFileSync`/`readdirSync` instead of importing
it — including the tree-scanning guards `src/screenIntro.removalGuard.test.js`,
`src/screenKeys.syncGuard.test.js`, and `test/governance.test.js`. Edit a screen and `--changed`
will silently skip the guard written to watch that screen. This is the same blind spot `CLAUDE.md`
already documents for graphify, and it is why Tier 1 can never be the merge gate.

Three properties are therefore mandatory, and are the real design work of this ticket:

1. **An always-run guard set.** Tier 1 runs the tree-scanning guards unconditionally, not by
   change detection. They are cheap (`test/` is 8.2s total for 13 files).
2. **Tier 1 must never print a passing verdict that reads like Tier 2's.** `scripts/verify.js`
   exists precisely because a tailed pipe once turned a red into a false green. Tier 1 must emit a
   distinct verdict line that says it is **not** a merge gate, and must never emit the string
   `VERIFY PASSED`.
3. **The evidence layer must reject it.** `scripts/verifierReport.js` / `gate.sh`'s `DONE`-stamp
   contract must not accept a Tier-1 result as a Verifier `PASS`. A fast tier that can be filed as
   gate evidence is the whole risk of this proposal, restated.

`scripts/gate.sh` already chunks the suite by explicit file list and writes a machine-readable
stamped result. **Tier 1 should be built on that existing contract, not beside it.**

## 6. Vitest configuration (question 4) — no change recommended yet

`vite.config.js` sets no `pool`, `maxForks`, `isolate`, or `fileParallelism` — vitest defaults
apply. The existing `testTimeout: 20000` and `vitest.setup.js`'s `asyncUtilTimeout: 3000` are both
**measured, documented, and load-justified**; the brief is right that they must not be undone, and
this ticket does not propose touching them. The `1.6×`-on-4-cores observation in §4 is the only
lead, and it needs a quiet-machine measurement before it is even a finding.

## 7. Two documentation defects found on the way

### 7.1 `TESTING_STANDARD.md` §1 does not describe the gate — Article I report

The standard that **owns the gate list** contradicts the code:

| `TESTING_STANDARD.md` §1 says | Reality |
|---|---|
| `node test/integration/run.js` | **That file does not exist.** It is `test/integration/run.automerge.js`, via `npm run test:integration` |
| `npm run build` is a gate | `VERIFY_STEPS` does **not** include `build` |
| (not listed) | `agents:check`, `security`, `check:governance` are all in `VERIFY_STEPS` |

Per `GOVERNANCE_INDEX.md` §11 rule 3 and Article I, code contradicting a standard is **reported, not
reconciled by an agent**. Flagged here for the owner; deliberately not fixed.

### 7.2 `CLAUDE.md`'s "~270 test files" — already owned, not duplicated

Actual count is **438**. This is already filed as
**T186** (`T186-claude-md-goes-stale-by-construction.md`, filed on another branch) by a concurrent session, which reframes it as a
structural staleness problem rather than a number to correct. **T188 does not touch `CLAUDE.md`** —
recorded here only so the two tickets are not worked twice.

## 8. Definition of done

- [ ] The full gate is re-measured on a quiet machine (1-min load < ~4) and those numbers replace §2's as the budget baseline.
- [ ] The owner has decided whether tiering is wanted at all.
- [ ] If yes: a fast tier exists that (a) runs the always-run guard set unconditionally, (b) emits a verdict that cannot be read as `VERIFY PASSED`, and (c) is rejected by `verifierReport.js` as Verifier evidence.
- [ ] The duplicate full-tree ESLint pass is resolved, through the review loop, with Red Hat specifically asked whether `npm run lint` truly subsumes it.
- [ ] `TESTING_STANDARD.md` §1 matches `VERIFY_STEPS` (needs the human gate — it is a standard).
- [ ] `npm run verify` is green.

## 9. Reproducing these numbers

```bash
# per-step wall clock (each step invoked directly, not through verify)
npx vitest run --reporter=json --outputFile=/tmp/vitest-report.json

# per-file concentration
python3 -c "
import json;d=json.load(open('/tmp/vitest-report.json'))
r=sorted(((f['endTime']-f['startTime'])/1000,f['name']) for f in d['testResults'])[::-1]
print(f'{len(r)} files, {d[\"numTotalTests\"]} tests')
[print(f'{t:7.1f}s  {n}') for t,n in r[:25]]"

# tests invisible to --changed
grep -rl 'readFileSync\|readdirSync' --include='*.test.js' --include='*.test.jsx' \
  src electron test scripts | grep -v node_modules | wc -l
```
