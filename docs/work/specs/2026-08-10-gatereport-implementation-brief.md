---
title: "GateReport implementation brief — storage mechanism and integration seam"
document_type: spec
status: draft
created: 2026-08-10
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T79-declare-gatereport-schema-and-reducer-spec.md]
related_adrs: [docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md]
related_specs: [docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md, docs/work/2026-08-09-graph-engineering-exploration.md]
archive_when: superseded by the run record(s) that implement this brief
---

# GateReport implementation brief — storage mechanism and integration seam

**Status: decided, ready for Maker.** This closes the one thing
`docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md` left open ("storage mechanism ...
implementation choice, out of scope"). It does not reopen the model choice (ADR
`2026-08-09-gate-stack-as-fixed-fanin-graph.md`) or the reducer semantics (spec §3–§13) — both
are settled and this brief treats them as fixed input.

---

## Candidate approaches considered

Divergence was run over the one open dimension (storage + integration seam), not the settled
reducer model.

1. **New agent-role gate-dispatch pipeline** (a code layer that literally dispatches the five
   gates and captures their output structurally) — rejected outright: the ADR and spec are
   explicit that gates are dispatched by human+agent orchestration, not code, and Governor's
   constraint here forbids any new agent role or routing change. Not a real candidate, listed
   only because it's the naive reading of "instrument gate-dispatch."
2. **Frontmatter-only persistence** — extend the existing `docs/work/runs/*.md` run record's
   frontmatter with `GateReport` fields directly, reusing `frontmatter.js`/`build-work-index.js`
   as-is. Rejected: `frontmatter.js` is explicitly scoped to scalars, inline lists, block lists,
   and block lists of *flat* maps ("not a YAML implementation"). `cross_gate_flags` is
   `[{ref, gate_names[]}]` — a list-of-maps where one field is itself a list — which is outside
   that subset. Forcing it in means either flattening the schema (contract drift from the
   settled spec) or extending the YAML subset (scope creep onto shared tooling other doc types
   depend on).
3. **Separate JSON record per (task_id, round), referenced by the run record** — the aggregate
   is written as its own JSON file, and the existing run `.md` gains one new reference field
   (or a line in prose) pointing at it. This is the ADR's own `gate_report_ref` concept, made
   concrete. **Chosen** — see Approach.
4. **Grader-owned, ephemeral, no durable file** — Grader computes the aggregate in-memory each
   round and only ever emits it in its own report text, never persisting a file. Rejected: spec
   §9 requires a durable, queryable record ("whether the outcome was PASS_ELIGIBLE or BLOCK");
   an ephemeral value satisfies none of "how often did Security block vs. Red Hat" across runs,
   which is the whole reason §9 exists.

Candidate 3 wins on the smallest-responsible test: it reuses the run record's identity
(`task_id`/`round`) and the `docs/work/runs/` location the project already treats as the durable
run-record home, adds exactly one new artifact type (a JSON sidecar) instead of stretching an
existing parser past its documented subset, and is trivially both additive and revertible.

---

## 1. Code file layout

Flat files under `scripts/`, matching the existing pattern (`frontmatter.js`,
`build-work-index.js`, `check-governance.js` are none of them in subdirectories). ESM
(`package.json` has `"type": "module"`, and every existing script uses `import`/`export`).

