---
title: Work Record Standard
document_type: standard
authority: normative
status: active
applies_to: [workflow, agents, documentation]
supersedes: []
last_reviewed: 2026-07-30
review_trigger: any field added or removed from a record schema, any enum value changed, or any new document_type under docs/work/
---

# Work Record Standard

**What a work document must declare so that it can be found again.** This document is the single
owner of the frontmatter schema for run records, tickets, specs, and ADRs.
`scripts/check-governance.js` enforces it; `scripts/build-work-index.js` reads it.

This standard adds no new obligation about *how* work is done. `CONSTITUTION.md` Article VII
already requires Governor to record the agent selection **"including which agents were omitted and
why"**. That requirement has existed since 2026-07-28 and has been honoured in exactly one file.
What was missing was a shape, a location, and a check. This standard supplies all three.

---

## 1. Why frontmatter, and why it is not the document

Every work document in this repository already declares its edges — `governing_docs`,
`related_adrs`, `related_tickets`, `affects`, `supersedes`. Until now nothing read them, so the
graph was written down and never traversed.

**The prose is the asset. The frontmatter only makes it findable.** A record whose narrative
sections are empty is incomplete no matter how valid its fields are. The checker cannot detect
this, and it is not asked to; it is Code Reviewer's responsibility under rule 6.

Corollary: **never delete reasoning to satisfy a field.** If a value does not fit an enum, that is
a finding about the enum. Raise it under rule 8; do not round the truth to the nearest allowed
value.

---

## 2. Common fields

Every document under `docs/work/**` and `docs/adr/**` carries:

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Quote it if it contains a colon |
| `document_type` | enum | yes | `run` · `ticket` · `spec` · `adr` · `index` · `plan` · `handoff` · `reference` · `discovery` · `baseline-inventory` |
| `status` | enum | yes | See §3 — the allowed set depends on `document_type` |
| `created` or `date` | ISO date | yes | ADRs use `date`; everything else uses `created` |
| `archive_when` | string | yes, except ADRs and the two report types | Prose. The condition under which this leaves `docs/work/`. Not required on `adr`, `discovery`, or `baseline-inventory` — a decision record and a dated point-in-time report are archived by their program, not by a self-scheduled condition |

### Reference fields

Every value is a **repository-root-relative path**. The checker resolves each one and fails on any
target that does not exist.

| Field | Points at |
|---|---|
| `governing_docs` | The standards and constitution articles that govern this work |
| `related_tickets` | `docs/work/tickets/**` |
| `related_specs` | `docs/work/specs/**` |
| `related_adrs` | `docs/adr/**` |
| `related_runs` | `docs/work/runs/**` |
| `resolved_by` | **Not a doc-to-doc edge.** The commit SHA — or a repository path — that closed a ticket. It is not inverted into backlinks, and a SHA is not resolved against the filesystem |
| `supersedes` | ADRs only. The ADRs this one replaces |
| `affects` | ADRs only. What this decision constrains |
| `parent_spec` | A spec that this document elaborates |

**All reference fields are lists**, even with one element. A bare string is a checker failure —
this is the single most common malformation and it silently breaks the index builder.

**Declare edges in one direction only.** Point from the newer document to the older one: a ticket
names its ADR, a run names its ticket. The reverse edges are *generated* into `INDEX.md`. Writing
both directions by hand creates two sources of truth that drift.

---

## 3. `status` by document type

| `document_type` | Allowed `status` |
|---|---|
| `run` | `in-progress` · `pass` · `retry` · `escalated` · `abandoned` |
| `ticket` | `open` · `in-progress` · `completed` · `closed` · `parked` · `wont-fix` |
| `spec` | `draft` · `active` · `approved` · `implemented` · `superseded` |
| `reference` | `active` · `superseded` |
| `adr` | `proposed` · `accepted` · `superseded` · `rejected` |
| `plan` | `draft` · `approved` · `complete` · `abandoned` |
| `handoff` | `active` · `superseded` |
| `discovery` | `draft` · `active` · `complete` · `superseded` |
| `baseline-inventory` | `draft` · `active` · `complete` · `superseded` |

