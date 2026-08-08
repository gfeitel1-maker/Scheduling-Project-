---
title: "Onboarding & Reconciliation UX Options"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Onboarding & Reconciliation UX Options

Derived from the synthesis source §9 (Designer), grounded in the current-state audit (§1) and
the spine (§3). This is a design synthesis, not an implementation plan — no code is authorized by
this document. It records the UX shape both bulk surfaces must share and the artifacts worth
prototyping before any slice is locked.

## 1. Hub, not a wizard

Directors provide their source materials across days and weeks — one file today, a corrected
sheet next week, a facility list whenever the facilities slice ships. A linear wizard punishes
that rhythm: it assumes everything arrives in one sitting and in one order.

So onboarding is a **hub**, not a wizard. The hub is the Setup Readiness screen
(`SETUP_READINESS.md`); the director returns to it between sources and always sees where setup
stands.

## 2. The plan is the object the director looks at the whole time

The `ReconciliationPlan` (spine §3B — a pure `src/ingest` decision layer, never a write layer) is
**the single object the director looks at from start to finish.** The in-app editor and the
workbook are two **renderings** of that one plan. Both write the same six states; both pass
through the **same** non-skippable preview and atomic commit that `ImportScreen.jsx` already
enforces today (read → propose → preview → commit; the shape *is* the decision, ADR 2026-08-01).

This is the load-bearing idea: there are not two features, there is one plan with two faces.

## 3. Five verbs are STATES of the plan, not pages

The onboarding flow is often described as five verbs. They are **states of the one plan**, not
five separate screens:

```
PROVIDE → REVIEW → RESOLVE → FILL → PREVIEW → COMMIT → (READINESS hub)
```

REVIEW, RESOLVE, and FILL are **three kinds of item in one queue** (§4), not three pages. After
COMMIT the director lands back on the readiness hub.

## 4. The Needs-Attention queue

Review / Resolve / Fill are three kinds of item in a **single Needs-Attention queue**, sorted by
**blocking-ness** (Missing before Needs-attention; the most consequential decisions first):

- **Review** — a proposal to accept or reject (an inferred entity, frequency, eligibility).
- **Resolve** — a judgment call: an ambiguous identity, a cross-source conflict, a stale value.
- **Fill** — volume data-entry a source did not supply.

One queue, one sort order, so the director never wonders which of three lists to open next.

## 5. Preview at 40–60 activities: ledger-first, exception-expanded

At the real scale (`F3`: 40–60 activities), a flat per-row list is unreadable. The preview is
**ledger-first and exception-expanded**:

- **Unchanged** rows collapse to a **count** — the reassuring majority, not 50 lines of noise.
- **Conflicts and Ambiguous** rows **auto-expand** and **gate the commit** (bronze,
  Needs-attention).
- **Clear** rows (removing data) get their own firmer treatment — they are not a peer of an
  ordinary update.
- Field-level diff renders **only changed fields**: old value **muted**, new value **full
  contrast**, an accent arrow between (`--accent`, DESIGN_STANDARD §4 caution/attention).

### Text sketch — ledger-first preview at 52 activities

```
 Reviewing "Camp Achva — Summer 2026 schedule.xlsx"

 ✓  46 activities unchanged                                    [ show ]
 ────────────────────────────────────────────────────────────────────
 !  4 need your attention — commit is held until these are resolved

   ⚠ CONFLICT   Archery
       location    Upper Field   →   Lower Range
                   (was, muted)      (schedule source, full)
       [ Keep Upper Field ]  [ Use Lower Range ]  [ Skip ]

   ≟ IDENTITY   "Ropes" ≟ "Ropes Course"                       (see card)

   ⌫ CLEAR      Swim — max_per_week   3   →   (cleared)
       This removes data. Confirm you meant to clear it.
       [ Clear ]  [ Keep 3 ]

 ────────────────────────────────────────────────────────────────────
 ✓  2 updated        Basketball (min 2→3),  Hike (priority low→high)

              [ Commit 52 activities ]   (disabled until 4 resolved)
```

## 6. Confirm-identity card

Ambiguous identity is never auto-merged (spine §3A). It surfaces as an **inline card**: the two
named entities **side by side**, each with its **evidence**, joined by **`≟` (not `=`)** — the
question is whether they are the same, not an assertion that they are. Three **equal-weight**
choices, plus a **"Remember this"** alias checkbox (confirm once, ever — writes a reviewable,
revocable `source_alias`, spine §3A).

