# Proposed Governance Architecture — Shoresh

**Produced:** 2026-07-28 · **Phase:** read-only audit · **Status:** proposal awaiting approval

Includes the Phase 4 governance index design and the Phase 8/9 naming and metadata standards.
Nothing here is implemented.

---

## Design rule applied throughout

> Every active document answers exactly one primary question. No question has two authoritative answers.

Departures from the spec's suggested tree are marked **[deviation]** with the repository evidence for them.

---

## Proposed final tree

```text
CLAUDE.md                          # entry point + routing into governance (shrinks ~59 → ~35 lines)
README.md                          # public; unchanged
SECURITY.md                        # public; becomes a 5-line pointer (GitHub convention)  [deviation]
.claude/
└── agents/                        # 10 files, names unchanged, bodies condensed
    ├── governor.md   architect.md   designer.md   maker.md
    ├── code-reviewer.md   verifier.md   tester.md
    ├── security.md   red-hat.md   grader.md
docs/
├── governance/
│   ├── GOVERNANCE_INDEX.md                    # the one entry point for authority
│   ├── constitution/
│   │   ├── PROJECT_CONSTITUTION.md
│   │   └── AGENT_WORKFLOW_CONSTITUTION.md     # repo-owned copy of the 10 rules + loop law
│   ├── standards/
│   │   ├── PRODUCT_PRINCIPLES.md
│   │   ├── DESIGN_PRINCIPLES.md
│   │   ├── TOKEN_STANDARD.md
│   │   ├── ARCHITECTURE_STANDARD.md
│   │   ├── SECURITY_STANDARD.md
│   │   └── TESTING_STANDARD.md
│   ├── audit/                                 # this audit; archived after migration
│   └── references/
│       ├── director-persona.md                # from tester/DIRECTOR_BRIEF.md
│       └── regression-script.md               # from tester/SCRIPT.md   (skill candidate)
├── current/
│   ├── PLATFORM_STATE.md
│   ├── SECURITY_STATE.md
│   └── UI_STATE.md
├── adr/                                       # unchanged location, + frontmatter
├── work/
│   ├── specs/     plans/     task-state/     tickets/
└── archive/
    ├── completed-plans/     completed-specs/
    ├── legacy-architecture/                   # the Supabase→local-first migration series
    └── workflow-runs/
```

### Deviations from the spec's suggested tree, with evidence

| Spec suggested | Proposed | Evidence |
|---|---|---|
| `PRODUCT_DIRECTION.md` | **Omit** | No forward-looking roadmap content exists in the repo. Creating it would be an empty framework document, which the spec forbids. Revisit when there is direction to record. |
| `PRODUCT_LANGUAGE_STANDARD.md` | **Omit for now** | Terminology work exists (`2026-05-29-terminology-rename-*`) but is historical and complete. A live glossary would be a new document with no current content. Flag as U-8. |
| `INTERACTION_STANDARD.md` | **Fold into `DESIGN_PRINCIPLES.md`** | Interaction doctrine (motion vocabulary, DnD activation, reduced-motion) is ~15 lines. A separate file would be thin. Split later if it grows. |
| `ACCESSIBILITY_STANDARD.md` | **Omit** | The repo has almost no accessibility content — `red-hat.md` names it as an unexamined gap. Creating the file would imply a standard that does not exist. This is itself a finding (see U-9). |
| `AGENT_WORKFLOW_STATE.md` | **Omit** | The 10 agent files *are* the state. A separate mirror is a second volatile truth — exactly the failure mode C1-3 documents. Replace with a deterministic check that the index and the filesystem agree. |
| `SECURITY.md` moves | **Root `SECURITY.md` stays as a pointer** | GitHub surfaces root `SECURITY.md` in its security tab and vulnerability-reporting UI. Moving it wholesale breaks a public convention for a public repo. |
| `docs/governance/references/` | **New layer** | The spec has no home for `tester/SCRIPT.md` / `DIRECTOR_BRIEF.md` — normative, agent-specific, conditionally loaded, too long to inline, not project-wide law. Precursor directory for future skills. |

---

## Layer definitions and content sources

### Layer 0 — `CLAUDE.md`
**Question: where am I, and where is the law?**

Keeps: orientation paragraph, commands (+ the missing integration harness and rebuild dance), the non-negotiables that must survive even if nothing else loads, a link to `GOVERNANCE_INDEX.md`, one-paragraph architecture, one-paragraph agent-workflow summary.

