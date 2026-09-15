---
title: "Opinion GateReport inputs are bound to a real, completed subagent dispatch"
document_type: adr
authority: normative
status: accepted
date: 2026-09-15
supersedes: []
implementation_state: shipped
affects: [scripts/gateReportCli.js, scripts/opinionReportProvenance.js, scripts/observeRun.js, docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md]
---

# Opinion GateReport inputs are bound to a real, completed subagent dispatch

**Status: ACCEPTED and implemented, 2026-09-15.**

---

## Context

`gateReportReduce.js` §5.1 already refuses a well-formed opinion report from a gate outside
`expectedOpinionGates`, specifically to stop score-inflation laundering. That check operates on
`reports`, a plain data array handed to the reducer as input. The reducer is pure by design — no
I/O, no clock — so it has no way to see, and was never meant to see, whether a report claiming
`gate_name: "code_reviewer"` actually came from a Code Reviewer dispatch, or was typed by a human
orchestrator who invented plausible findings and a plausible score.

That gap was demonstrated, not theorised. An orchestrator needed a GateReport, hand-wrote Code
Reviewer's and Red Hat's reports — invented findings, invented 4/4 scores — put them in the CLI
input, and the reducer returned a clean `PASS_ELIGIBLE`, which `writeGateReport` then persisted as
a durable artifact under `docs/work/runs/gate-reports/`. No reviewer had seen a line of the diff.
The artifact was indistinguishable from a real one, and would have looked identical to Grader, to
a human skimming the run log, or to a future audit.

This closes the equivalent gap T167/T169 already closed for Verifier: `verifierReport.js` derives
Verifier's PerGateReport from the gate's own results file (removing the hand-typing step
entirely), and binds it to a commit SHA via a stamp line the gate runner writes at run start, so a
green run from an unrelated commit downgrades to `UNVERIFIED` rather than certifying this diff.
Opinion reports have no equivalent binding today. This ADR adds it.

### What forensic material actually exists

Claude Code session transcripts (`~/.claude/projects/<slug>/**/*.jsonl`) record, in order:

1. An `assistant` record with a `tool_use` block (`name: "Agent"`, `input.subagent_type`, and a
   `tool_use_id` on the block itself).
2. A `user` record acknowledging the dispatch: `toolUseResult.agentId` and `.status` (e.g.
   `async_launched` for a backgrounded dispatch), and — in the same record's `message.content` —
   a `tool_result` block whose `tool_use_id` matches the dispatch block's id. This is how a
   specific `agentId` is joined back to the specific `subagent_type` that was dispatched; verified
   directly against this session's own transcript before writing any code.
3. Later, for a backgrounded dispatch, an `attachment` record (`attachment.type: "task_status"`,
   `taskId` = the same `agentId`, `status` moving to `completed`/`failed`/`error`) marks the
   terminal outcome.

`scripts/observeRun.js` already walks this corpus and folds it into aggregate counts (skills,
dispatches, completion). It was read before designing anything here, per the task's explicit
instruction, and its file-walking/cursor/chunked-read machinery is deliberately **not**
duplicated — this ADR's mechanism reuses `observeRun.parseLine` and its `TERMINAL_STATUSES`
constant directly. What `observeRun.js` did not previously do is retain the `tool_use_id` needed
to join a specific dispatch to a specific `agentId`; it only needed aggregate counts. That join is
the one additive change made to it (see Decision).

## Decision

**A new module, `scripts/opinionReportProvenance.js`, checks whether a claimed opinion report
(`security` / `red_hat` / `tester` / `code_reviewer`) has a matching, completed subagent dispatch
in a supplied session transcript — and `scripts/gateReportCli.js` enforces this, upstream of
`reduceGateReport`, before any opinion report reaches it.**

### The check

Pure function, mirroring `buildVerifierReport({ text, ... })`'s shape exactly:

```js
checkOpinionProvenance({ text, gateName }) => { bound: boolean, agentId?, reason? }
```

It parses transcript `text` with `observeRun.parseLine` (unmodified logic, reused not rebuilt),
joins dispatch → launch-ack → terminal status by `tool_use_id` then `agentId`, and returns
`bound: true` if there exists an `agentId` whose subagent_type matches the gate's expected type
(`security→security`, `red_hat→red-hat`, `tester→tester`, `code_reviewer→code-reviewer`) **and**
whose most recent terminal status is `completed`. A dispatch that never reached a terminal status,
or that reached `failed`/`error`, does not bind. When several dispatches of the matching type
exist, the most recent one wins — see Limits below for what that does and does not prove.

