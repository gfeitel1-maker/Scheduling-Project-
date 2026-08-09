---
title: "GateReport schema and reducer — specification"
document_type: spec
status: draft
created: 2026-08-09
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T76-declare-gatereport-schema-and-reducer-spec.md]
related_adrs: [docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md]
related_specs: [docs/work/2026-08-09-graph-engineering-exploration.md]
archive_when: superseded by an approved implementation plan that codes this contract
---

# GateReport schema and reducer — specification

**Status: draft for implementation.** This declares, precisely enough to code against, the
`GateReport` contract from `docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md` and the
node/edge/state model in `docs/work/2026-08-09-graph-engineering-exploration.md` §3. It is
the first ticket-sized migration move (exploration §10, step 1) for the bounded Model A
decision: **declare the contract that already exists implicitly; change nothing about how
gates run today.** No code, no harness change (see T76 non-goals).

Where this spec and the ADR could appear to differ, the ADR's Decision points 1–6 govern
and this document is the wrong one. It is written not to differ.

---

## 1. Scope and what this fixes

Today the five review gates fan out in parallel after Maker, and **Grader merges their five
prose reports into one score by hand, reinventing the merge rule every run** — exploration
§14 documents this from the run-record corpus (e.g. how N/A gates fold into an average, how
an `incomplete` panel is treated). This spec replaces the per-run reinvention with:

1. a typed **per-gate report** each gate emits (§3);
2. a typed aggregate **`GateReport`** (§4);
3. a **deterministic total-function reducer** that computes the aggregate from the five
   per-gate reports (§5) — the core of this document;
4. the **Verifier hard-block invariant** (§6, owner decision a);
5. **missing/`incomplete` handling** as Governor discretion-with-documented-gap (§7, owner
   decision a);
6. **promotion-gate surfacing** via `gate_report_ref` (§8, owner decision c);
7. the **durable record shape** that makes it queryable (§9).

Out of scope, restated from T76: any code, any change to how gates are dispatched or to
Governor's routing, and any Model B/C decision.

## 2. Terms

- **Gate** — one of the five reviewers dispatched in parallel after Maker: **Verifier**
  (deterministic), **Security**, **Red Hat**, **Tester**, **Code Reviewer** (the four
  *opinion* gates).
- **Deterministic gate** — Verifier only. Runs actual tests/lint/build; its verdict is
  evidence, not opinion (`CONSTITUTION.md` Article VII). It is **mandatory on every run**
  and is never an opinion gate.
- **Opinion gate** — Security, Red Hat, Tester, Code Reviewer. Each emits a judgment score.
  Any of the four may be legitimately **omitted** for a task via a declared reason (§7).
- **Expected gate set** — the gates Governor declared should run for this task, recorded in
  the run record's `selected_agents` / `omitted_agents` before dispatch
  (`WORK_RECORD_STANDARD.md`). This set is the reducer's authority for what "missing" means;
  the reducer never invents it (§7, §11 anti-laundering).
- **Reducer** — the pure function of §5. Same inputs → same aggregate, always. It computes
  and records; it does **not** decide PASS/RETRY/ESCALATE — that stays Governor's
  model-judged decision node (exploration §5), fed by the aggregate this reducer produces.

## 3. Per-gate report shape

Every gate emits exactly one `PerGateReport`. Field-by-field contract:

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `gate_name` | enum | required | `verifier` \| `security` \| `red_hat` \| `tester` \| `code_reviewer` |
| `verdict` | enum | required | `PASS` \| `FAIL` \| `N/A` \| `UNVERIFIED` — see §3.1 |
| `score` | number \| null | required | integer 1–5 for an opinion gate with `verdict ∈ {PASS, FAIL}`; **`null`** when `verdict ∈ {N/A, UNVERIFIED}`; **always `null`** for `verifier` (the deterministic gate is not scored) |
| `findings` | Finding[] | required | may be empty `[]`; never omitted |
| `evidence_ref` | string (pointer) | required for `verifier`; optional for opinion gates | a pointer (path/sha/log id), never inlined content — same discipline as `diff_ref` |