A **handoff** (`docs/work/handoffs/`) is not a routed task: it has no agents, gates, or verdict,
and it must not be typed as a `run`. It records what a new session needs that the repository
cannot tell it. A handoff describing a past state of `main` is `superseded`, not `complete` —
it is history, and `GOVERNANCE_INDEX.md` §9 applies.

**These are the words this repository already uses, not words chosen for it.** The first draft of
this table invented `resolved` for tickets and `approved` for specs. Running the checker showed 18
tickets saying `completed` and 7 specs saying `active` — so the table changed, not the documents.

That is not the same as loosening a rule to make a finding disappear. Where a value was a genuine
defect — a path that does not resolve, a bare string where a list is required — it is still
reported and still has to be fixed. The test is whether the corpus is expressing something true in
different words, or is simply wrong.

ADRs additionally require `authority` (`normative`) and `implementation_state`
(`not-started` · `in-progress` · `implemented`).

`implementation_state` is deliberately separate from `status`. An ADR can be `accepted` and
`not-started` for weeks — that gap is real, and collapsing the two fields would hide it.

### 3.1 A ticket or ADR closes in the same change that closes it

> A ticket or ADR closes in the same change that closes it. If a commit message references a
> ticket or ADR (`closes T##`, `Merge S##`, or an equivalent the team adopts), the frontmatter
> `status` (and, for ADRs, `implementation_state`) of every document so referenced must already
> read as closed in that same commit or an earlier one on the same branch. A merge commit is not
> the place to discover the status is still wrong — `scripts/check-governance.js` enforces this
> automatically and blocks `npm run verify` when it isn't true.

---

## 3.2 Completion references and the status-drift gate

`scripts/check-governance.js`'s `checkStatusDrift` enforces §3.1. This section is that check's
source of truth — the script derives its regex and resolution rules from the definitions below; if
the two ever disagree, this standard governs and the script is wrong.

**Vocabulary.** A completion reference is a keyword, whitespace, then an ID, found anywhere in a
commit subject:

- Keyword (case-insensitive): `closes` or `Merge`.
- ID: an optional `T` or `S` prefix followed by digits and an optional single lowercase suffix
  letter, e.g. `T76`, `S5b`.
- Regex: `/(?:closes|merge)\s+([TS]\d+[a-z]?)/gi`, applied per subject, collecting every match.
  **The regex is authoritative** — the prose above only describes it; the optional lowercase
  suffix letter applies to the whole `[TS]\d+` token, for both tickets and slices, not only
  slices.

This is deliberately narrow. A bare mention — `relates to T40, see also...` — has no `closes`/
`Merge` keyword and must not match. Widening the regex without a corresponding audit of the commit
vocabulary actually in use is how a gate stops meaning anything.

**Multi-ID closure.** A single commit closing more than one ID must repeat the keyword per ID —
`closes T12` `closes T13` — not `closes T12, T13`. A comma-separated list only captures the first
ID, since the regex requires the keyword immediately before each ID. This is the required
convention; the regex is not widened to parse lists.

**Revert commits are excluded.** A commit subject beginning with `Revert "` (git's default revert
subject format) is skipped entirely before completion references are parsed — a revert re-opens
whatever it reverted, so its original `closes`/`Merge` reference must not re-fire the gate.

**ID resolution.** Applied over the document set `readDocs()` already produces (no separate
filesystem walk):

- `T<n>` (ticket): a document under `docs/work/tickets/` whose basename starts with `T<n>`
  immediately followed by `-` or `.` — `T7` matches `T7-thing.md` and never matches `T70-other.md`.
  The number is matched case-sensitively.
- `S<n><letter?>` (slice): a document under `docs/adr/` **or** `docs/work/specs/` whose basename,
  lowercased, contains the token as a hyphen-delimited segment — matching a leading `s5b-`/`s5b.md`
  or an embedded `-s5b-`/`-s5b.md`. **`S` is not a filename prefix the way `T` is** — slices are
  recorded as ADRs or specs, and their id sits wherever the slug puts it (e.g.
  `2026-08-09-onboarding-s5b-conflict-ui.md`). The match is case-insensitive.
