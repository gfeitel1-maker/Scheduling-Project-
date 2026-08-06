---
title: T46-week-crud-has-no-failure-handling
document_type: ticket
status: closed
created: 2026-08-04
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: [docs/work/tickets/T8-snapshot-restore-silent-noop.md]
archive_when: resolved — a failed week write is visible to the director and local state is consistent
---

# T46 — A failed week write silently succeeds on screen

**Risk:** Medium-high. The UI can display a week that does not exist on disk, with no error shown.
**Found:** Phase D (`useWeeks` extraction), 2026-08-04.

**Partly in progress.** A separate session was started on *"Surface delete-week failures to the
user"* covering the error-surfacing half. **This ticket must not duplicate that work.** Its distinct
contribution is the **optimistic-rollback question**, which that session does not cover and which is
the more serious half of the defect.

## What is wrong

`src/screens/schedule/useWeeks.js` (extracted verbatim from `ScheduleScreen`, unchanged behavior)
implements create, rename, archive, unarchive and duplicate with **no try/catch anywhere**. If
`repo.createWeek`, `repo.writeWeekFields`, or `localClient.duplicateWeek` rejects — Host
unreachable, authorization failure, IPC error — the promise rejects unhandled inside the event
handler and React swallows it.

Two consequences, and the second is the real problem:

1. **No error is surfaced.** Every other mutation cluster (`useSnapshots`, `useGeneration`) routes
   failures through an injected `setActionError` and renders a banner. Week operations are the only
   cluster that does not.
2. **The optimistic update has already been applied.** Each handler calls `setWeeks(...)` locally
   *before or independently of* the write resolving. So after a failed create, the director sees the
   new week in the switcher. It is not on disk. It will vanish on the next reload, or — worse —
   they will keep working in it and their edits will target a `week_id` with no row behind it.

## Why it matters

This is the same failure shape as T8 (*snapshot restore silent no-op*): the app reports success for
something that did not happen. A director has no way to distinguish "saved" from "silently lost."
For week creation specifically, the divergence persists across a whole editing session until
something forces a reload, so real scheduling work can be built on top of a week that does not exist.

## Product decisions required (do not implement without these)

1. **Error copy** — what a director is told when a week write fails, per operation. Must not expose
   IPC or authorization internals.
2. **Rollback behavior** — the open question this ticket owns. On failure, does the optimistic local
   update get reverted (week disappears again), or is it left in place with an error shown? Reverting
   is more truthful but can yank a row out from under a director mid-interaction. Leaving it is
   friendlier but preserves the lie. There is a third option — mark the row visually as unsaved and
   offer a retry — which costs more and may be the right answer for `createWeek` specifically.
3. Whether `duplicateWeek` needs different treatment, since it already reloads from the repository
   rather than updating optimistically and so cannot show a phantom week — only a missing one.

## Scope

**In:** wire `setActionError` into `useWeeks` following the `useSnapshots.saveSnapshot` convention;
implement the agreed rollback behavior; tests covering a rejected write for every operation,
asserting both the error surface and the final state of `weeks`.

**Out:** `DeleteWeekDialog`'s own IO (separate, approved component-IO exception). Any change to the
week resolution/fallback rules, which are pinned by tests and deliberately divergent between archive
and delete.

**Boundaries:** the two deliberate asymmetries in `useWeeks` must survive — `'1'`/`'0'` strings to
`writeWeekFields` versus numeric `1`/`0` in local state, and `duplicateWeek` reloading while the
other five update optimistically.

## Completion evidence

1. Every week operation surfaces a failure to the director; none rejects unhandled.
2. The agreed rollback behavior is implemented and its rationale recorded in a comment.
3. After a failed create, the week switcher does not show a week that is absent from the database.
4. Tests cover a rejected write for each of the five mutations.
5. Full `npm run test`, `npm run lint`, `npm run build` pass.

## Closure note

Implemented in commits `68dda2d`, `c76bd68`, `196c775` (on main). All five week mutations surface failures to the director; loading state guards against duplicate in-flight creates; tests pass.