`Finding`:

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `severity` | enum | required | `BLOCKING` \| `HIGH` \| `MEDIUM` \| `LOW` |
| `summary` | string | required | one-line human-readable statement |
| `ref` | string (pointer) | optional | the file/module/line the finding touches; used by the cross-gate flag in §5.6 |

### 3.1 Verdict semantics (fixed, so the reducer is total)

- **`PASS`** — the gate ran and found no `BLOCKING`-severity finding.
- **`FAIL`** — the gate ran and raised **at least one `BLOCKING`** finding. Invariant:
  `verdict == FAIL` **iff** `findings` contains a `BLOCKING` entry. The reducer treats these
  as the same fact and does not need to trust the label alone (§5.6 re-derives it).
- **`N/A`** — the gate declares itself **not applicable** to this task (e.g. Security on a
  pure-docs change). Legitimate only for an **opinion** gate, and only when the run record's
  `omitted_agents` carries a reason from the enum (`no-predicate` / `not-applicable` /
  `human-waived`) **or** the gate ran and self-declared N/A with a stated reason. `score`
  is `null`. An `N/A` gate is **excluded from the numeric average**, never scored as 0 or 5.
- **`UNVERIFIED`** — **Verifier only.** A claimed success predicate could not be mechanically
  checked (`CONSTITUTION.md` Article VII). `score` is `null`. Treated by the reducer as
  "not PASS" for the hard-block (§6).

An opinion gate emitting `UNVERIFIED`, or `verifier` emitting a `score`, is a **malformed
report** — see §5.1.

## 4. Aggregate `GateReport` shape

The reducer's sole output. Field-by-field:

| Field | Type | Notes |
|---|---|---|
| `task_id` | string | the task/ticket this round belongs to |
| `round` | integer | 1 or 2 (the existing round cap; the reducer does not change it) |
| `verifier_pass` | bool | `true` **iff** the Verifier report is present and `verdict == PASS`. FAIL, UNVERIFIED, **or missing** → `false` (§6) |
| `gate_scores` | object | `{security, red_hat, tester, code_reviewer}`, each a number 1–5 or `null` (null for N/A / missing) |
| `overall_score` | number \| null | mean of the **present, scored** opinion gates (§5.3); `null` if none are scored |
| `lowest_dimension` | number \| null | min of the present, scored opinion gates; `null` if none |
| `blocking_findings` | Finding[] | every `BLOCKING`-severity finding from every gate, each tagged with its `gate_name` (§5.5) |
| `incomplete` | bool | `true` iff an **expected opinion gate** produced no usable report (§7) |
| `gap` | Gap[] | `[{gate_name, reason: "missing" \| "malformed"}]` for each expected opinion gate that produced no usable report — `"missing"` = no report at all, `"malformed"` = a report that failed §3 validation (§5.1); `[]` when `incomplete == false` |
| `cross_gate_flags` | CrossGateFlag[] | `[{ref, gate_names[]}]` — findings from ≥2 gates that reference the same `ref` (§5.6); `[]` if none |
| `decision_eligibility` | enum | `PASS_ELIGIBLE` \| `BLOCK` — computed by §5.7. **Advisory to Governor, not the decision itself** |
| `malformed` | Malformed[] | `[{gate_name, problem}]` for reports that violate §3; `[]` when all well-formed (§5.1) |

`decision_eligibility` is deliberately named *eligibility*, not *verdict*: the reducer says
whether a PASS is **permissible on the evidence**; Governor (and the human at promotion)
still own the actual decision (exploration §5, §13 Q1).

## 5. The reducer — a deterministic total function

Input: the five `PerGateReport`s (some possibly absent) **plus** the expected gate set from
the run record. Output: one `GateReport`. The steps below are total — every input
combination has a defined result. Applied in order.

### 5.1 Validate shape first
For each present report, check §3. A report is **malformed** if: an opinion gate has
`verdict == UNVERIFIED`; `verifier` has a non-null `score`; `verdict == FAIL` with no
`BLOCKING` finding, or a `BLOCKING` finding with `verdict != FAIL`; `score` out of 1–5 for a
scored verdict; or a required field is absent. Record each in `malformed[]`. A malformed
report is **not** silently coerced: it is treated as **absent** for that gate for all
subsequent steps (so it can never inflate a score or erase a block), and `malformed` being
non-empty forces `decision_eligibility = BLOCK` (§5.7). This prevents a bad report from
laundering into a pass. A gate whose only report was malformed contributes a `gap` entry
with `reason: "malformed"` (not `"missing"`), so the §9 audit distinguishes "Governor
proceeded past a genuinely absent gate" from "a gate reported but was garbled" — the two
have different causes and the audit trail (decision a) must not conflate them.

