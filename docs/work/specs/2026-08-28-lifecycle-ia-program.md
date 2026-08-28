---
title: "Lifecycle IA: Seed → Germination → Sprouts → Roots → Plants"
document_type: spec
status: active
created: 2026-08-28
archive_when: the lifecycle-IA program's constituent ADRs (WS1–WS5) all ship or are deferred, or a new owner decision supersedes the lifecycle model
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
parent_spec: [docs/adr/2026-08-22-roots-as-hub-setup-ia.md, docs/adr/2026-08-27-roots-hub-tiles-are-interface.md, docs/work/specs/2026-08-26-roots-subscreens-redundancy-program.md]
---

# Lifecycle IA — the camp as a living thing you plant, root, and grow

Status: **Active — north-star spec. Owner-approved model (2026-08-28 session). No code until each workstream's ADR is approved.**
Author: Governor (session, worktree `hungry-sammet-51f990`). Owner: the product owner (the craftsman).

This is the **north-star** for a multi-ADR program. It is deliberately a vision/IA spec, not an implementation plan — each workstream below decomposes into its own ADR (and, where the domain model or engine is touched, its own migration + tests). Nothing here authorizes code.

---

## 1. Why this exists — the problem

The Roots screen has been doing **two jobs at once: initial setup and ongoing thinking.** That conflation is the root cause of the front-door problems surfaced by a walkthrough of the running app (2026-08-28):

- The home **contradicted the sidebar** — the census panel said "understood / nothing needs you" while the sidebar honestly showed items still "needed."
- Its census vocabulary (Understood / Changed / Not in source) is **reconciliation language** — correct *after* an import, disorienting as the *default* for a hand-built camp, where three of the four gauges are structurally frozen at 0.
- The readiness banner and the census **disagreed on the same number** (a real defect — two different functions, `getReadiness` vs `buildRootMapModel`, compute it — see the count-bug workstream).
- The **living-roots metaphor evaporated** on the very screen named Roots.

Two design prototypes (a bold reframe and a conservative polish) each only *patched* this. The owner's insight went a layer deeper: **stop using one screen for two life-stages. Let the lifecycle be the architecture.**

## 2. The ruler — the craftsman thesis

Shoresh is a tool built by and for a **craftsman** in Richard Sennett's sense: the owner's craft is running a camp, and this app is their mold and form. Every decision is measured against:

- **A tool for a skilled hand, not a consumer app.** It never condescends, wizard-izes, or hides the material behind a black box. "No explainer/help text" is law — guidance comes from affordance and visual weight, not words. (A live *status* line — what the app is doing right now — is state, not explanation, and is allowed.)
- **The material stays visible and workable.** The director always sees the grain — why the schedule is as it is — and shapes it by hand.
- **Roots = a living, tended thing you return to and cultivate**, not a setup you complete and hand off.
- **Schedules are the roots from which a camp day grows.**

## 3. The model — one lifecycle, five stages

```
  ┌──────────────────┐
  │  Seed your camp  │   the initiating act — import last year (or start by hand)
  │  import last year│
  └────────┬─────────┘
           │  then you watch it…
           ▼
  Germination ──▶ Sprouts ──▶ Roots ──▶ Plants
   structure     the program   what took   the schedules
                               hold
```

**Seed your camp** is the *act* that starts everything — it is pulled out on its own, not grouped with the stages. From it, the lifecycle you *watch and tend* runs left to right. The stages are an active, self-leading process — you seed it, then watch it **germinate → sprout → take root**, and then you **tend** it. (An earlier draft wrapped these in a Plant / Understand / Grow meta-framing; that was dropped — the stage names are the better descriptors and carry the meaning themselves.)

### Stage contents

| Stage | What it is | Contains |
|---|---|---|
| **Seed your camp** | The initiating act — plant the camp | Import & extract last year's schedule (structure, program, **locations/facility, electives**); or start bare and plant by hand |
| **Germination** | The irreducible structure everything grows from | Age Divisions · Groups · Days · Time Blocks · Locations/Facility |
| **Sprouts** | The program that grows from the structure | Activities · **Fixed Events** · **Recurring Events** · Electives · Special Events (incl. Field Trips) |
| **Roots** | *What has taken hold* — the understanding layer, purely | The reconciliation census + attention view, no longer doing setup's job |
| **Plants** | The tree that grows above | The schedules — Generated, Manual, special-day & elective grids |

The special-schedule entities live in **Sprouts** (you plant them) and their actual grids live in **Plants** (they grow) — same entity, two life-stages. This is the seam that has been muddy.

