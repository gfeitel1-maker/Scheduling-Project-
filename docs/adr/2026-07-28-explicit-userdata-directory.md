---
title: "Development and packaged builds use explicitly named, separate userData directories"
document_type: adr
authority: normative
status: accepted
date: 2026-07-28
supersedes: []
implementation_state: shipped
affects: [docs/governance/standards/ARCHITECTURE_STANDARD.md, CLAUDE.md]
---

# Development and packaged builds use explicitly named, separate userData directories

**Status: ACCEPTED and implemented, 2026-07-28.** The orphaned directory is left in place, per the
approved disposition below.

---

## Context

`electron/main.js:676` calls `app.getPath('userData')` and never calls `app.setName()`. The
directory is therefore whatever Electron infers from argv, and it infers differently depending on
how the app was started:

| How it is run | Resolved directory | Why |
|---|---|---|
| `npm run electron:dev` | `~/Library/Application Support/Electron` | Launched as `electron electron/main.js`, so `--app-path` resolves to the `electron/` subdirectory. No `package.json` there, so Electron cannot read the app name and falls back to its built-in default, `Electron`. |
| `/Applications/Shoresh.app` | `~/Library/Application Support/shoresh` | Reads `name` from the real `package.json`. |

Measured 2026-07-28:

| Location | Camp | Ops | Slots |
|---|---|---|---|
| `Electron/shoresh.sqlite` | Test Camp | 290 | 20 |
| `shoresh/shoresh.sqlite` | Test Camp | 293 | 20 |

Two databases, three operations apart. Neither currently holds a real camp.

### The part the ticket did not capture

The fallback name is `Electron` — a constant, derived from the Electron binary, **not from the
repository**. Every development clone on this machine therefore resolves to the *same* directory:

