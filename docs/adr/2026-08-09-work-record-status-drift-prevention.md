---
title: "Work-record status drift prevention"
document_type: adr
authority: normative
status: accepted
date: 2026-08-09
supersedes: []
implementation_state: not-started
affects: [docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md, scripts/check-governance.js]
related_tickets: []
related_adrs: []
---

# Work-record status drift prevention

**Status:** accepted

## Context

`docs/work/handoffs/2026-08-09-doc-staleness-remediation-handoff.md` documents a remediation that
corrected 13 ADRs, 4 tickets, and `PLATFORM_STATE.md`, all of which described merged work as
`proposed` / `open` / `not_started`. The audit's root-cause finding, verified against git history,
is structural, not clerical: **a merge does not touch the frontmatter of the ticket or ADR it
closes.** Status lives in the file; the file is not part of the change that makes the status true.
`docs/work/INDEX.md` is a generated downstream view of that same frontmatter, so it inherits the
staleness rather than causing it.

Two pieces of enforcement machinery already exist and already partially cover this class of defect:

- `scripts/check-governance.js` validates every work document's frontmatter against
  `WORK_RECORD_STANDARD.md` (required fields, status enum, dangling references) and is wired into
  `npm run verify` as a **blocking** check.
- `checkIndexFreshness()` in that same script already fails the build if `docs/work/INDEX.md` does
  not match `npm run index:work`'s regenerated output. **The "INDEX is stale" half of the audit's
  recommendation #2 is already built and already blocking** — it was not what let this batch of
  drift through. `INDEX.md` was stale in this audit *because* the frontmatter it's built from was
  stale, and nothing had regenerated it since. A push-time freshness check on the index would have
  caught that specific symptom, but not the root cause: an ADR or ticket can sit at `proposed`
  indefinitely, `INDEX.md` faithfully reporting `proposed`, and the check passes every time because
  reported-stale and factually-wrong are different properties. Nothing in the current gate reads a
  commit message and asks "does this commit's own claim about what it closes match the frontmatter
  it's shipping."

That gap — commit-claims-close vs. frontmatter-says-open — is the one this ADR closes.

## Candidate approaches considered

1. **Commit-message-driven status gate, extending `check-governance.js`.** Parse `closes T##` /
   `Merge S##` tokens out of commits since `origin/main`; for each ticket/ADR named, require its
   frontmatter status to already reflect closure in the working tree. Reuses the existing blocking
   checker and its CI wiring. Rejected initially for coupling doc validation to git log parsing —
   accepted anyway because the alternative (below) is strictly worse and this repo already treats
   `check-governance.js` as the place structural doc rules live.
2. **A separate `check:doc-drift` script/CI job.** Same logic, new entry point. Rejected: doubles
   the number of gates a Maker has to know about and satisfy, for a check that is a natural
   extension of an existing one (both read frontmatter, both fail `npm run verify`). The audit
   handoff itself says "prefer extending existing governance-check machinery."
3. **Process-only fix: checklist item on Verifier/Code-Reviewer, no new automation.** Cheapest to
   build, but this is exactly the failure mode already observed — Article VII's agent-omission
   requirement existed as a written obligation since 2026-07-28 and "has been honoured in exactly
   one file" per `WORK_RECORD_STANDARD.md`'s own text. A prose obligation with no check is not a
   structural fix; the audit explicitly asked for one. Rejected as insufficient on its own, retained
   as a necessary complement (see Decision, part 1) because the gate in part 2 cannot write the
   *content* of a status change, only detect its absence.
4. **Git pre-commit hook instead of CI gate.** Rejected: the status flip and the code that closes a
   ticket routinely land in separate commits within one branch (see `git log`: `feat(S5b)...` then
   `Merge S5b...(closes T75)` as two commits). A pre-commit hook evaluated per-commit would false-
   positive on the intermediate commit. The predicate is only meaningful evaluated against the
   branch's cumulative diff at merge/push time, which is what CI sees and a single commit does not.

## Decision

Three changes, addressing the audit's three recommendations. Recommendation 3 (PLATFORM_STATE
by-reference) is **descoped to non-goal** — see below — after checking it against the actual file
structure; it is not a comparable fix to the other two and should not be built as part of this
program.

### 1. Merge-time status flip is part of "done" (process contract)

Add to `docs/governance/standards/WORK_RECORD_STANDARD.md` §3 (`status` by document type), as a new
subsection immediately following it:

> **A ticket or ADR closes in the same change that closes it.** If a commit message references a
> ticket or ADR (`closes T##`, `Merge S##`, or an equivalent the team adopts), the frontmatter
> `status` (and, for ADRs, `implementation_state`) of every document so referenced must already
> read as closed in that same commit or an earlier one on the same branch. A merge commit is not
> the place to discover the status is still wrong — `scripts/check-governance.js` enforces this
> automatically (see Recommendation 2) and blocks `npm run verify` when it isn't true.