Loses: the enumerated `window.shoresh.*` IPC list, the `buildSchedule` signature, the screen-routing mechanics, the styling detail, the 10-line legacy-Supabase section (→ a one-line pointer to `legacy/supabase/README.md`).

### Layer 1 — `docs/governance/constitution/`

| Document | Question | Sourced from |
|---|---|---|
| `PROJECT_CONSTITUTION.md` | Who decides, and when must work stop? | `~/.claude/CLAUDE.md` rules 1–2, 9–10; the spec's own approval-gate discipline; the trusted-LAN boundary as a product constraint |
| `AGENT_WORKFLOW_CONSTITUTION.md` | What law binds every agent? | **The 10 rules from `~/.claude/WORKFLOW_CONSTITUTION.md`, copied in verbatim** + the loop law extracted from `multi-agent-workflow-design.md` (max 2 rounds, pass/retry/escalate, parallel review round, Verifier-outranks-Grader, synchronous-dispatch discipline) + the canonical agent roster |

**External-file interaction rule (proposed, requires approval — U-1):**
> `~/.claude/WORKFLOW_CONSTITUTION.md` remains a personal default for all projects. Within this repository, `docs/governance/constitution/AGENT_WORKFLOW_CONSTITUTION.md` is authoritative. Where they differ, the repository copy governs; a difference is a signal to reconcile, not to defer.

This satisfies "do not silently import" — the copy is explicit, attributed, and dated, and the original keeps its own life.

### Layer 2 — `docs/governance/standards/`

| Standard | Question | Sourced from | Absorbs / retires |
|---|---|---|---|
| `PRODUCT_PRINCIPLES.md` | What is this product for, and what will it never do? | `README.md` "The problem"/"What it does" | The "camps own their logic; surface conflicts, never decide silently" thesis, currently only in public prose |
| `DESIGN_PRINCIPLES.md` | What must always be true visually and interactively? | `design-system.md` §1 + motion/DnD doctrine from 3 agents | The personality doctrine's 3 duplicate copies |
| `TOKEN_STANDARD.md` | What is each token, and what does it mean? | `design-system.md` §2–§6 verbatim | **The 3 duplicated token blocks in governor/maker/designer** |
| `ARCHITECTURE_STANDARD.md` | What must remain structurally true? | `CLAUDE.md` architecture + `maker.md` code-style + the isolation invariant | Fixes C1-5; gives the no-defensive-code convention an owner |
| `SECURITY_STANDARD.md` | What security properties must hold? | `SECURITY.md` "Deployment boundary" + "Explicitly NOT for" + the ADR-derived invariants | **Replaces `security.md`'s Supabase threat surface (C1-1)** and re-anchors Grader's rubric (C1-6) |
| `TESTING_STANDARD.md` | What counts as proof? | `verifier.md` + `README.md` "Tests" + the dev-mock/Electron distinction | Fixes C1-8 and C1-9; single owner of the gate list |

**Standards are what must remain true. They contain no implementation diary and no volatile inventory.** Every "as of today, X is not yet done" statement belongs in Layer 3.

### Layer 3 — `docs/current/`

| Document | Question | Volatile content it absorbs |
|---|---|---|
| `PLATFORM_STATE.md` | What exists right now? | Unchanged content; gains an explicit "descriptive, not authoritative" header |
| `SECURITY_STATE.md` | What is the security posture and what is knowingly accepted? | `SECURITY.md` "What is hardened" + "Known limitations" |
| `UI_STATE.md` | What does the UI actually look like today vs. the token standard? | **The retheme-pending caveat, currently duplicated in 3 normative documents (C1-3)** |

Generate-or-check candidates (do not hand-maintain twice): screen inventory, table list, `window.shoresh.*` IPC surface, agent roster.

### Layer 4 — `docs/adr/`
Location and contents unchanged; append-only preserved. Each ADR gains frontmatter declaring status, date, decision, supersedes, implementation state, and affected standards. **The ADR format moves into the repository** rather than being inherited from `~/.claude/skills/domain-modeling/ADR-FORMAT.md`.

### Layer 5 — `docs/work/`
`docs/workflow/*` moves here wholesale; `docs/superpowers/*` does **not** — it goes to archive. Every active-work document gains lifecycle frontmatter (Phase 9 below), including `archive_when`. `task-state/` gains the workflow-manifest frontmatter block.

### Layer 6 — `docs/archive/`
48 historical files, **content unchanged, dates preserved**, each gaining a header:

```markdown
> **ARCHIVED — historical record, not current authority.**
> Completed/superseded: <date>. Current law: docs/governance/GOVERNANCE_INDEX.md
```

