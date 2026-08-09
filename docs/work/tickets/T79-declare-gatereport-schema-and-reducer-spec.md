---
title: T79-declare-gatereport-schema-and-reducer-spec
document_type: ticket
status: completed
created: 2026-08-09
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: []
related_adrs: [docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md]
related_specs: [docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md]
archive_when: "the GateReport spec at docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md exists, has passed a Red Hat adversarial review on the reducer + discretion rule with all findings resolved, and is consistent with (does not contradict) the ADR and exploration doc"
---

# T79 — Declare the GateReport schema + reducer as a spec

> **Renumbered T76 → T79 (2026-08-09):** while this work was isolated on a branch, `main` merged
> a different, unrelated T76 (`T76-status-drift-commit-gate`) plus T77/T78. This ticket took the
> next free number to resolve the collision. Earlier commit messages on this branch reference
> "T76" for this work — they predate the rename.

**Risk:** Low. Documents only — no code, no harness change. The risk is spec ambiguity,
not runtime behaviour.
**Task class:** documentation-governance.

---

## Why this ticket exists

This is the **first ticket-sized move** of the migration path in
`docs/work/2026-08-09-graph-engineering-exploration.md` §10, for the bounded Model A
decision recorded in `docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md`. That
migration step reads: *"define the `GateReport` typed schema and the reducer rule
(including the `INCOMPLETE`/hard-block behavior) as a specification document — no code
changes to Governor's dispatch logic, no change to how gates are invoked today."*

The exploration's §14 evidence review found the reducer is currently **reinvented in
prose by Grader every mixed-panel run** (e.g. how N/A gates fold into an average, how an
`incomplete` panel is handled). This ticket removes that per-run reinvention by declaring
the contract once, precisely enough that a future coding session can implement it against
a fixed target.

The three product-owner decisions of 2026-08-09 are inputs to the spec, not open
questions: (a) a missing/`incomplete` opinion-gate report is Governor discretion, not a
hard-halt; the deterministic Verifier gate remains an absolute block; (b) evidence was
gathered first (done, §14); (c) the `GateReport` is surfaced to the human at promotion.

## Scope

**In:**

1. Author `docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md` declaring, field
   by field with types, required/optional, and allowed enum values:
   - the per-gate report shape emitted by each of the five gates;
   - the aggregate `GateReport` shape;
   - the **deterministic reducer function** that merges five per-gate reports into one
     aggregate — the exact rule Grader reinvents today;
   - the Verifier hard-block invariant (`verifier_pass = false` is absolute);
   - the missing/`incomplete` handling under owner decision (a);
   - what `gate_report_ref` surfaces to the human at promotion under owner decision (c);
   - the durable-record shape that makes a `GateReport` queryable.
2. Cross-reference the ADR and exploration doc; contradict neither.
3. Route the spec through a Red Hat adversarial pass targeting the reducer and the
   discretion rule specifically; resolve all findings in place (no triage).

**Out (explicit non-goals):**

- **No implementation code.** No schema code, no reducer code, no TypeScript/JSON-Schema
  wired into a build, no test files.
- **No harness changes.** Governor's dispatch logic, the gate invocation, the Grader
  agent definition, and the run-record template are all untouched by this ticket. This
  step "declares the contract that already exists implicitly" — it changes nothing about
  how gates run today.
- **No routing change.** Governor's role-to-role routing stays exactly as dynamic as
  today; this ticket touches only the gate fan-in payload/reducer seam.
- **No decision on Model B/C.** That is migration-path step 4, gated on evidence a future
  implementation produces; out of scope here.

## Success predicate (observable)

The spec document exists and a reader who has never seen this conversation can, from it
alone:

1. Write down the exact field list, type, and allowed values for each of the five
   per-gate reports and for the aggregate `GateReport`, with no field left "TBD".
2. Compute the aggregate `GateReport` by hand from any given set of five per-gate reports
   — including the PASS/FAIL/N/A/missing combinations and the numeric-score rule — and
   get a single deterministic answer, because the reducer is specified as a total function
   over its inputs (every input combination has a declared output).
3. State, without ambiguity, when the aggregate is blocking vs. non-blocking, and why
   `verifier_pass = false` can never be overridden.
4. State what the human sees at the promotion gate via `gate_report_ref`.

## What does NOT count as done

- A prose restatement of exploration §3 without a field-by-field typed contract.
- A reducer described only as "Grader merges the reports" — the merge must be a declared
  total function, not delegated back to model judgment.
- A reducer that leaves any input combination (e.g. all-N/A panel, a gate that returned
  FAIL while another is missing) with undefined output.
