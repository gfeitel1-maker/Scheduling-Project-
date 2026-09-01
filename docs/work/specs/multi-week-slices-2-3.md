---
title: "Multi-week Slices 2 and 3 — duplicate, per-week participation, permanent delete"
document_type: spec
authority: proposed
status: draft
created: 2026-08-03
governing_docs: [docs/adr/2026-08-03-multi-week-slices-2-3.md, docs/adr/2026-08-02-schedule-weeks-first-class.md]
depends_on:
  - docs/adr/2026-08-02-schedule-weeks-first-class.md
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
  - docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
archive_when: implemented and the three multi-week slice features are live
---

# Multi-week Slices 2 and 3

**Status: NOT approved for implementation.** Four gates in §7 must clear first, two of
them product decisions only the owner can make. Maker does not start until §7 is signed off.

> **Document location note.** This file was requested at `docs/workflow/specs/`. The
> repository's established location is `docs/work/specs/`, which is what
> `scripts/build-work-index.js` scans and what `docs/work/INDEX.md` is generated from.
> Left at the requested path as instructed; it will not appear in the work index until
> moved. Say the word and it moves.

---

## 1. What this covers

Slice 1 shipped: `schedule_weeks` (migration v27), `schedule_templates.week_id`,
`UNIQUE(week_id, kind)`, the WeekSwitcher, and `loadWeeks`/`createWeek`/`writeWeekFields`
in `~/dev/shoresh/src/data/scheduleRepository.js`. Groups, tiers,
activities and days remained camp-wide.

Product owner direction, verbatim:

> "yes to slice 1, 2, 3. they may need different activities and groups but not days. but
> it could be a toggle button on the activity set up part and not needed for the grid to
> decide"

Read as three binding constraints:

- **Activities and groups may vary by week. Days never do.**
- **Variation is expressed in the setup screens**, as a per-row toggle — not as new
  controls in the schedule grid.
- **The engine does not re-architect.** `buildSchedule`'s signature is unchanged; the
  screen flattens the camp catalog against the week's variation before calling it.

**Slice 2** — duplicate-a-week; per-week activity participation; per-week group participation.
**Slice 3** — permanent delete a week, with cascade.

### Non-goals (explicit — these do NOT count as done)

- Per-week days, time blocks, tiers, cohorts, or day-override templates. All stay camp-wide.
- Any new control in the schedule grid, drag-and-drop, or `computeOverlaps`.
- Any change to `src/engine/buildSchedule.js`'s signature or internals.
- Copying `schedule_snapshots` when a week is duplicated (see §3.3).
- Trash/restore for individual participation rows.
- Designating any week as canonical, current, or active. Slice 1's ADR rejected
  `camps.current_week_id` and that stands.

---

## 2. The schema decision, and the one that was reversed

Divergence and the Architect converged on: **junction tables keyed `(week_id, entity_id)`
against the camp-wide catalog, with a derived "customized" indicator rather than a stored
boolean.** That much holds.

**Architect proposed an INCLUDE list (a row means "this runs this week"; zero rows means
"inherit everything"). Red Hat killed it, correctly, and this spec reverses it to an
EXCLUDE list.**

The defect: under an include list, a director who turns off *every* activity for a themed
week produces zero rows — bit-for-bit identical to a week nobody ever touched. The app
would then silently schedule the entire camp catalog, the exact inverse of what the
director just did, while the "customized" badge reads "not customized." That is a
correctness bug in the specification, not an implementation edge case, and it violates
Article V ("the engine surfaces conflicts; it never resolves them silently").

An exclusion list has no such ambiguity, and it is strictly smaller and simpler:

| State | Include list (rejected) | Exclude list (adopted) |
|---|---|---|
| Untouched week | 0 rows | 0 rows |
| All activities off | 0 rows — **collides** | N rows — distinct |
| Some off | subset rows | rows for the off ones only |
| Storage for the common case | seeds N rows on first toggle | stores nothing |

It also matches the Designer's one-step UX exactly: the first OFF click *is* the row's
creation; clicking back ON deletes the row. There is no "enable customization for this
week" mode, because there is nothing to enable.

### 2.1 Tables (migration v28)