This belongs in **`WORK_RECORD_STANDARD.md`**, not only the Verifier/Code-Reviewer checklist,
because it's a property of the document schema's lifecycle (when a `status` value is allowed to
still be `open`), which is this standard's stated ownership per its own §1. Verifier already runs
`npm run verify` as a blocking gate (see `GOVERNANCE_INDEX.md` §3–8, "Deterministic checks"), so no
separate checklist entry is needed once part 2 lands — the standard states the rule, the checker
enforces it, Verifier's existing "run verify" step is the enforcement point. Code Reviewer's
existing rule-6 responsibility (prose completeness) is untouched.

### 2. Automated status-drift gate — extend `check-governance.js`

Add a new check, `checkStatusDrift`, alongside the existing `checkAll`/`checkIndexFreshness` in
`scripts/check-governance.js`. It runs as part of the same `npm run check:governance` invocation
(no new npm script, no new CI job — it fails the existing blocking gate).

**What it inspects:**
- Commits reachable from `HEAD` but not from `origin/main` (`git log origin/main..HEAD
  --format=%s`), i.e. the branch's own commits — mirrors how the existing repo already writes
  `closes T##` / `Merge S##` in commit subjects (confirmed against `git log`: `b71152b
  feat(S5b)...before commit` / `89e708a Merge S5b:...(closes T75)`).
- A reference pattern: `(?:closes|Merge)\s+([ST]\d+)` (case-insensitive on the keyword), extracting
  ticket IDs (`T\d+`) and slice/spec IDs (`S\d+`) — matching the two forms already in use.
- For each extracted ID, resolve it to a work document by filename prefix under
  `docs/work/tickets/` (`T##`) or `docs/adr/`/`docs/work/specs/` (`S##`, since slices are recorded
  as ADRs or specs in this repo, not a distinct type) — reuse `readDocs()`'s existing document set,
  do not re-walk the filesystem.
- Read that document's **current working-tree frontmatter** (not the state at the referencing
  commit — the predicate is "is it fixed *now*", so a later commit on the branch correcting an
  earlier commit's status is fine).

**Pass/fail predicate:**
- **Ticket** (`T##`): fails if `status` is not in `{completed, wont-fix}` (per the existing enum in
  `STATUS_BY_TYPE.ticket` — `open`, `in-progress`, `parked` all fail).
- **ADR/spec** (`S##`): fails if `status` is `proposed`/`draft` or `implementation_state` is
  `not-started` — i.e., the same test the 2026-08-09 audit applied by hand.
- Unresolvable ID (referenced in a commit message but no matching document exists on disk) is a
  **separate finding** (`status-drift-unresolvable-reference`), not a silent pass — this is the
  same failure class as the audit's Batch B item 4 (T70 collision/duplicate), and staying silent on
  it would recreate exactly that kind of drift.
- This check only evaluates commits **ahead of `origin/main`**. It intentionally does not walk all
  of history — that would re-flag every historical commit that referenced a ticket before this ADR
  existed, which is not the failure this gate is for. It is a going-forward gate, matching how
  `checkIndexFreshness` is already going-forward (checks the working tree, not history).

**Where it runs:** inside `checkAll()`, gated behind a working directory that is a git repo with an
`origin/main` to diff against (guard with a try/catch around the `git log` call so it degrades to
a no-op finding-free pass in environments without that remote — e.g. a fresh clone or CI checkout
without the base ref fetched — rather than crashing `npm run verify` outright). This keeps it inside
the existing blocking pipeline (`npm run verify` → `check:governance`) rather than inventing a
second CI job, per the audit handoff's own preference and per candidate #2 above being rejected.

**Test-first seam:** `scripts/check-governance.test.js` (extending the existing test file pattern
visible in `scripts/build-work-index.test.js`) should inject both `execFn` (for `git log`) and
`readDocs`, mirroring how `checkDoc` already takes an injected `exists` — this is a Maker-level
implementation detail, not a further architectural decision, but the seam is specified here so
Maker doesn't have to invent the test double shape.

### 3. PLATFORM_STATE by-reference generation — descoped

Assessed against the actual file (`docs/current/PLATFORM_STATE.md`, 247 lines) and the existing
`update-state` skill: **do not build generation/citation tooling for this.** Three reasons:

- `PLATFORM_STATE.md` is prose — architecture narrative, auth flow description, IPC surface
  documentation — not a table of facts with a single source. The audit's own root-cause finding
  was explicit that **no data-model-*shape* drift was found**; the only defects were the schema
  version number appearing three times and a landing-screen claim. Building a generation pipeline
  to solve a three-line problem is the over-engineering `karpathy-guidelines` warns against — it
  would be a new artifact this project has to maintain forever, to save re-typing one number.
  Same for the "SCREENS map" `PLATFORM_STATE.md` doc calls the screen table.
