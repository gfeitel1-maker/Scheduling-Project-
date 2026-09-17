---
title: "A transient camp-bootstrap failure is never retried for the rest of the session, while the notice copy tells the director to try again"
document_type: ticket
status: open
created: 2026-09-17
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
depends_on: "T190 and the seedDays fix (which made these failures visible at all — this ticket makes them recoverable). Sibling of T200, same effect, same seam."
archive_when: "A director who sees a bootstrap-failure notice has a way to recover within the session that matches what the copy tells them to do, StrictMode double-invocation still cannot double-seed days_of_operation, both are covered by tests proven to fail without the fix, and `npm run verify` is green"
---

# T201 — a transient bootstrap failure is never retried, while the copy says to try again

## Confirmed problem (verified against `main` at 340c995)

`src/App.jsx:226-250`:

```js
if (!campId || seededForCamp.current === campId) return
seededForCamp.current = campId      // set BEFORE either promise settles
seedDays(campId).catch(...)
ensureCohort(campId).catch(...)
```

The ref is set **synchronously**, before either promise settles. If either call fails, the camp is
marked seeded regardless, and **neither is retried for the rest of the session**. The effect's only
dependency is `campId`, which does not change again. The director's sole recovery is an app
restart, which nothing tells them to perform.

Meanwhile `describeWriteFailure` (`src/utils/writeErrorMessage.js`) ends both the transport branch
and the unrecognised branch with **"try again"**. So the UI actively instructs an action the code
has made impossible. That mismatch is why this defect is worth more than its size: a director who
follows the instruction learns that the app's own advice does nothing, which costs more trust than
the original failure did.

## The trap — any fix must survive this

`seededForCamp` is not incidental. It neutralises React StrictMode's dev-mode double-invocation.
`days_of_operation` has **no UNIQUE constraint** (the `schema.sql` / `localDb.js` comments claiming
otherwise are stale — see the TODO in `src/utils/seedDays.js`), so two concurrent `seedDays` runs
seed Mon–Fri twice → 10 days. A naive "clear the ref in the catch" reintroduces exactly that
duplication, and it reproduces **only in dev**, where StrictMode double-invokes; production masks
it.

Note the asymmetry: `ensureCohort` is protected by a real `UNIQUE(camp_id, name)` constraint and
its own catch. `seedDays` is protected by nothing but this ref.

## The open design question this ticket must answer

Is the right shape a retry, or is it making the failure recoverable some other way — an explicit
retry affordance, resetting only on a *settled* failure, per-call rather than shared tracking? If
the honest answer is that the **copy** should change rather than the control flow, that is a
legitimate outcome, stated with reasoning rather than a retry forced in.

## Success predicate

- A director who sees a bootstrap-failure notice has a recovery path inside the session that
  matches what the copy tells them to do.
- Concurrent invocation of the bootstrap — StrictMode's double-invoke specifically — still cannot
  seed `days_of_operation` twice.
- Recovery is bounded: no silent retry loop, no unbounded background retry.

## Does not count as done

- Clearing `seededForCamp` in a way that permits two concurrent `seedDays` runs.
- A test that only proves "retry happens" — the double-seed guard must be pinned by its own test.
- A test that passes with the fix reverted.
