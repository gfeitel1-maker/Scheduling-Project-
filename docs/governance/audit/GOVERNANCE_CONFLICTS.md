# Governance Conflicts — Shoresh

**Produced:** 2026-07-28 · **Phase:** read-only audit · **Status:** proposal, no file modified

Conflicts are ordered by **whether they change agent behaviour today**, prioritising those that can
alter agent routing, architecture decisions, security review, design decisions, or completion standards.

---

## Severity key

| Level | Meaning |
|---|---|
| **C1** | Actively misdirects an agent today, in a category the audit was asked to prioritise |
| **C2** | Will misdirect under a plausible near-term task |
| **C3** | Ambiguity, duplication, or drift risk; no live misdirection yet |

---

# Part 1 — Conflicts that change agent behaviour today

## C1-1 — The Security agent audits an architecture that no longer exists
**Category: security review**

| | |
|---|---|
| Competing sources | `.claude/agents/security.md` L36–46 · `SECURITY.md` (whole) · `CLAUDE.md` L28 · ADRs 2026-07-24/25 |
| Apparent authority | `security.md` is an *active agent constitution* — loaded on every security dispatch. `SECURITY.md` is not referenced by it at all. |
| Current implemented reality | Electron + SQLite + `ws://` LAN sync. Auth is local PIN + scrypt + Ed25519 Host-minted camp tokens + HMAC local tokens, gated by `authorize()` and a device-pairing flow. No Supabase, no RLS, no anon key, no service-role JWT. `@supabase/supabase-js` is not a dependency; an ESLint rule bans reintroducing it. |
| The conflict | `security.md`'s entire "Always check" list is Supabase-era: *"RLS bypass: New Supabase queries must not use the service role key… All queries must flow through the anon key with RLS enforced via `get_my_camp_id()`"*; *"SQL injection: Not applicable (using Supabase client with parameterized queries)"*; *"JWT exposure: Service role JWT…"*. Its "Known accepted exceptions" instructs the agent not to flag *"Service role key in `.env` file (local dev bypass — documented in CLAUDE.md)"* — an exception for a key that no longer exists, documented in a CLAUDE.md section that no longer says that. |
| Behavioural consequence | Every Security dispatch audits a dead threat surface and **has no instruction covering the live one**: plaintext PIN over `ws://`, pairing approval, Ed25519 key handling, `authorize()` bypass, IPC surface, packaging, audit-log integrity. The "SQL injection: not applicable" line is now **affirmatively wrong** — `better-sqlite3` executes raw SQL throughout `electron/db/`. |
| Recommended authoritative source | `SECURITY.md` (split into `SECURITY_STANDARD.md` + `docs/current/SECURITY_STATE.md`), with `security.md` reduced to role discipline that *links* to it. |
| Human decision required | **No** — this is a factual correction, not a product judgement. |
| Affects agent behaviour today | **Yes.** |

---

## C1-2 — Governor's team table points at nine filenames that do not exist
**Category: agent routing**

| | |
|---|---|
| Competing sources | `.claude/agents/governor.md` L289–297 (team table) and L362, L387, L393, L399–402, L408, L416 (dispatch instructions) · actual `.claude/agents/*.md` filenames |
| The conflict | Governor instructs *"Dispatch Architect (`agents/ARCHITECT.md`)"*, *"dispatch Designer with `agents/DESIGNER.md` as brief"*, and names `agents/MAKER.md`, `agents/TESTER.md`, `agents/SECURITY.md`, `agents/REDHAT.md`, `agents/CODEREVIEWER.md`, `agents/VERIFIER.md`, `agents/GRADER.md`. **All nine paths are wrong in three separate ways**: wrong directory (`agents/` not `.claude/agents/`), wrong case (uppercase vs. lowercase-kebab files), and for two of them wrong name entirely (`REDHAT.md` vs `red-hat.md`; `CODEREVIEWER.md` vs `code-reviewer.md`). Verified: 0 of 9 resolve. |
| Why it has not yet broken loudly | Claude Code discovers agents by the `name:` frontmatter field, not by these paths, and every `name:` is correct. So dispatch works **despite** the constitution, not because of it. |
| Behavioural consequence | Any agent (or human) that tries to *read* a peer constitution at the stated path gets nothing and must guess. It also encodes a false naming convention: a future agent added as `agents/STYLER.md` per this pattern would not be discovered at all. On a case-sensitive filesystem the divergence is permanent and silent. |
| Recommended authoritative source | The filesystem. Governor's table must be corrected to `.claude/agents/<name>.md`. |
| Human decision required | **No.** |
| Affects agent behaviour today | **Yes** (routing documentation is wrong; dispatch survives by accident). |