## 4. Stage-aware landing

Home is **stage-aware** — it drops you where your camp actually is:

- **First run, empty camp → Seed your camp** (the one-time front door; also offers "start by hand").
- **Every return after that → Roots.**

**Why Roots, not Plants, is the returning home** (owner-decided 2026-08-28, with a structural reason, not just preference): a camp holds **two schedules** (Manual and Generated) and the app deliberately **never anoints one as canonical** — export asks every time (ADR `2026-07-28-plural-candidate-schedules-per-camp.md`). So "land on Plants" would force a choice the app is built *not* to make (pick a route — forbidden) or degrade to a lobby. **Roots has no such problem**: it is a single, honest orientation surface. You land there, see where the whole living system stands (what's taken root, what still needs planting/tending), and *then* step out to whichever plant you choose. It is also the more on-thesis answer — the craftsman surveys the material from the bench before making a cut; you don't walk in mid-cut.

Roots-as-home only works *because* it no longer does setup's job — setup now lives in Germination/Sprouts. The exact per-state rules (what Roots shows mid-setup) are a WS1/WS4 detail; the principle is settled: **one returning home (Roots), Seed-your-camp as the initiating act, Plants as a destination you choose — never one forced on you.**

## 5. The seed-to-root import narration

The import is not a spinner — it is **the camp coming to life, narrated in the plant metaphor**, and it deposits the director on Roots at the end (so the progress experience *is* the on-ramp to home). The stages map to the **real, distinct phases of the extraction pipeline**, so the narration is honest, not theater:

- **"Seeding your camp"** → reading and parsing last year's file(s); shows what it finds ("3 age divisions, 5 groups, 60 activity cells…").
- **"Germinating"** → pulling out the **structure** (age divisions, groups, days, time blocks, locations/facility).
- **"Sprouting"** → growing the **program** (activities, fixed/recurring events, electives, special events).
- **"Taking root"** → reconciling against the camp → lands on **Roots**.

**Discipline (non-negotiable):** honest narration tied to the real pipeline stages. No faked progress bar, no padded timing to look busy. Each plant-stage message maps to actual extraction work and shows the real material it found — or honestly says "no locations in this file." The material stays visible as it is pulled out; the narration is a live receipt, not decoration.

## 6. Domain-model refinement — Fixed vs Recurring events

The "Fixed Events → Recurring Events" rename (PR #158) blurred two genuinely different concepts. This program **un-conflates** them (its own ADR — see WS2). The axis is **scope** (owner-decided 2026-08-28, ADR `2026-08-28-fixed-vs-recurring-events.md`):

- **Fixed events** — **all-camp**: the same slot for *every* group, at the same time: carpool, flagpole, mifkad, bussing. (Revert the name to "Fixed Events.")
- **Recurring events** — scoped to **one group or age division** (primarily group), at the same time across days: lunch, meals. (These *feel* fixed — locked, daily — but they are group-scoped, which is what makes them Recurring.)

**Both are scheduled first (hard pre-placement); the engine treats them identically.** The distinction is for **legibility and editing**, not scheduling behavior — the engine already blocks all-camp vs group cells correctly from the existing scope columns. So WS2 is a **classification** change (a `kind` column + constraint + migration + ingest + UI split), not an engine change. *(An earlier draft of this section framed Recurring as "contending like an activity" — that was wrong and is corrected here.)* **Special events** (field trips, some-weeks-only) are a third, separate thing that lives in the existing `special_days`/events/overlay layer — out of WS2's scope.

## 7. Design constraints (carried from the design work)

- **Real design tokens only** (`src/index.css`): `--bg:#F4F3EF`, `--surface:#FCFBF8`, `--primary:#173B63`, `--secondary:#2F6B58`, `--accent:#B8833A`, `--success:#4C8A63`, `--danger:#B44E48`, `--anchor:#5C6B7A`, `--text:#1E2A34`, `--text-secondary:#5C6670`, `--border:#D8DBD9`. Fonts: Inter / IBM Plex Sans / IBM Plex Mono / Playfair Display. **Invent no palette or fonts** (a hand-made attempt that did so was correctly rejected).
- **Real brand assets only** for any roots/tree imagery (`src/assets/brand/`: root-pattern, root-system, forest-circle, tree-full, root-line-divider…) — never hand-drawn SVG. Used sparingly: the owner judged a full-panel textured backdrop *too distracting*; cleanliness wins.
- **No explainer/instructional copy.** Status lines (live "what it's doing now") are allowed; captions and help text are not.
- **Do not undo "census tiles are the interface"** for the import/reconcile context (ADR `2026-08-27-roots-hub-tiles-are-interface.md`). The census vocabulary is *relocated* to Roots (where it is true), not deleted.
- **The schedule grid's restraint is protected** — it is the strongest realization of the thesis; do not add chrome to it (the toolbar density is a separate, already-noted concern).

## 8. Workstream decomposition

Each is its own ADR + ticket — small, reversible, independently shippable. **Nothing touches code until its ADR is approved.**

| # | Workstream | Risk | Status | Notes |
|---|---|---|---|---|
| **WS1** | Lifecycle IA + stage-aware navigation | Low | ✅ **shipped** (ADR #211, code #212) | Nav regrouped into the five stages; stage-aware landing (empty camp → Seed, has-data → Roots). |
| **WS2** | **Fixed vs Recurring events split** (§6) | Med | ✅ **shipped** (ADR #210, code #213) | Classification-only `kind` column + CHECK + v51 migration + ingest + sync + UI. No engine change. |
| **WS4** | Roots = pure understanding layer | Med | ✅ **shipped** (ADR #214, code #215) | The Roots home redesign — `RootsHomeScreen`, "what has taken root" + "needs your attention", census moved to the import flow (rescoped #206). |
| **WS4a** | Roots-home **targeted polish** + bento grid fix | Low | 🔵 **in flight** | Owner-approved polish: name-chips (ACTIVITY_COLORS dots), rooted-green counts, bronze attention tags, structured `--space-*`/`--radius-*` token scale, restrained reduced-motion-aware motion; plus the explicit-grid-coordinate fix for the latent bento auto-placement gap. |
| **WS4b** | Roots-home **general whole-screen polish** | Low | ⏳ queued (after WS4a) | The holistic feel/flow pass on the whole Roots home (emil/karpathy lens) — judge the screen as a whole, not piece-by-piece. Distinct from WS4a's targeted changes. |
| **WS3** | "Seed your camp" import-first entry + the seed-to-root narration (§5) | Med | ⏳ queued | Onboarding flow; extract locations/facility/electives; honest plant-staged progress. Designer + Architect. |
| **WS5** | **The schedule screens (Plants)** | High | ⏳ queued — a big arc | NOT a single pass: tackling `ScheduleScreen` + the schedule surfaces is its own multi-step design arc (like the Roots home was) — start with a design conversation + owner reactions before any ADR. Unify the schedule surfaces + fold the special-schedule "sprouts" with their grids; the deferred Schedule-toolbar IA question lives here. **Protect the grid's restraint — it is the strongest surface in the app.** |
| **debt** | Deferred / tracked | — | tracked | (a) **Persist unresolved import items to the Roots home** — the home's attention union is wired; needs a persisted decision store (own workstream, running in a separate session). (b) **`getReadiness` vs `buildRootMapModel` count-bug** — no longer surfaces on the home (numberless), carried as debt, not falsely closed. (c) Full `buildSchedule` findings in "needs attention" — deferred (gated on the two-routes "which route's findings count" question). |

**Sequence (done + ahead):** WS1 + WS2 + WS4 shipped → **WS4a targeted polish (now)** → **WS4b general whole-screen polish of the Roots home** → **WS5 the schedule screens** (its own design arc) → WS3 as fits. The debt items run/land independently.

## 9. Settled vs open

**Settled (owner-approved 2026-08-28):**
- The five-stage lifecycle and its vocabulary (Seed your camp / Germination / Sprouts / Roots / Plants).
- Seed your camp is the initiating *act*, pulled out on its own; the stages are an active self-leading process; the Plant/Understand/Grow meta-framing is dropped.
- Stage-aware landing: first-run → Seed your camp; every return → Roots (with the structural reasoning in §4).
- The seed-to-root import narration and its honesty discipline (§5).
- Fixed vs Recurring un-conflation as a real domain fix (§6).

**Open (workstream-level decisions, resolved in each ADR):**
- What Roots shows mid-setup (partial-state landing).
- Exact Plants grouping and how the special-schedule grids fold in.
- Whether/how "start by hand" (no import) is presented on the Seed-your-camp entry.
- The Roots understanding view's concrete shape (informed by the two design prototypes; neither is adopted wholesale).
- Naming confirmation for any new nav labels once seen in situ.

## 10. How the team plugs in

- **Architect** owns WS2 (the event-model split) and the routing/state-machine changes (WS1, WS3 onboarding).
- **Designer** owns the stage-aware IA visual and each stage-screen's feel, working in the real design system.
- **Governor** holds this spec and orchestrates; each ADR returns for owner approval before code.
