---
title: Testing Standard
document_type: standard
authority: normative
status: active
applies_to: [testing, engineering, workflow]
supersedes: []
last_reviewed: 2026-07-28
review_trigger: any change to the gate commands in package.json, or to the integration harness
---

# Testing Standard

What counts as proof. This document is the single owner of the gate list — Verifier, `CLAUDE.md`,
and `README.md` all derive from it rather than maintaining their own copies.

---

## 1. The gates

**`npm run verify` is the gate.** It runs these six steps, in this order, stopping at the first
failure, and prints a single `✅ VERIFY PASSED` / `❌ VERIFY FAILED` / `⚠️ VERIFY INCONCLUSIVE`
verdict line. Read that line; never read the exit code of a piped or tee'd wrapper.

| # | Command | Covers |
|---|---|---|
| 1 | `npm run agents:check` | Every `.claude/agents/` profile still round-trips from its bindings |
| 2 | `npm run check:governance` | Frontmatter shape, reference paths, index freshness, status drift, and descriptive docs naming deleted paths |
| 3 | `npm run build` | The production bundle. The only step that exercises the bundler |
| 4 | `npm run security` | npm-audit, secret scan, dangerous-pattern scan |
| 5 | `npm run test:integration` | **Multi-node** scenarios: pairing, revocation, token renewal, conflict detection, clock skew, role changes |
| 6 | `npm run lint` | ESLint, including the ban on reintroducing `@supabase/*` imports |
| 7 | `npm run test` | The Vitest suite |

**The order is cheapest-first and is load-bearing, not cosmetic.** Because the gate short-circuits,
a step placed after an expensive one is not reported until that expensive one has finished. These
six are sorted by measured cost so a failure is reported as early as it can be. Re-measure and
re-sort if a step's cost changes materially; `scripts/verify.test.js` asserts the ordering property,
not merely the literal list.

**`npm run build` was added on 2026-09-17, resolving T188 §7.1.** This standard had named it a gate
for months while `scripts/verify.js` never ran it — `git log -S` shows it was never in
`VERIFY_STEPS`. Rather than delete the claim, the gate was made true: the build costs **2.8s**,
cheaper than `security`, and it is the only step that exercises the bundler. A broken import in the
renderer fails `npm run build` and passes every test, and this repository has already shipped a
packaged crash from exactly that gap (`ERR_MODULE_NOT_FOUND`, `build.files` not shipping `src/**`).
Confirmed non-vacuous by planting a bad import and watching the step exit 1.

### Where the gate runs, and what each run is worth

`.github/workflows/gate.yml` runs the same `npm run verify` on every pull request and on push to
`main`, on a Linux runner.

**CI is the gate of record for merging.** A pull request whose CI run is red does not merge,
whatever a local run said. This is not a preference for automation: the runner is a clean machine,
and within an hour of existing it caught two defects no local run could — a suite that depends on
`zsh` being present (true on every Mac, false on a fresh Linux box) and a test asserting against a
hardcoded `/Users/<someone>/dev/shoresh`. A green local gate cannot distinguish "this code is
correct" from "this machine happens to be configured like the author's."

**A local `npm run verify` remains valid evidence, and remains the right tool while iterating.** It
is what `scripts/gate.sh` stamps and what `scripts/verifierReport.js` accepts, so a Verifier report
still comes from a local stamped run. What changed is that a local green is no longer *sufficient*
to merge — CI must also be green — and it is no longer *necessary* to run the full local gate before
every push, because CI will run it anyway, on a quieter machine, in about half the time.

The practical consequence, which is the point: **stop paying ~13 minutes locally to earn the right to
open a pull request.** Push, let CI run, and spend local gate time only when you need the answer
faster than CI can give it or when you are producing a stamped Verifier artifact.

### When the integration harness is mandatory

**Mandatory** for any change touching **sync, authentication, or schema**. Optional elsewhere.