- Any code, JSON-Schema wired to a validator, or harness edit.
- Passing the spec off before Red Hat has adversarially reviewed the reducer and the
  discretion rule and its findings are resolved in place.

## Testing / verification

This is a spec, so verification is **spec review, not automated tests** (there is no code
to run). Verification is:

- [x] Adversarial pass on the reducer and the documented-gap discretion, hunting
      for: (i) input combinations that yield a wrong or unsafe aggregate, (ii) ways the
      discretion could launder a real FAIL into a proceed. All findings resolved in place.
      **Note:** run as a main-loop adversarial pass on 2026-08-09 (the Red Hat sub-agent was
      unavailable — session rate limit until 12pm ET). Three findings raised and resolved in
      place: F1 (expected-set freeze precondition → new harness property H1, §7/§11/§13),
      F2 (malformed reports mislabeled as "missing" in the gap audit → gap `reason` enum now
      distinguishes `missing`/`malformed`, §4/§5.1), F3 (cross-gate flags silently best-effort
      on optional `ref` → limitation stated, §5.6). An independent Red Hat pass should still be
      run for confirmation once the limit resets; recorded so the substitution is not silent.
- [x] Independent Red Hat agent adversarial pass (ran 2026-08-09 once the limit cleared).
      Verdict: "does not survive as written" — found 2 HIGH + 4 MEDIUM/edge the main-loop pass
      missed. All resolved in place, no triage:
      - HIGH — §7's `gap` pseudocode still hardcoded `reason: "missing"`, silently un-fixing F2.
        Rewrote §7 Definitions so missing vs malformed is preserved end-to-end (§4/§5.1/§7/§8/§9).
      - HIGH — self-declared `N/A` laundering: a bare `N/A` bypassed the missing/gap audit and
        was quieter than a missing report. Added required `na_reason` field (§3), a malformed
        check for reasonless N/A (§5.1), a first-class `self_declared_na[]` aggregate field
        computed in new §5.8, surfaced at promotion (§8), persisted (§9), new property L6 (§11).
      - MEDIUM — §5.1 not exhaustive vs §3: added checks for verifier-N/A, non-null score on
        N/A/UNVERIFIED, non-integer score, null score on a scored verdict.
      - MEDIUM — §8 promotion payload omitted `malformed[]`: added it (+ `self_declared_na[]`).
      - MEDIUM — pre-dispatch omission legitimacy: named as residual boundary property H2 (§13).
      - EDGE — duplicate reports per gate: added cardinality invariant (§3) → malformed (§5.1).
      - EDGE — malformed report's BLOCKING content dropped: stated explicitly; `evidence_ref`
        must be carried in the `malformed[]` entry so the finding is recoverable (§5.1).
- [x] Confirmation Red Hat pass on the revised spec (ran 2026-08-09). Verdict: all seven items
      genuinely closed (not cosmetic), cross-checked across §3/§3.1/§4/§5.1/§5.7/§5.8/§7/§8/§9/
      §11/§13; no fix introduced a new contradiction; Resilience 5/5. One obscure drafting nit
      raised "for completeness" (reasonless N/A from an unexpected gate) — closed by dropping the
      expected-set qualifier on the §5.1 malformed check so any reasonless live N/A is malformed.
      Residual H2 (pre-dispatch omission legitimacy) is correctly out-of-reducer-scope and named.
- [x] Consistency check against `docs/adr/2026-08-09-gate-stack-as-fixed-fanin-graph.md`
      (Decision points 1–6) and `docs/work/2026-08-09-graph-engineering-exploration.md`
      (§3, §4, §13, §14) — the spec cross-references and does not contradict them (confirmed by
      the Red Hat consistency check above and the §12 consistency map).
- [x] The reducer is a total function: every (verifier ∈ {PASS,FAIL,UNVERIFIED,missing,malformed})
      × (each opinion gate ∈ {PASS,FAIL,N/A,missing,malformed}) combination has a declared output
      (§5 is total; §5.1 exhaustiveness confirmed by adversarial construction).

## Acceptance

- [x] `docs/work/specs/2026-08-09-gatereport-schema-and-reducer.md` exists with a
      complete field-by-field contract and a total-function reducer rule.
- [x] `verifier_pass = false` is stated as an absolute, non-overridable block.
- [x] Missing/`incomplete` handling reflects owner decision (a): discretion-with-
      documented-gap, opinion-gates only, never a FAIL, gap persisted + surfaced.
- [x] `gate_report_ref` promotion surfacing reflects owner decision (c).
- [x] Durable-record shape is specified (queryable fields named).
- [x] Red Hat findings on the reducer + discretion resolved in place.
- [x] `npm run check:governance` passes (frontmatter/cross-reference integrity).
