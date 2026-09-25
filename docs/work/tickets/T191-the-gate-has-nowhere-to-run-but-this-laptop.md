---
title: "The gate has nowhere to run but this laptop — there is no CI, and there never has been"
document_type: ticket
status: completed
created: 2026-09-16
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: "Either CI runs the gate on push to main and on pull requests and the repository has decided what status a CI result carries as evidence, or the owner has decided CI is not wanted and that decision is recorded with its reason"
---

# T191 — The gate has nowhere to run but this laptop

## 0. Status — the workflow is implemented; its *authority* is not

`.github/workflows/gate.yml` and `.nvmrc` land with this ticket. What is deliberately **not**
decided here is §5's question: what a CI result *counts as*.

**RESOLVED 2026-09-17: CI is the gate of record for merging.** A pull request whose CI run is red
does not merge, whatever a local run said. The runner earned that within an hour of existing, by
catching two defects no local run could (§0.1).

A local `npm run verify` remains valid evidence and remains what `scripts/gate.sh` stamps and
`scripts/verifierReport.js` accepts — Verifier reports are unchanged. What ends is the obligation to
spend ~13 local minutes before pushing. See `TESTING_STANDARD.md` §1, "Where the gate runs, and what
each run is worth".

### 0.1 The first CI run failed, and that is the ticket justifying itself

The workflow's first run on its own PR went red in ~9 minutes, on something **no local run can
reproduce**: eight test files spawn `/bin/zsh`, and `ubuntu-latest` does not ship zsh. `spawnSync`
returns no `stdout` when the interpreter is missing, so a missing shell surfaced as
`TypeError: Cannot read properties of undefined (reading 'trim')` inside a test helper.

The dependency is real, not incidental — ten scripts under `scripts/` carry a `#!/bin/zsh` shebang
(`gate.sh`, `integration.sh`, the worktree and heal predicates) and eight test files exercise them.
So the fix is to **install zsh on the runner**, not to skip those tests on Linux. A suite that
quietly drops eight files on the one machine nobody watches would be worse than no CI at all.

Two things worth keeping from this:

- **It is the first evidence that the laptop and CI disagree**, which is the whole argument for
  T191. Every prior green was on a machine that happens to have zsh because it is a Mac.
- **The second red was a test that named one machine.** With zsh installed, 444 of 445 files
  passed and the last was `scripts/gateLock.test.js` — a test *this programme wrote* — asserting
  `repoKey(process.cwd()) === repoKey('~/dev/shoresh')`. On a runner that path does
  not exist, so `repoKey` returned its no-git fallback and the comparison failed. A test for
  machine-independent behaviour had a developer's home directory baked into it, and **only a
  different machine could see that.** Now asserted between two directories of whatever repository is
  actually under test, plus an explicit test of the fallback.
- **A missing interpreter reports as a `TypeError` in a helper**, not as "zsh not found". Those
  eight helpers read `spawnSync(...).stdout` without checking `error` or `status`. Not fixed here
  (it would touch eight files owned by T168), but recorded: the next person to hit it should not
  have to rediscover that an undefined `stdout` means the shell is absent.

---

### 0.2 The runner is roughly twice as fast as the laptop

First green-path measurement, from the run that got as far as the suite:

| | Laptop (quiet, 4 cores) | `ubuntu-latest` |
|---|---:|---:|
| `test` step | 702.1s | **339.2s** |
| Whole job | 788s (13m08s) | **~9 min** incl. checkout, install and a from-source native build |

So CI does not merely move the cost off the developer's machine, it roughly halves it — on a
machine that is doing nothing else. The §4 minute budget should be recomputed against ~9–10 min per
run rather than the ~20 min it assumed, which makes the per-PR policy considerably more comfortable
than estimated.

---

### What the workflow does

| Choice | Why |
|---|---|
| `ubuntu-latest` | The gate never needs Electron or a display (§3). Linux is the **1×** minute multiplier; macOS is 10× |
| `pull_request` + `push` to `main` | §4's budget: per-PR fits comfortably, per-push on every branch does not (~9,200 min/mo) |
| `node-version-file: .nvmrc` (25.8.1) | Node was unpinned — no `engines`, no `.nvmrc`. §7's first risk, now closed |
| `cache: npm` + `npm ci` | `better-sqlite3` is the one native dependency and may build from source |
| `concurrency`, cancel-in-progress except on `main` | Three pushes to a PR should not burn three full gates; every `main` commit's result is kept |
| `timeout-minutes: 45` | The gate is 13m08s locally (T188 §0.4); 45 gives headroom for a cold native build without burning an hour on a hang |
| Gate lock left **enabled** | A runner has no competing gate so it acquires instantly and costs nothing — and CI then exercises the same code path developers run, rather than a CI-only variant |

`npm run electron:build` is **not** run. Packaging is a separate concern and is the only thing that
would force a macOS runner.