---

## C1-3 — The design token contract exists in four independently-drifting copies
**Category: design decisions**

| | |
|---|---|
| Competing sources | `docs/superpowers/specs/design-system.md` (self-declared *"Status: Authoritative"*) · `governor.md` L460–475 · `maker.md` L36–54 · `designer.md` L210–235 |
| Apparent authority | All four assert authority. Three of them *also* correctly name `design-system.md` as canonical — then restate its contents verbatim anyway. |
| The conflict | Full hex palette, activity colour array, font vars, motion tokens, and the deprecation of `--purple`/`--yellow-green` are copied into three agent constitutions. Today the copies agree. There is no mechanism keeping them agreeing: editing `design-system.md` leaves three stale copies that agents will read *in preference to it*, because they arrive in the agent's own constitution. |
| Aggravating factor | All four also carry the "retheme not yet applied — `src/index.css` still holds the OLD vivid values" caveat. That is a **volatile current-state fact embedded in four normative documents**. When the retheme ships, four files become wrong simultaneously, and a Designer/Maker reading a stale caveat will avoid using tokens that are by then live. |
| Recommended authoritative source | One `TOKEN_STANDARD.md` (values + semantics) + `DESIGN_PRINCIPLES.md` (personality/motion doctrine). Agents link; they do not restate. The retheme-status caveat moves to `docs/current/UI_STATE.md`, the one place a volatile fact belongs. |
| Human decision required | **No** for the structure. **Yes** for one question: is the retheme still pending? (see Unresolved Decision U-4) |
| Affects agent behaviour today | **Yes** — every UI-significant task loads three copies of the same palette, and the shared retheme caveat is unverified. |

---

## C1-4 — The highest workflow authority is outside the repository
**Category: agent routing, completion standards**

| | |
|---|---|
| Competing sources | `~/.claude/WORKFLOW_CONSTITUTION.md` (10 rules, 12 lines, outside the repo) · five agent constitutions that cite it as binding · no repository equivalent |
| Apparent authority | Maximal, and explicitly so. `governor.md` L299: *"Its ten rules are the standing law this entire loop exists to enforce; where anything below is silent on a case, the Constitution decides, not your own judgment."* |
| The conflict | The repository declares a document it does not contain to be supreme over everything it does contain. Four agents partially transcribe it (`code-reviewer.md` L110–114, `verifier.md` L1010–1014, `architect.md` L49–51, `grader.md` L491) — partial, paraphrased, and non-identical copies of law that only exists on one machine. |
| Behavioural consequence | On a fresh clone, or for any collaborator, or in any environment without this user's home directory: the constitution is absent, the citations dangle, and the four partial transcriptions become the *de facto* law — four differing subsets of ten rules, with no way to detect the loss. |
| Recommended resolution | Copy the ten rules into repo-owned `docs/governance/constitution/AGENT_WORKFLOW_CONSTITUTION.md` as the authoritative source. Leave `~/.claude/WORKFLOW_CONSTITUTION.md` in place as a personal default that **explicitly defers to the repository copy where they differ**. Do not delete or import silently. Agents cite the repo path. |
| Human decision required | **Yes** — see U-1. The repo copy and the personal file may legitimately diverge later; you must decide the precedence rule. |
| Affects agent behaviour today | **Yes** on any machine but this one; latent here. |

---

## C1-5 — Maker's hard constraints contain a retired database rule
**Category: architecture decisions**

