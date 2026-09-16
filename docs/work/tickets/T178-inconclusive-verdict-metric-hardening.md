---
title: "The INCONCLUSIVE load verdict keys on raw loadavg, which macOS inflates — harden the metric"
document_type: ticket
status: open
created: 2026-09-15
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: the INCONCLUSIVE verdict fires on genuine CPU starvation but not on a machine that is merely I/O-busy or idle-but-high-loadavg, and the load figure is recorded next to the step duration
---

# T178 — Harden the INCONCLUSIVE verdict's metric

Follow-up to T164 (shipped in #429). `scripts/verify.js` `machineLoadVerdict(load1, cores)` reports a
failed step as INCONCLUSIVE when the 1-minute load average is ≥ 4× the core count. That was the right
shape (a third answer between pass and fail), and it already proved itself — it caught a real lint
error downstream when a peer's rebased gate went INCONCLUSIVE and forced an isolated re-run.

## The problem, measured

**macOS `loadavg` counts uninterruptible I/O wait, not just runnable threads, so it is wildly
inflated.** A peer measured **load 252 on a 4-core box with NO test process running at all** — the
floor came from unrelated apps (a second coding agent, WindowServer). Under that floor, a raw-loadavg
4× trigger fires on essentially *every* failed run, whether or not CPU is the actual bottleneck.

A verdict that is INCONCLUSIVE almost all the time decays into noise people click past — which is
exactly the failure mode the whole T171/T174/T164 family exists to prevent (the blank summary column
and the always-zero exit code survived because nobody read them). An over-firing INCONCLUSIVE is the
same disease.

## Directions (none chosen)

1. **Key on the step's own duration vs a recorded baseline**, not raw loadavg — a step that normally
   takes 20s taking 200s is a far less jumpy "the machine was slow" signal than a loadavg number that
   is high while idle. Needs a per-step baseline store.
2. **Key on available CPU / run-queue length** rather than the I/O-inflated loadavg, if a portable
   reading is available.
3. **Record the load figure next to the duration regardless** (the peer's point, and #429 already
   reads `os.loadavg()` at verdict time) — the only way to tell "slow because of our own concurrent
   run" from "slow because the box is busy" after the fact, and a prerequisite for calibrating any
   threshold from real data instead of a guess.

## Not urgent

The shipped verdict is a net improvement and never masks a real red (INCONCLUSIVE is non-zero). This
is about keeping it from decaying into noise on chronically-loaded boxes. Direction 3 is cheap and
should probably land first so the threshold can be tuned on evidence.