```sql
CREATE TABLE IF NOT EXISTS week_activity_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  activity_id TEXT NOT NULL REFERENCES activities(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_week_activity_exclusions_week_activity
  ON week_activity_exclusions(week_id, activity_id);

CREATE TABLE IF NOT EXISTS week_group_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  group_id TEXT NOT NULL REFERENCES groups(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_week_group_exclusions_week_group
  ON week_group_exclusions(week_id, group_id);
```

Semantics, stated once and load-bearing everywhere: **a row means "this activity/group
does not run in this week." Absence means it runs.** There is no third state.

`CREATE TABLE` statements go in `electron/db/schema.sql` unconditionally (matching how
`schedule_weeks` is handled); the indexes are created only inside the migration block, for
the same reason `idx_schedule_weeks_camp_name` is — `schema.sql` re-executes on every open.

**No schema change to `activities` or `groups` themselves.** They are not forked per week.

**Migration gate:** `getSchemaVersion(db) >= 27 && < 28`, not a bare `< 28`. Reason in
§7 Gate C.

### 2.2 Required registrations (all four, or the feature silently half-works)

1. `~/dev/shoresh/electron/ops/campScopedEntities.js` →
   `PARENT_SCOPED_ENTITIES`, both tables, `parentTable: 'schedule_weeks'`,
   `parentKey: 'week_id'`.
2. `~/dev/shoresh/electron/ops/projections.js` → two `PROJECTIONS`
   entries, `fields: ['week_id','activity_id']` / `['week_id','group_id']`, with
   `ensureExists` gated on `field === 'week_id'` arriving first, mirroring
   `day_override_template_slots`. **Without this, writes silently never materialize.**
3. `~/dev/shoresh/electron/sync/syncServer.js` →
   `DOMAIN_PARENT_SCOPED_ENTITIES` (~line 25). **This array is hand-maintained and is NOT
   derived from `PARENT_SCOPED_ENTITIES`'s keys**, despite `campScopedEntities.js`'s own
   header comment claiming the two are structurally guaranteed to match. They are not.
   Registering in `campScopedEntities.js` alone makes both tables invisible to
   first-pairing full sync. This pre-existing drift deserves its own cleanup ticket
   (derive the list from `Object.keys`), out of scope here.
4. Not added to `RESTORABLE_ENTITIES` or `CLEARABLE_ENTITIES` — an exclusion row is
   created and destroyed by an ordinary toggle, not by the Trash flow.

### 2.3 Resolution — what the engine receives

New pure module `~/dev/shoresh/src/engine/weekCatalog.js`, co-located with
`buildSchedule.js` for the same reason (no React, no IPC, unit-testable directly):

```js
export function resolveWeekCatalog({
  groups, activities, anchors, weekId,
  activityExclusions, groupExclusions,
}) → { groups, activities, anchors, suppressedAnchors }
```

- `activities` = camp activities minus those with an exclusion row for `weekId`.
- `groups` = camp groups minus those with an exclusion row for `weekId`.
- `anchors` = camp anchors minus any whose activity or every one of whose groups was
  excluded — **see §2.4, this is not optional.**
- `suppressedAnchors` = the anchors that were dropped and why, returned so the screen can
  show it. Never silently swallowed.

Call site: `ScheduleScreen.jsx` resolves once per week load, alongside the existing
`loadSetupLists()`, and threads the *resolved* arrays into `useGeneration`.
`useGeneration.js` needs no change — it already receives `groups`/`activities` as props.
`buildSchedule`'s signature is confirmed unchanged.

The **grid is not filtered post-hoc.** Exclusions constrain what the generator and the
setup pickers offer; they never retroactively hide slots already placed. That asymmetry is
deliberate and is what "not needed for the grid to decide" means.

### 2.4 Anchors — the gap Red Hat found

`anchor_activities` is camp-wide (`DIRECT_CAMP_ENTITIES`) and `buildSchedule` pre-places
anchors as locked slots *before* the eligibility pass, without checking the anchor's
activity against the `activities` array passed alongside it. So filtering activities and
groups but not anchors lets an excluded activity reappear, **locked**, in the generated
schedule.

Required: `resolveWeekCatalog` filters anchors too, and the screen surfaces
`suppressedAnchors` as a visible finding — "2 anchored activities don't run in Week 3 and
were left out." Dropping them silently would be the tidiness-over-truth failure Article V
forbids.

---

## 3. Duplicate-a-week

### 3.1 Mechanism