### Enforcement, upstream of the reducer

`gateReportCli.js` gained one required-when-present input field, `sessionTranscript` (a path,
exactly like `gateResults`), and now — after deriving the Verifier report as before — maps over
`reports`: for every report whose `gate_name` is one of the four opinion gates, it runs
`checkOpinionProvenance`. If bound, the report passes through unchanged. If **not** bound
(including the case where `sessionTranscript` was omitted entirely — see the mandatory-vs-downgrade
decision below), the CLI does not hand that report to the reducer as-is. It replaces it with:

```js
{ gate_name, verdict: 'UNBOUND_NO_DISPATCH_EVIDENCE', score: null, na_reason: null, findings: [], evidence_ref: sessionTranscript ?? null }
```

`'UNBOUND_NO_DISPATCH_EVIDENCE'` is not a value in `gateReportSchema.js`'s `VERDICTS` enum.
`validatePerGateReport` — **unchanged** — rejects it as malformed on its own, using the exact
mechanism the reducer already uses for a report from an unexpected gate (§5.1): the entry lands in
the reducer's own `malformed[]` array (with the sentinel verdict string doubling as a
human-legible diagnostic — "missing or invalid verdict: UNBOUND_NO_DISPATCH_EVIDENCE" — no extra
plumbing needed to surface *why*), which forces `decision_eligibility: BLOCK` via the existing
§5.7 rule (`malformed.length > 0`). The CLI also `console.error`s the reason, mirroring the
existing pattern for a non-PASS derived Verifier report.

**This is why `gateReportReduce.js` and `gateReportSchema.js` have a zero diff from
`origin/claude/consolidation-into-repo`** — confirmed by `git diff --stat`. The binding decision is
made entirely in the CLI layer, by shaping what the reducer receives, not by teaching the reducer a
new concept.

### `observeRun.js`: the one additive change

`parseLine`'s `dispatch` events gained `tool_use_id` (from the tool_use block's own `id`, `null`
when absent); its `resolution` events gained `tool_use_id` (found by searching the same record's
`message.content` for the matching `tool_result` block, `null` when absent — e.g. for `attachment`
task_status records, which carry no `tool_use_id` at all). `TERMINAL_STATUSES` was exported instead
of module-private, so this module applies exactly the same "what counts as done" rule Observer
already uses rather than restating it and risking drift. These are backward-compatible field
additions to an existing event shape — `observeRun.test.js`'s exact-shape (`toEqual`) assertions
were updated to include the new field, which is the only reason that file's diff is non-trivial.
`observeRun.js`'s own aggregate behavior (`foldEvents`, the corpus walk, the cursor) is untouched.

### Mandatory, not downgrade-and-record — the judgement call

The task explicitly assigned this decision: follow `verifierReport.js`'s downgrade-to-`UNVERIFIED`
precedent unless there's a reason not to. There is one, stated plainly:

Verifier's binding problem (T169) downgrades to `UNVERIFIED`, which is a *first-class, valid*
verdict for verifier specifically (`VERDICTS` includes it; `validatePerGateReport` treats
`UNVERIFIED` as well-formed for `gate_name: verifier`) — the reducer already has an honest "we
cannot tell" state to fall into for Verifier, because Verifier being unbound genuinely does mean
"we don't know if this passed," not "someone lied." An opinion gate has no such honest middle
state in the current schema: `VERDICTS` for opinion gates is `PASS | FAIL | N/A`, and `N/A` means
"this gate legitimately doesn't apply" (it is `self_declared_na`, and — critically — does **not**
force `BLOCK` by itself; it is meant to let a report pass through the gap logic cleanly). Reusing
`N/A` for "we could not verify who wrote this" would have been a straightforward way to weaken the
existing check: an unbound, suspicious report would sail through as a legitimate abstention instead
of triggering scrutiny — the exact opposite of the demonstrated failure this ADR closes.

So: **an unbound opinion report is not downgraded to something that still counts less positively.
It is refused outright and forces `BLOCK`,** using the reducer's existing malformed/gap channel.
This also settles the "how strict" question the task raised explicitly. `sessionTranscript` is
**required, not opt-in** — an omitted field is treated identically to a provided-but-empty
transcript (every opinion report in the run is unbound). This mirrors `validatePerGateReport`'s own
existing stance on Verifier's `evidence_ref` (`gate_name === 'verifier' && evidence_ref == null` is
already malformed, unconditionally, no opt-out) rather than inventing a softer new one for opinion
gates. It is also consistent with this project's own stated preference (pre-production, no live
users yet: prefer a clean hard cutover over a back-compat shim) — a default-off enforcement flag
would have been exactly the kind of loophole this ADR exists to close.

