---
title: "Typed run records and a compiled work index — design"
document_type: spec
status: draft
created: 2026-07-30
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: []
related_specs: []
requires_adr: false
archive_when: superseded by an approved implementation plan
---

# Typed run records and a compiled work index — design

**Status: draft for product-owner approval.** This is governance and tooling only. It adds no
product behaviour, changes no schema, and touches no code under `src/` or `electron/`.

---

## 1. The problem

This repository has produced, in about five days, 22 tickets, 11 ADRs, 8 specs, and 2 task-state
files. Every one of those documents already declares its own edges in frontmatter —
`governing_docs`, `related_adrs`, `related_tickets`, `related_specs`, `affects`, `resolved_by`,
`supersedes`, `parent_spec`.

**Nothing reads them.** The graph is written down and never traversed. Consequences observed today:

- Edges are one-directional. `T21` names its ADR; the ADR does not name `T21`. Asking "what did
  this ADR come from" means grepping.
- There is no way to ask "what is still open", "which ADRs are `implementation_state:
  not-started`", or "which tickets have no owning spec" without reading 43 files.
- Dangling references are invisible. `GOVERNANCE_INDEX.md` states that a broken link in it is a
  defect in the index — but nothing checks that claim, here or anywhere else.
- Only 2 of the many routed tasks left a task-state record, and the two that exist disagree on
  shape. The routing decisions for everything else — which agents ran, which were omitted and why,
  what evidence closed it — live only in expired chat transcripts.

The second problem is the expensive one. It is the difference between knowledge that accumulates
and knowledge that evaporates.

## 2. Success predicate

The work is done when all of the following are true:

1. `docs/governance/standards/WORK_RECORD_STANDARD.md` exists and defines a required frontmatter
   schema for run records, tickets, specs, and ADRs.
2. Every routed task writes `docs/work/runs/YYYY-MM-DD-<slug>.md` from
   `docs/work/runs/TEMPLATE.md`, **before dispatch**, with typed frontmatter conforming to that
   standard.
3. `npm run index:work` regenerates `docs/work/INDEX.md` from frontmatter alone, is deterministic
   (running it twice produces a byte-identical file), and never requires hand-editing.
4. `npm run check:governance` reports when: any frontmatter reference points at a non-existent
   path; any required field is missing or holds a value outside its enum; or `docs/work/INDEX.md`
   is stale relative to the sources.
5. `npm run verify` exists — this repository has no such script today — and runs
   `lint`, `test`, and `check:governance`.
6. The 43 existing documents are backfilled to conform, and `INDEX.md` shows their real edges.

### 2.1 Staging: abandoned, and why

This section planned a warn-only period while a backfill waited on open branches. **It was not
needed and the plan was wrong** — see §5.1. All six predicates landed together and
`check:governance` is blocking.

## 3. Non-goals

- **Not** porting the loop to LangGraph or any graph-execution library. Routing here is judgement
  over a change's meaning, not a mechanical function of file paths, and encoding it as executable
  edges would either lose the judgement or hide an LLM call behind a `route()` function with worse
  traceability than a markdown record.
- **Not** parallelising agent dispatch. Dispatch stays foreground and synchronous.
- **Not** replacing prose. Frontmatter is added *alongside* the narrative sections, never instead
  of them. The reasoning in a record is the asset; the fields only make it findable.
- **Not** a search index, embeddings, or a vector store.
- **Not** touching `docs/archive/**` beyond ensuring the checker ignores it.

## 4. Design

### 4.1 The run record

Adopt `docs/work/task-state/2026-07-26-manual-grid-editing-state.md`'s frontmatter as the standard
— it already has the right fields — and move the directory to `docs/work/runs/` to match what the
record is (a trace of one dispatch), not when it was written.

```yaml
---
task: T22 — record the author on every op
document_type: run
date: 2026-07-30
round: 1                      # 1 | 2 — round 2 is a RETRY; there is no round 3
status: in-progress           # in-progress | pass | retry | escalated | abandoned
task_class: database-sync     # must be a row in GOVERNANCE_INDEX.md §3–8
governing_docs: [...]         # paths, checked to exist
related_tickets: [...]
related_adrs: [...]
related_specs: [...]
selected_agents: [maker, verifier, code-reviewer, security]
omitted_agents:
  - agent: designer
    reason: no-ui-surface     # no-predicate | not-applicable | human-waived
deterministic_checks: [test, lint, build, integration]
human_gates: []
verdict: null                 # null | pass | fail | unverified — Verifier only
completion_evidence: []       # paths or command output refs; empty until verdict is set
archive_when: plan complete
---
```

Two rules carry over from `Mobile-Prototype-org`'s routing graph, and they are the ones that make
the record worth writing:

- **The record is written before dispatch**, so an abandoned run still shows what was intended.
- **`omitted_agents` requires a reason from the enum.** "Seemed unnecessary" is not a reason. An
  omission with no entry is a checker failure, not a silent gap.

### 4.2 The compiled index

`scripts/build-work-index.js` walks `docs/adr/**`, `docs/work/{tickets,specs,runs}/**`, parses
frontmatter only (never body text), and emits `docs/work/INDEX.md` containing:

- **Open work** — tickets with `status: open`, grouped by `task_class`, each showing its specs,
  ADRs and runs.
- **Decisions** — ADRs by status and `implementation_state`, each with an **inverted** edge list:
  the tickets, specs and runs that reference it. This is the backlink layer that does not exist
  today.
- **Orphans** — documents nothing references and that reference nothing. Usually a real defect.
- **Dangling** — every reference whose target file does not exist.

Sort order is lexical by path throughout, so the output is stable and diffs are readable.

### 4.3 The checker

`scripts/check-governance.js` — same name and role as the one already working in the
`Mobile-Prototype-org` repo, so the two stay recognisably the same system. It validates the
frontmatter schema, resolves every reference, and re-runs the index builder into memory to compare
against the committed `INDEX.md`. Stale index is a failure, which is what keeps the file honest
without anyone remembering to regenerate it.

## 5. Tasks

Each is one routed run under the existing loop. A task must PASS before the next is dispatched.

| # | Task | Deliverable | Gate |
|---|---|---|---|
| 1 | Write `WORK_RECORD_STANDARD.md`; register it in `GOVERNANCE_INDEX.md` §3–8 | The standard + index row | link check by hand; **human gate — it is a standard** |
| 2 | Add `docs/work/runs/TEMPLATE.md`; move the 2 `task-state/` files to `runs/`, conform them | Template + 2 migrated records | `git mv` preserves history |
| 3 | `scripts/build-work-index.js` + `npm run index:work` | Generated `INDEX.md` | unit tests on a fixture doc set; determinism test (run twice, compare bytes) |
| 4 | `scripts/check-governance.js` + `npm run check:governance` | Checker | unit tests: missing field, bad enum, dangling ref, stale index each fail |
| 5 | Add `npm run verify` = `lint` + `test` + `check:governance`, warn-only | Updated `package.json` | `npm run verify` exits 0 |
| 6 | **Deferred — see §5.1.** Backfill the 43 documents; flip the checker to blocking | Clean checker run | `npm run verify` exits 0 with `CHECK_GOVERNANCE_STRICT=1` |

Tasks 3 and 4 are the only ones with real logic and both are pure functions over parsed
frontmatter — test-first, per `TESTING_STANDARD.md`.

### 5.1 The deferral was wrong, and this is what it got wrong

This section originally deferred task 6, on the grounds that **five branches with open `docs/`
edits** would each take a header conflict from the backfill. That was based on
`git diff --name-only main..<branch>`, which compares two trees. Most of those branches were
*behind* main, not ahead of it, so what looked like their pending edits was main's own history
reflected back.

The true state, from `git branch --no-merged main`:

| Branch | Commits ahead of main | `docs/` files genuinely pending |
|---|---|---|
| `docs/ux-specs-from-oss-research` | 3 | 5 (sidebar specs, a handoff) |
| `feat/delete-used-records` | 4 | 2 (T21 + its ADR) |
| `fix/t22-op-author` | 1 | 1 (T22) |
| `backup/wip-2026-07-27` | 1 | 0 — a backup, 86 behind |

Everything else was already merged. **None of the three defects the backfill had to fix lived in
any of those files**, so the conflict the deferral was protecting against did not exist. Task 6 ran
with the rest, and `check:governance` is blocking as of this commit.

**The lesson is about the tool, not the branches.** `main..branch` and `main...branch` answer
different questions, and reading the two-dot form as "what this branch is holding" overstates it
every time the branch is behind. Use `git branch --no-merged` to ask what is actually outstanding.

### 5.2 What is still outstanding

`feat/delete-used-records` sets T21 to `status: resolved`, which is not in the ticket enum — the
repository's word is `completed`. **Merging that branch will fail `check:governance` until that one
word changes.** That is the gate working as intended, and it is a one-word fix in that branch, not
a reason to widen the enum.

The other two branches' documents have never been validated; they may surface findings on merge.

## 6. What this costs

- **Ceremony per task.** ~15 lines of frontmatter on every routed run. For a one-person repo that
  is a real tax, and it is only worth paying because the loop already dispatches 4–6 agents per
  task whose decisions currently vanish.
- **A pull toward enum-thinking.** The risk is that records degrade into filled-in fields with no
  prose. Mitigation: the standard states explicitly that a record whose narrative sections are
  empty is incomplete regardless of frontmatter validity, and the checker cannot detect this — it
  is a Code Reviewer responsibility.
- **A new failure mode.** `check:governance` will fail builds for documentation defects. That is
  intended, and it is why task 6 is last: the checker must be green before it becomes blocking.

## 7. Open questions for the product owner

1. **Retrofit depth.** Task 5 backfills frontmatter. It does *not* reconstruct run records for the
   ~20 tasks already completed without one — that history is gone and inventing it would be
   fabricated provenance. Confirm that starting the run-record discipline from today, with no
   backfill of past dispatches, is acceptable.
2. **`Mobile-Prototype-org`.** That repo has the routing graph and run records but no index or
   backlinks; this one will have the reverse. Should the two converge on one standard now, or
   should this land here first and be ported once it has proven itself? Recommendation: land here
   first — this is the live project, and porting an unproven standard doubles the cost of getting
   it wrong.