- An ID may resolve to more than one document. The closed-state predicate below is applied to
  every match, not just the first.

**Closed-state predicate, by `document_type` of the matched document:**

| `document_type` | Closed when |
|---|---|
| `ticket` | `status` is one of `completed`, `closed`, `wont-fix` |
| `adr` | `status` is `superseded` or `rejected` (terminal — closed regardless of `implementation_state`); otherwise `status` is `accepted` **and** `implementation_state` is `implemented` |
| `spec` | `status` is one of `approved`, `implemented`, `superseded` |
| anything else | never closed — a completion reference is expected to resolve to a ticket, ADR, or spec |

**Findings:**

- `status-drift` — a referenced ID resolves to at least one document that is not closed. One
  finding per (id, unclosed document) pair, naming the ID, the document's path, and its current
  `status` (plus `implementation_state` for an ADR).
- `status-drift-unresolvable-reference` — a referenced ID resolves to zero documents. This is a
  **hard failure**, the same severity as `status-drift`, not a silent pass — an ID typo or a
  document rename that leaves an old reference dangling is the same defect class this gate exists
  to catch.

**Scope.** The check only looks at commit subjects reachable from `HEAD` but not from
`origin/main` (`git log origin/main..HEAD --format=%s`) — it is a going-forward gate over the
current branch, not a re-audit of history. If that `git log` call fails for any reason (no
`origin/main` to diff against — a fresh clone, a checkout without the base ref fetched), the check
is skipped entirely for that run rather than failing `npm run verify` for an unrelated environment
reason. The skip is not silent: `check:governance` prints one line to stderr
(`check:governance — status-drift check skipped (no origin/main to diff against)`) so a real
finding-free pass stays distinguishable from a run where the check did not execute.

---

## 4. `task_class`

Required on runs and on any spec that scopes implementation. The value must be one of the rows in
[`../GOVERNANCE_INDEX.md`](../GOVERNANCE_INDEX.md) §3–8, in kebab-case:

`architecture` · `ui-ux-design` · `security-auth` · `scheduling-engine` · `database-sync` ·
`copy-terminology` · `documentation-governance` · `concurrency` · `test-infrastructure`

The task class is what resolves which standards govern the work and which gates are mandatory.
**It is not a label applied afterwards** — Governor selects it before dispatch, and the standards
it names are the ones the work is held to.

A task that genuinely spans two classes takes the **stricter** gate list from both. It does not get
a new hyphenated class invented for it. `concurrency` and `test-infrastructure` are not such
spans: they were added (2026-08-13) because the corpus produced work the original seven classes
genuinely did not cover — op-log write-ordering / same-cell race work is a recurring concern
distinct from `database-sync`'s replication/migration focus, and test-harness engineering (flakiness
budgets, setup files, ABI probes) is not `documentation-governance`. Per §7, this is a
"the rule was incomplete" amendment with its reason recorded here, not an enum widened to clear a
finding.

---

## 5. The run record

One routed task produces one run record at `docs/work/runs/YYYY-MM-DD-<slug>.md`, from
[`../../work/runs/TEMPLATE.md`](../../work/runs/TEMPLATE.md).

### 5.1 It is written before dispatch

Governor writes the record — brief, task class, success predicate, planned agents — **before the
first agent is dispatched**, and updates it as agents return.

This ordering is the point of the record. Written afterwards it is a summary, and a summary of an
abandoned run does not get written at all. Written first, a run that dies mid-flight still shows
what was intended and how far it got, which is the case where the information is worth most.

Once a run record's `selected_agents`/`omitted_agents` have been used to dispatch gates, they must
not be edited in that round — a correction is a new round, not an edit to the frozen set.
<!-- Placed here (§5.1), not §2 ("Common fields") as
     docs/work/specs/2026-08-10-gatereport-implementation-brief.md §3 literally said — §2 does not
     define selected_agents/omitted_agents; this section does. -->

### 5.2 Schema

