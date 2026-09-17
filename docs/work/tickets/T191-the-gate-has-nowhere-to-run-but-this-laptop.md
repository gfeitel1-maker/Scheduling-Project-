---
title: "The gate has nowhere to run but this laptop — there is no CI, and there never has been"
document_type: ticket
status: open
created: 2026-09-16
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
archive_when: "Either CI runs the gate on push to main and on pull requests and the repository has decided what status a CI result carries as evidence, or the owner has decided CI is not wanted and that decision is recorded with its reason"
---

# T191 — The gate has nowhere to run but this laptop

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

- [ ] The owner has decided whether CI is wanted, and the §5 evidence question is answered explicitly.
- [ ] If yes: a workflow runs the full gate on pull requests and on push to `main`, on a Linux runner, with a pinned Node version.
- [ ] A gate run on a runner is measured, and §4's minute budget is confirmed or corrected against it.
- [ ] `TESTING_STANDARD.md` states what status a CI result carries (human gate — it is a standard).
- [ ] The INCONCLUSIVE load-verdict's behaviour on a runner is decided, not inherited by accident.
- [ ] `npm run verify` is green.

## 9. Reproducing the §3 portability findings

```bash
grep -rl "from 'electron'" --include='*.test.js' src electron | wc -l   # 0
grep -rln 'mdns' --include='*.test.js' src electron test scripts        # 1 file, config-only
grep -cE 'spawn|fork' test/integration/harnessAutomerge.js              # 0
git log --all --diff-filter=A -- '.github/**'                           # empty: never existed
gh repo view --json visibility                                          # PRIVATE
```
