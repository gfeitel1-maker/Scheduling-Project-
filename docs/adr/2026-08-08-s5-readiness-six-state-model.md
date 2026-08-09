---
title: "S5: the six-state readiness model as an additive layer over getSetupGaps"
document_type: adr
authority: normative
status: accepted
date: 2026-08-08
supersedes: []
implementation_state: implemented
affects:
  - src/engine/readiness.js
  - src/engine/readiness.test.js
  - src/components/layout/Sidebar.jsx
  - src/components/layout/sidebarState.js
  - src/components/layout/navSections.js
  - src/screens/ScheduleScreen.jsx
  - docs/work/onboarding-reconciliation/SETUP_READINESS.md
  - docs/work/onboarding-reconciliation/ONBOARDING_UX_OPTIONS.md
related_adrs:
  - docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
---

# S5: the six-state readiness model as an additive layer over getSetupGaps

**Status: PROPOSED.** Design for the Setup Readiness hub's state model (`SETUP_READINESS.md` §5).
No production code is authorized by this ADR. It records the module shape a Maker can build
without further architectural judgment, and — critically — the honest scope of what the
"Needs-attention" state can and cannot know from persisted data today.

This ADR governs one decision: **how the six-state readiness layer is structured so that it never
destabilizes `getSetupGaps`, the one blocking-truth function every surface trusts.** The hub
screen's layout, the two-doors affordance, and the Needs-Attention queue are downstream UX and
are out of scope here — this ADR fixes the *state model and its module seam*.

---

## Context

`src/engine/readiness.js` answers exactly one question — *"Can this camp build a week yet, and if
not, what is missing?"* — via `getSetupGaps(collections)`, a pure binary gap-detector over five
`REQUIRED_AREAS` (Units, Groups, Days, Time Blocks, Activities) plus two `OPTIONAL_AREAS` (Fixed
Events, Day Overrides) that are never gaps. Its file header records that it exists because the app
once held four disagreeing answers to that question. Three surfaces read it today:

- **The generation gate** — `ScheduleScreen.jsx:565` calls `getSetupGaps(...)` and blocks the
  Generated Schedule when it returns non-empty (`:569`), rendering `describeSetupGaps` as the
  headline.
- **The sidebar item marks** — `Sidebar.jsx:38` derives `gapAreas` from `countGaps` and paints
  each row `!` / `✓` / `·` (`:156`) via `MARK_COLOR` (`:23`).
- **The sidebar collapsed rollup** — `sidebarState.js:sectionRollup` reports `done / total` with a
  `!` or `✓` on behalf of hidden rows.

`SETUP_READINESS.md` §3 asks for six named states — **Ready / Needs-attention / Missing /
Optional / Not-applicable / In-progress** — to make one distinction the binary model structurally
cannot: **Missing (red, blocking, rare)** vs **Needs-attention (bronze, resolvable)**.

### The load-bearing constraint discovered in the code

The "Needs-attention" state, per §5.2, wants a per-category signal that rows exist *but* some are
"inferred-not-confirmed / ambiguous / held." **That signal is not persisted anywhere today.** The
`_inferred` and `eligibility_known` flags (`src/ingest/activityRules.js`, consumed in
`ImportScreen.jsx`) are **transient preview-time React state** — editing a field clears
`_inferred` (`ImportScreen.jsx:363`), and `commitIngest` writes only the confirmed values. A
"held" import is likewise local component state (`ImportScreen.jsx:124`), not a persisted row
status. The `ReconciliationPlan` is a pure decision object, never persisted (ADR
`reconciliation-plan-as-commit-input`). And the per-field import-vs-human provenance bit that
*would* make "needs review" durable is **ADR S2a — status proposed, not_started, schema v29**; it
does not exist yet.

So a `getReadiness` that tried to *read* Needs-attention out of loaded collections would find
nothing to read. Any design that pretends otherwise ships a state that is always empty and quietly
wrong. This ADR's central move is to make that honesty structural.

---

## Candidate approaches considered

Divergence per the architect role (the pre-flight gate does *not* close this — the synthesis fixed
the product-facing state vocabulary, but the module seam and the degradation model were genuinely
open, and picking wrong here re-couples the trusted core to speculative signals).

1. **Derive all six states inside a rewritten `getSetupGaps`** (states replace the boolean). —
   *Rejected.* Directly violates `SETUP_READINESS.md` §9 invariant 1–2 and the module's reason to
   exist. Every surface's gate would now depend on a richer, more fragile computation; a bug in
   "Needs-attention" could change what blocks a week. Non-starter.

2. **A separate `readinessStates.js` module that imports and wraps `getSetupGaps`.** — Rejected as
   the *default*, kept as a fallback. A second file invites the two-source-of-truth drift the
   original consolidation killed: `REQUIRED_AREAS` lives in one file, the state machine over it in
   another, and they can disagree. The category list is the shared spine; splitting it across files
   is exactly the failure mode `readiness.js` was written to end.