New host-only module `~/dev/shoresh/electron/ops/duplicateWeek.js`,
structured exactly like the existing `electron/ops/deleteRecord.js` precedent: **one
`db.transaction()`, host only, ops collected and returned for broadcast after commit.**

The divergence disagreement — one atomic payload op vs. N per-row ops — resolves to
neither pure answer. Route each entity through the mechanism it is already registered for:

- `template_slots` and `template_overlays` are already in `BULK_REPLACE_ENTITIES`. Use
  `appendBulkReplaceOp` against the fresh, empty target `template_id`. That is **one
  atomic op per table**, the same replication shape a normal `generate()` run already
  produces — not a new op kind, and not a fan-out that can half-arrive.
- `schedule_weeks`, `schedule_templates`, and the exclusion rows are low-cardinality with
  no bulk-replace registration; ordinary per-row `appendOp`, same as `createWeek` today.

Inventing a third op kind with an inline payload is rejected: `applyProjection` /
`applyBulkReplaceProjection` have no such shape and there is no precedent in
`electron/ops/operations.js`.

### 3.2 Ids

Every id is fresh. `crypto.randomUUID()` for the new week, exclusion rows, slots and
overlays; `deriveScheduleTemplateId(newWeekId, kind)` for each template — deterministic,
but keyed to the **new** week, never reusing the source's id. No row is ever aliased
between weeks; aliasing would make editing the copy silently mutate the original.

Both routes are copied — manual **and** generated. Neither is canonical
(ADR 2026-07-28), so copying only one would be the app picking a winner.

### 3.3 What is not copied

`schedule_snapshots`. They are point-in-time history belonging to the source template. A
duplicated week starts with no version history, matching a brand-new week. Called out
because it is an easy reflexive addition.

### 3.4 Ordering under partial sync

The new `schedule_weeks` row's ops are appended **last**, after every template, slot,
overlay and exclusion row. A client that replays only part of the duplication then does not
show a selectable-but-hollow week in the switcher. Whether the sync layer guarantees strict
per-entity seq ordering across a reconnect is **unconfirmed** and is Gate D in §7.

### 3.5 Idempotent retry

`client_write_id` idempotency is per-op. A duplication is dozens of ops. A renderer-side
timeout-and-retry that mints fresh ids would produce a **second complete duplicate week**,
not a no-op. Required: every op in a duplication derives its `client_write_id`
deterministically from the duplication's own identity —
`dup:${sourceWeekId}:${newWeekId}:${entity}:${n}` — with `newWeekId` minted once, before
the transaction, and reused on retry. This is the same reasoning that made
`deriveScheduleTemplateId` deterministic.

### 3.6 IPC

New `shoresh:duplicate-week` handler in `electron/main.js` behind `authorize()`, exposed as
`window.shoresh.duplicateWeek` in `electron/preload.js`, and mirrored in
`src/localClient.mock.js` so the browser dev route at :5200 doesn't diverge.

---

## 4. Permanent delete a week (Slice 3)

No existing helper covers this. `deleteRecord.js`'s `CLEARABLE_ENTITIES` is
`{groups, activities, days_of_operation}` and its "clear what blocks the delete" logic does
not apply — deleting a week deletes everything scoped to it.

New host-only module `~/dev/shoresh/electron/ops/deleteWeek.js`, one
transaction, children before parents, routed through the op-log as tombstone/delete ops —
**never a raw SQL DELETE outside the op-log**, or it neither replicates nor audits.

### 4.1 Cascade order (authoritative)

Guard first, then, for both the manual and generated template of the week:

1. `schedule_snapshots` — rows for both templates (real FK to `schedule_templates`).
2. `template_overlays` — rows for both templates (real FK).
3. `template_slots` — rows for both templates. **No FK exists**; leaving them is exactly
   the orphan class `removeDayFromWeek` already treats as a defect.
4. `week_activity_exclusions`, `week_group_exclusions` — rows for the week.
5. `conflicts` — any unresolved rows whose `entity_id` is one of the rows deleted above.
   See §4.3.
6. `schedule_templates` — both rows.
7. `schedule_weeks` — the week row itself, last.

**Explicitly not cascaded, and stated so it is not later mistaken for an omission:**
`day_override_templates` / `day_override_template_slots` are camp-scoped via `camp_id` and
have no relationship to weeks at all. `operations` is append-only history and is never
deleted — that is what makes the delete auditable.

