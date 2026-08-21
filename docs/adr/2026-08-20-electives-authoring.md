---
title: "Electives authoring — create-in-context first (T41 slices 2/3)"
document_type: adr
status: accepted
authority: normative
implementation_state: in-progress
date: 2026-08-20
approved: 2026-08-20 (owner ratified after the Red Hat pre-ratification corrections; sequenced first)
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/2026-08-20-group-electives-design.md
  - docs/work/specs/2026-08-20-electives-specialdays-facility-audit.md
related_tickets: [docs/work/tickets/T41-elective-scheduling.md]
gates: ["GATED on docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md (foundational) — do not proceed to Red Hat/Maker until that ADR is ratified."]
archive_when: T41 slices 2/3 ship and this is folded into PLATFORM_STATE, or rejected
---

# Electives authoring — create-in-context first

**Revision note (Red Hat, 2026-08-20, pre-ratification):** three corrections. (1) Tier (c) durable
surfaces in the Roots **Context** inventory, not the ingestible census — electives are authored, never
ingestible (D2). (2) A one-off elective is a real synced row and **needs** an `is_reusable` marker; the
"no schema change / no migration" framing was wrong (D2, migration). (3) The mutual-exclusion is a
concrete cross-field op-log race, resolved by making cell content-kind atomic, with a required
multi-device interleave test — not a plain "test-first" checkbox (D4).

**Gated on the foundational durability ADR (2026-08-20).** This ADR decides *how a director creates and
places electives*, building on the already-shipped v35 substrate (T41 slice 1). It reverses the original
slice ordering from `2026-08-20-group-electives-design.md` per the audit. Group-level / no-solver /
no-campers remains settled (T41 owner decision) and is not relitigated.

## Context

T41 slice 1 shipped a clean, correct, **inert** substrate: `elective_sets` + `elective_set_activities` +
`template_slots.elective_set_id`, full sync/permissions/migration registration, engine-skip, and a
`deleteElectiveSet` cascade with no IPC caller. There is no way to create, place, or see an elective in
the app. The original plan (design spec §Decomposition) sequenced **slice 2 = setup-CRUD screen**, then
slice 3 = authoring — i.e. build the elective catalog in setup, *then* return to the schedule. The audit
found this contradicts the point-of-intent principle and the `createActivityFromCell` precedent already
in the tree. Real-world research confirmed the group-level model is legitimate and common, and that two
attributes exist in *every* elective model and must be first-class: **per-offering capacity** and
**age/eligibility**.

## Decision

### D1 — Invert the slices: create-in-context is the primary authoring path

A director marks a cell as an elective **in the schedule grid**, by typing the offering inline —
extending the `CellInlineEditor` / `createActivityFromCell` interaction
([useSlotMutations.js:943](../../src/screens/schedule/useSlotMutations.js),
[SlotCell.jsx:340](../../src/components/schedule/SlotCell.jsx)) that the foundational ADR generalizes.
Naming an elective and listing its members happens in one gesture; member activities that don't exist yet
are created on type (reusing `createActivityFromCell`). The set + members + the cell's `elective_set_id`
are written together. This works on **both routes** (Manual / Generated), matching the drag-first
placement model.

The **elective-sets management screen becomes secondary** — a review/rename/retire surface following the
`setupCrudRepository` pattern — never the required entry point. It is still built (a director with years
of reusable electives needs it), but it is not the door.

### D2 — Durability mapping (honors the foundational ADR; corrected after Red Hat)

**Tier (c) durable for electives surfaces in the Roots *Context* inventory, NOT the ingestible census.**
An `elective_set` is an authored entity (like field trips / special days); it is never reconstructed from
a file. It must **not** be added to `INGESTIBLE_ENTITIES` — doing so would falsely make electives
ingest-parseable and contradict the non-goal below. This satisfies the foundational ADR's D3 by routing
tier (c) to the authored inventory, and it is the *same* Context surface the special-days ADR wires.

- **Tier (a) one-off:** an elective placed in a cell that the director does not want to keep. Because an
  elective cell **requires** an `elective_sets` row to render (the schema has no inline-string cell
  content), a one-off is a **real, replicated row** — so per the foundational ADR it **must carry an
  explicit persisted marker** (`is_reusable = false`), and every reuse surface (the palette, the
  management screen list, the Context inventory) filters on it. There is **no zero-schema tier-(a)** here;
  the earlier "just don't name it" framing was wrong (a one-off still syncs to every device).