### 5.2 Compute `verifier_pass`
`verifier_pass = (verifier report present) AND (verifier.verdict == PASS)`. Every other
case — `FAIL`, `UNVERIFIED`, missing, or malformed Verifier — yields `false`. (§6 makes this
absolute.)

### 5.3 Compute the opinion aggregate
Let **S** = the set of opinion gates whose report is present, well-formed, and has
`verdict ∈ {PASS, FAIL}` (i.e. `score` is a number). `N/A`, missing, and malformed opinion
gates are **excluded from S**.
- `gate_scores[g]` = that gate's `score` for g ∈ S, else `null`.
- `overall_score` = arithmetic mean of `{score : g ∈ S}` if `S` is non-empty, else `null`.
- `lowest_dimension` = min of that same set if non-empty, else `null`.

A `FAIL` opinion gate **keeps its score in S** (a blocking finding usually comes with a low
score, which should drag the average down honestly); its block is handled separately in
§5.5–§5.7, not by excluding it from the average.

### 5.4 Compute `incomplete` and `gap` — see §7
(Kept in §7 because it is the owner-decision-bearing part.)

### 5.5 Collect `blocking_findings`
`blocking_findings` = every `Finding` with `severity == BLOCKING` from every present,
well-formed report, each tagged with its emitting `gate_name`. This includes a Verifier
FAIL's findings. Empty list if none.

### 5.6 Compute `cross_gate_flags`
Group all findings (any severity) by their `ref`. For any `ref` referenced by findings from
**two or more distinct gates**, emit `{ref, gate_names: [...]}`. This is the concrete
surfacing of the accepted cross-cutting-risk cost named in the ADR (a finding one gate
raises that another gate's isolated pass didn't connect to — e.g. an `electron/db/**` change
implying a `better-sqlite3` ABI rebuild). The reducer only **flags** these for human
attention at promotion (§8); it does **not** re-open any gate's verdict (isolation is
preserved — exploration §3).

**Best-effort, by construction.** `cross_gate_flags` can only link findings that carry a
`ref`, and `ref` is optional (§3). Two gates flagging the same file where one omits `ref`
will **not** be linked, and the aggregate gives no false assurance that it would be: a
non-empty `cross_gate_flags` is a positive signal, an empty one is **not** a guarantee of no
cross-cutting risk. This is a deliberate limitation of a soft advisory feature, not a hole to
be closed by making `ref` mandatory (which would push ref-hygiene cost onto every finding for
a best-effort flag). Stated so a reader does not over-trust an empty list.

### 5.7 Compute `decision_eligibility`
`decision_eligibility = BLOCK` if **any** of the following hold; otherwise `PASS_ELIGIBLE`:

1. `verifier_pass == false` — **absolute; §6. Nothing below can override this and nothing
   can override it to `PASS_ELIGIBLE`.**
2. `blocking_findings` is non-empty (any gate raised a `BLOCKING` finding).
3. `malformed` is non-empty (§5.1).
4. `overall_score == null` (no opinion gate produced a score — there is no evidence to pass
   on). **Note:** an all-`N/A` opinion panel is only reachable on a task where every opinion
   gate is legitimately not-applicable; on such a task the PASS rests entirely on
   `verifier_pass == true`, and this rule intentionally makes that an explicit Governor
   judgment rather than an automatic pass (§11, edge E4).
5. `overall_score < 4.0`.
6. `lowest_dimension < 3`.

`incomplete == true` is **not** in this list — by owner decision (a) it does not force a
block (§7). It is surfaced (§8) and left to Governor's documented discretion.

## 6. Verifier hard-block invariant (owner decision a)

