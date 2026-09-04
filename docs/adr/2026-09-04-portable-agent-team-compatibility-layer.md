---
title: "Portable agent-team compatibility layer: generate the twelve native agent profiles from a reusable role source plus a Shoresh adapter"
document_type: adr
authority: normative
status: accepted
date: 2026-09-04
supersedes: []
implementation_state: in-progress
affects: [.claude/agents/code-reviewer.md, .claude/agents/red-hat.md, .claude/agents/security.md, .claude/agents/verifier.md, .claude/agents/grader.md, .claude/agents/architect.md, .claude/agents/architecture-auditor.md, .claude/agents/design-auditor.md, .claude/agents/designer.md, .claude/agents/governor.md, .claude/agents/maker.md, .claude/agents/tester.md, scripts/generateAgentProfiles.js, scripts/taskEnvelopeSchema.js, scripts/shadowGateEnvelope.js]
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

Related gap, since closed (see "Phase 1 status" below): `security.md`'s body mandates invoking a
`security-review` skill (line 36) that, at the time this ADR was first drafted, did not exist
anywhere under `~/.claude` (confirmed by the live audit). Adding the `Skill` tool let Security
*attempt* the call but it would still fail to find the skill. `~/.claude/skills/security-review/`
was written to close this — a Shoresh-owned methodology skill, not an Addy Osmani import — so
option (a) from the original two listed here. Option (b), adopting Addy's `security-and-hardening`
skill instead or in addition, remains a separate, unstarted decision.

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
- **`security-review` skill written** at `~/.claude/skills/security-review/SKILL.md` — closes the
  dangling dependency Security's profile always expected. Original methodology (attack-surface
  mapping, an OWASP-derived checklist, confirm-before-report), explicitly deferring to
  `SECURITY.md`'s accepted exceptions and never re-flagging them. This lives outside the repo (it's
  a global skill, like the rest of this project's skill catalog) so there is no repo diff for it —
  noted here for provenance.

What Phase 1 did **not** do, deliberately: no attempt to further generalize the per-role bindings
(they are 100% Shoresh-specific content today, just reorganized), no `departments.json` or
`capabilities.json` from the handoff's proposed `organization/` layout (nothing yet needs them),
and no change to `shoresh-config`'s distribution mechanism. The second-project portability test
the handoff document calls for — proving the `SKILL_MANDATE_WRAPPER` fragment binds cleanly to a
different project's roster without a Shoresh adapter — is unstarted and would be the natural next
slice before claiming actual portability rather than just a cleaner Shoresh-local build.

## Process-duplication fixes (2026-09-04, second pass)

Working through the rest of the original handoff's flagged conflicts, one turned out to be
real and concrete rather than superficial:

- **Maker mandated `subagent-driven-development` and `deep-execution`.** `deep-execution` is not
  a generic "be thorough" skill — it is the `claude-council` plugin's skill for spawning parallel
  subagents that each query an external AI provider (Gemini/OpenAI/Grok/Perplexity).
  `subagent-driven-development` breaks a plan into independently-dispatched session tasks. Both
  imply *Maker itself* fanning out to further agents, which directly contradicts Governor's own
  documented "Dispatch discipline" (flat dispatch, no nested orchestration, foreground-only).
  Removed from `docs/governance/agent-bindings/maker.md`; the underlying "be methodical, break
  work into steps" intent is already covered by `karpathy-guidelines` and
  `test-driven-development`.
- **Red Hat mandated `council-execution`** — same `claude-council` plugin, same external-provider
  fan-out risk, invoked on every single Red Hat dispatch with no explicit authorization. Removed
  from `docs/governance/agent-bindings/red-hat.md`. The four adversarial personas it named
  (frustrated director, bad-data scenario, untested sequence, wrong assumption) are unaffected —
  Red Hat's own "Adversarial Scenarios to Always Run" section already covers this in more
  Shoresh-specific depth, run directly by the role rather than via an external pipeline.
- **Pocock's `code-review`** (flagged in the original audit) — confirmed not actually referenced
  anywhere in the live twelve profiles. Stale finding from the archived snapshot; no action
  needed.
- **Architect's `adhd`** — confirmed intentional, not duplicative: `architect.md` already
  distinguishes it explicitly from Governor's `brainstorming` ("brainstorming sharpens the
  question, adhd widens the answers"). No change.

`governor.md`'s per-agent skill-mapping table and Phase 5/6 dispatch-brief text were updated to
match (no more naming `deep-execution` or `council-execution` as load-bearing skills to announce
in a dispatch brief).

## Verifier baseline-exception fix (2026-09-04)

