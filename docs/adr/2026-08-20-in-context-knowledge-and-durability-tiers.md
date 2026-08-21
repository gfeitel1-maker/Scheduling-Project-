---
title: "In-context camp-knowledge creation + three-tier durability spectrum"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-08-20
approved: 2026-08-20 (owner ratified all four 2026-08-20 ADRs after the Red Hat pre-ratification corrections)
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/2026-08-20-electives-specialdays-facility-audit.md
  - docs/work/specs/2026-08-19-roots-reconciliation-audit.md
gates: ["FOUNDATIONAL gate: the three 2026-08-20 area ADRs (electives-authoring, special-days-authoring, facility-topology-foundation) are all gated on this one; ratify it first."]
archive_when: ratified and folded into PLATFORM_STATE, or rejected
---

# In-context camp-knowledge creation + three-tier durability spectrum

**Revision note (Red Hat challenge, 2026-08-20, pre-ratification):** D3 originally stated tier (c) *is*
the ingestible census. That was wrong — electives and special days are authored (Context-layer) entities,
never ingestible, and adding them to `INGESTIBLE_ENTITIES` would falsely make them ingest-parseable and
touch five pipeline files. D3 is corrected to route tier (c) to the Roots inventory that fits the
entity's class (census for ingestible, Context for authored). The "Scope of the tier marker" section is
also corrected: a one-off that is a real row **needs** an explicit persisted marker (sync-visibility),
so "no schema change for tier (a)" was wrong except when the one-off is not a row at all.

**Foundational ADR. The three area ADRs dated 2026-08-20 are gated on this one.** It decides the single
thing the audit (`docs/work/specs/2026-08-20-electives-specialdays-facility-audit.md`) identified as
missing identically across electives, special days, and locations: *how a director creates camp
knowledge at the point of intent, and how Shoresh decides how durable that knowledge is.* Nothing here
is scheduled for build; ratifying it unblocks the area ADRs.

## Context

Shoresh already has exactly one instance of point-of-intent creation:
`createActivityFromCell` ([src/screens/schedule/useSlotMutations.js:943](../../src/screens/schedule/useSlotMutations.js))
lets a director type a nonexistent activity into a schedule cell and mints it — usage-derived defaults,
human provenance — placing it in one gesture. It is the yardstick the audit measured against, and all
three areas fall short of it the same way: they route the director to a setup screen first, and none can
express *how permanent* a newly-typed thing should be. Every activity created that way is durable camp
vocabulary forever; there is no "use once and forget" and no "true only this summer."

The durability boundary is not new — the Roots reconciliation work already split the world into **durable
reconstructible camp knowledge** (the seven `INGESTIBLE_ENTITIES` surfaced in the Roots census) versus
the **authored Context layer** (field trips, special events, day overrides — never reconstructed). What is
missing is (a) a way to *create into* that world from the point of intent for more than one entity, and
(b) an explicit place for the middle and one-off cases to land.

## Decision

### D1 — One generalized in-context-create interaction

Generalize the `createActivityFromCell` pattern into a single reusable interaction that the area ADRs
consume rather than re-solve. Type a name into a cell → the thing is created with sensible defaults and
placed in one gesture; **progressive enrichment** asks only for what scheduling needs, only when it needs
it (never an upfront interrogation). Electives, special-day activities, and typed locations all route
through this one interaction. **No area may send the director to a mandatory setup screen before they can
create the thing in context.** A management/setup screen is always the *secondary* review-rename-retire
surface, never the entry point.

The mechanism is not re-specified here (each area ADR wires its own cell/editor); this ADR fixes the
*rule* (create-in-context is primary; setup is secondary) and the durability contract below.

### D2 — Three durability tiers (owner decision, 2026-08-20)

Every in-context-created thing carries exactly one of three tiers. This is the whole spectrum; resist a
fourth.

| Tier | Meaning | Where it lives | Surfaced in a durable Roots inventory? |
|---|---|---|---|
| **(a) one-off** | a value used once and forgotten (a cell string, an inline offering that is never named/reused) | the slot/placement only — or a real entity **explicitly marked one-off** and filtered out of every reuse surface | **No** |
| **(b) this-summer / this-schedule** | real and reusable *now*, but not permanent camp vocabulary — scoped to the current season/schedule | a real entity marked with a scope, offered for reuse within scope, excluded from every durable inventory | **No** (a distinct "scoped" state, never counted as durable) |
| **(c) durable** | permanent camp knowledge the director wants Shoresh to remember | a normal camp entity in setup **and** surfaced in the Roots inventory that fits its class (see D3) | **Yes** |