`verifier_pass == false` is an **absolute block**: no combination of opinion scores,
`overall_score`, or Governor discretion may yield a PASS while it is false. This holds
whether Verifier returned `FAIL`, `UNVERIFIED`, was **missing**, or was **malformed** — in
every one of those cases `verifier_pass` is `false` (§5.2) and rule §5.7.1 fires. The
discretion of §7 **never** applies to the Verifier: a missing Verifier report is not a
"documented gap you may proceed past," it is an absent deterministic proof, and absent proof
is not a pass (`CONSTITUTION.md` Article VII; exploration §4). This mechanizes the
constitution rule that a reviewer score is never proof when a required gate fails.

## 7. Missing / incomplete handling — Governor discretion with documented gap (owner decision a)

**Precondition — the expected set must be frozen before dispatch.** The whole anti-laundering
guarantee (L1) rests on the reducer being able to trust that the `selected_agents` /
`omitted_agents` it reads were fixed *before* the gates ran, not edited after results came
back. The reducer consumes the expected set as an input and **cannot itself verify when it was
written**. Therefore the harness that produces the run record MUST make the expected gate set
**immutable once dispatch begins** — e.g. written in a pre-dispatch step and never rewritten
by the same actor that later reads the results. If that immutability is not enforced, L1 is
defeatable: an actor could add a still-missing gate to `omitted_agents` after the fact to turn
a `missing` into an `N/A` and clear `incomplete`. This spec declares the reducer's contract;
it flags this as a **required harness property (H1, §13)** the implementing session must
satisfy, not something the reducer can enforce alone.

**Definitions.** For each **opinion** gate in the **expected gate set** (§2):
- present + well-formed → contributes normally.
- absent from the run's reports, or malformed (§5.1) → **missing**.
- an opinion gate **not** in the expected set (Governor declared it omitted with an enum
  reason, or the gate self-declared `N/A`) → **N/A**, *not* missing. It does not set
  `incomplete`.

`incomplete = (at least one expected opinion gate is missing)`.
`gap = [{gate_name, reason: "missing"} for each such gate]`.

**Owner decision (a), 2026-08-09 — this is a closed decision, reversing the earlier
hard-halt default (ADR Decision point 3):**

- `incomplete == true` **does not** force `decision_eligibility = BLOCK`. Governor **may**
  proceed past a missing opinion-gate report **provided the gap is recorded** — which it is,
  by construction: `incomplete` and `gap[]` are written into the durable `GateReport` (§9)
  and surfaced to the human at promotion (§8). Proceeding is therefore never silent.
- The discretion is bounded, and the reducer **enforces the bounds** so they cannot be
  bypassed by prose:
  - It applies **only to opinion gates**. A missing **Verifier** is not a "gap" — it makes
    `verifier_pass = false` → absolute block (§6).
  - It applies **only to a *missing* report**, never to a gate that **returned FAIL**. A
    `FAIL` is present evidence of a blocking problem; §5.7.2 blocks on it and no discretion
    reaches it. "Documented gap" can never mean "documented FAIL."
  - A missing gate **cannot be reclassified as `N/A`** to make `incomplete` disappear. Only
    the run record's pre-dispatch `omitted_agents` reason, or the gate's own self-declared
    `N/A`, produces `N/A`. Governor cannot mint an `N/A` after the fact (§11, anti-laundering
    L1). The reducer derives `N/A`-vs-missing from the expected set, not from Governor's
    say-so at merge time.

So the reducer's contribution to decision (a) is: it makes the gap **visible, typed, and
un-erasable**, and it refuses to let discretion touch the Verifier or a FAIL. Whether to
actually proceed on a given documented gap remains Governor's judgment, reviewed by the
human at promotion.

## 8. Promotion-gate surfacing via `gate_report_ref` (owner decision c)

The promotion PAUSE node's payload carries `gate_report_ref` (exploration §4). At promotion,
the human is shown, read-only, from the referenced `GateReport`:

- `verifier_pass`, `overall_score`, `lowest_dimension`, `decision_eligibility`;
- each opinion gate's `verdict` and `score` (the full `gate_scores`);
- `blocking_findings` (with their `gate_name` tags and `ref`s);
- `incomplete` and `gap[]` — **so any documented gap Governor proceeded past under §7 is
  placed directly in front of the human who owns promotion**, which is what makes the §7
  discretion accountable rather than silent;
