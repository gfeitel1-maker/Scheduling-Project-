---
title: T84-architecture-audit-event-trigger
document_type: ticket
status: completed
created: 2026-08-16
completed: 2026-08-16
completed_note: "Implemented in the external morning routine (~/.claude/projects/…/\_consolidation/integration.sh), NOT in this repo. Report-only audit-staleness block; dry-run verified on both the DUE (34 ADRs vs a stale base) and fresh (origin/main base, drift 5, no new ADR/surface) paths. Reads report list from origin/main so a stale worktree can't false-DUE."
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T82-mutation-envelope-and-eligibility-predicate.md]
related_adrs: []
related_specs: []
related_reports: [docs/work/architecture-reports/2026-08-16-architecture-audit-summary.md]
archive_when: "the morning integration routine emits an 'architecture audit DUE/fresh' line driven by the event heuristic below (new ADR since last audit, OR new screen/op surface, OR 30-commit / 30-day drift), REPORT-ONLY with the human as the gate; a dismiss/quiet path exists so a standing DUE isn't permanent noise; and this ticket is merged with owner sign-off"
---

# T84 — Event-based "architecture audit due" signal in the morning routine

**Sequencing: AFTER T82 merges.** Owner decision (2026-08-16): the architecture audit runs on an
EVENT, not a clock. This ticket wires that signal into the existing morning integration routine as a
report-only line. Confirmed by evidence: the 2026-08-03 audit went stale because the work got *done*
(C1–C5 all landed) across 341 commits — the bottleneck was never report frequency, so a cron would
manufacture noise. See the "should we schedule it" discussion and the 2026-08-16 audit reconciliation.

**Home of the change (CONFIRM FIRST):** the morning routine is the **06:30 launchd job**, whose script
lives in the **external agent-config worktree (`~/dev/shoresh-config`, nightly `run.sh`)**, NOT in this
repo. This ticket is therefore documentation-of-intent plus a change to that external script. The Maker
must locate the actual script and confirm before editing; if the routine has moved, update this ticket.

**Task class:** operational tooling (report-only shell/heuristic; no app code, no data). **Risk:** low —
it only prints a recommendation; it must never invoke the auditor, branch, or write a report.

## The locked trigger logic

Compute against `main`. Let the newest report in `docs/work/architecture-reports/` (by `date:`
frontmatter) define `BASE` = the commit that authored it.

Emit **AUDIT DUE** when ANY of:
- **(a) New accepted ADR** — a file added under `docs/adr/` since `BASE`. *Headline signal: a finished
  initiative lands an ADR.* This is the primary trigger the owner endorsed ("any big project that
  finishes is worth it").
- **(b) New surface** — a commit since `BASE` added a file under `src/screens/**` or `electron/ops/**`
  (new screen or new op = new surface). Backup to (a).
- **(c) Slow drift** — ≥ 30 structural commits since `BASE` (touching `src/screens/**`,
  `src/screens/schedule/**`, `src/data/**`, `electron/ops/**`, `electron/sync/**`, `src/engine/**`,
  excluding merges / `docs/**` / test-only diffs) OR the last report is > 30 days old.

Otherwise emit **audit fresh** with a one-line count.

## Report line (report-only, human-gated)

```
🏛  Architecture audit: DUE — new ADR since 2026-08-16 audit (2026-09-02-seasons-as-containers.md).
    → Run when ready: invoke the architecture-auditor agent. (This routine does not run it for you.)
```
or:
```
🏛  Architecture audit: fresh — 12 structural commits since 2026-08-16, no new ADR/surface.
```

## Success predicate (observable)

1. The morning report prints exactly one `🏛 Architecture audit:` line each run, DUE or fresh, with the
   evidence (which trigger fired, which files).
2. It is **report-only**: grep the script — it must not call the auditor, `git checkout`/branch, or write
   under `docs/work/architecture-reports/`. Mirrors the routine's existing "NEVER merges/rebases" rule.
3. A **dismiss/quiet path** exists so a standing DUE isn't permanent noise — e.g. a marker the owner sets
   ("acknowledged for this BASE") that suppresses the line until the next trigger fires. (Design choice
   open to Maker; the requirement is that DUE can't nag forever after the owner has seen it.)
4. Thresholds (30 commits / 30 days) are named constants at the top of the block, easy to retune.

## Non-goals

- No cron/interval scheduling of the audit itself — the trigger is the event, the human is the gate.
- No auto-invocation, no auto-PR, no report generation by the routine.
- No change to the rest of the morning routine's existing checks.