---


**Spun out of T188.** T188 asked how to make the gate *cheaper*. This ticket is the question T188
did not ask: **where does the gate run?** The answer is "on the developer's own 4-core laptop,
always, with nothing scheduling it" — and that is a larger factor in felt slowness than any
per-step cost T188 measured.

Like T188, this proposes and does not implement. `test-infrastructure` carries a human gate, and
§5 below adds a **second** gate because this touches what counts as evidence.

---

## 1. The measurement that motivates it

2026-09-16, observed directly rather than inferred:

- **Three `node scripts/verify.js` processes ran concurrently** from three different worktrees
  (`gate-tiering-t188`, `vigilant-almeida-6c8ddc`, `sad-einstein-732a53`); a fourth
  (`frosty-bouman-ca6d90`) started minutes later. 1-minute load average **267** on 4 cores,
  thirteen vitest workers.
- A session that queued politely for a free slot **waited 20 minutes**, and two other gates started
  **within seconds** of its slot finally opening. Total wall time from queueing to abandoning:
  ~34 minutes, with no verdict.
- The gate is ~19.6 min alone (T188 §2). Under that contention, every concurrent run takes several
  times longer.

**Making one gate faster does not fix this.** Contention multiplies whatever the number is: a
17-minute gate run three-up is ~45+ minutes for everyone; an 8-minute gate run three-up is ~24. The
fixes in T188 raise the ceiling. They do not change the shape.

A machine-wide lock landed alongside this (`scripts/gateLock.js`) so concurrent runs serialise
instead of thrashing. **That is a mitigation, not a fix** — it makes the queue orderly, but the
queue still exists and it still runs on the machine the developer is trying to work on.

## 2. There is no CI, and there never has been

| Claim | Evidence |
|---|---|
| No CI configuration exists | `.github/` does not exist |
| It is not a deletion | `git log --all --diff-filter=A -- '.github/**'` returns **no commits** — it has never existed in this repository's history |
| There is a remote to run it on | `origin` = `git@github.com:gfeitel1-maker/Scheduling-Project-.git`, **private**, default branch `main` |

So every gate any session runs competes with the editor, the Electron app, and every other agent
session, on one 4-core / 8 GB machine.

## 3. The good news: the suite is already portable

This is the finding that makes the ticket cheap, and it was not obvious in advance. **Nothing in
the gate needs a Mac, a display, or a real device.**

| Potential blocker | Checked | Result |
|---|---|---|
| Tests needing Electron | `grep -rl "from 'electron'" --include='*.test.js'` | **0 files.** The whole suite runs under plain Node |
| Tests needing a display | jsdom only; no Electron renderer is launched | None |
| mDNS multicast (discovery is mDNS-only in production) | Only `electron/sync/automerge/discovery.test.js` mentions it, and it asserts the **wrapper's init options on a factory closure** — it never opens a socket | Not a blocker |
| Multi-process integration harness | `test/integration/harnessAutomerge.js` spawns **0** processes; it runs in-process libp2p nodes and connects with an explicit `node.dial(host.getMultiaddrs()[0])` — **direct dial, not discovery** | Not a blocker |
| Native modules | `better-sqlite3` only. `ensure-abi` targets Node for tests (`pretest`), and the Electron ABI is never needed by the gate | One build step |

**A standard Linux runner can run the entire gate.** That matters for cost: Linux is the 1×
minute multiplier, macOS is 10×. There is no reason to pay for macOS runners here.

## 4. Cost, on the numbers

