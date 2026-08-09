---
title: "Agent-quality track (Project B) — wasted-agent-work baseline measurement"
document_type: exploration
authority: informative
date: 2026-08-09
status: complete
related_adr: docs/adr/2026-08-09-agent-quality-waste-metric-and-quality-floor.md
---

# Agent-quality track (Project B) — wasted-agent-work baseline measurement

## 0. What this document is

The first execution of the measurement protocol in
`docs/work/specs/2026-08-09-wasted-agent-work-measurement-spec.md`, run against the existing
`docs/work/runs/` corpus, per
`docs/work/handoffs/2026-08-09-agent-quality-cut-wasted-work-brief.md` §3.3. It records the
per-record coding, the totals over the slice actually examined, and the honesty caveats the
corpus demands before any of it is read as a trend.

---

## 1. Corpus verification and corrections

`ls docs/work/runs/` returns:

```
2026-07-26-manual-grid-editing-run.md
2026-07-30-typed-run-records-and-work-index.md
2026-08-01-t28-schedule-persistence-seam-run.md
2026-08-01-t29-schedule-grid-geometry-run.md
2026-08-01-t30-schedule-feature-hooks-run.md
2026-08-01-t31-schedule-route-state-run.md
2026-08-01-t32-schedule-slot-mutations-run.md
2026-08-04-r5-conformance-summary.md
2026-08-08-t69-engine-id-list-purity.md
2026-08-09-status-drift-gate.md
TEMPLATE.md
```

**n = 10 real records**, not 11. `TEMPLATE.md` is a blank form (excluded from the corpus for the
same reason `check-governance.js` excludes it from validation — a template's placeholder fields
are not a work record). An earlier framing of this track said "~11 records"; that count included
the template. Corrected here and in the ADR.

**All ten spans roughly two weeks** (2026-07-26 to 2026-08-09), **written by a single author**
(the same product owner + agent stack this evaluation is itself scoring), a bias carried through
every finding below without exception.

---

## 2. Baseline measurement — per-record coding

