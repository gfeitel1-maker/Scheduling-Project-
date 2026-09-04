---
title: "Portable agent-team compatibility layer: generate the twelve native agent profiles from a reusable role source plus a Shoresh adapter"
document_type: adr
authority: normative
status: accepted
date: 2026-09-04
supersedes: []
implementation_state: in-progress
affects: [.claude/agents/code-reviewer.md, .claude/agents/red-hat.md, .claude/agents/security.md, .claude/agents/verifier.md, .claude/agents/grader.md, .claude/agents/architect.md, .claude/agents/architecture-auditor.md, .claude/agents/design-auditor.md, .claude/agents/designer.md, .claude/agents/governor.md, .claude/agents/maker.md, .claude/agents/tester.md, scripts/generateAgentProfiles.js]
---

# Portable agent-team compatibility layer

## Context

`docs/work/handoffs/2026-09-04-portable-agent-team-handoff.md` (source: an external handoff
document, not yet committed to this repo — see note below) proposes abstracting Shoresh's twelve
role definitions, routing policy, and memory rules into a reusable package
(`~/.claude/organization/`) that can be composed with a project-specific adapter to generate this
project's `.claude/agents/*.md` files, so the same durable expertise is reusable across projects
without copy-paste drift.

A live-audit agent (2026-09-04, this session) reconciled that document's claims against the
current repository and confirmed:

- All twelve roles named in `CONSTITUTION.md:146` ("This roster is authoritative; `.claude/agents/`
  must match it exactly") exist and match exactly.
- Five profiles — `code-reviewer`, `red-hat`, `security`, `verifier`, `grader` — declared
  `tools: Read, Grep, Glob, Bash` in frontmatter while their bodies mandate a `Skill` tool call as
  a non-negotiable first step. That is a live contradiction: a restricted-tool subagent cannot
  reliably do what its own instructions require. Fixed in this ADR's diff (see below) — this is a
  narrow, reversible correction to existing profiles, not a role addition/removal/rename, so it
  does not itself require a constitutional amendment.
- `docs/governance/constitution/CONSTITUTION.md` Article VII commits to dynamic Governor routing,
  not a fixed pipeline — the proposal's target architecture is consistent with this, not a
  replacement of it.
- The GateReport reducer (`scripts/gateReportReduce.js` etc.), two-round cap, and promotion gates
  are all live and unaffected by anything proposed here.

This ADR only covers **Phase 0 fix + Phase 1 proposal** from that handoff document. It does not
authorize Phase 2 (skill-loading rework), Phase 3 (memory retrieval/provenance), Phase 4 (task
envelopes/gate adapters), Phase 5 (pilot), or any Addy Osmani `agent-skills` adoption. Each of
those remains a separate decision requiring its own review.

## Decision

**Fix now (this diff, already applied in this worktree):**

Add `Skill` to the tool allowlist of the five affected agents:

```
.claude/agents/code-reviewer.md  tools: Read, Grep, Glob, Bash → Read, Grep, Glob, Bash, Skill
.claude/agents/red-hat.md        tools: Read, Grep, Glob, Bash → Read, Grep, Glob, Bash, Skill
.claude/agents/security.md       tools: Read, Grep, Glob, Bash → Read, Grep, Glob, Bash, Skill
.claude/agents/verifier.md       tools: Read, Grep, Glob, Bash → Read, Grep, Glob, Bash, Skill
.claude/agents/grader.md         tools: Read, Grep, Glob, Bash → Read, Grep, Glob, Bash, Skill
```

No other line in any of the five files changes. Role mandate, output contract, and report
destination (Grader vs. Governor) are untouched.

Known related gap, **not fixed here, flagged for a separate decision**: `security.md`'s body
mandates invoking a `security-review` skill (line 36) that does not exist anywhere under
`~/.claude` (confirmed by the live audit). Adding the `Skill` tool lets Security *attempt* the
call; it will still fail to find the skill. Resolving this requires either (a) writing a
Shoresh-owned `security-review` skill, or (b) adopting an adapted version of Addy Osmani's
`security-and-hardening` skill per the handoff's Part B — both are Phase-2-scope decisions, out of
this ADR.

**Propose for approval (not yet built):**

Stage, in a disposable branch/worktree, a compatibility layer that *generates* the same twelve
native `.claude/agents/*.md` files from (a) a versioned generic role source and (b) a Shoresh
project-adapter binding, such that:

- Generated file content is byte-for-byte equivalent to the current hand-written files (a diff of
  zero is the acceptance test for this phase — no behavior change).
- Each generated file records its source package version and adapter hash in frontmatter or an
  adjacent manifest.
- Role names, tool allowlists, model assignments, and report-routing (who reports to whom) are
  unchanged from today.
- `docs/governance/constitution/CONSTITUTION.md`, `GOVERNANCE_INDEX.md`, the GateReport reducer,
  and the two-round cap are untouched — this phase only changes *how the twelve profile files are
  produced*, not their content or the authority that governs them.
- The `shoresh-config` worktree's distribution mechanism (plain-copy `.claude/agents/*.md`, kept in
  sync with main) is inventoried but not altered in this phase.

