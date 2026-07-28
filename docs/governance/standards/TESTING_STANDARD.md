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

| Command | Covers |
|---|---|
| `npm run test` | Vitest unit and single-process integration suites |
| `npm run lint` | ESLint, including the ban on reintroducing `@supabase/*` imports |
| `npm run build` | Production build |
| `node test/integration/run.js` | **Multi-process** scenarios: pairing, revocation, token renewal, conflict detection, clock skew, role changes |

### When the integration harness is mandatory

**Mandatory** for any change touching **sync, authentication, or schema**. Optional elsewhere.

This is not a matter of thoroughness. The harness spawns real child processes; the unit suite runs
in one process and therefore *structurally cannot* observe two devices disagreeing, a revocation
landing mid-session, or a conflict being recorded. For those changes, a green `npm run test` is not
weak evidence — it is evidence about a different question.

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
in its own right, not a test-only inconvenience.

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
  product promise (`ARCHITECTURE_STANDARD.md` §7) and must be asserted, not assumed.

## 5. Reporting results

Per [`CONSTITUTION.md`](../constitution/CONSTITUTION.md) Article II:

- **Evidence outranks consensus.** If every reviewer approves and `npm run test` fails, the result
  is failure.
- **Missing evidence is disclosed, never converted into a pass.** A claim that cannot be
  mechanically checked is reported **UNVERIFIED** — not passed, not waived, not silently dropped as
  not-applicable. Governor decides what to do with it.
- **Reviewers do not modify the work they review.** Gates run against the code as committed. Do not
  patch a failing test to make a check pass.