| Record | W1 | W2 | W3 | W4 | W5 | Notes |
|---|---|---|---|---|---|---|
| `2026-07-26-manual-grid-editing-run.md` | **×1** | — | — | — | — | Migrated-from-legacy record; `verdict`/`completion_evidence` explicitly left null/empty rather than asserted without evidence (a *correctly avoided* W4-adjacent trap, not an instance). The record's frontmatter lists `grader` in `selected_agents` while its own prose routing table marks Grader **skipped** — a frontmatter/prose contradiction, documented independently in `docs/work/runs/2026-07-30-typed-run-records-and-work-index.md`'s "Also found, and not fixed" section. Recoded as W1×1 (state-disclosure gap), not W4 — see §3. |
| `2026-07-30-typed-run-records-and-work-index.md` | — | **×2** | — | — | — | Branch-drift (HEAD switched mid-run to a different branch by a background rebase) + `better-sqlite3` ABI mismatch (395→9 failures after a wrong-target rebuild). Two independent environment-state causes in one record. |
| `2026-08-01-t28-*` through `2026-08-01-t31-*` | — | — | — | — | — | **UNEXAMINED this cycle** — see §4. Not "zero waste confirmed." |
| `2026-08-01-t32-schedule-slot-mutations-run.md` | **×1** | — | — | — | — | Round 1: Maker hit an external usage-limit crash mid-verification; Governor had to inspect the working tree directly to determine the hook + rewire were complete, ran the gates Maker didn't reach, and applied a small disclosed fix itself. Round 2 was Maker(test-only) + Verifier + Grader **only** — Red Hat and Code Reviewer did not re-run (production code was byte-identical between rounds), correcting an earlier misreading of this record as "the full gate stack re-ran." |
| `2026-08-04-r5-conformance-summary.md` | — | — | — | — | — | **UNEXAMINED this cycle** — see §4. |
| `2026-08-08-t69-engine-id-list-purity.md` | — | — | **×1** | — | **×1** (tracked) | Round-2 suite runs contaminated by a concurrent vitest at load average >400 in another worktree; the record itself has to "explain away" its own red suite (Grader's own words, quoted below) — coded W3, the retry-round cost. Separately, a DEV-only shape-assertion gap was identified as a credible near-miss and deliberately **not** treated as an occurred defect — carried to ticket T78 instead, coded W5 (tracked, not counted). |
| `2026-08-09-status-drift-gate.md` | — | — | — | — | — | **UNEXAMINED this cycle** — see §4. |

**Recoded: manual-grid-editing's frontmatter/prose contradiction is W1, not W4.** The record's
frontmatter lists `grader` in `selected_agents`; its own prose routing table marks Grader
**skipped**. This is exactly the pattern already documented, independently, in
`docs/work/runs/2026-07-30-typed-run-records-and-work-index.md`'s "Also found, and not fixed"
section: "frontmatter and prose disagreeing is exactly what no checker can catch." That is a
record failing to give an accurate account of what happened via its own turn-ending state — the
W1 definition (state-disclosure gap), not W4 (hand-re-derived fact): nobody had to re-derive a
fact that lived elsewhere in the corpus; the record simply disagrees with itself about what it
did. **The earlier framing of this instance was unsupported and is corrected here.** It previously
claimed "downstream corpus references (the 2026-07-30 record's migration note) treat T1–T5 as
'Done'" — a grep of `docs/work/runs/2026-07-30-typed-run-records-and-work-index.md` does not
support that claim; no such statement exists in that record. That fabricated claim is removed. The
"other grounds" this instance was originally promised on turn out to be the frontmatter/prose
contradiction itself, which is better read as a W1 instance than a W4 one.

**Consequence: W4 has zero clean instances in the examined corpus.** With this recode, W4 (hand
re-derivation) has no supported instance in the four examined records. The one candidate that had
been coded W4 is better read as a record-consistency, W1-adjacent gap, and is recoded as such
above. This does not change the ADR's decision to decline a W4 edit — it stays declined, now on
firmer ground: not "one thin instance," but no instance at all.

**Recurrences noted, not double-counted:** the ABI-rebuild trap (Node vs. Electron
`better-sqlite3` target) and load-contaminated suite runs each appear in **two** separate records
(ABI: 2026-07-30 and, per `CLAUDE.md`'s own framing, a documented recurring hazard; load
contamination: 2026-08-08 and referenced again as a T44 evidence trail in that same record). These
are noted as *recurring* patterns — which is itself informative, since a one-off mistake and a
mistake that recurs across independent sessions are different findings — but each concrete
instance is counted once, against the record it actually occurred in, not once per mention.

---

## 3. Totals over the examined slice

Examined this cycle: 4 of 10 records (`2026-07-26`, `2026-07-30`, `2026-08-01-t32`,
`2026-08-08-t69`). The other 6 are reported as unexamined in §4, not as zero-waste.

| Category | Count | Rate (of 4 examined) |
|---|---|---|
| W1 — state-disclosure gap | 2 | 2/4 |
| W2 — un-preflighted environment drift | 2 | 2/4 |
| W3 — avoidable retry round | 1 | 1/4 |
| W4 — hand-re-derived fact | 0 | 0/4 — no clean instance; see §2's recode note |
| W5 — near-miss (tracked, not counted toward waste) | 1 (tracked) | not summed |

**These are not summed into one number.** Per the measurement spec, W1–W4 are reported per-
category, and W5 is reported separately and never folded into a headline total — a near-miss that
did not occur is not the same class of evidence as an occurrence.

---

## 4. Corpus honesty

- **n=10, ~2 weeks, single author.** Every count above is drawn from a corpus written by the same
  person and largely the same agent stack under evaluation. This is not an independent audit
  sample; it is closer to a self-report, and every conclusion below is qualified accordingly.
- **Survivorship bias.** Every examined record's `status` is `pass` (`2026-08-01-t32`,
  `2026-08-08-t69`) or heading toward pass. **No escalated or abandoned run record exists anywhere
  in the corpus.** This is an underdetermined finding, not a clean result: it says nothing about
  how this workflow behaves when a task actually fails badly, because no such record exists to
  examine. Any claim about failure-mode robustness would be unsupported and is not made here.