| | |
|---|---|
| Competing sources | `.claude/agents/maker.md` L69–71 (### Database) · `CLAUDE.md` L30 · `PLATFORM_STATE.md` L146 |
| The conflict | Maker's non-negotiable Database section reads: *"Table: `template_slots` (not `schedule_slots`) · **RLS via `get_my_camp_id()`** · DB-loaded objects use snake_case."* Line 1 and line 3 are correct and useful. Line 2 is a Postgres row-level-security policy from the retired backend, stated as a hard constraint on implementation. |
| Current implemented reality | `CLAUDE.md` L30: *"Data isolation is enforced by the app being single-camp-per-device-db … **not by RLS**."* `PLATFORM_STATE.md` L146: *"no table is Supabase-backed anymore."* |
| Behavioural consequence | Two-sided. A Maker taking the constraint literally could attempt to satisfy a nonexistent mechanism; more likely, it **displaces the real isolation rule** — that every `camps` lookup is `SELECT … FROM camps LIMIT 1`, and that `camp_id` projection is guarded (`plans/2026-07-25-camp-id-projection-guard.md`, now shipped). The genuinely load-bearing invariant is absent from the one document Maker treats as non-negotiable. |
| Recommended authoritative source | `ARCHITECTURE_STANDARD.md` for the isolation invariant; Maker links to it. |
| Human decision required | **No.** |
| Affects agent behaviour today | **Yes.** |

---

## C1-6 — Grader's security rubric floor describes retired failure modes
**Category: completion standards**

| | |
|---|---|
| Competing sources | `.claude/agents/grader.md` L58 · `SECURITY.md` |
| The conflict | Grader's Security score of **1** — the value that forces a FAIL regardless of average — is defined as *"Critical unmitigated vulnerability — RLS bypass, data isolation failure, JWT exposure."* Two of those three are Supabase-era. The real critical-severity classes for this app (Ed25519 private-key leakage off the Host, `authorize()` bypass, forged pairing approval, device-revocation bypass) have no rubric anchor. |
| Behavioural consequence | The pass/fail threshold for the entire loop is calibrated against the wrong failure taxonomy. A real Host-key exposure has no rubric row that obviously scores 1. |
| Recommended authoritative source | Rubric anchors derived from `SECURITY_STANDARD.md`. |
| Human decision required | **No** for the correction. **Yes** if you want the threshold itself revisited (U-5). |
| Affects agent behaviour today | **Yes.** |

---

## C1-7 — Governor's Project Context states the retired stack
**Category: architecture decisions**

`governor.md` L187: *"**App:** Shoresh camp scheduling app — React 19 + Vite frontend, **Supabase local Docker**"*, and L206: *"**DB:** `template_slots` table (not `schedule_slots`). **RLS via `get_my_camp_id()`**."*

This is the orchestrator's own belief state about what it is building. It contradicts `CLAUDE.md` L28, `README.md`, `PLATFORM_STATE.md`, and five ADRs. Because Governor classifies tasks and decides which agents to dispatch, a wrong stack belief propagates into every brief it writes. **Affects agent behaviour today: yes.** No human decision required.

---

## C1-8 — Verifier's gate list and README's gate list disagree
**Category: completion standards**

| | |
|---|---|
| Competing sources | `.claude/agents/verifier.md` L1020–1026 · `README.md` "Tests" · `package.json` |
| The conflict | Verifier's mandatory minimum is `npm run test`, `npm run lint`, `npm run build`. `README.md` documents a fourth required gate: `node test/integration/run.js` — *"16 multi-process integration scenarios … cross-process behavior (pairing, revocation, token renewal, conflict detection, clock skew, role changes) **that Vitest's single-process model cannot verify**."* Verifier never names it. |
| Behavioural consequence | The deterministic evidence gate can return **PASS** on a sync-protocol, pairing, or revocation change without running the only suite that covers cross-process behaviour — precisely the class of change most likely to break it. Per the constitution's *"Missing evidence is disclosed and never converted into a passing result,"* this is a live gap in the gate that enforces that rule. |
| Aggravating factor | `CLAUDE.md`'s Commands section also omits the integration harness, and omits the `electron-rebuild` / `npm rebuild` dance around it — which README does document. |
| Recommended authoritative source | `TESTING_STANDARD.md`, single owner of the gate list; Verifier and CLAUDE.md both derive from it. |
| Human decision required | **Yes, small** — is the integration harness mandatory for all changes or conditional on touching sync/auth? (U-6) |
| Affects agent behaviour today | **Yes.** |

---

## C1-9 — Tester validates in an environment documented as unfaithful
**Category: completion standards, design decisions**

| | |
|---|---|
| Competing sources | `.claude/agents/tester.md` L27 · `tester/SCRIPT.md` L10 · `tester/DIRECTOR_BRIEF.md` L11 · `maker.md` L37 · `governor.md` L129 · `PLATFORM_STATE.md` L209 |
| The conflict | Five active instructions send verification to `http://localhost:5200` — which is `npm run dev`: **the browser, with no Electron and no `window.shoresh`**, therefore running `src/localClient.mock.js`. `PLATFORM_STATE.md` L209 records that this mock was, until recently, *write-blind* — every create silently no-op'd — and that this defect *"could never be caught"* in that environment. It also notes *"all mock changes are dev-only (`window.shoresh` bypasses the mock entirely in Electron)."* |
| Behavioural consequence | Tester's UX evidence and Maker's `verification-before-completion` gate both run against a simulator whose divergence from the real app has already produced one project-blocking miss. Neither document mentions `npm run electron:dev`. |
| Recommended resolution | State the two environments and what each can prove, in `TESTING_STANDARD.md`. |
| Human decision required | **Yes** — U-7. |
| Affects agent behaviour today | **Yes.** |

---

# Part 2 — Conflicts that will bite soon

## C2-1 — Agent-name drift: the team roster has three incompatible versions
**Category: agent routing**

| Source | Roster |
|---|---|
| **Filesystem** (`.claude/agents/`, authoritative for dispatch) | architect, code-reviewer, designer, governor, grader, maker, red-hat, security, tester, verifier — **10** |
| **`governor.md` team table** | Architect, Designer, Maker, Tester, Security, Red Hat, Code Reviewer, Verifier, Grader — **9** (Governor itself excluded; paths all broken, see C1-2) |
| **`specs/2026-07-19-multi-agent-workflow-design.md`** (*"Approved — implementing"*) | Governor, Designer, Maker, Tester, Security, Red Hat, Grader — **7**. **No Architect. No Verifier. No Code Reviewer.** |
| **`~/.claude/CLAUDE.md` bootstrap template** | Governor, Designer, Architect, Maker, Verifier, Code Reviewer, Tester, Security, Red Hat, Grader — **10, matches the filesystem** |
| **The commissioning spec for this audit** | Governor, Maker, **Reviewer**, Tester, **Styler**, Security, Red Hat, Grader — **8** |

Resolving the terms the audit was asked to disambiguate, on evidence:

| Term | Verdict |
|---|---|
| **Reviewer** vs **Code Reviewer** | **Same role, two names.** No `reviewer.md` exists. `code-reviewer.md` covers plan alignment + maintainability. "Reviewer" is a conversational short form. |
| **Code Reviewer** vs **Verifier** | **Genuinely distinct, and the distinction is load-bearing.** `verifier.md` L989: *"Tester/Security/Red Hat/Code Reviewer form opinions from reading code and reasoning about it; you form nothing — you execute and report what actually happened."* Opinion vs. deterministic evidence. **Do not merge.** |
| **Tester** vs **Verifier** | **Distinct.** Tester = director's-eye UX/visual judgement (Haiku, browser). Verifier = machine-checkable gates. Both are "testing" in English; they are not the same jurisdiction. |
| **Designer** vs **Styler** | **`styler.md` does not exist.** The repository role is `designer.md` — visual *specification* before Maker, not styling after. "Styler" appears only in the commissioning spec and the example manifest. Recommend retiring the term; see U-2. |
| **Architect** | **Real, current, distinct** from Designer (technical structure vs. visual) and from Governor (design vs. routing). Absent from the 7-agent spec because it postdates it. |
| **Red Hat** vs **Security** | **Distinct and explicitly bounded.** `red-hat.md` L738: *"You do not find bugs. Security finds vulnerabilities. You find the thing everyone assumed was fine."* |

**Recommended authoritative source:** the filesystem, mirrored into `AGENT_WORKFLOW_CONSTITUTION.md`, with a deterministic check that the two agree.
**Human decision required: Yes** — U-2, U-3. **Do not rename any agent without approval.**

---

## C2-2 — Two parallel active-work hierarchies, neither labelled
**Category: agent routing**

`docs/superpowers/{plans,specs}` (50 files, last substantive write 2026-07-26) and `docs/workflow/{specs,task-state,tickets}` (13 files, live). No document states the relationship. `architect.md` L18 still cites `docs/superpowers/specs/` as where *"this project's existing architectural decisions"* live, and L43 endorses it as the ADR-substitute convention — while `docs/adr/` now holds five real ADRs and the live work is in `docs/workflow/`. An Architect following its own constitution reads the historical directory for current architecture. **Affects behaviour: soon, on the next architecturally-significant task.**

---

## C2-3 — 46 completed plans and designs are indistinguishable from current instruction
**Category: architecture, security, design**

None of the 46 historical documents carries a status marker or archive notice. `specs/2026-05-24-security-design.md` — *"Security Design: Auth, RLS, GitHub & Vercel"* — is a detailed, confident, fully-retired security architecture sitting in the same directory as `design-system.md`, which is genuinely authoritative. `plans/2026-07-21-renderer-supabase-migration-design.md` describes Supabase code paths in the present tense. A grep-driven agent has **no in-document signal** distinguishing them. This is the spec's hypothesis #13, confirmed.

Mitigating factor, worth crediting: the ESLint Supabase-import ban (`eslint.config.js` + `eslint.supabase-ban.test.js`) means a stale *code* instruction fails deterministically. There is no equivalent guard for a stale *governance* instruction — which is exactly why C1-1 survived.

---

## C2-4 — No ticket has a lifecycle; two are silently complete
**Category: completion standards**

T1–T5 have **no status field at all**. T6–T10 have `**Status:** CONFIRMED …` — a *diagnosis* marker, not a lifecycle state, with no vocabulary for "fixed."

- **T6** was fixed in `5e2c007` ("stop false-flagging UNFILLABLE"). Ticket still reads CONFIRMED.
- **T7** was fixed in `0a147ce`, and its stated blocker — *"Needs an ADR before implementation"* — was satisfied by `docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md`. Ticket still reads CONFIRMED and still demands the ADR that exists.

Git history is the only record of completion. No archival rule, no `archive_when`. Confirms hypothesis #8.

---

## C2-5 — `CLAUDE.md` and `PLATFORM_STATE.md` duplicate volatile architecture
**Category: architecture decisions**

Confirms hypothesis #3, with a nuance. The duplication is real: CLAUDE.md L30–48 restates the local-first model, the full `window.shoresh.*` IPC method list, the `buildSchedule` signature, the auth mechanism, and the screen-routing model — all covered in PLATFORM_STATE.md. But **both copies are currently accurate**; this is drift *risk*, not live contradiction. The specific hazard is the enumerated IPC list: adding one IPC method requires remembering to edit two files, and nothing enforces it. Severity **C3-going-on-C2**.

---

# Part 3 — Path, case, and duplication drift (Phase 2.3)

| Check | Result |
|---|---|
| Uppercase vs lowercase references | **9 failures** — Governor's entire team table (C1-2) |
| Markdown `[](…)` links | **All valid.** 3 distinct local link targets, all resolve |
| Backticked path references | **9 broken** (all C1-2). All other referenced files resolve, except intentionally-absent ones (`src/hooks/useSession.js`, `src/supabase.js`) which CLAUDE.md correctly labels as removed |
| References to nonexistent directories | `~/.claude/CLAUDE.md` prescribes `docs/workflow/{handoffs,evidence,architecture-reports}/` and `CONTEXT.md` — **none exist** |
| Duplicate ` 2.md` files | **2 found, byte-identical to their siblings** (`diff` clean): `plans/2026-07-19-users-camps-sync 2.md`, `specs/2026-07-19-users-camps-sync-design 2.md`. Both contain a **space** in the filename |
| Ambiguous spec/plan pairing | `docs/workflow/specs/designer-output-2026-07-26.md` names its date but not its parent spec; every `docs/superpowers` pair relies on a `-design` suffix convention that is applied inconsistently (`2026-05-23-schedule-iteration.md` exists as *both* a plan and a spec with **identical filenames** in different directories) |
| Agent names vs filenames | **Match** — all 10 `name:` fields equal their basenames. The drift is entirely in Governor's *references* |
| Case-insensitive-filesystem hazard | **Confirmed real.** macOS APFS is case-insensitive by default, which is why `agents/ARCHITECT.md` has never thrown. It would still fail here (wrong directory), and would fail differently on Linux CI |

---

# Part 4 — Duplication and context inflation (Phase 2.5)

Distinguishing **useful repetition** (an agent-local summary for execution) from **dangerous duplicated authority** (an independently-drifting restatement of volatile doctrine):

| Material | Copies | Verdict |
|---|---|---|
| Design token palette | 4 (`design-system.md` + 3 agents) | **Dangerous** — volatile hex values, no link-back mechanism |
| Retheme-pending caveat | 3 (governor, maker, design-system) | **Dangerous** — a current-state fact in normative docs |
| "Inline React styles only" | 4 (CLAUDE.md, governor, maker, designer) | **Useful but unowned** — stable rule, no authoritative home. Promote once, then link |
| Workflow constitution rules | 4 partial transcriptions | **Dangerous** — partial, non-identical copies of external law |
| `@dnd-kit` + `distance: 8` | 3 (CLAUDE.md, maker, designer) | **Borderline** — stable enough to tolerate; belongs in `ARCHITECTURE_STANDARD.md` |
| "Reviewers do not modify the work they review" | 3 (architect, code-reviewer, verifier) | **Useful** — each states it in its own role's terms; keep, but cite the constitution |
| Architecture summary | 3 (CLAUDE.md, README.md, PLATFORM_STATE.md) | **Tolerable** — README serves a different audience; CLAUDE.md's copy should shrink to a pointer |
| Director persona | 2 (`tester/DIRECTOR_BRIEF.md`, `tester.md` L32) | **Useful** — short summary + full reference is the correct pattern |

**Estimated always-loaded context today:** `CLAUDE.md` (59 lines) is auto-loaded; a UI-significant task additionally pulls `governor.md` (209) + `designer.md` (103) + `maker.md` (101) + `design-system.md` (212) ≈ **680 lines, of which roughly 180 are the same token/style material four times over**.

---

# Part 5 — Hypothesis verification (the 15 named in the spec)

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| 1 | Governor depends on `~/.claude/WORKFLOW_CONSTITUTION.md`, making governance non-portable | **CONFIRMED** | C1-4; 5 agents cite it; file exists only at user level |
| 2 | Security-agent instructions still describe retired Supabase architecture | **CONFIRMED — worst finding in the audit** | C1-1 |
| 3 | CLAUDE.md and PLATFORM_STATE.md duplicate volatile architecture | **CONFIRMED, low severity** | C2-5; both currently accurate |
| 4 | Governor references uppercase agent paths vs lowercase filenames | **CONFIRMED, and worse than stated** — also wrong directory, and 2 wrong names | C1-2 |
| 5 | Conversational and repository agent names have drifted | **CONFIRMED** | C2-1; five incompatible rosters |
| 6 | `docs/superpowers/{plans,specs}` are now primarily historical | **CONFIRMED, with 2 exceptions** — `design-system.md` and `multi-agent-workflow-design.md` are not historical | Inventory §E |
| 7 | Duplicate/ambiguous ` 2.md` variants exist | **CONFIRMED** — 2 files, byte-identical | Part 3 |
| 8 | Workflow specs/task-state/tickets lack lifecycle or archival rules | **CONFIRMED** | C2-4; 0 of 83 docs have lifecycle frontmatter |
| 9 | Current standards buried in task-specific specs | **CONFIRMED** | Inventory §H; 9 instances |
| 10 | Agent constitutions duplicate shared doctrine and drift independently | **CONFIRMED** | Part 4 |
| 11 | No canonical entry point for resolving document authority | **CONFIRMED** | No governance index exists; CLAUDE.md does not attempt one |
| 12 | Current-state facts manually duplicated in multiple files | **CONFIRMED** | Part 4; IPC list, token values, retheme status |
| 13 | Historical plans discoverable without non-authoritative labels | **CONFIRMED** | C2-3; 46 files, 0 notices |
| 14 | Dynamic workflow works but lacks cross-session observability | **PARTLY REFUTED — better than assumed** | `docs/workflow/task-state/2026-07-26-manual-grid-editing.md` already records classification, risk, and per-agent routing *with omission reasons*. It is one file, unnamed as a pattern, unenforced — but the practice exists |
| 15 | Reusable procedures mixed into constitutions that should be conditional skills | **CONFIRMED** | `tester/SCRIPT.md` (169-line regression script), `tester/DIRECTOR_BRIEF.md`, `designer.md`'s 11-step skill sequence |

**Not in the spec's list — additional findings from this audit:**

| # | Finding |
|---|---|
| 16 | **Verifier omits the integration harness** — the deterministic gate can pass without running the only cross-process suite (C1-8) |
| 17 | **Grader's rubric floor is calibrated to retired failure modes** (C1-6) |
| 18 | **Tester and Maker verify in the dev-mock environment**, which PLATFORM_STATE documents as having already hidden a project-blocking defect (C1-9) |
| 19 | **`tester/` is a top-level directory of governance material** sitting beside `src/` and `electron/` |
| 20 | **Two files share the identical basename** `2026-05-23-schedule-iteration.md` in `plans/` and `specs/`, defeating basename-only references |
| 21 | **`architect.md` points at the historical directory** for current architectural decisions (C2-2) |
| 22 | **Grader's output template contradicts its own body** — template says "Reports received: Tester, Security, Red Hat", body requires four inputs including Code Reviewer |
