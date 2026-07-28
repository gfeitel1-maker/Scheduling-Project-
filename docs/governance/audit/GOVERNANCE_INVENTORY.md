# Governance Inventory — Shoresh

**Produced:** 2026-07-28 · **Phase:** read-only audit · **Status:** proposal, no file modified
**Method:** full enumeration of every `*.md` under the repo (excluding `node_modules`), plus every
external file that repository documents assume exists. 83 markdown files inventoried. No sampling.

Legend for **Disposition**: Keep · Condense · Split · Merge · Redirect · Archive · Generate · Investigate

---

## A. Repository truth boundary (Phase 0)

### A.1 Files that can influence Claude behaviour

| Location | Count | Influence |
|---|---|---|
| `.claude/agents/*.md` | 10 | Agent routing, review scope, security scope, completion standards |
| `CLAUDE.md` | 1 | Auto-loaded every session; architecture + commands |
| `PLATFORM_STATE.md` | 1 | Referenced by CLAUDE.md and 3 agent constitutions as current-state truth |
| `SECURITY.md` | 1 | Security model of record |
| `README.md` | 1 | Public-facing; also states architecture |
| `docs/adr/**` | 5 | Decision record |
| `docs/superpowers/plans/**` | 23 (22 unique + 1 dup) | Historical implementation plans; no authority label |
| `docs/superpowers/specs/**` | 27 (25 unique + 1 dup + design-system) | Mixed: 1 authoritative standard, 1 workflow design, 23 historical designs |
| `docs/workflow/specs/**` | 2 | Active-work spec + designer output |
| `docs/workflow/task-state/**` | 1 | Live workflow state (proto-manifest) |
| `docs/workflow/tickets/**` | 10 | Bounded work items |
| `tester/*.md` | 4 | Loaded by the Tester agent as standing briefs |
| `legacy/supabase/README.md` | 1 | Explicitly historical |
| `eslint.config.js`, `eslint.supabase-ban.test.js` | — | Deterministic enforcement of the Supabase ban (non-markdown, but governing) |

### A.2 External (non-repository) dependencies

| External file | Referenced by | Exists? | Classification | Conflict risk |
|---|---|---|---|---|
| `~/.claude/WORKFLOW_CONSTITUTION.md` | `governor.md` L299, `architect.md` L37, `code-reviewer.md` L110, `verifier.md` L1010, `grader.md` L491 | **Yes** (12 lines, 10 rules) | **Required — highest workflow authority, and it lives outside the repo** | HIGH. A clean clone on another machine loses the standing law that five agent constitutions cite as non-negotiable. |
| `~/.claude/CLAUDE.md` | implicitly loaded by the harness | Yes | Personal defaults | MEDIUM. It prescribes a bootstrap (`CONTEXT.md`, `docs/workflow/{specs,tickets,handoffs,evidence,architecture-reports}/`) that this repo only partly followed — `CONTEXT.md`, `handoffs/`, `evidence/`, `architecture-reports/` do not exist. |
| `~/.claude/skills/domain-modeling/ADR-FORMAT.md` | `architect.md` L37 | Yes | Required for ADR format | MEDIUM. ADR format is not repo-owned; the 5 existing ADRs have no enforced shape. |
| ~50 global skills (`~/.claude/skills/*`) named in agent constitutions | all 10 agents | Yes | Required | MEDIUM. Agent constitutions hard-depend on a personal skill library. |

**Phase 0 verdicts:**
1. **The highest governing workflow document currently lives outside the repository.** Confirmed.
2. **A clean machine / fresh session cannot reproduce current behaviour without private local files.** Confirmed — the constitution, the ADR format, and every named skill are user-level.

---

## B. Root documents

