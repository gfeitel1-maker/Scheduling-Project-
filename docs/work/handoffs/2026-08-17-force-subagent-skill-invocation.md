---
task: "Make dispatched subagents reliably invoke their skills (enforcement, not new skills)"
document_type: handoff
status: completed
created: 2026-08-17
completed: 2026-08-18
---

# Handoff — force subagent skill invocation

## Root cause (verified 2026-08-17, do not re-litigate)
Dispatched subagents produce off-brand / skill-ignoring work even though every agent-def has a
`## Skills — invoke in this order` section. An introspection test confirmed: a dispatched subagent
**HAS the `Skill` tool, SEES the full skills menu, and receives NO `SUBAGENT-STOP` clause** — so it is
fully able to invoke skills. The gap is **enforcement, not capability**: the MAIN session gets the
forceful `using-superpowers` startup injection ("invoke skills BEFORE any response — not negotiable"),
but a dispatched subagent does NOT — it only has its agent-def's polite ordered list, which it skips
under "just produce the deliverable" pressure. Full detail: memory `reference-subagent-skill-loading`.

## How to run
- Launch at `~/dev/shoresh`, route through the **Governor loop**, worktree isolation. Agent defs are
  git-tracked there; changes reach all sessions only after merge to `main` → the `~/dev/shoresh-config`
  sync ([[reference-agent-config-worktree]]). Land it on main.
- Governance gate applies (ship any status flip in the same branch).

## Scope
1. **In every project agent-def** (`governor, architect, maker, designer, code-reviewer, tester,
   security, red-hat, grader, verifier` — all 10 have a `## Skills` section), rewrite that section's
   framing from a polite "invoke in this order" LIST into a **forceful, first-action MANDATE**: the
   subagent MUST invoke the load-bearing skill(s) as step 0, before producing its deliverable, and
   this is non-negotiable — mirror the `using-superpowers` enforcement language, adapted per agent.
   Keep the SAME skills each agent already names; only strengthen the compulsion. Put the mandate at
   the TOP of the agent's instructions, not buried mid-file.
2. **Governor dispatch convention:** update `governor.md` so that when it dispatches a subagent, it
   NAMES the specific load-bearing skill(s) that subagent must invoke in the brief (e.g. "Designer:
   invoke `impeccable` + `emil-design-eng` before speccing"). This is the belt-and-suspenders half —
   it worked immediately when done by hand on 2026-08-16.
3. **`designer.md` #4 `hallmark`:** confirm `hallmark` is an ENABLED skill (present on disk but may not
   be in the active list). If enabled, leave it; if not, drop the reference or swap to an enabled
   equivalent. Do not add new skills otherwise.

## Observable success predicate
- Each of the 10 agent-defs' `## Skills` section is a forceful first-action mandate (not a passive
  list), placed near the top of the file.
- `governor.md` instructs naming the load-bearing skill(s) in each dispatch brief.
- **Behavioural proof (required):** dispatch a `designer` subagent on a real UI task and show, from its
  transcript, that it actually CALLS the `Skill` tool for its ordered skills (e.g. `impeccable`) —
  not merely names them. A run where the subagent invokes skills is the pass; "the file says so" is not.
- Merged to `origin/main`.

## Non-goals
- Do NOT remove skills or change which skills any agent uses (only the enforcement strength).
- Do NOT touch the main-session `using-superpowers` skill or the harness — this is agent-def text only.
- Do NOT add the mandate to non-project/global agents.

## Return condition
Return when all 10 agent-defs carry the forceful mandate, governor.md names skills in dispatch briefs,
the `hallmark` question is resolved, the behavioural proof (a designer subagent actually invoking
`impeccable`) is captured, and it's merged to main.

## Pointers
- Memory: `reference-subagent-skill-loading` (root cause + verification method), `reference-agent-config-worktree`
- Agent defs: `~/dev/shoresh/.claude/agents/*.md`
- Enforcement model to mirror: the `using-superpowers` skill's "invoke BEFORE any response" language.

---

## Completion record (2026-08-18)

**Status: DONE — all scope items met, behavioural proof captured, merged to `main`.**

1. **Forceful first-action mandate in all 10 agent-defs.** Each `## Skills` section was retitled
   `## Skills — invoke via the `Skill` tool as STEP 0 (non-negotiable)` and given an
   `<EXTREMELY-IMPORTANT>` block mirroring `using-superpowers`: subagent's FIRST action must be an
   actual `Skill` tool call (naming/recalling doesn't count), names the deliverable-pressure trap,
   the "1% chance → invoke" rule, and "not negotiable". Same skills preserved per agent — only the
   compulsion was strengthened. Section already sits in each file's top third, ahead of the working
   procedure.
2. **Governor dispatch convention added.** `governor.md` carries a standing "Name the load-bearing
   skill(s) in every dispatch brief" block with a per-agent mapping table, plus inline reminders at
   the Designer / Maker / Parallel-Review dispatch phases.
3. **`hallmark` resolved.** It is present on disk (`~/.claude/skills/hallmark`) but NOT in the active
   Skill-tool menu (every other Designer skill is) → confirmed disabled. Swapped to the enabled
   `frontend-design` (matches "distinctive, non-generic, past templated defaults"). No new skills added.
4. **Behavioural proof (from the raw subagent transcript, not self-report).** A `designer` subagent
   dispatched on a real UI task (design a setup-screen empty state) made four real `Skill` tool calls
   in order — `clarify → design-dna → impeccable → emil-design-eng`. Its **first two tool calls of the
   whole run were `Skill:clarify` then `Skill:design-dna`, before any `Read`/`Bash`** — i.e. skills
   invoked as step 0, exactly as the mandate demands. Verified by parsing the subagent transcript
   `~/.claude/projects/.../subagents/agent-a888cab889c1e6095.jsonl` for `tool_use` entries with
   `name:"Skill"`, not by trusting the agent's own "SKILL INVOCATIONS" summary.

`check:governance` clean. Behaviour-only change to agent-def text; no code/tests touched.