- The existing `update-state` skill (`~/.claude/skills/update-state/SKILL.md`) already performs
  the correct fix by process: it rewrites `PLATFORM_STATE.md` from a fresh read of the current
  codebase (`git log`, `ls src/screens/`, etc.) and is meant to run "at the end of any session
  where structural things changed." The audit's own recommendation 3 already names this skill as
  the candidate mechanism — it doesn't need a new one built alongside it.
- What's genuinely missing is not tooling but **inclusion in the definition of done**: nothing
  currently *requires* `/update-state` to run as part of closing a structural ticket/ADR, the same
  way nothing required a frontmatter status flip. That is a process gap, not a generation-feasibility
  gap, and it is closed the same way as part 1: add one line to `WORK_RECORD_STANDARD.md` (or
  `GOVERNANCE_INDEX.md` §3–8's Architecture row, "current-state reference: `PLATFORM_STATE.md`")
  stating that a structural change's closing commit is not done until `/update-state` has been run
  since. This is **not independently CI-enforceable** — there is no deterministic test for "is this
  prose still accurate" — so it stays a checklist/process item, not a new script. That is an honest
  limit, not a gap in the design: recommendation 1 and 2 are deterministic gates; recommendation 3
  is, and remains, process discipline.

## Consequences

- **Highest-leverage of the three:** recommendation 2 (the status-drift gate). It's the only one of
  the three that is fully deterministic, catches the exact defect class the audit found (13 ADRs +
  4 tickets, ~90% of the audit's volume), and requires no ongoing human discipline to keep working.
- Recommendation 1 is necessary scaffolding for recommendation 2 to have teeth (the standard has to
  say the rule exists before a checker enforcing it makes sense to a reader), but by itself, as the
  2026-07-28 Article VII precedent shows, a written-only obligation in this repo has a demonstrated
  failure rate of "followed in exactly one file."
  Ship 1 and 2 together, not 1 alone.
- Recommendation 3 is real but bounded: it converts one bullet in `WORK_RECORD_STANDARD.md`/
  `GOVERNANCE_INDEX.md` plus (optionally) making `/update-state` a named step in the Architecture
  task-class row. No script, no ADR-level schema change.
- New failure mode this introduces: a legitimate branch that references a ticket in a commit
  message for a reason other than closing it (e.g. "relates to T40, see also...") could false-
  positive if it happens to match `closes|Merge`. The regex is deliberately narrow (`closes` /
  `Merge S##`) to match only the two forms this repo's own history already uses, not any mention of
  a ticket ID — Maker should not widen it without a corresponding audit of what commit-message
  vocabulary is actually in use.
- This does not retroactively re-validate history; a future audit of the same shape as
  2026-08-09's is still possible if a ticket is referenced with vocabulary the regex doesn't catch,
  or if a document is renamed/moved without its old ID being re-resolved. This ADR does not attempt
  to make that class of drift structurally impossible, only to make the observed class (a plain
  `closes T##`/`Merge S##` reference left unflipped) fail CI going forward.

## Files/modules affected

- `docs/governance/standards/WORK_RECORD_STANDARD.md` — new subsection under §3 (part 1); one line
  in the Architecture task-class routing area or GOVERNANCE_INDEX.md §3–8 pointing at `/update-state`
  (part 3).
- `scripts/check-governance.js` — new `checkStatusDrift` function wired into `checkAll()`.
- `scripts/check-governance.test.js` — test coverage for the new check, injected `git log` and doc
  reads.
- No schema, no IPC, no data-shape change. No changes to `scripts/build-work-index.js` — the index
  generator is unaffected; only the checker gains a new predicate.

## ADR required: yes

This decision changes the contract of an existing checker other work already depends on passing
(`npm run verify`), and it's not obviously reversible in the sense that once Makers start relying on
the gate catching drift, removing it silently reintroduces exactly the failure this program fixed.
Filed at `docs/adr/2026-08-09-work-record-status-drift-prevention.md`.

## Open questions for Governor / product owner

1. **Regex vocabulary lock-in.** The `closes T##` / `Merge S##` pattern is inferred from this
   repo's actual commit history, not prescribed by any existing standard. Confirm this is the
   vocabulary to freeze, or whether `WORK_RECORD_STANDARD.md` should formally define it in the same
   change (recommended: yes, define it there so the regex has a normative source instead of being
   inferred from git log a second time by whoever reads the script later).
2. **Unresolvable-reference severity.** The design treats a commit that says `closes T99` where
   `T99` doesn't exist as a blocking finding, same severity as a real drift. Confirm that's the
   intended failure mode rather than a warning — it's a stricter bar than the audit asked for, but
   it's the same shape of defect as the T70 duplicate/collision the audit already found by hand.
3. **Sequencing.** This ADR should land and be built as its own ticket-sized Maker slice (test-first
   on `checkStatusDrift`), separate from any future feature work — recommend Governor open one
   ticket covering parts 1+2 together (they ship as a pair per Consequences) and, if the product
   owner wants part 3's process line at all, a second, much smaller ticket for the
   `WORK_RECORD_STANDARD.md`/`GOVERNANCE_INDEX.md` one-liner.