| Path | Title | Category | Scope | Authority | Lifecycle | Readers | Currentness | Overlaps | Conflicts | Disposition | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `CLAUDE.md` | CLAUDE.md | Constitution-ish entry point (in practice: architecture summary) | Mixed (architecture, commands, legacy) | Governing (auto-loaded) | Living | Claude | **Current** | `PLATFORM_STATE.md` (architecture, IPC list, engine desc), `README.md` (architecture) | Duplicates volatile IPC method list and engine signature with PLATFORM_STATE.md | **Condense + Split** — keep orientation, commands, non-negotiables, pointer to governance index; move the IPC/table/engine detail to current-state | L28–48 restate the local-first model, IPC surface, engine signature, and screen routing already covered in PLATFORM_STATE.md §Architecture; L50–59 restate `legacy/supabase/README.md` |
| `PLATFORM_STATE.md` | Platform State | Current state | Mixed (architecture, schema, screens, known issues) | Descriptive | Living | Claude + devs | **Current** (222 lines, dated internally) | CLAUDE.md, README.md | None material | **Keep, relocate** to `docs/current/PLATFORM_STATE.md`; mark volatile sections (table list, IPC list, screen map) as generate-or-check candidates | L109–146 hand-maintained table and screen inventories |
| `SECURITY.md` | Security Model | Current state (security) | Security | Descriptive-normative hybrid | Living | Public + Claude | **Current** (`Last updated: 2026-07-26`, matches ADRs 2026-07-24/25) | `.claude/agents/security.md` (contradicts it — see conflicts) | **Directly contradicted by the active Security agent constitution** | **Split**: durable rules → `SECURITY_STANDARD.md`; current posture + known limitations → `docs/current/SECURITY_STATE.md`; keep a public `SECURITY.md` redirect for GitHub convention | L11–14 deployment boundary (durable); L96–130 known limitations (volatile) |
| `README.md` | Shoresh | Public documentation | Product + architecture | Descriptive | Living | Public | **Current** | CLAUDE.md, PLATFORM_STATE.md, SECURITY.md | None material | **Keep in place** — public entry point, correctly not agent-governing | L34–46 architecture + security summary, both accurate |

---

## C. Agent constitutions (`.claude/agents/`)

All 10 have valid YAML frontmatter (`name`, `description`, `model`; 5 also declare `tools`). Filenames are lowercase-kebab and **match** their `name:` field. None declare `governing_docs`, `conditional_docs`, or `outputs`.

