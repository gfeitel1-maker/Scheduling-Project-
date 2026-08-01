---
title: "Camp setup flow — diagnosis and recommendations"
document_type: spec
status: active
created: 2026-07-31
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
archive_when: R1 is merged and Verifier PASS recorded
---

# Camp setup flow — diagnosis and recommendations

Commissioned to answer: *the Camp Setup screen and the sidebar's Setup section
seem to be doing the same thing — recommend a change.*

Companion: `2026-07-31-campsetup-vs-sidebar-prototype.html` (Designer).

## 1. Answer

**The duplication is real but cosmetic. The bug underneath it is not.**

`CampSetup.jsx` and the sidebar do share destinations, labels and navigation —
for the five items they have in common, `step.screen` and the sidebar's
`item.key` are the same `SCREENS` keys routed through the same `onNavigate`. The
only thing CampSetup adds is completion state.

**That completion state is wrong**, and it is wrong in a way a director can
reach by ordinary use.

## 2. Five surfaces, five definitions of "setup"

| # | Surface | Required set | Test |
|---|---|---|---|
| 1 | `CampSetup.jsx:6-42` | Units, Groups, Time Blocks, Activities, Fixed Events (**5**) | `count > 0` |
| 2 | `ScheduleScreen.jsx:1646` | Groups, **Days**, Time Blocks, Activities (**4**) | `length === 0` |
| 3 | `Sidebar.jsx` `NAV_SECTIONS` | 9 nav items | none |
| 4 | Per-screen "Next:" chain | Units → Groups → Time Blocks → Activities → Fixed Events → Schedule; **Days is an orphan** | none |
| 5 | Per-screen empty states | varies | varies |

Plus a sixth on paper: `2026-07-30-sidebar-navigation-design.md` §D4/D6 proposes
a required set of **6**. See §6 — that one is mine, and it is also wrong.

The two *shipped* gates overlap on only three tables. Each demands something the
other ignores.

## 3. What the engine actually requires

Derived mechanically from `src/engine/buildSchedule.js`, not editorially:

| Input | Status | Evidence |
|---|---|---|
| `groups` | **Required** — outer loop | `:147` |
| `days` | **Required** — middle loop | `:148` |
| `timeBlocks` | **Required** — inner loop | `:149` |
| `activities` | Grid builds without it; every slot flagged `UNFILLABLE` | `:165`, `:336-339` |
| `tiers` | **Never read.** Destructured as `tiers: _tiers` and discarded | `:70` |
| `anchors` | Optional — arrives as `_legacyAnchors`, defaults `[]` | `:106` |
| `cohorts` | Not a parameter on the path ScheduleScreen calls | `:52-66` |

**The engine's real contract is groups, days, timeBlocks, activities — exactly
ScheduleScreen's four.** Of the five in-app surfaces, the one nobody designed as
the authority is the only one that matches.

### But "can it run" is not "is it usable"

The engine never reads the `tiers` **table**, yet reads `group.tier_id`
constantly — activity eligibility (`:94`), anchor targeting (`:110`), same-tier
rules (`:220`). With no Units, every group's `tier_id` is null, any activity
scoped by `eligible_tier_ids` matches nobody, and the engine happily produces a
week that is entirely unfillable.

Likewise Programs: `TiersScreen`, `TimeBlocksScreen` and `AnchorsScreen` all
gate data entry on `activeCohort`. Zero programs makes three of CampSetup's five
steps *uncompletable* — and CampSetup never mentions Programs.

**The honest taxonomy, which no surface expresses:**

| | Needed to run | Needed to be useful | Optional |
|---|---|---|---|
| Groups, Days, Time Blocks | ✓ | | |
| Activities | builds, all `UNFILLABLE` | ✓ | |
| Units | | ✓ (via `group.tier_id`) | |
| Programs | | ✓ (data entry gate) | |
| Fixed Events, Day Overrides | | | ✓ |

Every surface uses a flat `count > 0` test, and none distinguishes these
columns. That is *why* they disagree — each answers a different question without
saying which.

## 4. The reachable defect

1. Director completes CampSetup's five. `allDone` true (`:130-131`), CTA enabled.
2. `DaysScreen.jsx:157` deletes days one at a time with **no minimum guard**.
   Delete all of them. CampSetup still reads **5/5 complete** — `days` is not one
   of its keys.
3. Click **"Generate Schedule →"** → `onNavigate('schedule')`.
4. `ScheduleScreen.jsx:1646` computes `setupIncomplete` → true, and renders
   "Setup incomplete… Days" with a **"Go to Camp Setup"** button (`:1650-1665`).