- **6 of 10 records are UNEXAMINED this cycle** (`2026-08-01-t28`, `t29`, `t30`, `t31`,
  `2026-08-04-r5-conformance-summary.md`, `2026-08-09-status-drift-gate.md`). They are reported as
  unexamined, not as contributing zero waste — a category with no coded instances in an unexamined
  record is silence, not evidence of absence. A future measurement pass should examine them before
  any claim is made about the full corpus's waste rate rather than the 4-record slice this cycle
  actually covers.
- **Round-count rejected as a primary proxy.** Per the ADR's Option-A scoring, raw round count is
  kept only as a cheap cross-check, never as the waste metric itself — a low round count says
  nothing about which agent's instructions caused (or avoided) waste.
- **Each single-instance category is below the bar for a rate/trend claim.** W3 (1 instance) and
  W5 (1 tracked instance) are each observed exactly once in the examined slice. One instance is
  evidence a pattern *can* occur; it is not evidence of a rate, and is explicitly not treated as
  grounds for an agent-definition edit in the ADR (evidence-vs-assertion discipline, brief §4:
  "this prompt could be tighter" is not evidence, and neither is a single instance dressed up as a
  pattern). W4 has **zero** clean instances in the examined slice — the one candidate originally
  coded W4 is recoded W1 above (record-consistency gap, not hand re-derivation) — so W4 is
  reported at 0/4, not 1/4. W1 (2 instances, Maker's Done Signal) and W2/W3 combined (Governor's
  Phase 6.5 pre-flight — W2 has 2 instances, and W3's single instance shares the same root cause
  and seam as W2) clear the bar the ADR treats as sufficient: **≥2 verified corpus instances** per
  edited seam.

---

## 5. Attribution table — waste pattern → agent-definition seam

| Pattern | Seam | Edit this cycle | Caveat |
|---|---|---|---|
| W1 (state-disclosure gap) | `.claude/agents/maker.md`, Done Signal section (Edit 1); `.claude/agents/governor.md`, Phase 5 (Edit 3) | **Yes** — Edit 1 adds `INTERRUPTED —` signal shape; Edit 3 requires Governor to independently re-verify an `INTERRUPTED` disclosure rather than trust it at face value | 2 instances: T32 round 1 (Maker, external hard kill — no live Maker turn to use the signal; Edit 1 is scoped as prophylactic for interruptions where Maker can still emit output, not a fix for T32's exact hard-kill mode — see ADR Edit 1 caveat) and manual-grid-editing's frontmatter/prose contradiction (recoded from W4 above). Structural-gap reasoning still applies for Edit 1's shape itself, but the T32 citation's reach is narrower than "this incident would have been prevented." |
| W2 / W3 (environment drift, avoidable retry) | `.claude/agents/governor.md`, Phase 6.5 pre-Verifier dispatch | **Yes** — adds environment-state pre-flight line | 2 W2 instances in one record + 1 W3 instance in a second, independent record — clears the ≥2-instance bar across two separate sessions, not one. |
| W4 (hand-re-derived fact) | No clean instance in the examined corpus | **Declined** — 0 clean instances; the one original candidate is recoded W1 above (record-consistency gap, not hand re-derivation) | Reported, not edited. Declined on firmer ground than originally stated. |
| W5 (near-miss) | Would be wherever the near-miss's underlying risk actually lives (T78, the DEV-only engine shape assertion) | **Declined / watch** — it is tracked as its own ticket (T78) rather than as an agent-definition edit, since it never actually occurred | Reported, not edited. |
| — | Designer | **No edit** — no waste instance in the examined slice implicates Designer; Designer was correctly omitted from most examined tasks per each record's own routing table | Consistent with the brief's "Designer if evidence warrants" — evidence does not, this cycle. |
| — | Architect | **No edit** — same reasoning; Architect's `no-predicate` omissions in the examined records (e.g. T69) read as correct routing calls, not waste | — |

---

## 6. Re-measurement

Not yet run. Per the measurement spec §3, re-measurement executes against the next 5 tasks
dispatched after the three edits land, coded by an independent re-measurer, floor-checked before any
rate comparison is reported. This document is the "before" half of that comparison.