### ASCII sketch — confirm-identity card

```
 ┌── Is this the same thing? ───────────────────────────────────┐
 │                                                              │
 │   In your camp              ≟         In this file           │
 │   ───────────────                     ───────────────        │
 │   Ropes Course                        Ropes                  │
 │   seen 3× last year                   appears 5× · Upper Field│
 │   Unit: Seniors                       (no unit in source)     │
 │                                                              │
 │   [ Same — update Ropes Course ]  [ Different — add new ]     │
 │   [ Skip for now ]                                           │
 │                                                              │
 │   ☐ Remember this — treat "Ropes" as "Ropes Course" next time│
 └──────────────────────────────────────────────────────────────┘
```

The alias, once remembered, is shown each time it fires and must not silently outrank an exact
name match to a *different* live entity (spine §3A).

## 7. In-app vs workbook: one model, two faces

Both surfaces share **one model** (the `ReconciliationPlan`) via **identical six-state
vocabulary**:

- **In-app editor** — for **decisions**: identity, conflicts, judgment. The confirm-identity
  card, the conflict resolver, the auto-expanded exceptions live here.
- **Workbook** — for **volume**: bulk data-entry across 40–60 activities (the `T35` highest-value
  gap). It carries a **Status column** (the same six states as words) and **inferred-cell
  styling** that mirrors the on-screen muted/full treatment.

Either surface **can** do either job; the split is about which is *better* for decisions vs
volume, not a capability boundary. The workbook is **the `ReconciliationPlan` exported as a
sheet**, pre-populated with what Shoresh already knows — never a blank template — and it
**re-enters through the identical preview**. It is **never a bypass path**: an edited workbook
produces the same New/Updated/Unchanged/Clear/Conflict diff and passes the same atomic commit.

(Note the tri-state hazard the workbook forces: an empty spreadsheet cell is both *blank* and
*clear*. Blank must leave a value untouched; clearing needs an explicit token. The encoding is a
gate decision to settle before the workbook slice — flagged here, decided in the ADR, not in
this doc.)

## 8. Ranked list of decision-artifacts to prototype

Prototype in this order (synthesis §9):

1. **Six-state preview at 50 activities** — the ledger-first, exception-expanded diff (§5).
2. **Readiness hub** with six states + two-doors (see `SETUP_READINESS.md`).
3. **Confirm-identity card** (§6).
4. **Needs-Attention queue** shell (§4).
5. **Workbook parity mock** — Status column + inferred-cell styling matching the on-screen faces.
6. **Three-look provenance grammar** (§9).

## 9. Three-look provenance grammar — proposed DESIGN_STANDARD change (human gate)

Provenance is rendered in **three looks** (spine §3C, the Designer's three looks):

- **Inferred** — muted treatment (Shoresh's guess, not yet confirmed).
- **Confirmed** — full contrast (the director's value, or a confirmed match).
- **Unknown** — full contrast **plus a "worth checking" cue** — the absence of evidence must not
  masquerade as a muted, confident default. (This generalizes the existing `eligibility_known`
  handling already visible in `ImportScreen.jsx`'s `ActivityRuleRow`, where an unknown
  eligibility renders full-contrast with "Worth checking," deliberately *not* muted.)

This is a **new visual grammar** and therefore a **proposed addition to DESIGN_STANDARD**, not a
change this program may make unilaterally. DESIGN_STANDARD is normative and outranks the code
(§ front-matter; Constitution Article I). Adding a muted/full/full-plus-cue provenance vocabulary
is a **human-gated** standard change — flagged here for the product owner, to be ratified in the
standard before it is built (synthesis §12 decision 7).

## 10. Invariants any implementation must preserve

1. One `ReconciliationPlan`; in-app and workbook are two renderings, never two models.
2. Every path passes the **same** non-skippable preview + atomic commit — the workbook is never a
   bypass.
3. Preview is a pure function → diff object (no ops); recomputed verbatim at commit.
4. Unchanged collapses to a count; Conflict/Ambiguous auto-expand and gate commit; Clear is
   firmer than an update.
5. Identity is never auto-merged; the confirm card asks `≟`, not `=`.
6. Six-state vocabulary is identical across both surfaces (glyph + word + color).
7. The three-look provenance grammar ships only after the DESIGN_STANDARD change is ratified.