This is a **behavior-preserving refactor of profile generation**, not a role or authority change,
so it does not on its own trigger Article IV's "renaming, adding, or removing an agent" gate — but
because it is an architecture change to how project authority is composed, it is presented here as
an ADR for approval before implementation, per Article IV's "an architecture change without an
accepted ADR" gate.

## Consequences

- If accepted: Phase 1 implementation proceeds in an isolated worktree; a validator diffs generated
  output against the current files and fails closed on any divergence; nothing merges to `main`
  until that parity is demonstrated and a human has reviewed the generator source.
- If rejected or deferred: the five-agent tool/Skill fix (already applied in this worktree) can
  still be cherry-picked and merged independently — it stands on its own as a bug fix, not
  conditioned on the rest of this ADR.
- No change to production application behavior (`src/`, `electron/`) results from either part of
  this ADR.

## Rollback

**Tool/Skill fix:** `git checkout <pre-fix-sha> -- .claude/agents/code-reviewer.md
.claude/agents/red-hat.md .claude/agents/security.md .claude/agents/verifier.md
.claude/agents/grader.md` restores the five original files verbatim. No other state (memory, gate
reports, `shoresh-config`) is touched by this fix, so rollback is single-command and total.

**Compatibility layer (if later built):** disable the generator/adapter and keep using the
hand-written `.claude/agents/*.md` files already in the repo — they are not deleted or replaced by
the generator's existence, only optionally regenerated from it. Restoring prior behavior requires
no data migration because the generated output is defined to be identical to today's files.

## Phase 1 status (shipped)

Built rather than only proposed, because the actual generic/project split turned out small,
concrete, and independently verifiable — not the open-ended design work the rest of Phase 1
implied:

- **Reusable fragment source:** `~/.claude/organization/VERSION` (`0.1.0`) and
  `~/.claude/organization/fragments/SKILL_MANDATE_WRAPPER.md`. That fragment is the one piece of
  content found to be byte-identical, word-for-word, across ten of the twelve profiles
  (`code-reviewer`, `red-hat`, `security`, `verifier`, `grader`, `architect`, `designer`,
  `governor`, `maker`, `tester` — `architecture-auditor` and `design-auditor` have no such block
  and pass straight through). It is the "invoke your mandated skills via the `Skill` tool before
  doing anything else" compulsion text — genuinely project-agnostic; nothing about it names
  Shoresh, SQLite, or camps.
- **Project bindings:** `docs/governance/agent-bindings/*.md`, one per role, each the full current
  profile with the shared wrapper replaced by a `{{SKILL_MANDATE_WRAPPER}}` placeholder (verbatim
  for the two pass-through roles). This is genuinely everything else — the per-role skill list,
  BDI framing, domain knowledge, output contracts — none of it generalizes yet; it stayed exactly
  as specific as it already was.
- **Generator/validator:** `scripts/generateAgentProfiles.js`. `npm run agents:check` (default) generates
  in memory and diffs against the committed `.claude/agents/*.md`, exiting non-zero on any
  divergence — this is the acceptance test named above, and it currently passes for all twelve
  roles. `npm run agents:generate` writes the generated output and
  `docs/governance/agent-bindings/manifest.json` (per-role adapter/generated content hashes,
  keyed to the organization package's `VERSION`).
- **Not wired into `npm run verify` or `check:governance` yet.** It is a standalone script so this
  phase's blast radius stays limited to new files plus the already-approved tool/Skill fix; wiring
  it into the required gate list is a candidate follow-up, not assumed here.
- **Confirmed:** all twelve roles regenerate byte-for-byte identical to the profiles already on
  `main` — no role's tool access, model, mandate, or report routing changed as a side effect of
  this refactor.

What Phase 1 did **not** do, deliberately: no attempt to further generalize the per-role bindings
(they are 100% Shoresh-specific content today, just reorganized), no `departments.json` or
`capabilities.json` from the handoff's proposed `organization/` layout (nothing yet needs them),
and no change to `shoresh-config`'s distribution mechanism. The second-project portability test
the handoff document calls for — proving the `SKILL_MANDATE_WRAPPER` fragment binds cleanly to a
different project's roster without a Shoresh adapter — is unstarted and would be the natural next
slice before claiming actual portability rather than just a cleaner Shoresh-local build.

## Note on provenance

The source handoff document lives outside this repository at
`/Users/gregfeitel/Documents/Codex/2026-09-04/referenced-chatgpt-conversation-this-is-an/outputs/portable-agent-team-handoff.md`
and is not itself committed here. This ADR summarizes only the portion of it acted on so far
(Phase 0 audit + the tool/Skill fix + the Phase 1 proposal). Later phases, if pursued, should get
their own ADRs rather than blanket-approving the source document.