### 4.2 Last-week refusal

Before anything else: `SELECT COUNT(*) FROM schedule_weeks WHERE camp_id = ?`. If the week
being deleted is the camp's only week, refuse — return `{ error: 'last-week' }`, delete
nothing.

This is a data-layer invariant, not a UI nicety. `deriveScheduleTemplateId`,
`templateRowFor`, the WeekSwitcher, and v27's "every camp gets exactly one Week 1" all
assume a camp has ≥1 week. `ScheduleScreen.jsx`'s week resolution falls back to `camp[0]?.id`,
which is `undefined` on an empty array — an unrecoverable state nothing downstream handles.
The UI blocks it too (§5.4), but the guard lives in the data layer.

### 4.3 Concurrent edit / stale conflicts

- Unresolved `conflicts` rows pointing at deleted entities must be closed by the delete, or
  the conflicts UI shows a conflict about a slot in a week that no longer exists. Closing
  them in step 5 is the required behavior.
- A device mid-edit when another device deletes the week must collapse gracefully: the
  in-flight edit's op fails to project (parent gone), and the editing screen redirects to
  another week with a plain message — "Week 3 was deleted on another device." Silent
  failure or a frozen drag is not acceptable.

### 4.4 No pre-delete snapshot

Unlike group/day deletion, no automatic snapshot is taken. A snapshot of the doomed week
would point at a `template_id` deleted in the same transaction — orphaned on creation.

---

## 5. UX specification

Full design detail is in the Designer's spec, reproduced in the handoff. The binding
points:

### 5.1 Week context pin

`ActivitiesScreen.jsx` and `GroupsScreen.jsx` currently have **no week context whatsoever**.
A director toggling off while mistaken about which week they are in is the top failure mode.