```yaml
---
task: T22 — record the author on every op
document_type: run
date: 2026-07-30
round: 1
status: in-progress
task_class: database-sync
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets: [docs/work/tickets/T22-most-ops-record-no-author.md]
related_adrs: []
related_specs: []
selected_agents: [maker, verifier, code-reviewer, security]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: no UI surface changes
deterministic_checks: [test, lint, build, integration]
human_gates: []
verdict: null
completion_evidence: []
archive_when: ticket resolved
---
```

| Field | Rule |
|---|---|
| `round` | `1` or `2`. There is no round 3 — Article VII escalates instead |
| `selected_agents` | Agent names in kebab-case, matching `.claude/agents/*.md` filenames |
| `omitted_agents` | See §5.3 |
| `deterministic_checks` | From `TESTING_STANDARD.md` §1: `test` · `lint` · `build` · `integration` |
| `human_gates` | Prose entries. Empty list means none apply — never omit the key to mean that |
| `verdict` | `null` until Verifier returns, then `pass` · `fail` · `unverified`. **Verifier alone sets this** |
| `completion_evidence` | Paths or command references. Must be non-empty when `verdict: pass` |

`verdict` is not `status`. `status` is where the run is; `verdict` is what the gates said. A run
can be `status: escalated` with `verdict: fail` — those are two different facts and the record
keeps both.

### 5.3 Omission requires a reason

Every one of the ten Governor-loop agents in Article VI either appears in `selected_agents` or has
an entry in `omitted_agents`. (Article VI also defines the two standalone auditors — Design Auditor
and Architecture Auditor — which run outside the loop and are not part of this accounting; the
checker's `AGENTS` list is exactly the ten loop agents.) There is no third state, and a missing
agent is a checker failure.

`reason` must be one of:

- `no-predicate` — the task class does not call for this agent.
- `not-applicable` — the agent's subject matter is absent from this change.
- `human-waived` — the user waived it. **Quote them verbatim in `note`.**

**"Seemed unnecessary" is not a reason.** If Governor believes a called-for agent is genuinely
unnecessary, that is a rule 8 challenge — raise it, do not quietly omit it.

`note` is optional for the first two reasons and mandatory for `human-waived`. Use it. The
2026-07-26 record is worth reading two months later entirely because of its notes.

---

## 6. The generated index

`docs/work/INDEX.md` is generated by `scripts/build-work-index.js` from frontmatter alone and is
**never hand-edited**. It carries a generated-file header. It holds open work by task class,
decisions with their inverted backlinks, orphans, and dangling references.

Regenerate with `npm run index:work`. `npm run check:governance` rebuilds it in memory and reports
if the committed copy is stale, so a forgotten regeneration surfaces as a finding rather than as
silent rot.

Being generated, `INDEX.md` is **descriptive, never authority** — `GOVERNANCE_INDEX.md` §9 applies
to it in full. Where it disagrees with the documents it was built from, they are right and it is
stale.

---

## 7. Enforcement

`npm run check:governance` is **blocking**, and `npm run verify` runs it after `lint` and `test`.
A finding fails the build. This includes `checkStatusDrift` (§3.2): a commit on the current branch
that claims to close a ticket or ADR while its frontmatter still reads open is a finding, same as
any other.

`CHECK_GOVERNANCE_WARN=1` downgrades it to print-and-exit-0 for a local sweep. It is not a way to
get a branch through.

### What to do with a finding

Two dispositions, and choosing between them is the judgement this standard asks for:

- **The corpus is wrong.** Fix the document.
- **The rule is wrong.** Amend this standard, in its own commit, with the reason recorded. §3
  already carries one such amendment: the enum said `resolved` and eighteen tickets said
  `completed`.

**Never a third option.** Do not widen an enum to make a specific finding disappear while leaving
the rule's intent unchanged — that is how a gate becomes decorative.

The design record is
[`../../work/specs/2026-07-30-typed-run-records-and-compiled-work-index-design.md`](../../work/specs/2026-07-30-typed-run-records-and-compiled-work-index-design.md).