The Supabase→local-first series goes to `legacy-architecture/` so the retirement is legible as one story.

---

## Phase 4 — `GOVERNANCE_INDEX.md` design

A single page, target ≤120 lines, answering the spec's 14 questions. Proposed skeleton:

```markdown
# Governance Index

## 1. Highest repository authority
Explicit current human instruction → PROJECT_CONSTITUTION → AGENT_WORKFLOW_CONSTITUTION

## 2. What Governor always reads
CLAUDE.md · this index · AGENT_WORKFLOW_CONSTITUTION.md   (nothing else by default)

## 3–8. Task-class routing table
| Task class | Governing standards | Current-state refs | Deterministic checks | Human gate |
|---|---|---|---|---|
| architecture | ARCHITECTURE_STANDARD + relevant ADRs | PLATFORM_STATE | test·lint·build·integration | ADR approval |
| ui/ux | DESIGN_PRINCIPLES + TOKEN_STANDARD | UI_STATE | test·lint·build | IA change |
| security | SECURITY_STANDARD + ADRs 07-24/07-25 | SECURITY_STATE | test·lint·build·integration | any accepted-risk change |
| scheduling engine | ARCHITECTURE_STANDARD + TESTING_STANDARD | PLATFORM_STATE §engine | buildSchedule.test.js·test·lint | none |
| db / sync | ARCHITECTURE_STANDARD + ADRs | PLATFORM_STATE §schema | integration harness (mandatory) | migration plan |
| copy / terminology | PRODUCT_PRINCIPLES | — | lint | none |

## 9. Descriptive only (never cite as law)
docs/current/**  ·  README.md  ·  PLATFORM_STATE.md

## 10. Historical (never load as instruction)
docs/archive/**  ·  legacy/**

## 11. Resolving disagreement — precedence order  (see below)

## 12. When work stops for human review
architecture change without an ADR · any change to an accepted security tradeoff ·
product-judgement question · agent rename · a standard contradicting shipped code ·
Verifier FAIL or UNVERIFIED at round 2

## 13. Conditionally loaded (specialist references / skill candidates)
docs/governance/references/regression-script.md · director-persona.md

## 14. Never authority despite being detailed
docs/archive/**  ·  any completed spec or plan  ·  agent-local summaries  ·
~/.claude/** (personal defaults, subordinate to this repo)
```

### Proposed precedence order

The spec's order is adopted **with one modification**, which is the audit's own recommendation and needs your sign-off (U-10):

| # | Source |
|---|---|
| 1 | Explicit current human instruction |
| 2 | `PROJECT_CONSTITUTION.md` |
| 3 | `AGENT_WORKFLOW_CONSTITUTION.md` |
| 4 | Domain normative standard |
| 5 | Accepted ADR |
| 6 | Approved active specification |
| 7 | Approved implementation plan |
| 8 | **Code and deterministic test evidence** ⇽ *moved up from #9* |
| 9 | **Current-state documentation** ⇽ *moved down from #8* |
| 10 | Historical documents |

**Why the swap:** the constitution already says *"canonical project documents and live code outrank agent memory."* Between hand-maintained current-state prose and the code it describes, the code is the more reliable witness — this audit found current-state duplication drifting in exactly that direction (C2-5). Ranking code above descriptive documentation makes drift self-correcting rather than self-reinforcing.

**What the order does *not* mean.** Code sits at #8, below standards at #4. Per the spec: current implementation is evidence of reality, not authority over an approved standard. Where code contradicts a standard — for example, `src/index.css` still holding the pre-retheme vivid palette while `TOKEN_STANDARD.md` defines the new one — **that is a recorded gap in `UI_STATE.md`, not a silent amendment to the standard**. This is the single most important rule in the model and the one most likely to be violated in practice.

---

## Phase 8 — Naming convention

1. Directories and filenames: **lowercase kebab-case**, except recognised root conventions (`CLAUDE.md`, `README.md`, `SECURITY.md`) and governance documents in `docs/governance/**` and `docs/current/**`, which stay **UPPER_SNAKE** — matching existing practice (`PLATFORM_STATE.md`) and making authority visible in a file listing.
2. **No spaces.** (Fixes 2 files.)
3. **No numeric duplicate suffixes** (` 2`). Duplicates are resolved, not accumulated.
4. ISO dates (`YYYY-MM-DD-`) **only** on event-specific artefacts: work docs, ADRs, archived runs.
5. **Stable governing documents never carry a date in the filename.** Their date lives in frontmatter.
6. Specs and plans for the same work share a slug and differ only by directory: `work/specs/<slug>.md`, `work/plans/<slug>.md`. **Never two files with the same basename in different directories** (fixes the `2026-05-23-schedule-iteration.md` collision). Designer artefacts: `<slug>-designer-output.md`.
7. Archived files keep their original names and dates; only a header is added.
8. **Agent `name:` frontmatter, filename, and every Governor/index reference must match exactly**, and a deterministic check enforces it.
9. Names describe purpose, never the tool or conversation that produced them. (`docs/superpowers/` is itself a violation — it is named after the skill library that generated it. Renaming it is subsumed by the archive move.)