**Default conservatively.** An in-context create defaults to the *lowest* tier that still lets the
director keep working — typically (a) for a bare typed value, (b) when they name/reuse it in-session.
**Promotion is a single low-friction gesture** ("keep this for next time" → (b); "add to camp knowledge"
→ (c)), never a modal that blocks the work. Demotion/retirement is a setup-screen concern.

### D3 — Tier (c) surfaces in the Roots inventory *that fits the entity's class* — reused, not reinvented

**(Corrected 2026-08-20 after Red Hat — see revision note.)** The durable tier must reuse the existing
Roots surfaces, but Roots already has **two** durable inventories, and which one applies depends on the
entity's class:

- **Reconstructible / ingestible entities** (activities, locations, groups, tiers, days, time blocks,
  cohorts — the seven `INGESTIBLE_ENTITIES`) → a tier-(c) create appears in the **Roots census**.
- **Authored entities** (electives, special days, field trips, day overrides — the Context layer, which
  is *never* reconstructed from a file) → a tier-(c) create appears in the **Roots Context inventory**,
  **not** the census. Do **not** add an authored entity to `INGESTIBLE_ENTITIES` to make it "durable";
  that array is normative and order-sensitive (drives extract/plan/import/export), and doing so would
  falsely make the entity ingest-parseable.

The load-bearing integrity rule (unchanged in spirit, corrected in target): **a tier-(a)/(b) create must
not appear in *either* durable inventory** (census or Context durable listing); only tier (c) does. This
is exactly the "keep the census/Context calm and truthful" invariant the Roots audit (H2) protects — get
it wrong and every one-off "Slip-n-Slide" becomes permanent camp vocabulary. **Each area ADR must state
which inventory its tier (c) lands in, and neither may reach the census unless the entity is already an
`INGESTIBLE_ENTITIES` member.**

## Scope of the tier marker

- **How the tier is stored is an area-ADR concern, not decided here** — but two constraints bind every
  area. **First: tier is a sync-visibility property, not just a UI affordance.** Any real entity row
  replicates to every device over the op log; "not surfaced in a palette" on one screen does not stop the
  row appearing in `list(...)`, exports, or the management screen on every peer. So a tier-(a)/(b) entity
  that is a real row **must carry an explicit persisted marker** (e.g. `is_reusable=false` / a scope
  column) that every durable-inventory and reuse query filters on — there is *no* "no schema change"
  path for a one-off that is nonetheless a real row. (A true zero-marker tier (a) is possible only when
  the one-off is *not* a row at all — e.g. a bare string on a slot — which not every entity can do.)
  **Second:** whatever each area does maps onto exactly these three tiers and honors D3 (states which
  inventory its tier (c) lands in).
- **Seasons.** Tier (b)'s "this-summer" scoping intentionally leaves room for the future
  seasons-as-containers direction (camp spatial model assessment) but does **not** require it. Until
  seasons exist, tier (b) scopes to "the current schedule/summer" as a single implicit scope. No seasons
  work is authorized by this ADR.

## Consequences

- **Positive:** the three areas stop re-solving in-context-create; the "how permanent?" question has one
  answer; the `.shoresh`/reconstructibility work gains a create path without a competing durability model.
- **Cost / risk:** the temptation is an elaborate scope/season/versioning system. Explicitly out of
  scope — three tiers, one conservative default, one promotion gesture. A second risk is the tier→census
  mapping (D3); it must have an invariant test (a tier-(a)/(b) entity never appears in the census
  denominator) when the first area implements it.
- **Reversible:** additive. Tier (a) needs no schema. Tiers (b)/(c) are nullable-additive per area. No
  live camp data exists (pre-production), so introducing the marker is a clean cutover.

## Gate

**Ratify this ADR before any of the three area ADRs proceeds to Red Hat / Maker.** Recommended review:
Red Hat challenges D3 (the census-pollution failure mode) and the "default conservatively / promote
later" ergonomics before any code. Owner ratifies the three-tier shape here; the area ADRs then choose
per-entity representations that honor it.
