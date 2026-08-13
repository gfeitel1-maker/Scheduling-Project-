---
title: "Design notes — Phase D reconciliation experience mockups"
document_type: spec
status: active
created: 2026-08-10
parent_spec: [docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md]
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
archive_when: the Phase D reconciliation experience ships and Verifier PASS recorded
---

# Design notes — Phase D reconciliation experience mockups

Mockup: `docs/work/specs/mockups/2026-08-10-phaseD-reconciliation/reconciliation-experience.html`
(open directly in a browser — self-contained, no build, no external deps). Five panels, switchable
via the left rail: Summary, Medium-confidence decision, Changed/firm decision, Batched legacy-priority
decision, Review-flow queue.

Source docs used: `docs/adr/2026-08-10-ingestion-phaseD-experience.md` (D1–D4, OQ1–OQ3),
`docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md`, `src/ingest/reconciliationReport.js`
(real output shape), `src/screens/ReconciliationLedger.jsx` (existing firmer-treatment precedent),
`docs/governance/standards/DESIGN_STANDARD.md`.

No dark mode: `src/index.css` defines exactly one `:root` — the app has no dark theme today. The
mockup is light-only to avoid inventing a second theme Shoresh doesn't have.

## Key design decisions

- **Glyph/colour vocabulary is 100% reused, nothing new.** `✓`/`⚠`/`○`/`↻` and the
  `--success`/`--accent`/`--anchor`/`--danger` mapping come directly from
  `ReconciliationLedger.jsx`'s existing section glyphs. The summary's four buckets map onto them in
  the same order the brief specifies (understood/needsAttention/notInSource/changed).
- **374 understood collapses to one line, no list** — matches `ReconciliationLedger`'s existing
  `unchanged` section convention (count-only, collapsible-by-default reasoning already in the
  codebase), not a new pattern.
- **Category strip** ("Structure / Scheduling model / Time / Resources") is not an invented taxonomy —
  it's `readiness.js`'s `REQUIRED_AREAS`/`OPTIONAL_AREAS` screen groupings rendered as chips, per the
  ADR's D1 note that `decision.entity` gives this for free.
- **Decision card shape** follows the brief's Observed/Proposed/Unknown structure literally, with
  `unknowns` rendered as a quiet italic note (never a blocking field) even though C1 doesn't populate
  `unknowns` yet — the mockup shows the intended future state, Maker should treat an empty `unknowns`
  array as "render nothing," same discipline as the why-affordance.
- **The firm `confirm_change` card (panel 3)** is the ADR's explicit ask and gets four distinct
  treatments, not just a colour swap: a tinted border + top-edge wash in `--danger`, an explicit
  `firmerNote` banner reusing `ReconciliationLedger`'s exact firmer-copy convention (`⌫` glyph +
  "confirm you meant to"-style framing), reframed buttons ("Overwrite with new value" / "Keep my
  value" instead of "Looks right / Edit" — because "Looks right" undersells an overwrite), and it's
  the only place in the whole flow a primary button is `--danger` instead of `--primary`.
- **Why-disclosure** is always visually subordinate (small type, secondary colour, below a hairline
  divider), consistent whether it renders a populated table (panel 2) or an honest "not populated yet"
  note (panel 3) — never hidden, never disabled, per D3's plain-transparency requirement.

## The three open questions

**OQ1 — commit-while-unresolved behavior.**
Mockup treatment (panel 1): a soft explanatory hint under "Commit everything else now," not a hard
gate. Recommended default is **(c) held back**: decisions under review stay unwritten (skipped, not
auto-accepted, not auto-cleared) until resolved, while everything already reconciled — the 374 + the
7 changed — commits normally. Rationale: (a) full gate contradicts the brief's "leave and return
later" and would make "Commit everything else now" a lie; (b) auto-applying the proposed value on an
un-reviewed decision is exactly the "manufacture information to complete the model" anti-pattern the
brief bans (UNKNOWN is a valid state). (c) is the only option consistent with the program's existing
non-goals. **This needs explicit owner confirmation** — it changes commit semantics, not just copy,
and the ADR itself flags this as unresolved for Governor.

**OQ2 — evidence-population gap (why-disclosure with vs. without evidence).**
Both states are shown: panel 2 (populated, per-group table) and panel 3 (`evidence: null`, honest
empty note). Recommend shipping D3's UI shell now (cheap, immediately useful once evidence starts
populating) and tracking evidence-population as a separate later Phase C slice — matching the ADR's
own recommendation. No further owner input needed here beyond confirming that sequencing.

**OQ3 — legacy-priority batch resolve behavior.**
Mockup treatment (panel 4): all-or-nothing at the batch level. The top-level queue counts the whole
batch as one decision ("N of 4"); a local sub-progress bar (e.g. "2 of 12") lives inside the expanded
card only and never changes the top-level count. This matches Phase C's own batching choice (one
`decision` object, not twelve) and keeps "Review 4 decisions" honest. Recommend this as the answer;
flagging for owner confirmation since it's a genuine behavior decision, not just visual.

## What's needed from the owner before D-build

1. Confirm OQ1's held-back-on-commit treatment (or pick a. gate / b. auto-apply instead).
2. Confirm OQ3's all-or-nothing-batch treatment.
3. Sign off on the reframed button copy for `confirm_change` ("Overwrite with new value" / "Keep my
   value") — this is new copy not lifted verbatim from `reason`, which is otherwise the discipline
   Phase C/D hold to for card body text.
4. Nothing else blocks D1 (the summary) from being built — it's read-only wiring per the ADR.
