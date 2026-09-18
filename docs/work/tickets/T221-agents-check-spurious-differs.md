---
title: T221-agents-check-spurious-differs
document_type: ticket
status: open
created: 2026-09-18
archive_when: the deliberate-corruption test no longer prints DIFFERS into a passing gate log
governing_docs: [docs/governance/standards/TESTING_STANDARD.md]
---

# T221 — `agents:check` DIFFERS lines leaking out of a passing test

## Symptom

`npm run verify` intermittently shows, with no diff to explain it:

```
DIFFERS  docs/governance/agent-bindings/manifest.json — recorded hashes do not match freshly generated ones
1 profile(s) diverged from the generator. Not behavior-preserving — fix before merging.
```

Observed at least three times on 2026-09-17/18, across two branches and two sessions. Every time,
`git diff origin/main -- .claude/agents/ docs/governance/agent-bindings/` was empty and a standalone
`npm run agents:check` passed. Each session re-diagnosed it and settled on "probably environmental".

## Root cause (confirmed in code and by measurement, not inferred)

Benign stdout from a **passing** test — lead (a). Mechanism:

1. `scripts/generateAgentProfiles.js:139,145` prints `DIFFERS …` and `N profile(s) diverged` with
   `console.error`, i.e. to **stderr**.
2. `scripts/generateAgentProfiles.test.js` → `runCheck()` invokes the CLI with `execFileSync`.
   Node's `execFileSync` **both captures a child's stderr and echoes it to the parent's stderr** by
   default. Measured directly:
   `execFileSync('node', ['-e', 'console.error("X");process.exit(1)'], {encoding:'utf8'})` →
   `e.stderr === "X\n"` *and* `X` written to the parent's stderr.
3. The `manifest verification` test deliberately corrupts `manifest.json`, asserts the generator
   reports DIFFERS, and restores it in `afterEach`. So the two lines are printed **every time the
   suite passes**.

Reproduced on a clean tree: `npx vitest run scripts/generateAgentProfiles.test.js` emits exactly the
two reported lines and reports `Tests 3 passed (3)`.

The lines carry **no step attribution**, so reading them as the `agents:check` step is the reader's
inference; stderr is unbuffered while the `▶ npm run <step>` banners go through a buffered stdout
pipe, so the interleaving readily puts them far from the `▶ npm run test` banner that owns them.

## Leads ruled out

- **Not a race on the corrupted manifest.** `agents:check` is `VERIFY_STEPS[0]` and completes before
  `test`; `grep` over `scripts/ test/ src/ electron/ .github/ package.json` shows
  `generateAgentProfiles.js` has exactly **one** other consumer — its own test file. No second
  process reads the manifest during the corruption window.
- **Not shared/symlinked config state.** `.claude/agents/*.md` are **regular tracked files**, not
  symlinks, in both the main checkout and worktrees (`find . -type l` over the repo returns
  nothing). The `~/dev/shoresh-config` note in memory is stale on this point; concurrent sessions in
  separate worktrees each resolve `MANIFEST_PATH` from their own `ROOT`. **No ADR needed** — this is
  test hygiene, not an architectural decision.

## Fix (applied on this branch)

Pass `stdio: ['pipe', 'pipe', 'pipe']` in `runCheck`'s `execFileSync` options, with a comment
naming this ticket. Output is captured, never echoed.

Non-vacuity: the `DIFFERS` text exists **only** on stderr, so the corruption test's
`expect(output).toMatch(/DIFFERS/)` still passing proves stderr is still captured — the assertion did
not become a no-op. Verified: 3 passed, zero stray lines.

## Residual hazard (not fixed here, deliberately)

The corruption test mutates the **real committed** `docs/governance/agent-bindings/manifest.json` and
relies on `afterEach` to restore it. A `SIGKILL` (or a `--bail` abort) mid-test leaves a corrupted
manifest in the working tree — which would then fail `agents:check` for real, with a *non-empty*
diff. That is distinguishable from this ticket's symptom and self-announcing, so it is left alone
rather than papered over; fixing it properly means teaching the generator to accept a manifest path
via env, which is a larger change than this ticket warrants.