This is not a matter of thoroughness. The harness runs **real libp2p nodes over real transports,
merging real Automerge documents, with no mocks** — the unit suite runs a single node and therefore
*structurally cannot* observe two devices disagreeing, a revocation landing mid-session, or a
conflict being recorded. For those changes, a green `npm run test` is not weak evidence — it is
evidence about a different question.

> An earlier revision justified this by saying the harness "spawns real child processes." It does
> not, and has not since the Stage 6 cutover replaced the WebSocket harness with
> `test/integration/run.automerge.js`: `grep -cE 'spawn|fork|child_process'` over the harness
> returns **0**, and its own header describes "in-process nodes (`startSyncNode`) and real Automerge
> documents — no mocks." The mandate above is unchanged; only the reason it rests on is corrected.
> What makes the harness irreplaceable is the *real transport and real merge*, not process
> boundaries.

Concretely, mandatory for: `electron/sync/**`, `electron/auth/**`, `electron/ops/**`,
`electron/db/schema.sql` and migrations, and release preparation.

### Schema changes carry one extra gate

A migration must be shown to produce a schema **identical** to a freshly created database. Migrated
and fresh databases diverging is the failure mode that does not surface until a user's data is
already in the drifted shape.

### What a green (or red) verdict actually claims

Read this section when a gate result confuses you — when green feels wrong, when red points at a
diff that looks innocent, or when you are about to write "it passed" in a completion claim. The
gate is trustworthy about the question it answers; the recurring defect is reading a narrow answer
as a broad one.

> **In every instance below the gate answered a question about *this tree at this moment*, and was
> read as answering a question about *the repository*.**

That one sentence is the whole pattern. The members are collected here so they read as one thing
rather than as unrelated gotchas — treating them as unrelated is how the next one gets made. This
is a **triage aid, not the fix.** The mechanical mitigations at the end are the fix, and the
strongest evidence in this section (see "Prior art") is that writing the lesson down, on its own,
has already been shown not to prevent recurrence.

#### Family 1 — the answer was true, of something else

The check ran, on the right kind of input, and passed — but the input was narrower than the reader
assumed.

| Member | The check | What it actually measured | What it was read as |
|---|---|---|---|
| Duplicate ticket / schema numbers | `npm run check:governance` | the **working tree**; your branch has no other branch's tickets or migrations | "no number collision exists" — collisions on other branches are invisible until a rebase |
| The live advisory clock | `npm run security` (`npm audit`) | a **live external database**, so the verdict is a function of wall-clock time, not committed state | "our diff broke the build" — an advisory published overnight reddened an untouched branch. Corollary: `main` is **stale-green**, not green. "It passed" and "it would pass now" are different claims |
| Stale `node_modules` after a dependency-major rebase | `npm run test` / whole suite | the packages **actually installed** — the OLD major, while `package-lock.json` already named the new one, with nothing in any output saying so | "the gate validated this tree." **Confirmed twice, not hypothetical.** Run `npm ci` before trusting any local result after such a rebase |
| Status-drift skipped in CI | `npm run check:governance` `checkStatusDrift` | nothing — CI's shallow checkout has no `origin/main` to diff against, so the check **skips** (see [`WORK_RECORD_STANDARD.md`](WORK_RECORD_STANDARD.md) §3.2, "Scope") | "CI is the gate of record, so drift was validated." Because CI is the gate of record for merging, a green CI run is **positive evidence status-drift was NOT checked** — it runs only in a local gate |
| A merge-conflict sweep over stale literals | a hand `git`-driven sweep of conflicted files | only files **both** sides touched — `git` raises conflicts nowhere else | "every stale version literal is fixed." A tripwire in a file the *other* side merely added rides through untouched. **Sweep the predicate (`grep` every assertion), never the conflict list** |