New `WeekContextBar`, rendered directly under `<ScreenIntro>` and above the error banner,
`position: sticky, top: 0` inside the screen's scroll container so it cannot scroll out of
reach of the toggles. Bronze `--accent` tint (the standard's caution/attention role), not
navy — this is a scoped-editing notice, not navigation chrome. It reuses the existing
`src/components/schedule/WeekSwitcher.jsx` component unmodified rather than forking a
second week picker. Right side carries a derived summary: "Same activities as every other
week" at zero, "3 of 14 customized for Week 2" otherwise.

The week name is **repeated on every individual toggle** ("Runs in Week 2" / "Off in
Week 2"), not only in the bar. Context is pinned at the point of interaction.

### 5.2 The toggle

A 32×18 switch at the right of each row, before the existing Edit/History/Delete buttons,
separated by a `1px solid var(--border)` divider so it doesn't read as another action
button. On = `--primary` navy (this is a live part of the plan). Off = neutral border-gray
— **not** `--danger`, which the standard reserves for destructive and error states.
Toggling off is a normal, reversible planning decision.

Motion: knob `left` and track background over `--motion-fast` / `--ease-standard`, the
curve the standard names for reversible toggles. Instant under `prefers-reduced-motion` via
the existing `prefersReducedMotion()` helper.

### 5.3 What the toggle does NOT do — hard constraints for Maker

1. **Never deletes the activity or group.** The camp-wide row is untouched. Nothing routes
   through `previewDelete` / `deleteRecord` / `DeleteRecordDialog`.
2. **Never touches another week.** Scoped to exactly the pinned `weekId`.
3. **Never silently discards placed slots.** Before writing an OFF toggle, count that
   entity's `template_slots` **in that week only**, across both routes. If zero, toggle
   immediately with no dialog — that is the common case and must not be interrupted. If
   greater than zero, confirm first, in a new small sibling of `DeleteRecordDialog` (not
   the dialog itself — nothing is being deleted and there is no Trash recovery path):
   > Turn off "Archery" for Week 2?
   > Archery is used in 4 places in Week 2's schedule. Turning it off empties those cells —
   > everything else in the week stays exactly where it is.
   > Turning it back on later does not refill those cells — you'll place it again where you want it.

   Confirm button `S.btnDanger`, labelled "Turn off and clear 4 places."
4. **Never confirms OFF → ON.** Turning something back on is additive and safe. It makes
   the activity eligible again; it does not re-place anything.
5. The "Customized" badge is **derived from row existence in the same render pass**. There
   is never a stored boolean and never an "enable customization" step.

Director-facing copy never says template, override, entity, kind, manual, or generated —
it says "Week 2," "this activity," "your schedules."

### 5.4 Duplicate and delete entry points

**Duplicate** — a `duplicate` text-button in each `WeekSwitcher` row, between `rename` and
`archive`, in the existing 10px `--text-secondary` style. Default name `"{name} copy"`,
collision-suffixed " (2)", " (3)" the way `duplicateActivity` already does. Confirmation is
*after*, not before (duplicating is additive): a transient success-toned banner naming what
was copied and what is shared camp-wide.

**Permanent delete** — reachable **only from the Archived section**, so archiving is a
required first step, mirroring the app's existing two-step Trash pattern. It is the only
`--danger` text-button in the component. Confirmation reuses `DeleteRecordDialog`'s visual
shell with real counts, never estimates, and only clauses whose count is > 0:

> Permanently delete "Week 3"?
> Week 3 has 84 scheduled sessions across your schedules, 6 customized activity settings,
> and 2 saved versions. Deleting it removes all of that permanently — this cannot be undone.
> **There is no way to get this week back.**

That last line is plain `--danger` text, deliberately **not** in `recoveryStrong`'s
navy reassurance box — reusing a "you're safe" visual for "you are not safe" would be a
personality violation. Confirm button `S.btnDanger`, labelled `Delete "Week 3" permanently`.
No type-to-confirm field; this app's precedent is a named, counted button label.

Sole-week case: the delete (and archive) affordance is omitted entirely, with the data-layer
guard of §4.2 as defence in depth.

---

## 6. Tickets

Each has a success predicate. Data layer lands before UI in both slices. Test-first at the
migration, projection, duplicate, and delete seams per the testing standard.

### Slice 2

| # | Ticket | Layer | Done when |
|---|---|---|---|
| S2-1 | Migration v28 + `schema.sql`: the two exclusion tables and indexes, gated `>= 27 && < 28` | data | A v27 db opens, migrates to 28, both tables and both unique indexes exist, no existing row is altered, and a second open is a no-op |
| S2-2 | Register both tables in `campScopedEntities.js`, `projections.js`, **and** `syncServer.js`'s `DOMAIN_PARENT_SCOPED_ENTITIES` | data | A write to an exclusion row materializes via the projection, and a freshly paired client receives existing exclusion rows in its first full sync |
| S2-3 | `src/engine/weekCatalog.js` — `resolveWeekCatalog`, including anchor suppression and `suppressedAnchors` | data | Unit tests: no exclusions returns the input unchanged; every activity excluded returns an empty activity list (**not** the full catalog — this is the Red Hat Risk 1 regression test); an anchor whose activity is excluded is suppressed and reported |
| S2-4 | `scheduleRepository` reads/writes for exclusions | data | `loadWeekExclusions()` returns both tables' rows; toggling on/off writes and deletes exactly one row, asserted against a fake `localClient` |
| S2-5 | `duplicateWeek.js` + IPC + preload + mock | data | Duplicating a week with both routes produces a new week whose slots/overlays/exclusions are deep copies with fresh ids; a retried duplication produces exactly one copy; the source is unmodified |
| S2-6 | `WeekContextBar` + week threading into Activities and Groups screens | ui | Both screens show the pinned week; switching it re-derives every toggle; screens render exactly as today when a camp has one week |
| S2-7 | Per-row toggle, derived badge, placed-slot confirmation dialog | ui | Toggling off an unplaced activity is one click; toggling off a placed one confirms with a real count; toggling on never confirms; the camp-wide row is never modified |
| S2-8 | Duplicate entry point in `WeekSwitcher` + post-action banner | ui | Duplicate produces a named copy, collisions are suffixed, and the director is told what was copied |
| S2-9 | Integration test: generated rebuild for a week with exclusions | test | A rebuild of Week 2 places no excluded activity and no excluded group, and does not alter Week 1 or Week 3's slots |

### Slice 3

| # | Ticket | Layer | Done when |
|---|---|---|---|
| S3-1 | `deleteWeek.js` — full §4.1 cascade, one transaction, host-only, op-log routed | data | Every table in §4.1 is emptied for the week in one transaction; `operations` retains the history; a mid-transaction failure leaves the db unchanged |
| S3-2 | Last-week guard | data | Deleting a camp's only week returns `{ error: 'last-week' }` and deletes nothing; a test asserts the camp still has its week |
| S3-3 | Conflict closure for deleted entities | data | No unresolved `conflicts` row survives pointing at a deleted week's entity |
| S3-4 | IPC + preload + mock for delete-week | data | Non-admin callers are refused by `authorize()`; the mock matches the real handler's shape |
| S3-5 | Delete entry point, archived-only, with the counted confirmation | ui | Delete is unreachable except from Archived; counts shown are real, not estimated; the sole-week case shows no affordance |
| S3-6 | Concurrent delete handling in `ScheduleScreen` | ui | A device viewing a week deleted elsewhere redirects with a plain message rather than erroring or freezing |
| S3-7 | Cross-feature test: duplicate then delete the source | test | The copy is fully intact with no dangling reference to the source week's ids |

---

## 7. Gates before Maker starts

Four. Two are product decisions; two are technical decisions this spec recommends but does
not have the authority to close.

**Gate A — ADR required, and must be accepted (Article II rule 4).**
Two independent grounds: a new persistent data shape the setup screens and the engine-input
step both depend on, and a new cascade-delete contract over `schedule_weeks` that
ADR 2026-08-02 explicitly excluded from Slice 1. Title: *"Per-week activity and group
participation, week duplication, and permanent week delete (Slices 2–3)."* Its
candidates-considered must record the include-list-vs-exclude-list reversal in §2 and the
duplicate-op-shape resolution in §3.1, since both were live disagreements.

**Gate B — PRODUCT DECISION: the downgrade contract. Owner sign-off required.**
Slice 1 promised non-destructive downgrade to an older build. Per-week exclusions strain
that promise in a way Slice 1's precedent does not cover. Slice 1's degradation was
*subtractive* — extra weeks are invisible but preserved. An old build that cannot see
exclusion rows would do something worse: **show and schedule activities the director
explicitly turned off for that week**, and any rebuild it performs would bake them into
slots. That is silent misrepresentation, not graceful degradation.
Recommendation: accept it as a documented, bounded degradation rather than build a
compatibility fence, on the grounds that downgrade is rare, nothing is destroyed, and
re-upgrading restores correct filtering — but record it explicitly in the ADR as an
accepted consequence. Confidence: moderate. **The owner decides; this is exactly the
Article IV product-judgement gate.**

**Gate C — the v26 migration freeze, now due.**
ADR 2026-08-02 documented that every migration after v26 is gated behind v26 completing for
every camp on a device, and said "a future migration should add a bounded escape hatch
rather than leaving this open-ended." v28 is that future migration. Each new migration
lengthens the list of features withheld from a device holding one troublesome camp.
Recommendation: gate v28 `>= 27 && < 28` as specified, and take the bounded escape hatch as
its own small ticket landing **before or alongside** S2-1 rather than deferring it a third
time. Confidence: high that the gate is right; the escape hatch is a scope call for the owner.

**Gate D — unconfirmed sync ordering.**
§3.4's mitigation (append the week row last) only holds if the sync layer replays ops in
strict seq order across a reconnect. Red Hat could not confirm this from
`electron/sync/syncClient.js`. **Verifier must confirm or refute it before S2-5 is
considered done**, and if it is refuted, duplicate-a-week needs a completeness marker
rather than relying on ordering. Missing evidence is not converted into a pass
(Article II rule 3).

### Review routing for this work

- **Architect** — already run; the ADR of Gate A is its remaining deliverable.
- **Designer** — already run; §5 is binding on Maker.
- **Red Hat** — re-run after the ADR, specifically against the exclusion-list reversal, since
  its Risk 1 attack was aimed at the include-list design and the replacement deserves the
  same hostility.
- **Security** — routed in for `deleteWeek`/`duplicateWeek` only: both are new host-only IPC
  handlers performing bulk mutation, and permanent delete is irreversible.
- **Verifier** — mandatory, and must run the integration harness under Electron, not the
  :5200 browser mock. Migration, sync, and delete cannot be verified against
  `src/localClient.mock.js`.
- **Tester** — Slice 2 UI and Slice 3 confirmation flows, as a director.
- **Omitted:** none. Every reviewer has a real surface here.
