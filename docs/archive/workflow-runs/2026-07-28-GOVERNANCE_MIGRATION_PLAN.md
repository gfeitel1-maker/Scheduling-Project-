> **ARCHIVED — historical record, not current authority.**
> Governance audit of 2026-07-28. Its recommendations were executed across four PRs;
> where this document and the current tree differ, the tree is right. Several proposals
> here were deliberately **not** adopted (see the PRs for why).
> Current law: [`docs/governance/GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md)

# Governance Migration Plan — Shoresh

**Produced:** 2026-07-28 · **Phase:** read-only audit · **Status:** PROPOSAL — NOT APPROVED, NOT EXECUTED

Nothing in this plan has been performed. No file has been moved, renamed, merged, archived, or
rewritten. The only files created by this audit are the five documents in `docs/governance/audit/`.

---

## 1. Files that remain exactly where they are

| Path | Why |
|---|---|
| `README.md` | Public entry point, currently accurate, correctly non-governing |
| `.claude/agents/*.md` (all 10, same names) | Claude Code discovers agents here by frontmatter `name:`. **Moving or renaming these breaks agent discovery.** Bodies get edited in place; locations and names do not change |
| `docs/adr/**` (5 files) | Already correct; append-only preserved. Gains frontmatter only |
| `legacy/supabase/**` | Already explicitly labelled historical — the one document in the repo that got this right |
| `eslint.config.js`, `eslint.supabase-ban.test.js` | Working deterministic enforcement; the model for the new governance checks |

---

## 2. Files to relocate (content unchanged)

| From | To |
|---|---|
| `PLATFORM_STATE.md` | `docs/current/PLATFORM_STATE.md` |
| `docs/workflow/specs/2026-07-26-manual-grid-editing.md` | `docs/work/specs/manual-grid-editing.md` |
| `docs/workflow/specs/designer-output-2026-07-26.md` | `docs/work/specs/manual-grid-editing-designer-output.md` |
| `docs/workflow/task-state/2026-07-26-manual-grid-editing.md` | `docs/work/task-state/manual-grid-editing.md` |
| `docs/workflow/tickets/T1–T10` | `docs/work/tickets/` (names preserved) |
| `tester/DIRECTOR_BRIEF.md` | `docs/governance/references/director-persona.md` |
| `tester/SCRIPT.md` | `docs/governance/references/regression-script.md` |

**Risk of relocating `PLATFORM_STATE.md`:** it is referenced by `CLAUDE.md`, `README.md`,
`architect.md` (L18, L50), and `code-reviewer.md`. All four must be updated in the same commit.

---

## 3. Files to rename

| From | To | Reason |
|---|---|---|
| `plans/2026-07-19-users-camps-sync 2.md` | resolved by deletion (§7) | Space in filename + `2` suffix |
| `specs/2026-07-19-users-camps-sync-design 2.md` | resolved by deletion (§7) | Same |
| `specs/2026-05-23-schedule-iteration.md` | `archive/completed-specs/2026-05-23-schedule-iteration-design.md` | Collides with the identically-named plan |

**No agent is renamed.** (Requires approval regardless — see §12, U-2/U-3.)

---

## 4. Files to condense

| File | Today | Remove | Target |
|---|---|---|---|
| `CLAUDE.md` | 59 lines | IPC enumeration, `buildSchedule` signature, screen-routing mechanics, 10-line legacy section | ~35 lines + index link |
| `.claude/agents/governor.md` | 209 lines | 16-line duplicated token block, retheme caveat, stale Project Context | ~150 lines |
| `.claude/agents/maker.md` | 101 lines | Duplicated token block, `RLS via get_my_camp_id()` | ~65 lines |
| `.claude/agents/designer.md` | 103 lines | Duplicated token block | ~70 lines |
| `.claude/agents/code-reviewer.md` | 89 lines | Restated constitution rules → citation | ~80 lines |
| `.claude/agents/verifier.md` | 74 lines | Restated constitution rules → citation | ~70 lines (**and gains the integration harness — net larger, correctly**) |

---

## 5. Files to split

| Source | Into |
|---|---|
| `docs/superpowers/specs/design-system.md` | §1 → `standards/DESIGN_PRINCIPLES.md` · §2–§6 → `standards/TOKEN_STANDARD.md` · retheme-status → `current/UI_STATE.md` |
| `SECURITY.md` | Boundary + "Explicitly NOT for" → `standards/SECURITY_STANDARD.md` · "What is hardened" + "Known limitations" → `current/SECURITY_STATE.md` · root file → 5-line pointer |
| `docs/superpowers/specs/2026-07-19-multi-agent-workflow-design.md` | Loop law + roster → `constitution/AGENT_WORKFLOW_CONSTITUTION.md` · remainder → `archive/completed-specs/` |
| `CLAUDE.md` | Detail → `current/PLATFORM_STATE.md` (already covered there — this is deletion, not duplication) |

---

## 6. Files to merge

| Sources | Into |
|---|---|
| `~/.claude/WORKFLOW_CONSTITUTION.md` (copy) + loop law from the workflow design + canonical roster | `constitution/AGENT_WORKFLOW_CONSTITUTION.md` |
| `maker.md` code-style + `CLAUDE.md` architecture + isolation invariant + DnD constraint | `standards/ARCHITECTURE_STANDARD.md` |
| `verifier.md` gate list + `README.md` "Tests" + dev-mock/Electron distinction | `standards/TESTING_STANDARD.md` |
| `tester/BRIEF.md` | folded into `.claude/agents/tester.md` (73 lines, entirely role instruction) |

---

## 7. Files to archive

| Group | Count | Destination |
|---|---|---|
| `docs/superpowers/plans/**` (excl. duplicate) | 22 | `archive/completed-plans/` — except the ~6 Supabase-migration plans → `archive/legacy-architecture/` |
| `docs/superpowers/specs/**` (excl. duplicate, `design-system.md`, workflow design) | 23 | `archive/completed-specs/` — except the ~6 Supabase-migration designs → `archive/legacy-architecture/` |
| `tester/REPORT_2026-06-28.md` | 1 | `archive/workflow-runs/` |
| `docs/governance/audit/**` (this audit) | 5 | `archive/workflow-runs/` **after** migration completes |

Each archived file gains a 3-line header. **No content is edited.** Historical documents remain
historically accurate, including where they describe Supabase as current — that was true when written.

### Files proposed for deletion (the only destructive operations in this plan)

| File | Information lost | Where preserved |
|---|---|---|
| `plans/2026-07-19-users-camps-sync 2.md` | **None.** `diff` against `plans/2026-07-19-users-camps-sync.md` is byte-identical | The sibling file, archived |
| `specs/2026-07-19-users-camps-sync-design 2.md` | **None.** Byte-identical to its sibling | The sibling file, archived |

Both remain recoverable from git history regardless. **If you prefer zero deletions, archive them
instead** — the cost is two permanently confusing filenames in the archive.

---

## 8. Files to replace with redirects

| Path | Redirect content |
|---|---|
| `SECURITY.md` | 5 lines → `standards/SECURITY_STANDARD.md` + `current/SECURITY_STATE.md`. **Must stay at root** for GitHub's security tab |
| `docs/superpowers/specs/design-system.md` | Pointer to `TOKEN_STANDARD.md` + `DESIGN_PRINCIPLES.md`. Three agent constitutions cite this path today; a redirect prevents a dangling reference during the transition |
| `docs/workflow/` and `docs/superpowers/` | One `README.md` each, stating where the content went. Removable once no reference remains |

---

## 9. External dependencies to bring into repository governance

| External file | Action | Rule after migration |
|---|---|---|
| `~/.claude/WORKFLOW_CONSTITUTION.md` | **Copy 10 rules verbatim, attributed and dated**, into `AGENT_WORKFLOW_CONSTITUTION.md` | Repository copy governs within this repo. Personal file stays as a cross-project default. **Neither is deleted; nothing is imported silently.** |
| `~/.claude/skills/domain-modeling/ADR-FORMAT.md` | Copy the format into `docs/adr/README.md` | Repo owns its ADR shape |
| `~50 global skills` | **Do not import** | Agents may name them; if absent, the agent proceeds and says so. Convenience, never authority. **Requires approval — U-11** |
| `~/.claude/CLAUDE.md` bootstrap paths (`CONTEXT.md`, `handoffs/`, `evidence/`, `architecture-reports/`) | **Do not create** | This repo diverged deliberately. `docs/work/task-state/` covers the same need. |

---

## 10. Stale active instructions requiring immediate correction

Ordered by risk. **Items 1–3 are the argument for approving something soon rather than nothing.**

| # | File | Correction | Risk if left |
|---|---|---|---|
| 1 | `.claude/agents/security.md` | Replace the entire Supabase threat surface with the real one | **Every security review audits an architecture that does not exist** |
| 2 | `.claude/agents/governor.md` L187, L206 | Stack is Electron/SQLite/LAN; isolation is single-camp-per-db, not RLS | The orchestrator's belief state is wrong; it propagates into every brief |
| 3 | `.claude/agents/maker.md` L70 | Delete the RLS line; state the real isolation invariant | The real invariant is absent from Maker's non-negotiables |
| 4 | `.claude/agents/governor.md` L289–297 + 7 dispatch lines | Fix all 9 agent paths to `.claude/agents/<name>.md` | Wrong by construction; encodes a false convention |
| 5 | `.claude/agents/grader.md` L58 | Re-anchor the Security=1 row to real critical classes | The loop's fail threshold is calibrated to retired failure modes |
| 6 | `.claude/agents/verifier.md` | Add `node test/integration/run.js` | The evidence gate can pass without the only cross-process suite |
| 7 | `.claude/agents/tester.md` + `tester/SCRIPT.md` + `maker.md` L37 | State what `localhost:5200` can and cannot prove; name `npm run electron:dev` | Verification in an environment that has already hidden a blocking defect |
| 8 | `.claude/agents/architect.md` L18, L43 | Point at `docs/adr/` and `docs/work/`, not `docs/superpowers/specs/` | Architect reads the historical directory for current architecture |
| 9 | `.claude/agents/grader.md` L594 | Output template lists 3 reports; body requires 4 | Code Reviewer's findings can silently vanish from the score |
| 10 | `CLAUDE.md` Commands | Add integration harness | Documented gate is invisible at the entry point |
| 11 | `docs/work/tickets/T6`, `T7` | Mark resolved, cite the fixing commits and the ADR | Two closed tickets read as open; T7 demands an ADR that exists |

---

## 11. Broken links and path references

| Issue | Count | Fix |
|---|---|---|
| Broken agent path references in `governor.md` | 9 | §10 item 4 |
| Broken markdown `[](…)` links | **0** — all 3 local link targets resolve | none |
| References to nonexistent directories (from `~/.claude/CLAUDE.md`) | 4 | §9 — do not create |
| Duplicate ` 2.md` files | 2 | §7 |
| Colliding basenames | 1 pair | §3 |
| Filenames containing spaces | 2 | §7 |

---

## 12. Human decisions required

Isolated, not guessed. **None of these is resolved in this audit.**

| # | Decision | Why it is yours | Audit's recommendation |
|---|---|---|---|
| **U-1** | Does the repo constitution override `~/.claude/WORKFLOW_CONSTITUTION.md` within this repo? | Governs how your personal defaults interact with project law across all your projects | **Yes — repo governs; personal file is a cross-project default.** Confidence: high |
| **U-2** | Is "Styler" a real intended role, or an obsolete term for Designer? | It appears in your own commissioning spec but nowhere in the repo | **Obsolete term; keep Designer, retire "Styler."** Confidence: medium — you may have wanted a post-implementation styling pass, which would need a new role and a constitution rule change |
| **U-3** | Confirm the canonical 10-agent roster and that no agent is renamed | Spec requires approval before any rename | **Keep all 10 names; deprecate "Reviewer" as an alias for Code Reviewer** |
| **U-4** | Has the retheme shipped? Do `src/index.css` and `src/styles/shared.js` hold the new token values? | Determines whether a caveat in 4 documents is current or stale | Unresolved — the audit was read-only over documents. **Requires a code check before `UI_STATE.md` is written** |
| **U-5** | Keep the Grader threshold at avg ≥ 4.0 / no dimension < 3? | A completion standard is a product decision | **Keep it.** Correct the rubric anchors only |
| **U-6** | Is `node test/integration/run.js` mandatory always, or only for sync/auth/schema classes? | Trades cycle time against coverage | **Mandatory for classes 5, 6, 7, 9; optional elsewhere.** Confidence: high |
| **U-7** | Is `localhost:5200` (dev mock) acceptable for Tester, or must UX validation run under `electron:dev`? | Determines what a Tester PASS means | **Dev mock for UX/layout; Electron mandatory before any completion claim involving persistence or sync.** Confidence: high |
| **U-8** | Create `PRODUCT_LANGUAGE_STANDARD.md` now? | Terminology is product judgement | **Not now** — no current content. Revisit if terminology drifts again |
| **U-9** | Is accessibility an intended standard? | The repo has almost none; creating the file implies a commitment | **Do not create an empty standard.** Record it as a known gap instead |
| **U-10** | Accept the precedence swap — code/test evidence above current-state documentation? | Changes how every future disagreement resolves | **Accept.** Confidence: high |
| **U-11** | Should agent constitutions keep depending on ~50 user-level skills? | Full portability would mean vendoring or removing them | **Keep as convenience, never authority** — an agent whose skill is missing proceeds and says so. Confidence: medium; full portability is a larger, separate piece of work |
| **U-12** | Delete the 2 byte-identical duplicates, or archive them? | The only destructive operation proposed | **Delete** — zero information loss, verified by `diff`, recoverable from git |

---

## 13. Ordered implementation steps

Each step is independently revertible. Later steps depend on earlier ones.

| Step | Work | Gate |
|---|---|---|
| **0** | Approve this plan; resolve U-1 … U-12 | human |
| **1** | Create `AGENT_WORKFLOW_CONSTITUTION.md` (copy the 10 rules) + `GOVERNANCE_INDEX.md` v1. **Nothing moves.** | index resolves; no dangling references |
| **2** | Correct stale instructions §10 items 1–3 (security.md, governor.md, maker.md) **in place** | agents dispatch; test+lint+build green |
| **3** | Correct §10 items 4–11 (paths, rubric, gates, tickets) | governance-lint v1 green |
| **4** | Promote standards: `TOKEN_STANDARD` · `DESIGN_PRINCIPLES` · `SECURITY_STANDARD` · `ARCHITECTURE_STANDARD` · `TESTING_STANDARD` · `PRODUCT_PRINCIPLES`. Leave redirects | every standard reachable from the index |
| **5** | Remove the now-duplicated blocks from agent constitutions; replace with links | no fact has two homes |
| **6** | Create `docs/current/`; move `PLATFORM_STATE.md`; write `SECURITY_STATE.md` + `UI_STATE.md`; update 4 referrers | all references resolve |
| **7** | Create `docs/work/`; move `docs/workflow/**`; add lifecycle frontmatter; close T6/T7 | frontmatter check green |
| **8** | Create `docs/archive/`; move 48 historical files with notices; resolve duplicates per U-12 | link check green; no active doc references an archived path |
| **9** | Add the manifest header to `task-state/`; adopt it for the next real task | manifest check green |
| **10** | Implement deterministic safeguards (link, frontmatter, agent-name, stale-tech, mock-parity) | all green in CI |
| **11** | Condense `CLAUDE.md` to entry point + index link | `CLAUDE.md` links to the index; nothing lost that is not elsewhere |
| **12** | Archive `docs/governance/audit/**` | done |

---

## 14. Rollback strategy

1. **All work on a branch** (`governance/consolidation`), never on `main`.
2. **One commit per step**, each self-contained and revertible with `git revert`.
3. **Steps 1–3 are pure additions and in-place corrections** — no moves. Reverting them restores the exact prior state.
4. **All moves use `git mv`** so history follows the file and `git log --follow` still works.
5. **Redirects stay for the full migration window**; they are removed only in a final, separately-revertible commit after CI confirms zero references.
6. **No deletion before step 8**, and the only two deletions are verified byte-identical duplicates.
7. **Checkpoint after step 3.** Steps 1–3 deliver the entire safety benefit with zero structural churn; if steps 4–12 prove disruptive, the project stops there and is strictly better off.

---

## 15. Recommended smallest safe first migration step

> **Step 2 alone: correct the three stale architecture instructions, in place, in one commit.**
> `.claude/agents/security.md` (rewrite the threat surface from `SECURITY.md` + the three auth ADRs),
> `.claude/agents/governor.md` L187/L206, `.claude/agents/maker.md` L70.

**Why this and not step 1.** Step 1 (creating the constitution and index) is the architecturally
correct beginning and should follow immediately — but it is *additive*: it improves nothing that is
currently wrong. Step 2 is the only step that stops an active, ongoing harm. Every security review
run today audits a backend that was deleted, and the review that would catch a real Ed25519 or
`authorize()` flaw has no instruction telling it to look.

**Why it is safe:**
- Three files, no moves, no renames, no deletions, no new directories.
- Touches no application code — `npm run test`, `lint`, and `build` are unaffected by construction.
- Fully revertible with one `git revert`.
- Requires **no** unresolved human decision. It is factual correction, not product judgement: the source of truth (`SECURITY.md`, the three ADRs, `CLAUDE.md`) already exists in the repo and is already current.
- It does not pre-commit you to the hierarchy, the naming convention, or any rename. If you reject everything else in this plan, this correction is still right.

**Estimated scope:** ~60 lines changed across 3 files.
**Verification:** Security agent's threat surface maps 1:1 to `SECURITY.md`'s hardened areas and known limitations; `grep -i "supabase\|RLS\|get_my_camp_id\|service.role\|anon key" .claude/agents/` returns only intentional historical references.

---

## 16. Estimated context reduction

| Measure | Today | After | Change |
|---|---|---|---|
| Always-loaded (`CLAUDE.md`) | 59 lines | ~35 lines | −40% |
| Typical UI task context | ~680 lines | ~480 lines | **−30%** |
| Duplicated token/style material | ~180 lines across 4 files | 0 | **−100%** |
| Security-task context relevance | ~0% accurate | ~100% accurate | the actual point |
| Historical files reachable as instruction | 48, unlabelled | 0 (all labelled, all excluded by the matrix) | **−100%** |
| Facts with more than one authoritative home | ≥ 6 | 0 | **−100%** |

**Honest caveat:** total repository line count barely changes — archiving preserves everything, and
the index and standards add new lines. The gain is in *duplicated authority eliminated* and
*correctness restored*, not in bytes. Fewer files was explicitly not the success metric, and it
should not be reported as one.

---

## 17. Risks created by this migration

| Risk | Severity | Mitigation |
|---|---|---|
| **Moving `.claude/agents/` would break agent discovery** | Would be critical | **Not proposed.** Agents stay put; only bodies change |
| Moving `PLATFORM_STATE.md` breaks 4 referrers | Medium | Same-commit updates + link check in CI |
| A session mid-migration loads a half-migrated tree | Medium | Branch-only work; redirects at every moved path; steps 1–3 are additive |
| Splitting `SECURITY.md` breaks the GitHub security tab | Medium | Root `SECURITY.md` retained as a pointer |
| Archiving 48 files makes genuinely useful history harder to find | Medium | `archive/legacy-architecture/` keeps the migration series as one legible story; index question 10 names archive locations |
| The new `SECURITY_STANDARD.md` is written from documents rather than code | **Medium-high** | It must be validated against `electron/auth/**` by the Security agent before adoption. **This audit read documents, not the auth implementation** |
| The retheme caveat is propagated into `UI_STATE.md` without verification | Medium | Blocked on U-4 — verify against `src/index.css` first |
| Six new standards become six new things to keep current | Medium | `review_trigger` frontmatter + the doc-freshness hook; create none without real content |
| Precedence change (code above current-state) misread as "code overrides standards" | **High** | Stated explicitly and prominently in the index; it is the model's most misreadable rule |
| Governance churn during active feature work (T8, T9, T10 open) | Medium | Steps 1–3 are ~4 files; defer steps 4–12 past the open tickets if preferred |
| The audit itself becomes stale governance | Low | Step 12 archives it |

---

## 18. What this audit did not do

Stated plainly, so the plan is not read as more authoritative than its evidence:

- **Did not read the auth implementation.** `SECURITY_STANDARD.md` content is derived from `SECURITY.md` and the ADRs, which the audit judged current from dates and consistency — not from `electron/auth/**`.
- **Did not verify the retheme status** against `src/index.css` (U-4).
- **Did not read all 48 historical documents end to end.** They were classified by title, header, date, and directory. If a durable standard is buried in one of them beyond the nine listed in Inventory §H, this audit would not have found it.
- **Did not dispatch the agent team.** The spec's mandatory workflow calls for Governor to orchestrate Reviewer, Security, Red Hat, and a Verifier-equivalent; the user's direct instruction for this session was to run the audit inline. Per the constitution, explicit human instruction outranks a spec's process requirement — but it means these findings are **one agent's analysis, not an independently reviewed one**. Independent review before executing steps 4–12 is recommended.
- **Ran no Grader pass** — appropriate, since the spec gates Grader on the audit deliverables existing, which is only now true.