The duplicate-schema member is the one with teeth: the second migration at a given version is
**never applied** on a database that already ran the first (the guard compares stored version
against the literal), and the app then reports itself fully migrated — silent data-shape divergence
across a camp's devices. Only a pre-merge **rebase + re-run** catches it, which is why that step is
mandatory rather than advisory.

#### Family 2 — the tool abstained, and the abstention read as agreement

The more dangerous half. A stale answer is at least an answer; an abstention read as agreement is
the tool saying *"I did not look"* and the reader hearing *"there is nothing there."*

| Member | The check | What it actually said | What it was read as |
|---|---|---|---|
| `npm run verify` printing `⚠️ VERIFY INCONCLUSIVE` and **exiting 0** | the full gate under load | "this was not a pass" — often with real failure counts underneath (`1 failed \| 447 passed`) | a pass, by exit code. **Read the verdict line, never the exit code**, and read the counts before believing the "very likely a load artifact" banner |
| `graphify affected "<sym>"` → *"No unique node match"* | the codebase graph | "this symbol is not indexed" (e.g. a `useCallback` const) | "nothing depends on it" |
| A uniform zero across a sweep of many items | any `grep`/shell sweep | "the measurement returned nothing" — often a quoting or glob defect, not absence | "there is nothing on any of them." A **uniform** result where variation was expected is a defect in the measurement until proven otherwise |

The rule that follows: **treat "no results" as a claim about the measurement until shown
otherwise.** Two tells it is lying: a count of zero for something you know exists, and a uniform
zero across many items where you expected variation.

#### Family 3 — the test asserted something adjacent to the bug, not the bug

Distinct from staleness and abstention: the check ran, on the right file, on the exact line
containing the bug, and passed — because its predicate is **invariant across the buggy and fixed
code paths.**

| Member | The check | What it actually measured | What it was read as |
|---|---|---|---|
| `v68_down.test.js:46` and the equivalent in every rollback test (see [`T220`](../../work/tickets/T220-rollback-bare-equality-guard.md)) | rollback of a fresh single-version DB | "the row for exactly N is gone after rollback" — **true identically** whether the code reads `WHERE version = N` or `WHERE version >= N` | "the cleanup at this line is correct." The two predicates only diverge on a row for a version *higher* than N, which the fixture never seeded |

The general form: **a test can cite the exact line containing a bug and still not test the bug.**
Line-level proximity between a test and a defect is not evidence the test would catch it — only
running the test against both versions of the code is (see the `test-driven-development` skill's
verify-RED step, and the non-vacuity proof required in T220).

#### The mitigations that are the actual fix

None of the above is fixed by writing it down; each is fixed by a mechanical step that does not
depend on remembering it at the right moment:

- **Read the verdict line** (`✅`/`❌`/`⚠️`), never the exit code of a piped or tee'd wrapper.
- **`npm ci` before trusting any local result** after a dependency-touching rebase; confirm the
  resolved version rather than trusting that the install reported success.
- **Rebase onto `origin/main` and re-run `check:governance` immediately before merge**, so
  cross-branch number collisions surface while they can still be fixed.
- **Assert a sweep found *something* before trusting that it found nothing** —
  `expect(files.length).toBeGreaterThan(N)`, the shape already used in
  [`electron/sync/automerge/transportBoundary.guard.test.js`](../../../electron/sync/automerge/transportBoundary.guard.test.js)
  and [`electron/authRejectedSender.test.js`](../../../electron/authRejectedSender.test.js),
  both of which fail loudly if their scanner matches zero inputs.
- **Sweep the predicate, not the conflict list** — `grep` every assertion, and extend structural
  sweeps to `test/` and `scripts/`, not only `src/` and `electron/`.
- **Prove a paired test non-vacuous**: plant the bad pattern, watch the guard go red, remove it,
  watch it go green.
- When `security` reddens, triage it as *"which advisory, published when"* before hunting the diff.
  Do **not** try to "fix" the live-advisory property — learning about new advisories is the gate's
  job.

#### Prior art — this is not a new discovery