GitHub-hosted Linux runners are 4 vCPU — comparable to the laptop, but **dedicated**: no editor, no
Electron app, no other agent sessions. So a CI run should land near T188's *quiet-machine* figure
(~19.6 min today, less once T188's remaining fixture conversions land), not the contended one.

Private repositories on the Free plan include 2,000 Actions minutes/month. Budget at ~20 min/run:

| Trigger policy | Runs/month (observed rates) | Minutes | Fits? |
|---|---:|---:|---|
| Every push on every branch | ~460 (107 commits in the last 7 days) | ~9,200 | **No** |
| **PR + push to `main`** | ~25–60 (25 recorded gate reports since mid-August) | ~500–1,200 | **Yes** |

**Recommendation: PR + `main` only.** That is also the honest matching of policy to purpose — the
gate is merge evidence, and merges happen per PR, not per commit.

Confidence: **high** on portability (each row in §3 was checked, not assumed); **medium** on the
minute budget, which depends on a run time not yet measured on a runner.

## 5. The part that is not a YAML file: what a CI result *means*

This is the real work, and it is why the ticket carries two human gates.

This repository has an unusually explicit evidence layer, and it currently assumes the gate runs
**locally**:

- `scripts/gate.sh` writes a stamped result file with a SHA, a `dirty` count, and a terminal `DONE`
  line, and `scripts/verifierReport.js` refuses anything else.
- The **Verifier** role (`CONSTITUTION.md` Art. VI) is "the only deterministic evidence source," and
  Art. VII makes its result non-averageable.
- `scripts/verify.js` downgrades a slow failure of a load-sensitive step to **INCONCLUSIVE** when
  the machine is oversubscribed (T178). **On a dedicated runner that logic is close to dead code** —
  and worse, it could launder a genuine CI failure if a runner is merely slow.

So the decisions the owner has to make are not "should we add a workflow file":

1. **Does a CI result count as Verifier evidence** — replacing the local run, supplementing it, or
   neither? Changing this edits `TESTING_STANDARD.md`, whose row's human gate is "any change to a
   constitution or standard."
2. **What produces the evidence artifact?** Either CI emits the `gate.sh` stamped format, or
   `verifierReport.js` learns a second accepted shape. The first is much less risky.
3. **What is the INCONCLUSIVE verdict's meaning on a runner?** It exists because a contended laptop
   produced meaningless reds. That premise does not hold on dedicated hardware.
4. **Does CI change local behaviour at all?** It should not remove the local gate as a pre-push
   option, and it does not remove the need for `gateLock.js` — local runs will continue.

## 6. Non-goals

- Not a deployment pipeline. No secrets, no publishing, no signing.
- Not a replacement for the local gate as a *developer* tool.
- Not a change to what the gate checks. `VERIFY_STEPS` is out of scope here; T188 owns that.
- Not an argument for per-commit CI — §4 shows it does not fit the budget and does not match what a
  gate is for.

## 7. Open risks to resolve before implementing

- **Node version is unpinned.** `package.json` declares no `engines`, and there is no `.nvmrc`.
  Local is **v25.8.1**. CI must pin a version, and pinning will expose whatever the suite silently
  depends on. Adding `engines`/`.nvmrc` is arguably worth doing regardless.
- **`better-sqlite3` on a Linux runner** may build from source (no `prebuilds/` directory is present
  in the local install), which needs a toolchain and adds minutes. Caching `node_modules` by
  lockfile hash is the usual answer; measure before assuming.
- **Timing-sensitive tests on shared runners.** The suite already carries a documented load-
  sensitivity problem (`testTimeout: 20000`, `asyncUtilTimeout: 3000`, both measured and justified).
  A runner is dedicated but not necessarily *fast*; the first CI runs should be watched for the
  same flake classes rather than assumed clean.
- **Private-repo minutes are billed to the owner's account.** The budget in §4 should be confirmed
  against the actual plan before enabling anything.

## 8. Definition of done

- [x] A workflow runs the full gate on pull requests and on push to `main`, on a Linux runner, with a pinned Node version — `.github/workflows/gate.yml`, `.nvmrc`.
- [x] Node is pinned, closing §7's first risk.
- [x] **Owner decision: does a CI result count as Verifier evidence?** Resolved — CI is the gate of record for *merging*; the local run stays the stamped Verifier artifact. Recorded in `TESTING_STANDARD.md` §1 and §0 above.
- [x] A gate run on a runner is measured and §4's budget corrected against it — **8m41s**, roughly half the laptop's 13m08s (§0.2). The budget assumed ~20 min/run, so per-PR CI is comfortably inside it.
- [x] The INCONCLUSIVE load-verdict's meaning on a runner is decided — see §8.1.
- [x] `npm run verify` is green.

### 8.1 INCONCLUSIVE on a runner — decided: leave it, do not special-case it

`scripts/verify.js` downgrades a *slow* failure of a *load-sensitive* step to INCONCLUSIVE when the
1-minute load average is at least 4× the core count. The worry was that this is near-dead code on
dedicated hardware and could launder a genuine CI failure.

**Decided: leave the logic exactly as it is, and do not add a CI-specific branch.** The T178 filters
already require *both* an oversubscribed machine *and* a failing step that ran ≥10s. A GitHub runner
that is genuinely thrashing badly enough to clear 4× its core count has produced a result nobody
should trust either — reporting that as INCONCLUSIVE is correct there for the same reason it is
correct locally, and INCONCLUSIVE still exits non-zero, so it never reads as a pass or merges
anything. Adding an `if (process.env.CI)` branch would mean the gate behaves differently on the
machine that matters most, which is a worse property than a rule that rarely fires.

## 9. Reproducing the §3 portability findings

```bash
grep -rl "from 'electron'" --include='*.test.js' src electron | wc -l   # 0
grep -rln 'mdns' --include='*.test.js' src electron test scripts        # 1 file, config-only
grep -cE 'spawn|fork' test/integration/harnessAutomerge.js              # 0
git log --all --diff-filter=A -- '.github/**'                           # empty: never existed
gh repo view --json visibility                                          # PRIVATE
```
