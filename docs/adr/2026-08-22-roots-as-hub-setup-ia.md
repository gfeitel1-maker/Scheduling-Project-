---
title: "Roots as the setup home — refine (not rebuild) the setup IA"
document_type: adr
status: accepted
authority: normative
implementation_state: planned
date: 2026-08-22
approved: 2026-08-22 (owner approved the direction from an iterated interactive prototype — "go ahead")
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/camp-setup-ingestion-program.md
  - docs/adr/2026-08-19-roots-census-and-persistent-inspector.md
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
archive_when: the setup-IA slices ship and this is folded into PLATFORM_STATE
---

# Roots as the setup home — refine, don't rebuild, the setup IA

## Context

The camp-setup navigation grew redundant, and the earlier W2 "sidebar declutter"
attempt (collapse the two schedule routes; move System behind a gear) was rejected
by the owner: the two build routes must stay distinct, and the change was made
without the design exploration a nav-model change warrants (Constitution Art. IV —
navigation model is a human-approval gate).

This ADR replaces that attempt with a direction developed through a full Governor
loop — brainstorming, adhd divergence, an impeccable critique (Operate mode), and
an emil lifecycle-flow lens — then pressure-tested against an **interactive
prototype seeded with real demo data**, iterated with the owner, and approved
2026-08-22.

**The load-bearing correction during that loop:** the work is **refinement of the
real screens, not a rebuild.** The app already has the census (Understood /
Needs-attention / Changed / Not-in-source), entity screens with rule columns, and
two schedule routes. An early prototype that reinvented Roots as a generic card
grid was the wrong instinct and is explicitly rejected here.

## Decision

1. **Roots is the calm setup home.** It is where a director lands and browses what
   Shoresh knows, and jumps from. It is refined in place — the existing census and
   the shipped roots-visual layout are the starting point, not replaced.

2. **The per-entity setup screens are kept, as a collapsible list nested under
   Roots** in the sidebar. They hold real editing (rule columns, week toggles) that
   Roots does not replace. This is the home for the "All setup screens" list — not a
   buried in-page disclosure.

3. **The two schedule routes (Generated, Manual) stay distinct.** No collapse. This
   re-affirms `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`: the app
   never designates one route as canonical, and listing both is not designation.

4. **System items (Camp, Conflicts, Trash, LAN & Devices) move behind a Settings
   affordance.** Conflicts retains its badge so nothing time-sensitive hides.
   Devices stays role-gated.

5. **No explainer banners, anywhere.** Remove the `SCREEN_INTRO` narration
   (`src/components/screenIntroText.js`), the schedule caption "The week the app
   proposed / Drag anything to move it" (`ScheduleScreen.jsx`), and the Roots census
   header explainer. **Rationale (owner principle):** a top-of-screen explainer is
   evidence the interface is not self-evident; the fix is to make state legible in
   the UI (fillable cards, checkmarks, counts), not to narrate it. This is the same
   restraint the "Operate screens stay quiet" rule already encodes.

6. **Import is a single, state-aware entry.** The redundant sidebar "Import last
   year" row and the Roots action-bar Import collapse to one. On an **empty** camp
   it is the standard header action — an empty camp reads as *open and waiting*
   (positive, inferrable), never a "your camp is empty" banner. Once populated it
   recedes to Settings and resurfaces each new season. Re-import keeps the existing
   non-destructive diff-preview.

7. **Inferred rules live on the entity screens, with provenance.** Rules Shoresh
   inferred from an import (activity min/week, eligibility, location need, etc.)
   are surfaced on the screen that owns them (Activities → the list), each tagged
   **observed / inferred / confirmed** with a Confirm/Change control — reusing the
   existing confidence machinery (`CONFIDENCE_COPY`, `plainEvidenceSentence`, the
   roots-census provenance model). They are **not** added to the Roots dashboard,
   and are **not** framed as "what Shoresh learned" (it is not a learning system).

8. **Colors are unchanged.** Use the app tokens exactly (`src/index.css`): cards on
   `--surface #FCFBF8` (not pure white), green `--secondary #2F6B58` for
   checks/rooted, navy `--primary` for brand and primary actions, `--text` for
   counts. This ADR introduces no palette change; the prototype's earlier color
   drift was a mistake, not a decision.

## Consequences

- **Sequenceable.** Points 5 (copy removal), 2+4 (sidebar restructure), 6 (import
  consolidation), and 7 (entity-screen provenance) are independently shippable
  slices, each through the Maker → review → gate loop. See the companion spec.
- **Reversible per slice.** Each is a display/IA change over existing data; none
  touches the schema, the op-log, sync, or the schedule engine.
- **Constitution Art. IV satisfied** for the nav-model gate by the owner's approval
  of the prototype on 2026-08-22.
- **Deferred, tracked elsewhere:** the ingest mislabel of fixed activities
  (separate ticket), and the arbitrary-N-period schedule "merge" (peer branch
  `claude/admiring-dijkstra-db441a`).
- A follow-on motion/polish pass (`/improve-animations` + `/apple-design`, emil-
  validated, on the app's motion tokens) addresses card flatness and makes state
  transitions feel alive — motion only where purposeful, never on constantly-used
  nav.