**Consequence: this is a breaking change to `gateReportCli.js`'s input contract.** Any existing
caller (Grader, a human running the CLI by hand) that does not yet pass `sessionTranscript` will
now get `BLOCK` on every run, with a clear `console.error` line per unbound gate naming the reason.
This is deliberate and is called out as the main open item for Governor below.

## Alternatives considered

Explored via structured divergent ideation (five parallel frames — regulator, adversarial/
competitor, 3am-on-call, remove-the-load-bearing-assumption, logistics) before converging. The
serious candidates, and why each lost to the shipped design:

- **Cryptographic signing / HMAC receipts / ephemeral per-dispatch keypairs.** Several frames
  converged on this independently (signed reports, dispatch-secret-derived signatures, watermark
  echo). Rejected: it requires control over the Agent dispatch mechanism and the subagent's own
  output path, neither of which this module can reach — Claude Code's `Agent` tool and subagent
  runtime are not things a script in this repo can inject a nonce into or have sign a receipt.
  Would require harness changes far outside this task's boundary and stated constraints.
- **Merkle-proof / content-hash binding of the report's own text to transcript bytes.** Provably
  stronger (binds *content*, not just *occurrence*), but requires the subagent to emit a
  self-describing hash of its own output, which no current dispatch does. Same "outside this
  module's reach" problem as signing, plus real flakiness risk (whitespace/formatting drift
  between what a reviewer wrote and what a human transcribes into the PerGateReport JSON).
- **Query-at-evaluation-time instead of extract-and-bind** (report stores a query spec, reducer
  executes it against the transcript at read time). Interesting, and would have avoided ever
  materializing a "bound/unbound" boolean — but it requires the *reducer* to gain I/O to execute
  the query, directly violating the hard constraint that `gateReportReduce.js` stays pure with no
  I/O.
- **Full chain-of-custody (dispatch manifests, batch IDs, sealed briefs, dual ledgers).** The
  logistics frame's contributions. Rejected as more machinery than the demonstrated failure needs:
  none of it is buildable without also changing how dispatches are issued (injecting a manifest
  entry into a tool call this module doesn't control), and the 3am-on-call frame's own output
  warned against exactly this kind of path/format-fragile multi-file bookkeeping.
- **Prompt-text / commit-SHA matching inside the dispatch** (does the dispatch prompt mention the
  commit this gate run is for?). Considered as a way to strengthen recency/relevance beyond
  "a completed dispatch of the right type exists somewhere in this transcript." Rejected for this
  pass: substring/fuzzy matching against freeform prompt text is exactly the flaky-on-rewording
  failure mode Verifier's own SHA-stamp mechanism was built to avoid by using a structured stamp
  instead of prose. Left as a documented limitation, not solved speculatively.

The shipped design — presence-plus-completion binding via the transcript's own structural fields,
enforced by shaping the reducer's input rather than touching the reducer — was the smallest
mechanism that (a) uses only forensic material that genuinely already exists and is already parsed
elsewhere in this repo, (b) requires zero changes to the two files under a hard constraint, and (c)
closes the exact demonstrated failure.

## Limits — read this before trusting a `bound: true`

Stated plainly, per the task's explicit instruction not to overclaim:

- **This proves occurrence and completion, not content.** It proves a subagent of the claimed type
  was dispatched in this transcript and reached `completed`. It does **not** prove the findings and
  score in the PerGateReport are the ones that dispatch actually produced. A human who runs a real
  Code Reviewer dispatch, discards its actual output, and hand-writes different findings — while
  the dispatch is still sitting in the transcript, completed — defeats this check. This is the same
  shape of gap Verifier's SHA-stamp binding has: it proves a green run happened against the right
  commit, not that anyone read the output.
- **This proves "somewhere in this transcript," not "for this round."** The "most recent matching
  dispatch" rule means a stale, unrelated dispatch of the right type from earlier in a long-running
  session — reviewing a different commit, a different task entirely — satisfies binding for a
  report about today's diff. No commit- or task-level correlation is attempted (see Alternatives:
  prompt-text matching was deliberately not built, for flakiness reasons).