- **Tier (b) this-summer:** a named set marked reusable-but-scoped (`is_reusable = true` + a scope),
  offered for reuse this season, excluded from the durable Context listing.
- **Tier (c) durable:** a named set in the durable Context inventory (a camp's standing "Afternoon
  Chugim").
- **Promotion** is the single "reuse this?" gesture from the foundational ADR.
- **Schema impact (corrected):** this needs a real marker — an `is_reusable` (and optional `scope`)
  nullable-additive column on `elective_sets`, a v36 migration (existing rows = durable/reusable). The
  earlier "no migration needed" line applied only to the render/place plumbing, not to the durability
  marker.

### D3 — Capacity + eligibility become first-class on the offering

Per the research, carry **per-member-activity capacity** (via the existing `locations` capacity where the
offering runs — no new capacity model, per the design spec) and **age/eligibility** on the set or its
members, so an elective offering can be age-scoped the way real camps scope them. This does not add a
solver — the director still decides the split; these are display/validation constraints, not engine
assignment.

### D4 — Elective/activity mutual exclusion: a cross-field op-log race, resolved by making cell-content atomic

Today mutual exclusion is a render-time convention only. Naively "the write path clears the other field"
is **not sufficient**, and this ADR names the hazard explicitly (Red Hat, 2026-08-20): conflict detection
is **per-`(entity, entity_id, field)`**, so `activity_id` and `elective_set_id` are two *independent*
last-write-wins fields on the same row. Two devices editing the same cell (or undo/redo racing a live
write) emit four field ops (`activity_id=X`+`elective_set_id=null` from A; `elective_set_id=Y`+
`activity_id=null` from B) that can interleave to leave **both** columns non-null — the exact invariant
D4 exists to prevent — with **no conflict ever recorded** (neither column is a uniqueness constraint).
This is the DnD/T91 write-race class this codebase has already been burned by twice.

**Decision:** model a cell's content-kind **atomically**, not as two independently-written fields. The
resolution is a Maker+Red-Hat design choice among: (i) a single `content_ref` field carrying a typed
value (`activity:<id>` | `elective:<id>`) so any write is one field the conflict machinery already
serializes; (ii) reusing the per-cell **write queue** from the DnD write-serialization work
(`2026-08-12-drag-live-write-serialization`) to make the paired clear+set one serialized unit *and* a
row-level invariant that rejects/repairs a both-non-null row on apply. **Recommended: (i)** — it removes
the race by construction rather than guarding it, at the cost of a small read-migration of existing slot
readers. Whichever is chosen, an explicit **multi-device interleave test** (not just single-device
sequencing) is required — a test-first pass that only sequences one device would pass and still ship the
bug.

## Non-goals (unchanged)

Campers as records, per-camper rosters, choice/preference data, any solver. Import recognition of
flattened "Chugim"/"Indoor Elective" activities as elective candidates is a **separable later concern** —
it does not block authoring.

## What to build (assessment, not a schedule)

- Reuse unchanged: v35 data model, projections, sync, permissions, engine-skip, `deleteElectiveSet`
  cascade, the set-vs-placement seam.
- Add: IPC surface (create/edit set + members, place/clear in cell, delete → wire `deleteElectiveSet`);
  elective-cell render in `SlotCell` (data-attribute + `scheduleGrid.css`, no new tokens, per the
  schedule-canvas ADR); the inline authoring interaction; capacity + eligibility fields; export that
  renders an elective cell as its set; the write-path mutual-exclusion.
- Migration: the render/place plumbing needs none (v35 in place). The durability marker **does** need a
  v36 nullable-additive `is_reusable` (+ optional `scope`) column on `elective_sets` (existing rows =
  reusable) — corrected from the earlier "no migration" framing. If resolution (i) of D4 is chosen
  (a typed `content_ref`), that is a further additive column plus a read-migration of slot readers.

## Consequences

- **Positive:** electives become native to the schedule workspace instead of a setup detour; the substrate
  finally becomes load-bearing.
- **Risk:** the pull toward a per-camper solver — explicitly held as a non-goal. Second risk: the inline
  editor doing too much; keep member-create delegating to `createActivityFromCell` rather than
  re-implementing it.

## Gate

Gated on the foundational ADR. When that ratifies: **Maker (test-first) → Red Hat (the write-path mutual
exclusion + the durability→census mapping + engine-skip still holds under authored writes) → Security
(permissions unchanged surface) → Code Reviewer → Verifier → Grader.**
