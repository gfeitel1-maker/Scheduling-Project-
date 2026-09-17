---
title: "The gate is 88% one step, and lints the tree twice"
document_type: ticket
status: open
created: 2026-09-16
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: "Either a tiered gate exists with a fast tier that is structurally incapable of being read as the merge gate, or the owner has decided tiering is not wanted; and the duplicate full-tree ESLint pass inside the test suite is resolved either way; and docs/governance/standards/TESTING_STANDARD.md §1 lists the gate steps that scripts/verify.js actually runs"
---

# T188 — The gate is 88% one step, and lints the tree twice

**This ticket proposes a change to a gate budget. Per
[`GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md) §3–8 (`test-infrastructure` row),
"changing a shared harness, setup file, or gate budget" is a human gate. Nothing here is
implemented. It is a measurement and a recommendation awaiting the owner's decision.**

---

## 0. Status — what has landed, and one recommendation withdrawn

Two changes from this ticket are implemented on `claude/t188-gate-tiering`; one recommendation was
investigated and **withdrawn as wrong**; the rest is unstarted and still awaiting the owner.

| Item | State |
|---|---|
| Order `VERIFY_STEPS` cheapest-first | **Landed** (#456) |
| Prebuilt-schema test fixture | **Landed** (#456), then carried to **65 files** (#457, #458) |
| Remove the duplicate full-tree ESLint pass (§3) | **Landed** (#457) — replaced by a grep, see §0.4 |
| Vitest parallelism (§6) | **Landed** (#457, #458) — per-project `isolate: false` |
| Serialise concurrent gates | **Landed** (#456) — `scripts/gateLock.js` |
| `TESTING_STANDARD.md` §1 (§7.1) | **Corrected** in this change; the `build` question stays open for the owner |
| Collapse the 33 migration tests | **WITHDRAWN — the proposal was wrong.** See §7.4 |
| Tiering / change-based selection (§5) | **Recommend closing unbuilt.** See §0.4 |

### 0.1 Gate step order — landed

`runVerify` short-circuits on the first failure, but the two cheapest checks ran **last**, behind
`test`. A `check:governance` failure — a doc field resolving in 1.2s — was only reported after
~1174s of gate, and the re-run after fixing it paid ~1174s again to re-prove tests a docs change
cannot affect. **One governance typo cost ~39 minutes of gate time.** Reordered by measured cost:
that failure is now reported in **1.4s**. No step removed, added, or weakened; on a green tree the
output is identical. Two tests pin the *property* — ascending measured cost, and the unchanged set
of six gates — rather than the literal list.

### 0.2 Prebuilt-schema fixture — landed, measured A/B

`electron/db/testDbTemplate.js` builds the migrated database once per process and hands each test a
byte copy instead of replaying 65 migrations (304ms) per test. Measured back-to-back, same machine:

| | Before | After | Tests |
|---|---:|---:|---|
| `electron/main.test.js` | 86.2s (tests 67.98s) | **32.7s** (tests 16.28s) | 161 pass both |
| next four biggest files | 69.2s (tests 142.87s) | **31.4s** (tests 51.53s) | 255 pass both |

The copy is the database the real chain produced, not a hand-written schema — that distinction is
the T62 defect class. Its test asserts the copy is indistinguishable from a chain-migrated database
(same tables, indexes, DDL text, same applied migration set). Files whose subject *is* migration
behaviour still call `openLocalDb` directly; all 33 `*.migration.test.js` are untouched.

**63 files still use the per-test rebuild.** Converting them is mechanical and is the remaining
share of the ~330s.

### 0.3 A migration defect found on the way, filed separately

Writing the fixture's equivalence test surfaced that **`openLocalDb` is not idempotent across
opens**: a fresh database has 25 indexes, the same file reopened has 26.
`idx_schedule_snapshots_template_id` is declared in `schema.sql`, then dropped when migrations
**v53/v59** rebuild `schedule_snapshots` (`DROP TABLE` + `RENAME`), and `schema.sql`'s
`CREATE INDEX IF NOT EXISTS` has already run for that open. Confirmed by query plan: a brand-new
install **`SCAN`s** `schedule_snapshots` until its second launch.

Performance, not correctness — but it is a fresh-vs-migrated divergence, the class
`TESTING_STANDARD.md` §1 calls the failure that "does not surface until a user's data is already in
the drifted shape." **33 migration-parity tests did not catch it**, and that gap is the more
interesting half. Filed as its own `database-sync` task (ADR + migration/rollback plan + Red Hat).

---

### 0.4 Where the gate actually stands now — and why tiering should close unbuilt

Re-measured 2026-09-17 on `52efd0d`, machine 76% idle, **green**:

| | Original (2026-09-16) | Now | Change |
|---|---:|---:|---|
| Whole gate | ~1174s (19.6 min) | **788s (13m08s)** | **−33%** |
| `test` step | 1015.0s | **702.1s** | **−31%** |
| Test files / tests | 439 / 5893 | 445 / 5984 | *more* tests, less time |

Every second of that came from **coverage-neutral** work — the fixture, the ESLint de-duplication,
and per-project isolation. Nothing was removed from the gate; the suite grew by 6 files and 91 tests
while getting a third faster.

**That settles §5.** Tiering was always the one option on the list that trades a guarantee for
speed, and it was justified by a 19.6-minute gate. At 13 minutes, with the cheap steps now reported
in the first ~60 seconds (a governance failure lands in 1.4s instead of 1174s), the remaining
benefit does not pay for a second definition of "green" that can be mistaken for the merge gate.
The Governor routing reached the same conclusion independently and added the sharper objection: a
declared path→test map **fails open** — `CLAUDE.md` drifting makes an agent wrong, but a selection
map drifting makes a run *silently green*. The proof is already on file: `vitest --changed` after
editing `electron/db/schema.sql` selects **zero** test files and exits 0.

**Recommendation: close §5 unbuilt.** The remaining wall-clock problem is not the gate's size, it is
that the gate has nowhere to run but the developer's laptop — which is T191, not this ticket.

Residual, deliberately not done: three files still build the schema directly
(`src/engine/fixtureSchemaParity.test.js`, `electron/ops/projectionsCoverage.test.js`,
`electron/sync/automerge/peerIdentity.test.js`). Together they are **3.04s for 51 tests**, and the
first is T187's guard that engine fixtures match the *real* schema — converting it would point the
guard at the thing it exists to check independently. There is nothing left to win here.

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
| `lint` | **131.3s** | 11.2% |
| **`test`** | **1015.0s (16.9 min)** quiet · 1131.9s contended | **87.2%** |
| `test:integration` | 20.6s | 1.6% |
| `security` | 5.9s | 0.5% |
| `check:governance` | 1.2s | 0.1% |
| `agents:check` | 0.2s | <0.1% |
| `ensure-abi` (warm, per invocation) | **0.3s** | <0.1% |
| **Total** | **~1174s (19.6 min)** quiet · ~1291s contended | |

### Two hypotheses in the brief, both refuted by measurement

- **`pretest`/`ensure-abi` is *not* a large fixed cost.** It is a **0.3s** no-op when the binary
  already matches (measured twice consecutively). It is designed to be: it probes the compiled
  `.node` and skips the rebuild when the marker and the binary agree. Only an actual Node↔Electron
  switch pays. This is not a target.
- **`lint` is far more expensive than anyone assumed** — 131s, the second-largest line item, and
  never previously called out.

### The run was repeated on a quiet machine — contention was *not* the explanation

The first `test` run (1131.9s) was taken while the machine was heavily oversubscribed (1-min load
ranged ~20 → ~191 on 4 cores). It was therefore repeated at load **6.5**, below the threshold
`scripts/verify.js` itself uses for "oversubscribed" (4× cores = 16). Both runs were green, same
439 files / 5893 tests.

| | Contended run | Quiet-start run |
|---|---:|---:|
| 1-min load at launch | ~150 | **6.5** |
| **Wall clock** | 1131.9s | **1015.0s** |
| Summed per-file time | 1808s | **1327s** |

**Removing the contention cut summed CPU time by 27% but wall clock by only 10%.** The suite is
~17 minutes even on a quiet machine. Contention was making it worse; it was not making it slow.
A budget set from ~1015s is defensible; the figure is no longer load-caveated.

## 3. The single largest finding: the gate lints the whole tree twice

Per-file timings (vitest JSON reporter) put one file at the top by a wide margin:

```
136.1s  eslint.supabase-ban.test.js      <- 10.3% of ALL test file-time, in one file
 70.2s  electron/main.test.js
 41.4s  electron/ops/ingest.test.js
 30.3s  src/screens/ScheduleScreen.test.jsx
 28.8s  electron/db/localDb.migrations.test.js
```
(quiet run; the contended run put the same file at 193.1s / 10.7% — it is the top entry either way)

`eslint.supabase-ban.test.js` spawns a real `ESLint` instance and lints the tree. Its middle test —
`does not flag any real file under src/ or electron/ for a Supabase import` — lints
`src/**/*.{js,jsx}` and `electron/**/*.js` through the ESLint API. **The file's own header comment
already says so:** "this is redundant with the repo's own `npm run lint`."

It is not merely redundant, it is **strictly weaker**. `npm run lint` runs the same config with the
same `no-restricted-imports` rule at `error` severity over a **superset** of those paths, and its
failure fails the gate. Any violation that test could catch, `lint` catches first — and `lint` runs
earlier in `VERIFY_STEPS`.

So the gate pays for ESLint over the tree twice: **131s (`lint`) + ~135s (inside `test`) ≈ 266s,
about 23% of the entire gate.**

**The other two tests in that file are worth keeping and are cheap.** The probe test (writes a
file importing `@supabase/supabase-js`, asserts the rule fires) is the non-vacuity test that proves
the rule actually works — exactly the kind of guard this repo has learned to insist on. The
`legacy/supabase/` test pins the scope exemption. Only the redundant full-tree pass should go.

> **Deleting a test is a governed act, not a cleanup.** It goes through the loop with Code Reviewer
> and Red Hat, and the reasoning above ("strictly weaker than an earlier gate step") is the claim
> they should attack. It is recorded here as a recommendation, not done.

## 4. The suite's cost is concentrated, which is what makes tiering possible

| Cumulative (quiet run) | Share of total file-time |
|---|---:|
| Top 10 files | 31.8% |
| Top 25 files | 45.4% |
| Top 50 files | 58.9% |
| Top 100 files | 76.3% |

| Directory | File-time | Files |
|---|---:|---:|
| `electron/` | 1115.5s (61.7%) | 179 |
| `src/` | 434.2s (24.0%) | 226 |
| `eslint.supabase-ban.test.js` | 193.1s (10.7%) | 1 |
| `scripts/` | 56.0s (3.1%) | 19 |
| `test/` | 8.2s (0.5%) | 13 |

`src/` is half the files and a quarter of the time; `electron/` is the reverse. A UI-only change
pays the full `electron/` bill today.

### The suite barely uses the machine, and that is now a measured finding

The quiet run completed **1327s of summed file-time in 1015s of wall clock — a 1.31× speedup on 4
cores.** Perfect 4-way parallelism would be ~332s. The suite is running about **3× slower than its
own CPU cost implies**, and the quiet run is *less* parallel than the contended one (1.6×), which
is the opposite of what contention would predict.

This is no longer "not yet evidence." Wall clock is dominated by serialization — process startup
under `pool: 'forks'` with per-file isolation, plus a long pole (`eslint.supabase-ban` at 136s,
`electron/main.test.js` at 70s) that no amount of core count shortens. **It is the single largest
remaining lever after the ESLint duplication**, and it does not require giving up any coverage —
which is what makes it more attractive than tiering.

## 5. Recommended tiering

**Recommendation: two tiers, with the fast tier structurally unable to impersonate the merge gate.**
Confidence: **high** on the diagnosis and on the ESLint duplication; **medium** on the exact fast-tier
composition, which should be tuned after a quiet-machine baseline.

### Tier 1 — `npm run check` (fast, advisory, per-commit)

**Candidate composition, not a spec.** The exact contents must be fixed *after* the quiet-machine
baseline in §8; a Maker must not read the list below as settled. Target well under 60s:

- `agents:check` (0.2s) + `check:governance` (1.2s) + `security` (5.9s) — all deterministic, all
  already cheap, all catching the governance failures that currently surface late.
- ESLint **on changed files only** rather than the full tree.
- `vitest run --changed <base>` — verified working on this tree: on a 9-file commit it selected
  2 test files; on a 22-file commit, 2.

### Tier 2 — `npm run verify` (unchanged, the merge authority)

Exactly what it is today. **No step is removed from it by this proposal** (the ESLint duplication in
§3 is a redundancy inside `test`, not a reduction in coverage).

### The guarantee that must not be weakened, and how

**`--changed` is blind to a load-bearing part of this suite.** It selects from vitest's module
graph, so a test that reads source as a *string* has no edge to the file it guards. Measured: **63
test files call `readFileSync`/`readdirSync`; of those, 29 read a source-shaped path**
(`.js`/`.jsx`/`.sql`/`.json`/`.md`) rather than a fixture. Treat 29 as the working figure and 63 as
the upper bound — the split is a static-text heuristic, not a resolved-path analysis, and it should
be confirmed before any selection logic depends on it.

The 29 are not a long tail; they include two classes the gate genuinely rests on:

- **Tree-scanning guards** — `src/screenKeys.syncGuard.test.js` (reads `App.jsx` to pin the
  `SCREENS` keys), `src/screenIntro.removalGuard.test.js`, `test/governance.test.js`. Edit a screen
  and `--changed` silently skips the guard written to watch that screen.
- **Migration/schema-parity tests** — a dozen `electron/db/*.migration.test.js` files read
  `schema.sql` as text. **Edit `schema.sql` and `--changed` selects none of them**, which is the
  exact case `TESTING_STANDARD.md` calls out as the failure that does not surface until a user's
  data is already in the drifted shape. This is the same blind spot `CLAUDE.md`
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

## 6. Vitest configuration — now the most promising lever, and the safest

`vite.config.js` sets **no** `pool`, `poolOptions`, `maxForks`, `isolate`, or `fileParallelism` —
vitest defaults apply throughout. Given §4's measured 1.31× speedup on 4 cores, that is where the
time is going.

**Do not touch the two timeouts.** `testTimeout: 20000` and `vitest.setup.js`'s
`asyncUtilTimeout: 3000` are measured, documented, and load-justified; both config comments record
the numbers behind them and explicitly warn that a rising timeout is the symptom, not the fix. The
same applies to the ad-hoc `--no-file-parallelism` used to fight load flakiness — note it is **not**
in the committed config, so the default parallel behaviour is what the gate actually runs.

What to investigate instead, in order of expected payoff and ascending risk:

1. **`isolate: false` for the pure-unit majority.** Per-file process isolation is what makes 439
   forks expensive. It is genuinely required for the SQLite/native and WebSocket-adjacent files;
   it is not required for pure-function suites like `src/engine/**`. A per-project split is the
   mechanism vitest provides for this.
2. **`poolOptions.forks.minForks/maxForks`.** Defaults may under-subscribe a 4-core box.
3. **Splitting the long pole.** Removing the redundant ESLint pass (§3) shortens the critical path
   as well as the CPU bill — the two findings compound.

**This lever gives up no coverage**, which is what makes it more attractive than tiering and why it
should be evaluated *before* the owner is asked to accept a fast tier at all. It is still a shared-
harness change, so it still needs the `test-infrastructure` human gate and the review loop —
particularly Red Hat, since `isolate: false` is exactly the kind of change that trades wall clock
for cross-test contamination that shows up as flakiness weeks later.

## 7. Two documentation defects found on the way

### 7.1 `TESTING_STANDARD.md` §1 does not describe the gate — Article I report

The standard that **owns the gate list** contradicts the code:

| `TESTING_STANDARD.md` §1 says | Reality |
|---|---|
| `node test/integration/run.js` | **That file does not exist.** It is `test/integration/run.automerge.js`, via `npm run test:integration` |
| `npm run build` is a gate | `VERIFY_STEPS` does **not** include `build` — and `git log -S"'build'" -- scripts/verify.js` returns **no commits**, so it was never removed from the gate; it was never in it |
| (not listed) | `agents:check`, `security`, `check:governance` are all in `VERIFY_STEPS` |

Per `GOVERNANCE_INDEX.md` §11 rule 3 and Article I, code contradicting a standard is **reported, not
reconciled by an agent**. Flagged here for the owner; deliberately not fixed.

**This is three decisions, not one, and they are not equally clerical.** Rows 1 and 3 are almost
certainly staleness. **Row 2 is not: the owner has to say whether `build` is a gate.** If it should
be, this ticket's premise shifts — the gate gets *slower*, not faster, and the tiering math changes.
Evidence for that decision: `build` was not dropped from `VERIFY_STEPS`, it was never in it, so the
standard's line has been aspirational since `scripts/verify.js` was written. Resolve row 2
explicitly rather than letting whoever edits the file first settle it.

### 7.2 `CLAUDE.md`'s "~270 test files" — already owned, not duplicated

Actual count is **438**. This is already filed as
**T186** (`T186-claude-md-goes-stale-by-construction.md`, filed on another branch) by a concurrent session, which reframes it as a
structural staleness problem rather than a number to correct. **T188 does not touch `CLAUDE.md`** —
recorded here only so the two tickets are not worked twice.

## 7.3 Recommended sequencing

The quiet-machine baseline now exists (§2), so the ordering can be stated properly. **Tiering is
the last resort, not the first move** — it is the only option here that trades away coverage, and
two cheaper levers come first:

1. **Remove the duplicate full-tree ESLint pass (§3).** ~135s, no coverage lost, no ADR, no
   baseline dependency. Needs Red Hat + Code Reviewer + Verifier. **Take this first.**
2. **Tune vitest parallelism (§6).** The suite uses 1.31× of 4 cores; the ceiling is ~3× faster.
   No coverage lost. Needs the `test-infrastructure` human gate and a careful Red Hat pass on
   `isolate: false`.

2b. **Convert the remaining 63 files to the §0.2 fixture.** Mechanical, measured, already proven on
   five files. This is the largest remaining *certain* win.
3. **Tier the gate (§5).** Only if 1 and 2 leave it too slow. This is the one that weakens a
   guarantee, and §5's three mandatory properties are the price of doing it safely.

A legitimate owner answer is "do 1 and 2, skip 3 entirely." On the measured numbers that is the
outcome I would expect: 1 and 2 together plausibly reach single-digit minutes without touching
what the gate proves.

### 7.4 WITHDRAWN: "collapse the 33 migration tests into one chain-walk"

**An earlier revision of this ticket recommended this. The recommendation was wrong and is
withdrawn.** It is recorded rather than deleted because the reasoning error is the useful part.

The claim was that the 33 `electron/db/*.migration.test.js` files assert the same three properties
(fresh-vs-migrated, idempotency, rollback) at 33 points, so one parameterized walk over v0→v65
would prove more for less. The first half is true and the conclusion does not follow. Counting what
those files actually assert:

**Of 294 tests across the 33 files, 42 are generic parity and 252 — 86% — are slice-specific.**

| File | Slice-specific / total |
|---|---:|
| `locations.migration.test.js` | 15 / 17 |
| `scheduleKind.migration.test.js` | 15 / 16 |
| `anchorKindSplit.migration.test.js` | 13 / 14 |
| `retireOrphanSlots.migration.test.js` | 13 / 15 |
| `electives.migration.test.js` | 12 / 13 |

Those 252 are backfill correctness, per-migration forward behaviour, and invariants unique to one
slice — `locations.migration.test.js` carries a two-database cross-device backfill determinism test
its own header marks non-negotiable. **A collapse would have deleted them to save ~180s.**

The error was inferring content from *file naming and header comments* instead of counting the
assertions. The headers genuinely do say "fresh-vs-migrated / idempotency / rollback" — that is what
made the misreading plausible — but they describe the shared skeleton each file opens with, not its
body. This is the same shape as the repeated lesson that a guard's description is not the guard:
here, a *test file's* description was taken for its contents.

**The corrected position: that ~199s is largely irreducible.** Replaying the chain is what those
files test, and they cover the highest-consequence change class in the repository. The only
defensible optimisation is narrow — the *fresh* side of a fresh-vs-migrated comparison is exactly
what the §0.2 template already is, so it could be supplied from the template while the *migrated*
side keeps replaying. That is a modest, delicate saving on part of 199s and should not be attempted
before the §0.3 defect is resolved, since it is that comparison's correctness that is in question.

---

## 8. Definition of done

- [x] The full gate is re-measured on a quiet machine — §2, and again at §0.4 after the follow-on work.
- [x] `VERIFY_STEPS` is ordered cheapest-first — §0.1.
- [x] A prebuilt-schema fixture exists, is proven equivalent to a chain-migrated database, and is applied — §0.2. Now on **65 files**; the 3 that remain are 3.04s total and correctly excluded (§0.4).
- [x] The "collapse the 33 migration tests" recommendation is resolved — **withdrawn**, with the counting that refutes it — §7.4.
- [x] The duplicate full-tree ESLint pass is resolved (#457) — replaced by a grep that proves the same property without a second full-tree lint.
- [x] Vitest parallelism is investigated against the 1.31×-on-4-cores finding (#457, #458) — per-project `isolate: false`.
- [x] Concurrent gates are serialised rather than left to convention — `scripts/gateLock.js`.
- [x] `TESTING_STANDARD.md` §1 matches `VERIFY_STEPS` — corrected here, including the stale "spawns real child processes" rationale. **The one genuine decision, whether `build` should gate, is left open for the owner and is not settled by this change.**
- [x] The tiering question (§5) has an evidence-backed recommendation — **close unbuilt**, §0.4. Formally closing it is the owner's call.
- [x] `npm run verify` is green.

**This ticket is complete apart from two owner decisions**: whether `npm run build` should be a gate
step (§7.1), and formally closing §5. Neither blocks anything; both are recorded where they will be
found. The wall-clock problem that outlives this ticket — the gate having nowhere to run but one
laptop — is **T191**.

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

# tests invisible to --changed (63 upper bound; 29 read a source-shaped path)
grep -rl 'readFileSync\|readdirSync' --include='*.test.js' --include='*.test.jsx' \
  src electron test scripts | grep -v node_modules | wc -l
# the 29: files whose fs read names a .js/.jsx/.sql/.json/.md target
# (static-text heuristic — confirm before any selection logic depends on it)

# whether `build` was ever a gate step (returns nothing: it never was)
git log -S"'build'" --oneline -- scripts/verify.js
```