- **This is entirely defeated by a `sessionTranscript` pointed at a doctored file.** Nothing in this
  module authenticates the transcript file's own provenance — it is read the same way any local
  file is read. A determined author with filesystem write access can fabricate a transcript exactly
  as they previously fabricated a report. This mechanism does not raise the ceiling on a truly
  determined adversary; it raises the floor on an accidental or lazy fabrication — someone who skips
  a real dispatch because it's slow, or reuses an old report without meaning to misrepresent it. The
  task's own success bar states this explicitly and this design does not exceed it: "an accidental
  or lazy fabrication is caught and a deliberate one leaves evidence," not "forgery is impossible."
- **The `agentId` is not cross-checked against anything outside the transcript** — no correlation
  with the subagent's own transcript file (`<slug>/subagents/agent-<agentId>.jsonl`) is performed.
  That file's mere existence would be weak corroboration at best (same doctoring risk as the parent
  transcript) and was left out to keep the check to one file read, per the 3am-on-call frame's
  emphasis on minimal moving parts and resilience to missing/rotated files.

## Files/modules affected

- `scripts/opinionReportProvenance.js` — new. Pure `checkOpinionProvenance({ text, gateName })` and
  `SUBAGENT_TYPE_BY_GATE`.
- `scripts/opinionReportProvenance.test.js` — new.
- `scripts/observeRun.js` — additive: `tool_use_id` on `dispatch`/`resolution` events;
  `TERMINAL_STATUSES` exported.
- `scripts/observeRun.test.js` — updated fixtures/assertions for the additive field (no behavior
  change to `foldEvents` or the corpus walk).
- `scripts/gateReportCli.js` — new required-when-present `sessionTranscript` input field; opinion
  reports are checked and, if unbound, replaced with a sentinel that the **unchanged**
  `validatePerGateReport`/`reduceGateReport` reject on their own.
- `scripts/gateReportCli.test.js` — existing fixtures updated to supply a bound transcript (since
  binding is now mandatory); new `describe('opinion report dispatch provenance (T171)')` block,
  including the required acceptance test that reproduces the exact fabrication scenario and shows
  it is refused.
- `scripts/gateReportReduce.js`, `scripts/gateReportSchema.js` — **zero diff**, confirmed via
  `git diff --stat origin/claude/consolidation-into-repo`.

## Reused vs. new

Reused: `observeRun.parseLine`'s event parsing (extended additively, not replaced),
`TERMINAL_STATUSES`, the existing `verifierReport.js` → `gateReportCli.js` architectural pattern
(derive-and-inject upstream of the reducer), and the reducer's own malformed/gap/BLOCK machinery
(reused as the enforcement channel, not modified). New: the dispatch↔agentId↔status join logic
(did not previously exist anywhere — `observeRun.js` only needed aggregate counts, never a
per-agentId identity), and the CLI's mandatory-binding pass over opinion reports.

## ADR required: yes

This changes an existing contract other code already calls (`gateReportCli.js`'s input JSON shape
gains a required-when-omitted-still-enforced field, and its behavior on omission changed from
"not checked at all" to "forces BLOCK") and introduces a not-obviously-reversible tradeoff (opinion
provenance is now mandatory with no opt-out, a deliberate hard-cutover choice over a softer
downgrade). Filed at `docs/adr/2026-09-15-opinion-report-dispatch-provenance.md`.

## Open questions for Governor

- **Caller migration.** Every existing call site that builds `gateReportCli.js` input (Grader's own
  invocation, any documented manual workflow) must start passing `sessionTranscript` — pointing at
  its own session's transcript file — or every future gate run BLOCKs on opinion provenance. This
  ADR does not audit or update those call sites; confirm they get updated before this lands on a
  branch anyone runs gates from. The current session's own transcript path is available (see this
  ADR's Context section for how it was located: `~/.claude/projects/<slug>/<session-uuid>.jsonl`,
  found from `.claude/projects/-Users-gregfeitel-dev-shoresh/` by mtime) but nothing in this repo
  currently plumbs "my own transcript path" to a script programmatically — that is a product
  decision (does Grader know its own transcript path today, or does a human supply it?) rather than
  a technical one, and is out of this ADR's scope to resolve unilaterally.
- **Human-run/synchronous gates.** The task flagged this as worth considering explicitly. As shipped,
  a human running a gate by hand with no subagent dispatches at all will always BLOCK on opinion
  provenance — there is no escape hatch. If synchronous human review is meant to remain a legitimate
  path (not just an artifact of pre-launch informality), that needs its own explicit mechanism
  (e.g., a human-attestation report shape distinct from an agent-dispatch one) — deliberately not
  invented here, since it is a new legitimate-input category, not a hardening of the existing one,
  and speculative infrastructure for a case that may not need supporting was avoided per the
  karpathy constraint.