### Canonical agent names — recommendation (approval required, U-2/U-3)

Retain all ten current names unchanged. Nothing is renamed.

| Name | Responsibility boundary — the one thing only this role does |
|---|---|
| **Governor** | Routing, classification, briefing, stopping rules, escalation. Never implements, never reviews. |
| **Architect** | Technical structure before code: schema, module boundaries, wire/IPC shape. Writes the ADR. Never visual, never implements. |
| **Designer** | Visual and interaction specification before code. Never technical structure, never implements. |
| **Maker** | The only agent that writes production code. No design opinions. |
| **Code Reviewer** | Plan alignment + maintainability, by reading. Not vulnerabilities, not adversarial scenarios, not execution. |
| **Verifier** | Executes gates and reports raw results. **Forms no opinion.** The only deterministic evidence source. |
| **Tester** | Director's-eye UX and visual fidelity in the running app. Judgement, not gates. |
| **Security** | Confirmed vulnerabilities against the real threat surface. Not resilience, not maintainability. |
| **Red Hat** | Broken assumptions and edge cases nobody considered. Explicitly *not* bugs and *not* vulnerabilities. |
| **Grader** | Calibrated score from the four opinion reports. Runs nothing, decides nothing — and never outranks Verifier. |

**"Reviewer"** → deprecated informal alias for Code Reviewer; the index states this so the term stops recurring.
**"Styler"** → **no such role exists.** Recommend retiring the word entirely: the repository role is Designer (specifies *before* Maker), and reintroducing a post-hoc styling agent would violate "reviewers do not modify the work they review." **Needs your confirmation — it appears in your own commissioning spec (U-2).**

---

## Phase 9 — Metadata standard

Every required field must serve authority resolution, lifecycle management, routing, traceability, or review timing. Fields that serve none are excluded.

**Stable governance documents:**
```yaml
---
title:
document_type: constitution | standard | index | current-state | adr
authority: constitutional | normative | descriptive | historical
status: active | draft | superseded | archived
applies_to: [architecture, security, design, testing, product, workflow]
supersedes:
last_reviewed:
review_trigger:            # the event that makes this doc suspect, e.g. "any schema migration"
---
```
`owner:` is **omitted** — this is a single-owner project; a field that always reads the same is a field nobody maintains.

**Work documents:**
```yaml
---
title:
document_type: spec | plan | task-state | ticket
status: draft | approved | active | blocked | completed | archived
created:
governing_docs: []
related_adrs: []
supersedes:
archive_when:              # the condition, not a date — fixes C2-4
---
```

**Agent constitutions** — extend existing frontmatter:
```yaml
---
name:
description:
model:
tools:
governing_docs: []         # always loaded with this agent
conditional_docs: []       # loaded when the task class calls for it
outputs:                   # the report contract this agent owes
---
```
This turns the Phase 6 context matrix into machine-readable data rather than prose, and lets a script verify that every agent's `governing_docs` resolve.

---

## Estimated effect on active context

| Path | Today | After | Change |
|---|---|---|---|
| Always loaded (`CLAUDE.md`) | 59 lines | ~35 + index ~120 (loaded once, replaces guessing) | +~95, but *authority becomes resolvable* |
| UI-significant task (governor+designer+maker+design-system) | ~680 lines, ~180 duplicated | ~480 lines, 0 duplicated | **−30%, and one source per fact** |
| Security task | `security.md` 78 lines, **~0% relevant** | `security.md` ~45 + `SECURITY_STANDARD.md` ~60, ~100% relevant | Slightly larger, **correctness restored from ~0%** |
| Historical material reachable as instruction | 48 files, unlabelled | 48 files, all labelled non-authoritative | Unchanged size, eliminated as a hazard |

The honest headline is not "less context." It is **fewer contradictions per token**. Duplicated-authority reduction is the measurable win; raw line count barely moves and should not be the metric.