| Path | Role | Authority | Currentness | Overlaps | Conflicts | Disposition |
|---|---|---|---|---|---|---|
| `governor.md` | Orchestrator | Constitutional (for the loop) | **Partly stale — high impact** | Duplicates design tokens verbatim from `design-system.md` (L460–475) and from `maker.md`/`designer.md` | **9 broken agent path references** (`agents/ARCHITECT.md` etc. — wrong case, wrong dir, and `REDHAT.md`/`CODEREVIEWER.md` don't correspond to any filename). **Project Context L187 says "Supabase local Docker"; L206 says "RLS via `get_my_camp_id()`"** | **Condense + Split**: routing/classification/loop stays; team table paths fixed; token block replaced with a link |
| `maker.md` | Implementation | Normative (role) | **Partly stale** | Token block duplicated from `design-system.md` and `governor.md` | L70 `RLS via get_my_camp_id()` — retired architecture stated as a hard constraint | **Condense** — replace duplicated token block + DB section with links |
| `security.md` | Vulnerability audit | Normative (role) | **STALE — highest-risk document in the repo** | `SECURITY.md` covers the real model and is not referenced | Entire "App-Specific Threat Surface" (L36–46) describes Supabase/RLS/anon-key/service-role-JWT. **Zero coverage of the actual attack surface**: `ws://` LAN protocol, PIN handling, pairing, Ed25519 minting, `authorize()`, IPC, packaging | **Rewrite from `SECURITY.md` + ADRs** (post-approval) |
| `code-reviewer.md` | Maintainability + plan alignment | Normative (role) | Current | Constitution rules restated inline (L110–114) | None | **Keep, condense** — replace restated constitution with a reference |
| `verifier.md` | Deterministic gate | Normative (role) | Current — gate commands match `package.json` | Constitution rules restated inline (L1010–1014) | Does not name `node test/integration/run.js`, which README documents as a required gate | **Keep, condense + one correction** |
| `architect.md` | Technical design + ADR | Normative (role) | Current | — | Cites `docs/superpowers/specs/` as the ADR-substitute convention; that directory is now historical | **Keep, condense** |
| `designer.md` | Visual design | Normative (role) | Current | Token block duplicated (3rd copy) | — | **Condense** — link to `design-system.md` |
| `tester.md` | Director's-eye UX | Normative (role) | **Partly stale** | `tester/*.md` briefs | Drives `http://localhost:5200` (`npm run dev`, browser mock). PLATFORM_STATE L209 documents that the dev mock is a materially different environment from Electron | **Keep + correct the environment statement** |
| `red-hat.md` | Adversarial | Normative (role) | Current | — | — | **Keep** |
| `grader.md` | Calibrated scoring | Normative (role) | **Partly stale** | — | Rubric Security score 1 = "RLS bypass … JWT exposure" (L58); Output Format L594 says "Reports received: Tester, Security, Red Hat" while the body requires four | **Keep + correct rubric wording** |

---

## D. `docs/adr/` — 5 files

| Path | Currentness | Conflicts | Disposition |
|---|---|---|---|
| `2026-07-24-bulk-replace-seq-fix.md` | Current | No `status:`/`date:` frontmatter | **Keep + add metadata** |
| `2026-07-24-centralized-authorization-layer.md` | Current | same | **Keep + add metadata** |
| `2026-07-25-append-only-audit-event-log.md` | Current | same | **Keep + add metadata** |
| `2026-07-25-device-trust-revocation.md` | Current | same | **Keep + add metadata** |
| `2026-07-28-first-pairing-domain-sync-and-template-identity.md` | Current (today) | same | **Keep + add metadata** |

None of the five declares `status`, `supersedes`, `implementation state`, or affected standards. ADR format is inherited from a user-level skill file.

---

## E. `docs/superpowers/` — 50 files (2 exact duplicates)

### E.1 `specs/design-system.md` — the outlier

| Field | Value |
|---|---|
| Category | **Normative standard misfiled among historical specs** |
| Authority | Self-declared: *"Status: Authoritative. This document is the durable record of the Shoresh token architecture."* (L3) |
| Referenced as canonical by | `governor.md` L460/L478, `maker.md` L36, `designer.md` L210 |
| Conflict | Its content is **copied, not linked**, into three agent constitutions — four independently-drifting copies of a volatile hex palette |
| Disposition | **Promote** → `docs/governance/standards/TOKEN_STANDARD.md` (+ split the Personality/Motion §1 material into `DESIGN_PRINCIPLES.md`) |

### E.2 `specs/2026-07-19-multi-agent-workflow-design.md` — the second outlier

| Field | Value |
|---|---|
| Category | **Workflow constitution material misfiled as a task spec** |
| Status line | *"Approved — implementing"* (still, 9 days later) |
| Conflict | Describes a **7-agent** team; `.claude/agents/` holds **10**. Architect, Verifier, Code Reviewer are absent from it |
| Disposition | **Split** — durable routing law → `AGENT_WORKFLOW_CONSTITUTION.md`; the rest → archive as the historical design |

### E.3 Duplicate files (byte-identical, verified with `diff`)

| Path | Disposition |
|---|---|
| `plans/2026-07-19-users-camps-sync 2.md` | **Archive-or-delete after approval** — identical to its sibling; filename contains a space *and* a `2` suffix, violating the proposed naming convention |
| `specs/2026-07-19-users-camps-sync-design 2.md` | same |

### E.4 The remaining 46 files

22 plans (`2026-05-23` → `2026-07-25`) and 24 designs. **All describe completed work.** Categories: implementation plan / design spec. Authority: **task-specific, now historical**. Lifecycle: **completed**. Currentness: historically accurate; several describe retired architecture as current-of-their-date.

**None carries a status marker, a completion note, or a non-authoritative notice.** An agent grepping for "how does auth work" can land on `specs/2026-05-24-security-design.md` (*"Security Design: Auth, RLS, GitHub & Vercel"*) or `plans/2026-05-24-security-plan.md` with nothing on the page saying it is superseded.

Notable sub-group — the Supabase→local-first migration series (`2026-07-19` → `2026-07-21`, ~12 files): these are the *record of the retirement*. They belong in `archive/legacy-architecture/`.

**Disposition for all 46: Archive** (`docs/archive/completed-plans/`, `docs/archive/completed-specs/`, `docs/archive/legacy-architecture/`) **with a non-authoritative header**, dates preserved, content unchanged.

---

## F. `docs/workflow/` — 13 files

| Path | Category | Authority | Lifecycle | Currentness | Disposition |
|---|---|---|---|---|---|
| `specs/2026-07-26-manual-grid-editing.md` | Specification | Task-specific, **active** | Per-task | Current | **Keep** → `docs/work/specs/` + lifecycle frontmatter |
| `specs/designer-output-2026-07-26.md` | Specification (designer artefact) | Task-specific | Per-task | Current | **Keep** → `docs/work/specs/`; filename should pair explicitly with its spec |
| `task-state/2026-07-26-manual-grid-editing.md` | Workflow state | Descriptive | Per-task | Current (Status: Phase 7) | **Keep** → `docs/work/task-state/`. **This file is already 80% of the Phase-7 workflow manifest** — it records classification, risk, per-agent routing *with omission reasons*, and success predicate. It should become the manifest template. |
| `tickets/T1`–`T5` | Ticket | Task-specific | Per-task | **Unknown — no status field at all** | **Keep + add lifecycle metadata**; determine actual state |
| `tickets/T6` | Ticket | Task-specific | **Completed** (fixed in `5e2c007`) | Ticket still reads `Status: CONFIRMED` | **Keep + mark resolved**; archive rule needed |
| `tickets/T7` | Ticket | Task-specific | **Completed** (fixed in `0a147ce`, ADR `2026-07-28`) | Ticket still reads `Status: CONFIRMED … Needs an ADR` — the ADR now exists | **Keep + mark resolved** |
| `tickets/T8`–`T10` | Ticket | Task-specific | Open | Current | **Keep + add lifecycle metadata** |

**Structural finding:** `docs/superpowers/{plans,specs}` and `docs/workflow/{specs,task-state,tickets}` are two parallel active-work hierarchies with no stated relationship. The first is de facto dead (last write 2026-07-26 handoff), the second is live. Nothing in the repo says so.

---

## G. `tester/` — 4 files

| Path | Category | Authority | Lifecycle | Currentness | Disposition |
|---|---|---|---|---|---|
| `tester/BRIEF.md` | Agent constitution fragment | Normative (Tester-local) | Living | Partly stale (L17 preview-server assumption) | **Merge** into `.claude/agents/tester.md` or move under governance |
| `tester/DIRECTOR_BRIEF.md` | Reference — director persona | Normative (Tester-local) | Stable | Current | **Keep, relocate** — durable, reusable; a skill candidate |
| `tester/SCRIPT.md` | Reference — regression script | Normative (Tester-local) | Living | Partly stale — 169 lines of `localhost:5200` browser steps | **Keep, relocate**; strongest **skill candidate** in the repo |
| `tester/REPORT_2026-06-28.md` | Historical run record | Historical | Completed | Historical | **Archive** → `docs/archive/workflow-runs/` |

A top-level `tester/` directory sitting beside `src/` and `electron/` reads as source code. Its three standing briefs are governance; its one report is history.

---

## H. Governing material buried inside task-specific documents

Per Phase 1's final instruction — content that is durable law but currently lives in a per-task file:

| Buried in | Material | Should become |
|---|---|---|
| `specs/design-system.md` §1 | Personality doctrine ("Professional. Grounded. Warm. Quiet. Precise. Never playful."), motion doctrine | `DESIGN_PRINCIPLES.md` |
| `specs/design-system.md` §2–§6 | Full token map with semantic meanings, `color-mix` tinting rule | `TOKEN_STANDARD.md` |
| `specs/2026-07-19-multi-agent-workflow-design.md` | Loop law: max 2 rounds, pass/retry/escalate, parallel review round, Designer-dispatch triggers | `AGENT_WORKFLOW_CONSTITUTION.md` |
| `SECURITY.md` "Deployment boundary" + "Explicitly NOT for" | The trusted-LAN threat model — the single most load-bearing security constraint in the project | `SECURITY_STANDARD.md` |
| `CLAUDE.md` "Styling" paragraph + `maker.md` | "All styles are inline React style objects; no CSS files; no className for styling" — repeated in 4 places | `ARCHITECTURE_STANDARD.md` (or `DESIGN_PRINCIPLES.md`) |
| `README.md` "The problem" / "What it does" | Product thesis: *camps own their scheduling logic; surface conflicts, never decide silently* | `PRODUCT_PRINCIPLES.md` |
| `maker.md` "Code style" | No-defensive-code / validate-only-at-boundaries convention — cited by `code-reviewer.md` as "this project's established convention" but owned by no shared document | `ARCHITECTURE_STANDARD.md` |
| `verifier.md` "What to run" + `README.md` "Tests" | The actual gate list (`npm run test`, `npm run lint`, `npm run build`, `node test/integration/run.js`) — the two disagree | `TESTING_STANDARD.md` |
| `task-state/2026-07-26-manual-grid-editing.md` | The routing-decision table with omission reasons | Workflow manifest template |

---

## I. Counts

| Class | Files |
|---|---|
| Agent constitutions | 10 |
| Root governing/descriptive | 4 |
| ADRs | 5 |
| Standards hiding in specs | 2 (`design-system.md`, `multi-agent-workflow-design.md`) |
| Active work | 13 |
| Tester standing briefs | 3 |
| Historical (plans, designs, one report, legacy README) | 48 |
| Exact duplicates | 2 |
| **Total inventoried** | **83** |
| Documents with lifecycle/status frontmatter | **0** |
| Documents carrying a non-authoritative notice | **1** (`legacy/supabase/README.md`) |