5. That button returns to CampSetup, which shows **5/5 complete** and an enabled
   CTA.

**A closed loop with no exit signposted.** The only escape is knowing to click
Days in a nine-item sidebar with no indication which item is the problem.

And `CampSetup.jsx:168` tells the director, in plain text: *"The engine needs all
five before it can build a schedule."* **False in both directions** — it names
two tables the engine never requires and omits the one it blocks on.

**Bounding qualifier, verified:** `seedDays` re-seeds Mon–Fri on every mount via
a per-camp ref (`App.jsx:73-79`), so the zero-days state persists only for the
session. The loop is reachable but transient. This does not make the gate
correct — it means the gate has been wrong without being noticed.

## 5. Recommendations

### R1 — One readiness function, derived from the engine *(recommended, high confidence)*

New pure module `src/engine/readiness.js` exporting
`getSetupGaps({ groups, days, timeBlocks, activities })` → an array of
`{ key, screen, message }` in camp language ("You haven't said which days camp
runs").

- `ScheduleScreen.jsx:1646` replaces its inline boolean with a call to it.
- `CampSetup.jsx` calls **the same function**. The progress bar (`:214-233`),
  `doneCount`/`allDone` (`:130-131`), the gated CTA (`:320-338`) and the false
  copy (`:168`) are **deleted**, replaced by one honest line: *"Ready to build a
  week"* or *"Two things still needed before you can build a week: Days, Time
  Blocks"*, items linking via existing `onNavigate`.
- The step rows survive as an unranked launcher with live counts. **Days is
  added as a row.** `prevAllDone` sequential gating (`:240-241`) is deleted — it
  was never real (it only drives `boxShadow` and `outline`; the button has no
  `disabled` and always navigates).

This is not a fourth opinion. Its authority is mechanical: the engine's source
says which four tables it dereferences.

**Verifiable success criterion.** Fixture with tiers/groups/timeBlocks/
activities/anchors populated and **zero rows in `days_of_operation`**:
`getSetupGaps` returns exactly one gap naming Days; CampSetup and ScheduleScreen
render the same sentence from it. Second assertion: `grep` finds no other
hardcoded required-set literal in `src/`.

**Cost.** One new file (~50 lines), edits to two screens, mostly deletion. No
schema, no persisted state, no router, **no file owned by the sidebar stream**.
Survives 1 and 100 groups.

**Load-bearing risk.** Removing the gate without the gap sentence strands a
first-run director. They ship together; the sentence lands first.

### R2 — One manifest, three renderings *(follow-on)*

`src/setup/setupManifest.js` — one entry per setup area carrying
`{ key, screen, label, desc, engineRequired, isSufficient(rows) }` plus the
empty-state string. `engineRequired: true` for groups/days/timeBlocks/
activities; `false` for Programs, Units, Fixed Events, Day Overrides, which
appear in navigation and gate nothing.

**The sidebar spec §D4 already asks for exactly this module** ("the same string
the destination screen shows in its own empty state, imported from one shared
module"). The two streams want the same thing, so build it once.

**Coordination required** — R2 touches `Sidebar.jsx`, owned by the sidebar
stream. See `docs/superpowers/handoffs/2026-07-30-stream-ownership.md`.
Sequence R1 first so R2 has a proven predicate to put in the manifest rather
than inventing one.

### R3 — Delete the CTA rather than rename it *(ships with R1)*

`CampSetup.jsx:331` reads **"Generate Schedule →"** — the generated route's own
verb (`ROUTE_COPY.generated.offerAction` is literally "Generate a schedule").
The *target* is neutral and ADR-compliant; the **wording is not**. A director who
builds by hand reads it as the thing they haven't done.

Designer proposed renaming to a neutral phrase. Governor argues for deleting the
CTA outright, and I agree: `App.jsx:39-50`'s neutral entry **already asks** which
week to open, so a CTA here makes the director answer the same question twice —
and whichever option sits left reads as the default. Two "equal" buttons violate
the ADR more subtly than one wrong one.

In-repo precedent for the neutral phrasing if a CTA is kept anyway:
`AnchorsScreen.jsx:690` says **"Next: Schedule →"**.

Also restate `:168` factually — it currently asserts something false regardless
of what happens to the button.

### R4 — Sufficiency predicates *(hold — file, don't build)*

`count > 0` is a *presence* test, not a *sufficiency* test. A camp with one
group, one activity whose `eligible_tier_ids` matches no group, seven days and
three blocks reads as complete on both gates and produces a useless week.

**Do not build this yet.** A 1-group camp is legitimate, and the only case
provably producing a bad week — eligibility mismatch — is already flagged at
runtime as `UNFILLABLE` (`buildSchedule.js:337`). Duplicating that check at setup
time is speculative machinery. Wait for a real complaint.

## 6. My own spec was also wrong

`docs/work/specs/2026-07-30-sidebar-navigation-design.md` §D4/D6 specifies a
required set of six — Programs, Units, Groups, Days, Time Blocks, Activities —
and gates the sidebar's recession on it. That set includes two things the engine
does not require, and was derived editorially rather than from the engine.

**It must be amended to consume R1's `getSetupGaps` rather than carry its own
list.** Recorded here rather than quietly fixed, because a sixth independent
definition of setup is exactly the failure this document is about, and I
introduced it.

## 7. Bugs found in passing — worth tickets regardless

1. **`CampSetup.jsx:168` states something false to the director.** Highest
   trust cost, lowest fix cost.
2. **Days deletable to zero** (`DaysScreen.jsx:157`) with no minimum guard.
3. **`seedDays` and `ensureCohort` are fire-and-forget** (`App.jsx:73-79`) with
   no `.catch`. `ensureCohort` *throws* on camp mismatch
   (`ensureCohort.js:54`) — an unhandled rejection, no banner, no retry. Contrast
   CampSetup's own `loadCounts`, which degrades gracefully with a retry
   (`:96-98`, `:138-148`).
4. **`seedDays` fights the director.** It re-adds any missing weekday, so a camp
   legitimately running Sunday–Thursday gets Friday back on every launch.
5. **CampSetup counts camp-wide; three of its destinations are cohort-scoped.**
   `loadCounts` calls `localClient.list(table)` with no filter (`:81`), while
   `TiersScreen`, `TimeBlocksScreen` and `AnchorsScreen` filter to
   `activeCohort`. With more than one program, CampSetup can show "3 Units ✓"
   while the Units screen shows zero.
6. **CampSetup is the landing screen on every session** — `useState('setup')`
   (`App.jsx:60`), first run and hundredth, with no first-run distinction. A
   progress dashboard earns its space once. `App.jsx` is a shared file; route
   this through the ownership handoff.
7. **No tests exist for CampSetup.** `doneCount`, `allDone`, the `count > 0`
   rule, the `Promise.allSettled` fallback and the CTA gate are entirely
   uncovered.

## 8. Explicitly rejected

- **Deleting CampSetup.** It carries the per-step `desc` strings that explain
  what a "unit" or "anchor activity" *is* — a first-run director doesn't know,
  and a 200px sidebar cannot hold two explanatory lines per item. The sidebar is
  not a viable host for the onboarding narrative.
- **Two equal CTAs ("Build Manually" / "Let the engine propose").** Violates the
  ADR more subtly than the current single wrong button. See R3.
- **Hardening `prevAllDone` into real sequential locking.** The ordering is
  already fake — Days is editable any time from the sidebar — and enforcing it
  would formalise an order the engine doesn't require.
- **Running `buildSchedule()` speculatively on partial data** to derive
  readiness. Attractive, but `normalizeInput` assumes arrays exist and the
  placement passes are not hardened for degenerate shapes. A crash-prone setup
  screen is worse than a wrong one. R1 captures the value statically.
- **Attestation records / persisted completeness claims.** New entity, new
  projection, new sync surface, for a problem no director has.
- **Per-week or per-group readiness.** Invents a *fifth* definition and needs
  week-scoped state the app lacks.

## 9. Noted for the flag-system work, not this ticket

The strongest idea generated didn't fit here: **route every schedule flag back to
the setup item that caused it** — *"this UNFILLABLE traces to: Activities →
Archery, no eligible groups."* That inverts the relationship — setup stops being
a thing you finish before scheduling and becomes where the schedule sends you
when it's unhappy. Recorded in
`2026-07-31-flag-system-review-recommendations.md`'s territory rather than
actioned here.

## 10. What would change the recommendation

- **Does a first-run director need a starting point at all?** R1 bets the
  sidebar plus a gap sentence is enough. The only assumption not settleable from
  code — watch one director open a genuinely empty camp.
- **Is Fixed Events genuinely optional in practice?** The engine says yes. A
  director building a week with no meals or flagpole may disagree.
- **Should Units be a row at all**, given eligibility reads `tier_id` off groups?
  If `GroupsScreen` requires picking a unit, Units is enforced transitively and
  the row is informational.