- `cross_gate_flags` — the same-`ref` cross-gate findings from §5.6, flagged for attention;
- the `evidence_ref` pointers, so the human can follow them to raw evidence.

This makes "the human owns promotion" (`CONSTITUTION.md`) mean the human owns it **with the
gate evidence, gaps, and cross-cutting flags in hand.** No automation may auto-resume this
node (ADR Consequences; exploration §11).

## 9. Durable record shape (the queryability win)

Each reduce produces one persisted, queryable record per `(task_id, round)`. Named fields a
query must be able to filter/aggregate on (storage mechanism is an implementation choice,
out of scope — the *shape* is the contract):

| Field | Purpose it must serve |
|---|---|
| `task_id`, `round`, `created_at` | identity + ordering |
| `verifier_pass` (bool) | "how often did the deterministic gate block" |
| `gate_scores` (per-gate, nullable) | per-gate score history |
| `overall_score`, `lowest_dimension` | score trend |
| `decision_eligibility` (enum) | eligibility distribution |
| `blocking_findings` (list, each with `gate_name`) | **"how often does Security block vs. Red Hat"** — the §14.3 queryability gap this closes |
| `incomplete` (bool), `gap` (list) | "how often did Governor proceed past a gap, and which gate" — the audit trail decision (a) depends on |
| `cross_gate_flags` (list) | same-file cross-gate risks over time |
| `malformed` (list) | report-quality signal |

The record is written **whether the outcome was PASS_ELIGIBLE or BLOCK, and whether or not
Governor exercised §7 discretion** — an absent record would defeat the audit trail that makes
decision (a) safe.

## 10. Worked example (consistency check with exploration §9)

Reusing exploration §9's trace, round 1: Verifier `FAIL` (1 failing test, one `BLOCKING`
finding, `score: null`); Security/Red Hat/Tester/Code Reviewer each present with scores
`{4, 4, 4, 4}`, no blocking findings; all four expected.

Reducer: §5.2 → `verifier_pass = false`. §5.3 → `S = {security, red_hat, tester,
code_reviewer}`, `overall_score = 4.0`, `lowest_dimension = 4`. §5.5 → `blocking_findings =
[{gate: verifier, severity: BLOCKING, ...}]`. §7 → `incomplete = false`, `gap = []`. §5.7 →
rule 1 fires (`verifier_pass == false`) **and** rule 2 (blocking finding) →
`decision_eligibility = BLOCK`. Aggregate: `{verifier_pass: false, overall_score: 4.0,
lowest_dimension: 4, blocking_findings: [verifier], incomplete: false,
decision_eligibility: BLOCK}`. Governor reads BLOCK → RETRY round 1. **Consistent with
exploration §9 step 7–9** (the hard block holds regardless of the 4.0 average).

Round 2: Verifier `PASS`; opinion scores `{4,5,4,4}`. §5.2 → `verifier_pass = true`. §5.3 →
`overall_score = 4.25`, `lowest = 4`. §5.7 → no rule fires → `PASS_ELIGIBLE`. Governor →
PASS; promotion node carries `gate_report_ref`; human sees the clean panel. **Consistent
with §9 steps 11–13.**

## 11. Anti-laundering properties (for adversarial review) and degenerate edges

The reducer is designed so that a real failure cannot be quietly turned into a pass. The
properties an adversary should try to break:

- **L1 — no post-hoc N/A.** `N/A` vs missing is derived from the pre-dispatch expected set,
  not from Governor at merge time (§7). Governor cannot retroactively declare a missing gate
  N/A to clear `incomplete`. **This holds only if the expected set is frozen before dispatch
  (precondition H1, §7/§13).** The reducer cannot verify freeze-time itself; L1 is a joint
  guarantee of the reducer plus that harness property. An adversary's realistic attack on L1
  is not the reducer's logic but editing the run record's `omitted_agents` after seeing
  results — which H1 exists to prevent.
- **L2 — discretion never reaches the Verifier or a FAIL.** §6 and §7 bound it to *missing
  opinion* reports only.
