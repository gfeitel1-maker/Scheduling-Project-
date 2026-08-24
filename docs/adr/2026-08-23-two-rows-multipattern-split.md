---
title: "Two-rows split for multi-pattern activities (OQ1 implementation)"
status: accepted
date: 2026-08-23
supersedes: none
amends: docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md (§7 OQ1)
approved: "owner-approved 2026-08-23. OQ1 = two rows sharing a display name. OD-1 = ship now behind the human confirm-gate + instrument precision. OD-2 = auto '(rec)' suffix, director-editable inline."
---

# Two-rows split for multi-pattern activities

Owner priority #5 in the camp-setup-ingestion program. Implements OQ1 of the
recurrence-tiers ADR: a single activity that carries **two occurrence-patterns**
— e.g. "Swim" is a director-pinned **Asserted** block *and* also a frequency
(**Obligation**) or refusable (**Permission**) offering — is modeled as **two
separate `activities` rows sharing a display name**, the split **suggested to the
director during ingestion, never silently auto-applied**.

This is the coexistence case that PR #172 (#3 permission-tier) and PR #173 (#4
reclassify) deliberately deferred to. Both are non-destructive by construction —
they only ever write a *blank* `recurrence_truth_status` or clear an *exactly*
`'permission'` one, never overwriting `asserted`/`obligation`
(`src/ingest/electivePermissionTier.js`, `src/ingest/electivePermissionClear.js`).
The split completes that seam: it is how a real coexistence gets *two* truth
values instead of one row's single column being fought over.

## Load-bearing constraint: `UNIQUE(camp_id, name)`

`activities` enforces uniqueness on `(camp_id, name)` — via the table constraint
on fresh installs (`electron/db/schema.sql:302`) and via `idx_activities_camp_name`
on migrated dbs (localDb.js version-15). **Two rows cannot share a stored `name`.**

Therefore the two rows share a *display relationship*, not an identical stored
string: the pinned row keeps the bare name ("Swim"); the flexible row takes a
**distinct suffixed stored name** ("Swim (rec)"). The suffix is not cosmetic — it
is the mechanism that satisfies the UNIQUE constraint. Omitting it makes the
second INSERT fail. This means:

- **No migration is required** (the recurrence-tiers ADR §Recommended-path claim
  holds) — but *only* under the distinct-stored-name model. A genuine shared
  `display_name` column (suffix as pure UI) *would* require a migration: a new
  column plus moving the UNIQUE off `name`. We do **not** do that here.
- The suffix convention (OD-2 below) is a real, load-bearing decision, not paint.

## Design

### Trigger & surface
Reuse the existing `dualUseNames` signal (`src/ingest/fixedEvents.js:340-376`): a
name is dual-use iff the same normalized name appears both inside a fixed-event
footprint AND outside it. Today it only seeds `pinOnlyActivityNames`'s default
tick-state in the ImportScreen review flow. #5 adds one affordance in that same
reconciliation surface (not a parallel system): for each dual-use name, offer
"This appears as both a fixed block and a flexible activity — keep as one, or
split into **Swim** (pinned) + **Swim (rec)** (flexible)?" with the split
**off by default** (conservative; a wrong suggestion costs one ignore, an
accepted wrong split costs an untick + merge).

### Split mechanics (on director accept)
1. The existing row keeps the bare name and takes `recurrence_truth_status =
   'asserted'` (the pinned/fixed-event pattern stays on it).
2. A new `activities` row is created with the suffixed name and
   `recurrence_truth_status = 'obligation'` (or left blank for the classifier /
   `'permission'` if the flexible pattern is an elective) — the flexible
   pattern's data (frequency rule / elective membership) attaches to the new row.
3. Both writes compose with the non-destructive #3/#4 writers: the split sets
   `asserted`/`obligation` explicitly on create; the elective writers still only
   touch a blank or `'permission'` value, so they never fight the split.

### Provenance & re-import idempotency
A director-accepted split is a human decision and must survive re-import. Reuse
the `_humanFields` / `import_evidence` provenance mechanism (same as activity-rule
provenance, PR #28): stamp the split rows human-confirmed. On re-import of the
same file:
- the suffixed row is matched by its stored name and **not** re-suggested;
- the split is **not** undone (the flexible pattern re-imports onto the existing
  suffixed row via normalized-name dedup, which now matches "Swim (rec)");
- a dual-use name that was **declined** (kept as one) must also not nag every
  re-import — record the decline decision so the suggestion is suppressed.

### False-split risk (the ADR's medium-confidence caveat)
OQ1 confidence is **high** that two-rows is the right shape, **medium** that
`dualUseNames` is precise enough to drive the suggestion without false splits.
Because the split is **director-confirmed, off by default**, a false positive
costs a single ignore — the human gate absorbs the data risk the ADR worried
about. The residual risk is **suggestion noise** (if dualUseNames flags many
non-splits, the director learns to ignore all of them). This cannot be measured
here — the owner's 4 real schedules were chat attachments, not committed
fixtures, so there is no data to run `dualUseNames` against in-repo. See OD-1.

## Decisions (owner-resolved 2026-08-23)

**OD-1 — sequencing / validation gate. RESOLVED: ship now.** Build the suggestion
behind the human confirm-gate, off by default, plus lightweight accept/ignore
instrumentation so real usage measures `dualUseNames` precision instead of
speculation. The confirm-gate makes the data safe; gating on validation needs
real fixtures we don't have and would stall the slice.

**OD-2 — suffix convention. RESOLVED: auto "(rec)", editable.** The flexible row
is auto-named "<name> (rec)"; the director can edit the suffix inline before
confirming. Smallest director effort; "(rec)" reads as recreational/flexible,
matching the Permission/Obligation sense.

## Slice plan (each independently shippable + gate-able)
- **Slice 1 — split-emit logic (pure, no UI):** given an accepted dual-use split
  decision, write the two rows with correct truth-status + human provenance.
  Test-first; the whole risk of the data shape lives here. No schema change.
- **Slice 2 — reconciliation affordance:** the off-by-default suggestion in the
  ImportScreen review surface + the editable suffix (OD-2) + decline-memory.
- **Slice 3 — instrumentation (OD-1):** accept/ignore counters so precision is
  measured from real imports.

## Confidence & biggest risk
Confidence **high** on the data model (distinct-stored-name, no migration,
composes with #3/#4). Biggest risk: **suggestion noise** from `dualUseNames`
false positives — mitigated by off-by-default + human gate + instrumentation, but
genuinely unmeasurable until real imports flow (OD-1).