The 2026-09-08 sync-layer deletion recorded in the standing instructions (`~/.claude/CLAUDE.md`,
"Why this is a rule and not a suggestion") already reached the structural conclusion this section
rests on: hand-written `grep` sweeps produced four separate false negatives, and the answer was not
"grep more carefully" but *graph → `grep -a` → gate* — three tools with three different blind
spots, none sufficient alone, closing with "diligence inside the wrong method still converges on
the wrong answer." The in-repo record is
[`docs/work/handoffs/2026-09-09-post-stage6-handoff.md`](../../work/handoffs/2026-09-09-post-stage6-handoff.md),
which adds: *a zero-result search is a claim about the search.* That recommendation was adopted,
loaded at session start, and **still did not prevent the 2026-09-17 recurrence** — which is why the
mitigations above are mechanical rather than another written rule. Further material on what a green
gate does and does not mean lives in
[`docs/work/security/2026-09-14-security-program.md`](../../work/security/2026-09-14-security-program.md).

---

## 2. The two environments, and what each can prove

| | `npm run dev` → `localhost:5200` | `npm run electron:dev` |
|---|---|---|
| Runs | Browser renderer only | The real app |
| Data layer | `src/localClient.mock.js` | Real SQLite via IPC |
| Can prove | Layout, copy, visual fidelity, navigation, interaction feel | Everything, including persistence, auth, and sync |
| Cannot prove | **Anything about persistence, auth, sync, or IPC** | — |

**The dev mock is acceptable for layout and UX evaluation. It is not acceptable as the basis of any
completion claim involving persistence, auth, or sync — those require `electron:dev`.**

This rule exists because the mock has already hidden a project-blocking defect: its `write()`
returned `{status:'applied'}` without persisting, so in the only environment anyone was testing,
every create silently no-op'd and no entity could be built. Nothing about the browser view revealed
it. See `docs/current/PLATFORM_STATE.md` Known Issues.

The mock emulates the real client's `UNIQUE` constraints and delete semantics precisely so it stays
faithful. **When you change `localClient`, change the mock** — divergence between them is a defect
in its own right, not a test-only inconvenience. This is enforced: `test/governance.test.js`
asserts the mock implements every `window.shoresh` method the renderer calls, and fails the build on
any new divergence.

Mock data must be **visibly fake** (names suffixed "(sample)"). A dev screen showing plausible
invented data is worse than one showing none — it invites a conclusion the environment cannot
support. The sidebar's DEV badge is the other half of that signal.

## 3. Native module rebuild

`better-sqlite3` must match the runtime:

```bash
npx electron-rebuild -f -w better-sqlite3   # before electron:dev
npm rebuild better-sqlite3                   # before npm run test
```

Skipping this presents as a module-load error or startup crash, never as a test failure.

---

## 4. What a test must assert

- **A real property, not a mock configured to return the expected value.** A test that passes
  against a stub that cannot fail proves the stub works.
- **The behaviour the task cares about.** Coverage named in a brief's testing plan is required, not
  aspirational — a missing test named there is a finding.
- **Bug fixes start with a failing test** that demonstrates the bug. A fix without one has no
  evidence it fixed anything, and no protection against regression.
- **Determinism where determinism is the guarantee** — the schedule engine's seeded output is a
  product promise (`ARCHITECTURE_STANDARD.md` §8) and must be asserted, not assumed.

## 5. Reporting results

Per [`CONSTITUTION.md`](../constitution/CONSTITUTION.md) Article II:

- **Evidence outranks consensus.** If every reviewer approves and `npm run test` fails, the result
  is failure.
- **Missing evidence is disclosed, never converted into a pass.** A claim that cannot be
  mechanically checked is reported **UNVERIFIED** — not passed, not waived, not silently dropped as
  not-applicable. Governor decides what to do with it.
- **Reviewers do not modify the work they review.** Gates run against the code as committed. Do not
  patch a failing test to make a check pass.