3. **Chosen — additive `getReadiness(collections, signals?)` in the same `readiness.js`, layered
   strictly on top of the untouched `getSetupGaps` + `REQUIRED_AREAS`.** The blocking core is a
   pure sub-computation of the states layer (Missing is *defined as* "this required area is in
   `getSetupGaps`"). Needs-attention / In-progress / Not-applicable are driven by an **optional
   second `signals` argument** the caller supplies — because that data is not in the collections.
   With no `signals`, `getReadiness` degrades to exactly today's truth expressed in the richer
   glyph vocabulary (Ready / Missing / Optional), never inventing a state it cannot substantiate.

4. **Persist the provenance bit now so Needs-attention can read from collections (pull S2a
   forward).** — Rejected for S5. It is a schema + sync-replication change with its own
   migration/rollback gate and its own ADR already in flight; folding it into the readiness-model
   ADR would couple a pure computed-state feature to a schema migration and blow S5's scope. S5
   ships the *shape* that S2a's bit later slots into, without waiting on it.

---

## Decision

### 1. One new pure export in `readiness.js`, wrapping the untouched core

Add `getReadiness(collections, signals)` to `src/engine/readiness.js`. **`getSetupGaps`,
`REQUIRED_AREAS`, `OPTIONAL_AREAS`, `describeSetupGaps`, and `COLLECTION_FOR` are byte-for-byte
unchanged.** The existing `readiness.test.js` must continue to pass verbatim — it is the
regression fence for the core.

Introduce a single category spine the layer iterates. `REQUIRED_AREAS` and `OPTIONAL_AREAS` stay
as-is; add a small forward-looking list and a derived `ALL_CATEGORIES`:

```
kind: 'required' | 'optional' | 'forward'
```

- `required` — the five, from `REQUIRED_AREAS`, `kind:'required'`.
- `optional` — the two, from `OPTIONAL_AREAS`, `kind:'optional'`.
- `forward` — **`location`** (screen `camp`/none yet) and **`staffing`** (no screen yet),
  `kind:'forward'`. These are label-and-key descriptors only; they carry **no** collection binding
  and can never enter `COLLECTION_FOR`.

`getReadiness` returns an **array of per-category descriptors** (stable order: required in setup
order, then optional, then forward), each:

```
{ key, label, screen, kind, state, message? }
state ∈ 'ready' | 'needs-attention' | 'missing' | 'optional' | 'not-applicable' | 'in-progress'
```

### 2. The state machine — what drives each state, honestly scoped

`signals` is an **optional** additive argument, shape (all fields optional):

```
signals = {
  attention:     { [key]: number },   // count of review items the caller knows about
  inProgress:    { [key]: true },      // a reconciliation plan is staged, not yet committed
  notApplicable: { [key]: true },      // this camp declares the category N/A (e.g. supplies no staff)
}
```

Per category, in precedence order:

| kind | rule | state |
|---|---|---|
| any | `notApplicable[key]` is set | **not-applicable** (`–`) |
| any | `inProgress[key]` is set | **in-progress** (`⋯`) |
| required | backing collection empty (i.e. `key ∈ getSetupGaps`) | **missing** (`!`, red) |
| required/optional | has rows **and** `attention[key] > 0` | **needs-attention** (`!`, bronze) |
| required | has rows, no attention | **ready** (`✓`) |
| optional | empty | **optional** (`·`) |
| optional | has rows, no attention | **ready** (`✓`) |
| forward | (no collection) default | **optional** (`·`, "not started") unless `notApplicable` |

**Missing is computed from `getSetupGaps`, not re-derived.** The layer calls
`getSetupGaps(collections)` once and treats membership in its result as the sole definition of
Missing. This is what keeps red meaning exactly "blocks generating a schedule" and keeps the two
layers from ever disagreeing (`SETUP_READINESS.md` invariant 7).

**Where Needs-attention data comes from — and what is deferred.** `attention` and `inProgress` are
supplied by the *caller* (the hub screen / the live reconciliation session that holds the
in-memory `ReconciliationPlan`), **not read from persisted collections**, because the persisted
signal does not exist yet (see Context). Concretely:

- **Available today (S5 can ship):** the *hub session* can pass `attention`/`inProgress` computed
  from a `ReconciliationPlan` it currently holds in memory (the preview the director is looking at,
  or a staged-but-uncommitted plan). While no plan is in play, these are absent and every category
  is Ready / Missing / Optional — the honest binary, richer glyphs.
- **Deferred to S2a (not this ADR):** a *durable, at-rest* Needs-attention — "this activity's
  eligibility was inferred at last import and never confirmed," visible on a cold app load with no
  active session. That requires the per-field import-vs-human provenance bit S2a persists
  (schema v29, proposed). When S2a lands, a follow-up can populate `attention` from collections
  inside `getReadiness` **without changing its signature** — the seam is already the right shape.

This split is the recommendation: **build the full six-state shape now; scope the Needs-attention
*inputs* to the live-session data that exists; do not add schema in S5 to make at-rest
Needs-attention work — let it ride on S2a.**

### 3. Location and Staffing are forward-looking, never blocking

`location` and `staffing` are `kind:'forward'` descriptors with no collection binding. They render
**Optional** ("not started") by default, or **Not-applicable** when the camp declares it (a camp
that supplies no staff). They **cannot** reach Missing — the state machine's Missing arm is gated
on `kind === 'required'`, and neither is in `REQUIRED_AREAS`. This is enforced structurally, not by
convention: `REQUIRED_AREAS` never grows (`SETUP_READINESS.md` invariant 6), so nothing forward can
ever gate a week. (`notApplicable` for staffing is a session/camp-preference input, not new schema
— if a durable "this camp supplies no staff" flag is later wanted, that is a separate small
decision, deliberately out of S5 scope.)

### 4. Missing (blocking, red) vs Needs-attention (bronze) — the enforced distinction

- **Missing** = `kind:'required'` + empty collection = member of `getSetupGaps`. Red
  (`--danger`), rare, loud. Red is reserved strictly for "blocks generating a schedule."
- **Needs-attention** = has rows + a caller-supplied review count. Bronze (`--accent`),
  resolvable, **never** red. It cannot be produced for an empty required area (that path is Missing
  first) — the precedence table makes the two structurally non-overlapping.

### 5. The honest one-sentence summary — evolve, don't replace

Keep `describeSetupGaps(gaps)` **unchanged** (the gate calls it). Add a sibling:

```
describeReadiness(readiness) -> { blocking: string, attention: string | null }
```

- `blocking` = `describeSetupGaps(getSetupGaps(...))` verbatim — blocking truth first.
- `attention` = the quiet second line, e.g. `"3 items could use your attention."`, or `null` when
  there are none. Built from the count of `needs-attention` categories/items in the readiness
  array. Ready headline stays `"Ready to build a week."`

The hub renders `blocking` as the headline and `attention` as a visually quieter secondary line so
it can never be mistaken for a blocker. No percentage, no progress bar (invariant 3).

### 6. Integration — no regression to the gate

- **Generation gate (`ScheduleScreen.jsx`): unchanged.** It keeps calling `getSetupGaps` +
  `describeSetupGaps` directly. It does **not** adopt `getReadiness`. This is the guarantee that
  the six-state layer cannot alter what blocks a week.
- **Sidebar + new hub: consume `getReadiness`.** The two new glyphs — `–` (Not-applicable) and `⋯`
  (In-progress) — extend `MARK_COLOR`/`TONE_COLOR` in the same spirit (distinct glyph + a word + a
  muted color role) so the sidebar rollup and the hub never disagree (invariant 7). Migrating the
  sidebar's marks from `countGaps` to `getReadiness` is a mechanical follow-up, not required in the
  first slice; when done it must preserve the existing `!`/`✓`/`·` rendering for the three states
  that already exist.
- The Maker adds `getReadiness` + `describeReadiness` with their own unit tests (state-machine
  table, degradation-with-no-signals, forward-never-missing, Missing-from-getSetupGaps identity).
  The existing `readiness.test.js` is untouched and must stay green.

---

## Schema impact: NONE

Confirmed. Readiness is computed from already-loaded collections plus caller-supplied session
signals. No table, column, migration, or sync-replication change. The one signal that *would* need
persistence — a per-row/per-field "inferred, not yet confirmed" bit for at-rest Needs-attention —
is **deliberately not added here**; it is deferred to ADR S2a (schema v29, proposed), and
`getReadiness`'s signature is shaped so S2a can feed it later without a contract change. If a
future decision wants a durable "camp supplies no staffing" flag for Not-applicable, that is a
separate, smaller schema decision outside S5.

---

## Consequences

- The blocking core stays the single source of truth; the states layer is strictly additive and
  reads *from* it. A bug in the states layer cannot change what blocks a week.
- Until a reconciliation session is active (or S2a lands), Needs-attention and In-progress are
  simply absent — the hub shows Ready / Missing / Optional. This is a feature: the app never shows
  a "needs attention" flag it cannot substantiate, preserving the module's hard-won property that
  the flags shown are the flags that are real.
- The full six-state *vocabulary* (glyphs, colors, copy) can be designed and shipped now; its
  richer *inputs* arrive incrementally as the live-plan session and then S2a provide them.

---

## Open questions for Governor

1. **Not-applicable source for Staffing/Location.** S5 treats `notApplicable` as a session/preference
   input with no persistence. Is a durable per-camp "supplies no staff" declaration wanted now, or
   is Optional ("not started") an acceptable resting state for both forward categories until S3/S6
   build them? (Recommendation: Optional-only in S5; defer any durable N/A flag.)
2. **Sidebar migration timing.** Move the sidebar's item marks + rollup onto `getReadiness` in this
   slice, or leave them on `getSetupGaps`/`countGaps` and only have the *new hub* consume
   `getReadiness` first? (Recommendation: hub-first; migrate the sidebar as a mechanical follow-up
   once the two new glyphs are ratified, to keep the first slice small and reversible.)
3. **New-glyph ratification.** `–` and `⋯` extend the DESIGN_STANDARD glyph vocabulary. Does adding
   two glyph+color pairings clear the bar as a normal design change, or does it need the same human
   gate flagged for the three-look provenance grammar (`ONBOARDING_UX_OPTIONS.md` §9)?