`verifier.md` previously said: "a change is clean if every failing file is outside the paths it
touched." The source handoff document called this out explicitly as unsafe — a change can break a
file it never directly edited (a dependent module, a shared fixture, a changed export another
test imports) — and said fixing it "requires an explicit governing decision, not an agent-local
shortcut." Owner approval for this fix was given in this session.

Replaced with: attributing a failure to "pre-existing" now requires matching the exact test name
and error message against a known baseline record, never file location alone. If no current
baseline reference is found, or a failure doesn't exactly match a recorded one, Verifier runs the
suite against the pre-change tree (or asks Governor to) before calling it pre-existing — never
infers innocence from where the failing file lives.

## Addy Osmani adapter pilot (2026-09-04)

Per Part B's first-candidate set, four uniquely-named, project-adapted skills were written
(pinned to commit `1c760d643497e9da289300e5eb2f5aca861503f7`, each documenting its exact local
changes from upstream, per the handoff's own installation checklist item 3):

- `~/.claude/skills/org-source-verification/` — adapted from `source-driven-development`.
- `~/.claude/skills/org-interface-contracts/` — adapted from `api-and-interface-design`, remapped
  from REST/TypeScript examples onto this project's actual IPC/WebSocket/op-log contracts.
- `~/.claude/skills/org-migration/` — adapted from `deprecation-and-migration`, widened to cover
  configuration/infrastructure consumers (settings, symlinks, launch paths) alongside application
  code, and explicitly stripped of any license to delete project history.
- `~/.claude/skills/org-decision-challenge/` — adapted from `doubt-driven-development`, bounded to
  one cycle (not upstream's up-to-three), no per-invocation confirmation, no external-provider
  consultation, and grounded in this project's existing two-round cap rather than adding a second
  loop.
- `~/.claude/skills/security-review/` (written earlier this session, see above) fills the fifth
  first-candidate slot — a Shoresh-owned skill rather than an Addy adaptation, since `security.md`
  already needed a `security-review` skill to exist by that exact name.

`org-decision-challenge` was fixture-tested against its own three stated cases by an independent
fresh-context agent (a separate dispatch, not this session reasoning about its own skill) before
being considered pilot-ready. **All three passed:** the false-idempotency claim (an `updated_at`-
only comparison that clobbers on any timestamp mismatch, not a real no-op-if-unchanged check) was
correctly classified as a failed claim rather than rubber-stamped; the unspecified `sync_batch`
disconnect-before-ack contract was correctly escalated as unresolved rather than guessed at; and
the already-accepted plaintext-PIN-over-LAN tradeoff, reframed as if newly proposed, was correctly
recognized as already-settled rather than re-litigated. The skill discriminates as intended.

**Update, 2026-09-04 (owner-approved):** the four adapters are now wired in.
`docs/governance/agent-bindings/architect.md` mandates `org-source-verification` and
`org-interface-contracts` (items 5-6, before `writing-plans`), and names `org-migration` as
situational — invoked only when the task itself is a deprecation/migration, not on every design.
`docs/governance/agent-bindings/governor.md`'s Phase 2.5 gained a bounded trigger for
`org-decision-challenge`: invoked once, only when Architect's design rests on a claim Governor
can't independently verify, never as a repeated loop and never on every Architect dispatch — it
neither adds a third round to the existing two-round cap nor requires per-invocation user
confirmation, both deliberate departures from upstream `doubt-driven-development` recorded in the
skill itself. `org-security-review`-equivalent placement (i.e. `security.md`) was already handled
earlier in this ADR via the Shoresh-owned `security-review` skill, not an Addy adaptation.
Regenerated via `npm run agents:generate`; only `architect.md` and `governor.md` changed, all
twelve still round-trip byte-identical via `npm run agents:check`.

## Phase 3 — memory provenance (additive schema only, 2026-09-04)

Adds `~/.claude/organization/schemas/memory-record.md`: an **optional** extension to the existing
memory taxonomy (`id`, `project_id`, `scope`, `namespace`, `kind`, `status`, `summary`,
`source_refs`, `observed_at`, `last_verified_at`, `applies_to`, `supersedes`), for new memory
writes going forward. Explicitly does **not** retrofit any of the ~85 existing memory files with
fabricated timestamps or provenance, and does not change the nightly consolidation scripts
(`_consolidation/*.sh`, `consolidate.md`) — those keep writing exactly as they do today. Teaching
consolidation to populate this schema from birth is a natural next step, deliberately left
separate. This is the full extent of Phase 3 undertaken in this session: a documented schema, no
runtime behavior change, and an explicit refusal to manufacture provenance for legacy records.

## Phase 4 — task envelope, shadow mode only (2026-09-04)

Per the owner's explicit choice of "shadow mode only" for this phase — the GateReport reducer is
the one piece of infrastructure every real feature's pass/fail already depends on, so nothing here
may touch it:

- `scripts/taskEnvelopeSchema.js` — the proposed `TaskRun` envelope's shape validator, and a pure,
  read-only projection (`projectTaskRunStatus`) from an existing `GateReport` (produced by the
  real, unmodified `reduceGateReport`) onto envelope status fields (`in_progress` / `complete` /
  `blocked` / `escalated`, `pending_human_decision`). It never recomputes `overall_score` or
  `decision_eligibility` — those stay the reducer's alone, per this ADR's existing "never silently
  change the reducer inputs" rule.
- `scripts/shadowGateEnvelope.js` (`npm run gate:shadow-check`) — re-runs the same deterministic
  scenarios the Phase 0 audit validated the reducer against, through the real `reduceGateReport`,
  and projects each through the envelope. All nine scenarios (the original eight plus a round-2
  escalation case) produced the expected `decision_eligibility`/`status` pairing. Confirmed
  zero-touch: `git status` shows no diff to `gateReportReduce.js`, `gateReportSchema.js`,
  `gateReportCli.js`, `gateReportPersist.js`, or anything under `docs/work/runs/gate-reports/` —
  the harness calls the reducer's pure function directly, in-memory, and writes nothing.
- **A real bug was caught and fixed during this work**, worth recording as evidence the shadow
  harness itself is trustworthy: the first draft's test fixture accidentally attached a `score` to
  the `verifier` gate report, which the *existing* schema correctly rejects ("verifier must not
  carry a score") — this turned every scenario's `verifier_pass` false and every projection into
  `BLOCK`, a bug in the new harness, not the reducer. Fixed in the harness before treating any
  result as evidence.
- **Not done, deliberately:** no comparison against a live Grader run (no real task is in flight
  to compare against without fabricating fake reviewer reports, which would misrepresent this as
  tested against reality when it isn't), and no wiring of the envelope into any agent's dispatch
  or output contract. This stays exactly what "shadow mode" means: provably compatible, never
  live.

## Phase 5 — second-project portability fixture (2026-09-04)

Built a disposable fixture (scratchpad-only, not committed anywhere — per the source handoff,
"a portability test, not authorization to migrate another real project"): a fictional Python CLI
project (`invoice_parser`) with a `reviewer` role binding using `{{SKILL_MANDATE_WRAPPER}}`, the
same organization fragment Shoresh's ten profiles use. Composed it with the same fragment file
Shoresh reads from (`~/.claude/organization/fragments/SKILL_MANDATE_WRAPPER.md`), without editing
that fragment or anything in the Shoresh repo. Confirmed:

- The generated fixture profile carries the identical generic mandate text (`EXTREMELY-IMPORTANT`
  block present, byte-for-byte the same fragment).
- **Zero leakage**: grepped the generated output for `shoresh|camp|sqlite|electron|schedule|scheduling`
  (case-insensitive) — no matches. The fixture's own skill list (`pytest-fixture-design`,
  `invoice-domain-modeling` — fictional, invented for this test) is entirely its own, unrelated to
  Shoresh's roster.
- Removing the fixture leaves nothing behind in either the Shoresh repo or `~/.claude/organization/`
  — the fixture only ever *read* the shared fragment, never wrote to it.

This confirms the one claim Phase 1 actually makes portable — the `SKILL_MANDATE_WRAPPER`
fragment — genuinely binds to an unrelated project's own role without modification. It does not
by itself prove the full `organization/` package (`departments.json`, `capabilities.json`, a real
generator CLI) is portable, because those don't exist yet — only the fragment does. The **five
real-task production pilot** from the source handoff's Phase 5 (a predeclared cohort of five
consecutive Shoresh tasks) was **not** run in this session: fabricating five tasks to complete a
checklist would produce evidence about contrived tasks, not real usage, which is exactly the kind
of measurement the source handoff itself warns against ("the old baseline is ten self-authored
records... it cannot establish broad reliability"). This should happen as genuine Shoresh feature
work occurs, not be manufactured now.

## Note on provenance

The source handoff document lives outside this repository at
`/Users/gregfeitel/Documents/Codex/2026-09-04/referenced-chatgpt-conversation-this-is-an/outputs/portable-agent-team-handoff.md`
and is not itself committed here. This ADR summarizes only the portion of it acted on so far
(Phase 0 audit + the tool/Skill fix + the Phase 1 proposal). Later phases, if pursued, should get
their own ADRs rather than blanket-approving the source document.
