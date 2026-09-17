---
title: "ensureCohort discards every write result and its caller drops the rejection, so a failed cohort seed is invisible"
document_type: ticket
status: open
created: 2026-09-16
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
depends_on: "None. Direct sibling of the seedDays fix in the same bootstrap effect (src/App.jsx), which established the shape this ticket should follow."
archive_when: "src/utils/ensureCohort.js checks each localClient.write result for status applied/queued and throws otherwise, src/App.jsx surfaces an ensureCohort rejection through describeWriteFailure rather than dropping it, both are covered by non-vacuous tests proven to fail without the fix, and `npm run verify` is green"
---

# T190 — ensureCohort's write failures are invisible, on both sides

## Confirmed problem (verified against code at 907cb28 + the seedDays fix)

Two independent defects, both in the one-time camp bootstrap. Either alone hides a failure; together
they mean a camp can end up with no "Main" cohort and the director is told nothing.

### 1. The write loop discards `{ status }` — `src/utils/ensureCohort.js:69`

```js
for (const [field, value] of Object.entries(fields)) {
  await localClient.write(token, 'cohorts', id, field, value)   // result discarded
}
```

Every comparable per-field write loop in the codebase checks the result and throws otherwise —
`src/data/scheduleRepository.js:68`, `src/data/setupCrudRepository.js:81`,
`src/utils/seedDays.js:67` (fixed alongside this ticket's filing),
`src/screens/specialDay/SpecialDayGridEditor.jsx`, `src/screens/event/EventGridEditor.jsx`. This is
the last remaining site that does not.

**The existing try/catch does not cover this.** It is worth being precise, because the file reads as
though failure is already handled: that catch exists to swallow a `UNIQUE(camp_id, name)` collision
from the concurrent-mount race, and it only ever sees errors that were *thrown*. A rejected write
does not throw — `localClient.write` **resolves** with `{ status: 'rejected' }`. So the rejection
flows straight past the catch as if it were a success, and `ensureCohort` returns normally having
written nothing.

### 2. The caller drops the rejection — `src/App.jsx:239`

```js
ensureCohort(campId)    // floating promise
```

Even once (1) is fixed, the throw lands nowhere. This also swallows the **existing**
camp-mismatch throw at `src/utils/ensureCohort.js:54`, which can already fire today.

## Why it matters

A camp with no complete `Main` cohort is not a cosmetic gap: cohort is the parent scope the setup
screens and the engine read against. The failure surfaces later as an empty or broken setup with no
stated cause, on a code path that runs exactly once per camp — the moment a director is least able
to tell "not set up yet" from "set up and broken".

## Required work

Mirror the fix already made to `seedDays`, rather than inventing a second shape:

1. In `ensureCohort`, check each write result for `status === 'applied' || 'queued'` and throw
   otherwise. **Keep the UNIQUE-collision catch intact** — a rejected-status throw raised inside the
   `try` must not be mistaken for the race outcome, so the thrown message must not match `/UNIQUE/i`.
   `write failed for field "<field>"` (the sibling loops' wording) satisfies that.
2. In `src/App.jsx`, `.catch` the `ensureCohort` call and route it through `describeWriteFailure`
   into the notice surface already mounted in `AppShell`.
3. Cover both with tests, and **prove non-vacuity** by reverting each change and confirming the new
   test goes red. A test that plants only the defect the guard was designed for proves nothing.

## Non-goals

- Reworking the concurrent-mount race or the `name`-written-first ordering. That design is settled
  and documented in the file; this ticket only makes its failures visible.
- Introducing a new error-surface component. Reuse the existing notice.