| File | Role | Notes |
|---|---|---|
| `scripts/gateReportSchema.js` | Validates a single `PerGateReport` against spec §3, returns `{ malformed: bool, problem?: string }`. Pure, no I/O. Exports the enums (`GATE_NAMES`, `VERDICTS`) so the reducer and CLI share one source of truth instead of re-declaring them. | New |
| `scripts/gateReportSchema.test.js` | Unit tests for every malformed case enumerated in spec §5.1 (UNVERIFIED on an opinion gate, scored verifier, FAIL/BLOCKING mismatch, out-of-range/non-integer score, reasonless N/A, duplicate `gate_name`, missing required field). | New |
| `scripts/gateReportReduce.js` | The reducer. Exports `reduceGateReport({ taskId, round, expectedOpinionGates, reports })`. **Pure function, no I/O** — takes the five (possibly-absent) `PerGateReport`s and the expected-opinion-gate set as plain data, returns the `GateReport` object per spec §4–§8. Implements §5.1–§5.8 in order, exactly as specified. | New |
| `scripts/gateReportReduce.test.js` | Test-first. See §Test plan below. | New |
| `scripts/gateReportPersist.js` | Exports `writeGateReport(gateReport, { runsDir })`. Writes `gateReport` as pretty-printed JSON to `<runsDir>/gate-reports/<task_id>-r<round>.json` and returns the repo-relative path (this **is** `gate_report_ref`). `runsDir` is an injected parameter, not a hardcoded constant — defaults to `docs/work/runs` in the CLI but tests pass a scratch directory so no test run ever writes into the real `docs/work/runs/gate-reports/`. Creates the `gate-reports/` subdirectory if absent. Does not read or touch `docs/work/runs/*.md`. | New |
| `scripts/gateReportPersist.test.js` | Verifies the write, the filename convention, idempotent overwrite on re-run of the same `(task_id, round)`, and that it never touches any file outside the injected `runsDir`. | New |
| `scripts/gateReportCli.js` | Thin CLI Grader invokes via Bash: `node scripts/gateReportCli.js <input.json>`. Reads `{ taskId, round, expectedOpinionGates, reports }` from the given JSON file, calls `reduceGateReport`, calls `writeGateReport`, prints the resulting `GateReport` (with `gate_report_ref` added) as JSON to stdout. Exits non-zero with a clear message if the input file doesn't parse or is missing required top-level fields — this is a CLI-usage error, distinct from a malformed *gate* report (which the reducer handles per spec, not the CLI). | New |
| `scripts/gateReportCli.test.js` | Imports and calls the CLI's internal handler function directly (not a subprocess spawn, for speed) against a fixture input file in a scratch dir; asserts stdout-equivalent return value and the persisted file's contents match. This is the seam test — see §4. | New |

No existing script is modified in step 1 or 2.

**Confidence: high.** This is a direct application of the repo's own established convention;
there is no design judgment left once "flat files, ESM, co-located test" is confirmed against
three existing examples.

## 2. Persistence location and format

**Decision: JSON file at `docs/work/runs/gate-reports/<task_id>-r<round>.json`, one per
`(task_id, round)`, written by `gateReportPersist.js` and produced by `gateReportCli.js`.**

- `docs/work/runs/` is already this project's durable home for per-round records
  (`WORK_RECORD_STANDARD.md` §2: `related_runs` → `docs/work/runs/**`; every existing run record
  lives there as `docs/work/runs/<date>-<slug>-run.md`). `gate-reports/` is a new subdirectory
  under it, not a new top-level location — it inherits the existing convention that this is
  where round-scoped evidence lives.
- **Format is JSON, not frontmatter**, because `cross_gate_flags` (`[{ref, gate_names[]}]`) has
  a list-valued field nested inside a list-of-maps entry, which is outside the documented subset
  `frontmatter.js` supports (see Candidate 2, rejected above). Every other `GateReport` field
  *would* fit the frontmatter subset, but the contract is one object — splitting it so most
  fields live in frontmatter and `cross_gate_flags` lives elsewhere would be worse than one
  consistent JSON file.
- **Filename convention** `<task_id>-r<round>.json` mirrors the run record's own identity
  (`task_id`, `round` are already the primary key spec §9 names) and sorts predictably.
- **Not indexed by `build-work-index.js`.** That indexer walks `docs/work/**/*.md` and reads
  YAML frontmatter; a JSON file is invisible to it by construction, and `check-governance.js`'s
  `REQUIRED_BY_TYPE`/`STATUS_BY_TYPE` tables have no `document_type` for a raw data record like
  this. This is deliberate, not a gap: `GateReport` is evidence data, not a work document with
  a lifecycle status — nothing in spec §9 asks it to have a `status` or appear in `INDEX.md`. The
  existing run `.md` file remains the documented, indexed, human-readable record; the JSON file
  is what a `.md` file's prose is not: mechanically queryable and pinned to a stable schema.
  Querying across gate-reports (the whole point of §9) is a `grep`/`jq` sweep over
  `docs/work/runs/gate-reports/*.json` — no new tooling is required to get that; a query script
  is explicitly not part of this ticket (out of scope, see Constraints).