- **L3 — malformed ≠ ignorable.** A malformed report is treated as missing *and* forces
  BLOCK (§5.1, §5.7.3), so garbling a report cannot erase a finding it contained.
- **L4 — gaps are un-erasable and surfaced.** `incomplete`/`gap` are persisted (§9) and shown
  to the human (§8); discretion leaves a permanent, reviewable trace.
- **L5 — no score invention.** N/A and missing gates are `null`, never 0 or 5 (§3.1, §5.3);
  the average cannot be padded up or down by a gate that did not score.

Degenerate edges, each with a defined result:
- **E1 empty panel** (no gate ran at all): `verifier` missing → `verifier_pass = false` →
  BLOCK. `overall_score = null` → BLOCK (rule 4). Cannot pass. Correct.
- **E2 single opinion gate only, Verifier missing:** `verifier_pass = false` → BLOCK.
- **E3 Verifier PASS, all four opinion gates N/A** (legitimately, e.g. a governance-doc-only
  task): `overall_score = null` → BLOCK by rule 4, i.e. **not an automatic pass** — Governor
  must consciously decide, and the record shows the panel was all-N/A. This is a deliberate
  conservative choice; see owner-judgment note O1 below.
- **E4 Verifier PASS, three N/A, one opinion PASS score 5:** `S = {that gate}`,
  `overall_score = 5`, `lowest = 5` → `PASS_ELIGIBLE` on a single dimension. Matches the
  real t69 run record (exploration §14.2: "the average rests on a single dimension"). The
  record makes the thin basis explicit.
- **E5 two gates flag the same file, neither blocking:** `cross_gate_flags` non-empty,
  `decision_eligibility` may still be `PASS_ELIGIBLE`; the flag is surfaced at promotion
  (§8) for human attention, not auto-blocked — the accepted-cost tradeoff (ADR; exploration
  §3).

## 12. Consistency map to the ADR

| ADR Decision point | This spec |
|---|---|
| 1 — `GateReport` sole contract | §4 |
| 2 — per-gate isolated input; `design_spec_ref` pointer | §3 (per-gate report reads only the diff/spec pointers; not modeled as reducer input here since it is an *input to gates*, not to the reduce) |
| 3 — reducer + missing-gate discretion (owner a) | §5, §7 |
| 4 — `verifier_pass=false` hard block | §5.7.1, §6 |
| 5 — persisted durable record | §9 |
| 6 — surfaced at promotion (owner c) | §8 |

Nothing in this spec changes Governor's routing, the round-1/round-2 cap, or the agent
roster (ADR "Decision", closing paragraph; exploration §11).

## 13. Required harness properties and owner judgment before code (carried to T76 return)

**Required harness property (must be satisfied by the implementing session, not optional):**

- **H1 — the expected gate set is frozen before dispatch.** The reducer's L1 anti-laundering
  guarantee (§7, §11) is only sound if `selected_agents` / `omitted_agents` cannot be edited
  after gate results are known. The implementing session MUST enforce this at the run-record
  layer (write the expected set in a pre-dispatch step; forbid the merge-time actor from
  rewriting it). The reducer cannot check freeze-time itself. Surfaced by the 2026-08-09
  main-loop adversarial pass (finding F1) — without H1, an actor can convert a `missing` gate
  into an after-the-fact `N/A` and clear `incomplete`.

**Owner judgment:**


- **O1 — all-N/A opinion panel (edge E3).** This spec makes an all-`N/A` opinion panel BLOCK
  (rule 4), forcing a conscious Governor decision rather than an automatic pass on
  `verifier_pass` alone. That is a conservative reading of decision (a)'s spirit, not a
  decision the owner explicitly made. If the owner would rather an all-N/A panel with
  `verifier_pass == true` be `PASS_ELIGIBLE` automatically, rule 4 changes. Flagged, not
  assumed.
- **O2 — pass threshold source of truth.** §5.7 uses `overall_score ≥ 4.0` and
  `lowest_dimension ≥ 3` from the current Governor decision policy. If those numbers ever
  move, they move in one declared place (this reducer), not in Grader's prose — but the
  *values* remain the owner/constitution's to set, not this spec's to invent.