- `~/dev/shoresh`
- `~/dev/shoresh-ui`
- `~/dev/shoresh-verify` (referenced in T9's captured process args)

At the time of writing, `shoresh-ui` is running `electron:dev` against
`~/Library/Application Support/Electron` — the same database this repository's dev build uses. Two
different codebases, one database, concurrently. This is not a dev-versus-packaged problem; it is
an every-clone-collides problem, and it explains why the database inspected during T8 contained
drag-test data from a different working tree.

## Decision

Set the userData directory explicitly, and make the two cases visibly distinct.

1. Call `app.setName('shoresh')` before any `app.getPath('userData')` call, so the name never
   depends on argv.
2. When `app.isPackaged` is false, resolve userData to a **`shoresh-dev`** directory instead of
   `shoresh`.
3. Surface which database is loaded in the UI. The footer already shows `shoresh.sqlite`; it must
   show enough to distinguish the two — a `DEV` marker when unpackaged, and the resolvable path on
   hover.
4. Document the split in `CLAUDE.md` under Commands, and state the invariant in
   `ARCHITECTURE_STANDARD.md`.

### Why separate rather than unified

Unifying is the more obvious fix — it would make "it works in dev" evidence about the shipped app,
which is the stated motivation in T9. It is rejected because the asymmetry of harm is severe.

Shoresh is used to run a real camp. A development session that regenerates a schedule, restores a
snapshot, or exercises a migration against the operational database can destroy a director's work
irreversibly. A testing gap costs a re-test; corrupted camp data costs a camp's schedule. Those are
not comparable, and the default should protect the worse outcome.

Today neither database holds a real camp, so unifying would be safe *right now*. That is precisely
why the decision should be made now rather than after a real camp exists, when the safe path is
harder to take.

The testing gap that unification would have closed is addressed differently:
`TESTING_STANDARD.md` §2 already requires `electron:dev` for completion claims involving
persistence, and the integration harness for sync, auth, and schema work. The residual risk — that
dev data does not resemble production data — is real but bounded, and is not fixed by pointing
development at live data.

### Why the indicator is not optional

The harm in T9 was never that two databases exist. It is that **nobody could tell which one they
were looking at.** A deliberate split without a visible marker reproduces the original defect with
better intentions. If only one of the four changes above is implemented, it should be the indicator.

## Consequences

**A one-time data-location change.** `~/Library/Application Support/Electron` becomes orphaned.
It holds Test Camp, 290 ops.

**Approved disposition — leave it.** Development starts from an empty database. Nothing real is lost — it held
Test Camp, three operations from its sibling — and `~/Library/Application Support/Electron` is not
deleted by this change, so anything wanted from it is still recoverable.

Per `CONSTITUTION.md` Art. II rule 5, this is a sensitive change and needs migration, rollback, and
recovery plans. Rollback is reverting the commit: the old directory is never deleted by this change,
so reverting restores the previous behaviour exactly, with data intact.

**Clones stop colliding with the Electron default**, but still share `shoresh-dev` with each other.
That is judged acceptable and arguably desirable — consistent test data across working trees — and
is now at least a named, documented directory rather than a coincidence. If per-clone isolation is
wanted later, that is a separate decision.

**The packaged app is unaffected.** It already resolves `shoresh`; `setName('shoresh')` makes that
explicit rather than changing it. No user of a packaged build sees any difference, and no packaged
data moves.

**`app.setName()` must be called before `app.whenReady()`** and before any `getPath` call, or it
silently has no effect — the same class of ordering trap as the projection-registry omission. This
needs a test asserting the resolved directory, not a code comment.

## Alternatives considered

**Unify on `shoresh`.** Rejected above: makes every development run a live-data operation.

**Keep the accident, document it.** Rejected: relies on a fallback constant in Electron's own
implementation, which no one on this project controls and which would change silently on upgrade.

**Per-clone dev directories** (e.g. hashed from the repo path). Rejected as speculative: it solves a
problem nobody has reported, at the cost of scattering test databases and making them hard to find.
Revisit if working trees start needing genuinely independent state.

## Addendum, 2026-08-09: a third userData case for the deploy smoke test

The deploy smoke test (`scripts/deploy-local.sh`) originally pointed its launch heartbeat check at
the packaged app's real `shoresh` userData directory — the same directory the director's live camp
database lives in. That made the smoke test correctness-coupled to that database's schema: a build
on a branch behind the machine's already-migrated operational database would boot successfully and
still false-fail, because the smoke test was reading heartbeat state next to a database it never
opened, in a directory it assumed was safe to inspect. This happened in practice — machine DB at
schema v30, branch at v29.

The smoke test's job is narrower than "the operational database still works" — it is "this build
boots." Those are different claims and only one of them is what a deploy smoke test should be
proving.

### Decision

Add a third resolution path to `applyUserDataPath`, gated so it can only ever fire during an
intentional smoke run:

- `app.isPackaged` must be true (dev is unaffected, unconditionally — the smoke override is
  ignored when unpackaged even if the env var is set).
- `SHORESH_SMOKE_USERDATA` must be a non-empty string naming a directory. `deploy-local.sh` sets it
  to a freshly created `mktemp -d` directory for the duration of the smoke run and removes it via
  `trap ... EXIT` regardless of pass or fail.

When both hold, userData resolves to that disposable directory instead of `shoresh`. The app still
opens (and creates, via the same `openLocalDb` path every fresh install takes) a database there —
it just never touches the director's real one. `SHORESH_SMOKE_NONCE` is generated per run and
threaded through to the startup heartbeat marker, so a stale marker from a previous run (or a
leftover temp dir) can never be mistaken for evidence that *this* launch succeeded.

### Consequences

The smoke test now proves the build boots against a schema the build itself creates, independent of
whatever schema version the machine's live database happens to be at. It can never again false-fail
on drift between "what schema the branch expects" and "what schema the last packaged install
already migrated to."

The heartbeat marker write itself is now gated on `SHORESH_SMOKE_NONCE` being set, so it no longer
fires — and no longer writes a stray file into userData — on any dev, test, or ordinary launch.

Known ceiling, not fixed by this addendum: `did-finish-load` proves the renderer shell loaded, not
that React mounted or that IPC works end to end. A renderer-mount-plus-IPC heartbeat is a planned
follow-up, tracked in `scripts/deploy-local.sh` next to the poll loop.