- **Linking back:** the run `.md` record gains **one new line in its existing prose** (not a new
  required frontmatter field — that would touch `WORK_RECORD_STANDARD.md` and
  `check-governance.js`'s `REQUIRED_BY_TYPE['run']`, which is out of scope and not needed) stating
  the `gate_report_ref` path per round, e.g. under the round's own subsection: `**Gate report:**
  docs/work/runs/gate-reports/T80-r1.json`. This is how a human reading the run record finds the
  structured evidence without the schema needing to become a frontmatter obligation.
- **Additive and reversible:** writing this file changes nothing that already reads
  `docs/work/runs/*.md` today — no existing script parses `gate-reports/`. Reverting is deleting
  `scripts/gateReportPersist.js`'s call site (or the whole file) and the `gate-reports/`
  directory; no other file's behavior depends on it existing.

**Confidence: high.** The rejected alternative (frontmatter) was ruled out by a concrete parser
limitation, not a preference; the chosen location directly extends a directory whose purpose
(durable per-round records) already matches what's being stored.

## 3. Step-2 gate-dispatch instrumentation and the H1 freeze

**There is no `dispatch()` function.** "Instrument gate-dispatch" means: name the exact point in
the *existing, already-documented* human+agent process where the expected gate set becomes fixed,
and confirm nothing after that point can rewrite it.

**That point already exists and is already followed** — it doesn't need to be invented, only
named and pointed at. `WORK_RECORD_STANDARD.md` requires `selected_agents`/`omitted_agents` as
run-record frontmatter, and the convention (visible verbatim in
`docs/work/runs/2026-08-01-t32-schedule-slot-mutations-run.md`: *"Written before dispatch per
`WORK_RECORD_STANDARD.md` §5.1"*) is that Governor writes the run record — including
`selected_agents`/`omitted_agents` — **before** dispatching any gate. This is the mechanism spec
§13's **H1** ("expected gate set frozen before dispatch") asks the implementing session to name.

Concretely, for this ticket:

- **H1 is satisfied by existing Governor practice**, not new code: the run record's
  `selected_agents`/`omitted_agents` fields are the "expected gate set," they are written
  pre-dispatch per the standard's own §5.1 convention, and `gateReportReduce.js`'s
  `expectedOpinionGates` input parameter is read directly from that already-frozen frontmatter
  (Governor/Grader copies `selected_agents` minus `verifier` into the CLI input JSON — a
  transcription, not a new decision).
- **What this brief adds, and all it adds, to make H1 durable rather than merely conventional:**
  a one-line rule added to `WORK_RECORD_STANDARD.md` §2 (the section that already defines
  `selected_agents`/`omitted_agents`): *"Once a run record's `selected_agents`/`omitted_agents`
  have been used to dispatch gates, they must not be edited in that round — a correction is a
  new round, not an edit to the frozen set."* This is documentation, not a code check: adding a
  git-history-diffing enforcement to `check-governance.js` (e.g. "this frontmatter field must be
  identical across every commit that touches this file within a round") is a real feature with
  its own edge cases (amended commits, rebase) and is more than this ticket's scope. Recommend
  stating the rule now and treating code enforcement as a fast-follow **only if** a violation is
  ever observed in the run-record corpus — consistent with this project's own practice of not
  building enforcement ahead of an observed defect (see `WORK_RECORD_STANDARD.md`'s own account
  of why its enum tables were corrected to match the corpus rather than the reverse).
- **H2 (pre-dispatch omission legitimacy) is explicitly out of scope**, per the spec itself
  (§13: "lives in the WORK_RECORD_STANDARD / Governor-dispatch layer... this spec names it as a
  residual boundary risk"). This brief does not change omission-reason review; that stays a
  human/Governor judgment call, unchanged.

**Confidence: medium-high.** High on "the mechanism already exists and this correctly names it"
(directly evidenced by the T32 run record's own stated convention). Medium on "a documentation
rule is sufficient" — this is an explicit smallest-responsible-solution call, not a proven one;
flagged as an open question below in case the product owner wants code enforcement now rather
than on first observed violation.

## 4. Step-3 Grader input swap

Read in full: `.claude/agents/grader.md`. Today Grader receives **four** prose reports (Tester,
Security, Red Hat, Code Reviewer) — Verifier's pass/fail is handled by Governor separately and
never reaches Grader as an input; Grader's own bias-mitigation protocol (Pass A/Pass B
re-ordering) is how it currently guards against report order affecting the score.

**Changes to `.claude/agents/grader.md`:**

1. **Grader now receives Verifier's report too**, as a fifth input (Governor forwards it).
   Required because `GateReport.verifier_pass` (the absolute hard block, ADR point 4 / spec §6)
   cannot be computed without it, and today's split — "Verifier is separate, always outranks the
   score" — is exactly what the reducer now mechanizes structurally instead of leaving as a
   prose reminder in Grader's role description.
2. **New required transcription step, before scoring:** for each of the five received reports,
   Grader writes one `PerGateReport` JSON object (`{gate_name, verdict, score, na_reason,
   findings[], evidence_ref}`, spec §3) capturing what that report actually said — this is a
   judgment step (mapping a gate's prose findings to `severity` and to `PASS`/`FAIL`/`N/A`), not
   a mechanical one, and stays with Grader because Grader is already the role reading all the
   reports. It assembles these five (plus `taskId`, `round`, `expectedOpinionGates` from the run
   record's `selected_agents`) into one input JSON file.
3. **Grader Bash-invokes the reducer**: `node scripts/gateReportCli.js <input.json>`, reads back
   the printed `GateReport` JSON (including `gate_report_ref`, the path the CLI just wrote).
4. **Grader's Output Format section is rewritten** to source its verdict and scores from the
   returned `GateReport` rather than computing them by re-reading prose:
   - `overall_score`, `lowest_dimension`, `gate_scores` replace the current per-dimension manual
     scoring — Grader still cites evidence per dimension (pulled from the `findings[]` it
     transcribed), but the *numbers* come from the reducer's arithmetic, not from Grader's own
     averaging.
   - **The Bias Mitigation Protocol (Pass A/Pass B re-ordering) is removed.** Position bias was
     a real risk when Grader computed the average itself by re-reading reports in different
     orders; once the average is `reduceGateReport`'s arithmetic mean over a fixed input list,
     order cannot affect the result — the deterministic function replaces the mitigation, it
     doesn't need it duplicated on top.
   - **PASS/FAIL is now `decision_eligibility`** (`PASS_ELIGIBLE` → report PASS,
     `BLOCK` → report FAIL), not Grader's own average-and-floor check — this also means Grader's
     verdict is now correct-by-construction on the Verifier hard block (spec §6) instead of
     relying on the "always outranks your score" prose reminder.
   - Output includes `gate_report_ref` so Governor can carry it into the promotion PAUSE payload
     (ADR point 6 / spec §8) — this is the one piece of step 3 that connects forward to the
     ADR's already-owner-approved promotion-surfacing decision, though wiring the promotion node
     itself is not this ticket (no step-4 work).
5. Grader's "Notes for Governor" section gains one line surfacing `incomplete`/`gap[]` and
   `self_declared_na[]` verbatim when non-empty, so a documented gap (spec §7 owner decision a)
   reaches Governor exactly the way the spec requires, not only via the persisted file.

**The testable seam** is the CLI boundary, not Grader's prose judgment: `gateReportCli.js` takes
a `PerGateReport[]`-shaped JSON in and produces a `GateReport`-shaped JSON out, deterministically.
`scripts/gateReportCli.test.js` pins this contract with fixture inputs covering the worked
example in spec §10 (Verifier FAIL + four PASS opinion scores → BLOCK; then Verifier PASS + four
scores → PASS_ELIGIBLE) and asserts the exact returned object and the exact bytes written to the
persisted file. What is **not** unit-testable — and is not claimed to be — is Grader's
prose-to-`PerGateReport` transcription judgment; that remains a reviewable agent output, exactly
as Grader's scoring judgment is reviewable today. The schema validation in
`gateReportSchema.js`/`gateReportReduce.js` is what bounds that judgment: a malformed
transcription (wrong severity enum, FAIL without a BLOCKING finding, etc.) is caught and reported
in `malformed[]`/forces `BLOCK`, rather than silently accepted.

**Known limitation, flagged rather than solved here:** the four opinion-gate agents
(`security.md`, `red-hat.md`, `tester.md`, `code-reviewer.md`) do not currently emit
machine-readable `severity`-tagged findings in a fixed schema — Grader's transcription step
depends on inferring `BLOCKING`/`HIGH`/`MEDIUM`/`LOW` from each report's prose. This is a
reasonable and bounded judgment call for Grader today (it already reads these reports and forms
opinions from them), but it is worth naming as the actual source of any transcription drift risk,
rather than something this brief silently assumes away. Standardizing each gate agent's own
output format is a separate, larger change (touches five agent files, not one) and is explicitly
not part of this ticket.

**Confidence: medium.** High on the mechanical CLI contract (fully test-first, deterministic).
Medium on "Grader is the right transcription point" — it is the smallest change (one agent file)
that satisfies the spec's requirement, but it does concentrate a new judgment responsibility in
an agent that today only scores; flagged as an open question below.

## 5. Per-step revertibility

| Step | What it adds | Revert |
|---|---|---|
| 1 — schema + reducer | `scripts/gateReportSchema.js`, `scripts/gateReportReduce.js` and their tests. Pure, imported by nothing yet outside their own tests. | Delete the four files. Nothing else in the repo references them until step 2/3 wire them in. |
| 2 — persistence | `scripts/gateReportPersist.js`, `scripts/gateReportCli.js` and their tests; the new `docs/work/runs/gate-reports/` directory starts accumulating files once step 3 calls the CLI. | Delete the two files and their tests; `rm -rf docs/work/runs/gate-reports/`. No existing `.md` run record, indexer, or governance check reads that directory — deleting it changes nothing else. |
| 3 — Grader swap | Edits to `.claude/agents/grader.md` only (received inputs, transcription step, Bash invocation, Output Format, removal of Bias Mitigation Protocol). | `git revert` the commit that changed `grader.md`. Grader reverts to eyeballing four prose reports with Pass A/Pass B re-ordering, exactly as today. Governor stops forwarding Verifier's report to Grader (a one-line change to whatever currently withholds it, if anything explicit does). |

This matches the ADR's own Consequences claim ("each migration step... is independently
reversible; reverting step 3 alone restores today's freeform Grader behavior") — nothing in this
brief weakens that.

## Test-first plan (for Maker)

**Reducer (`gateReportReduce.test.js`), write these before the implementation:**
1. Five present, well-formed reports (Verifier PASS, four opinion PASS with scores) →
   `verifier_pass: true`, correct `overall_score`/`lowest_dimension`, `decision_eligibility:
   PASS_ELIGIBLE`.
2. Spec §10's worked example verbatim, round 1 (Verifier FAIL) and round 2 (Verifier PASS) —
   assert against the exact aggregate values given in the spec.
3. `verifier_pass = false` (FAIL, UNVERIFIED, missing, and malformed Verifier — four separate
   cases) each force `decision_eligibility: BLOCK` **regardless** of a high `overall_score` —
   this is the hard-block invariant (§6) and must be tested as an absolute, not a threshold.
4. Missing opinion gate → `incomplete: true`, `gap: [{gate_name, reason: "missing"}]`, does
   **not** force BLOCK on its own (unless another rule also fires).
5. Malformed opinion report (each malformed case from §5.1) → excluded from `S`, appears in
   `malformed[]`, `gap` entry with `reason: "malformed"` (not `"missing"`), forces BLOCK.
6. Self-declared N/A with `na_reason` → excluded from `S`, appears in `self_declared_na[]`,
   does not set `incomplete`, does not force BLOCK on its own.
7. Self-declared N/A with empty/null `na_reason` → malformed, not a legitimate N/A.
8. `cross_gate_flags`: two gates' findings sharing the same `ref` → flagged; only one gate
   referencing a `ref` → not flagged; a finding with no `ref` never contributes to a flag.
9. All L1–L6 anti-laundering properties from spec §11, each as an explicit test asserting the
   property holds (e.g. L1: an opinion gate that is *not* in `expectedOpinionGates` and never
   reported is `N/A`-shaped, not `missing` — the reducer must derive this from the expected set,
   not invent it).
10. All degenerate edges E1–E5 from spec §11, each producing the exact result spec §11 states.
11. Ordering/determinism: same input object (deep-equal, different object identity) →
    byte-identical output, twice in a row — pins "pure, total function."

**CLI seam (`gateReportCli.test.js`):**
1. Valid input JSON in a scratch dir → stdout/return value is the exact `GateReport` (plus
   `gate_report_ref`); the file at that ref path exists and its JSON content deep-equals the
   returned object minus the ref field itself (avoid self-reference ambiguity).
2. Re-running the same `(task_id, round)` overwrites the prior file rather than erroring or
   duplicating (idempotent).
3. A structurally invalid input file (missing `taskId`, or `reports` not an array) exits non-zero
   with a message that names the missing field — a CLI-usage error, distinct from a malformed
   *gate* report inside a structurally valid input.
4. Two different `(task_id, round)` inputs from the same test run never collide or overwrite
   each other's files.

## Open questions for Governor

1. **H1 enforcement level (§3).** This brief recommends a documentation-only rule in
   `WORK_RECORD_STANDARD.md` and treats code-level enforcement (diffing `selected_agents` across
   commits within a round) as a fast-follow only if a violation is actually observed. If the
   product owner wants that enforcement built now rather than on first observed defect, that is
   additional scope beyond this ticket and should be a separate ticket, not folded in here.
2. **Grader as the transcription point (§4).** This brief puts the prose→`PerGateReport`
   transcription judgment on Grader, and flags (but does not solve) that the four opinion gates'
   own report formats aren't currently `severity`-tagged in a fixed schema. If drift shows up in
   practice (Grader's transcriptions disagreeing with what a gate's report actually said), the
   fast-follow is standardizing each gate agent's own output format — a larger, five-file change,
   not something to pre-build speculatively here.
3. **`docs/work/runs/gate-reports/*.json` is unindexed and unqueried by any script** in this
   ticket (spec explicitly puts a query tool out of scope). If the product owner wants "how often
   does Security block vs. Red Hat" answerable by a command rather than manual `jq`/`grep`, that
   is a follow-on ticket, not part of this brief.
