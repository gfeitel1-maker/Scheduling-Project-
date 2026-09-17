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
| 3 | `npm run security` | npm-audit, secret scan, dangerous-pattern scan |
| 4 | `npm run test:integration` | **Multi-node** scenarios: pairing, revocation, token renewal, conflict detection, clock skew, role changes |
| 5 | `npm run lint` | ESLint, including the ban on reintroducing `@supabase/*` imports |
| 6 | `npm run test` | The Vitest suite |

**The order is cheapest-first and is load-bearing, not cosmetic.** Because the gate short-circuits,
a step placed after an expensive one is not reported until that expensive one has finished. These
six are sorted by measured cost so a failure is reported as early as it can be. Re-measure and
re-sort if a step's cost changes materially; `scripts/verify.test.js` asserts the ordering property,
not merely the literal list.

**`npm run build` is deliberately not in that list.** An earlier revision of this standard listed it
as a gate; `git log -S"'build'" -- scripts/verify.js` returns no commits, so it has never been one.
Whether a production build *should* gate is an open question recorded in `docs/work/tickets/T188-the-gate-is-88-percent-one-step-and-lints-the-tree-twice.md` §7.1 — it is a
product decision for the owner, not something to settle by editing either side to match the other.

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
