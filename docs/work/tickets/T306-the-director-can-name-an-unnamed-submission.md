---
title: "A camp can name an unnamed submission from inside the app"
document_type: ticket
status: open
created: 2026-09-29
task_class: security-auth
governing_docs: [docs/governance/constitution/CONSTITUTION.md, SECURITY.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md, docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T305-a-whole-sheet-planner-grid-imports-through-the-panel.md, docs/work/tickets/T299-identical-submissions-are-not-one-camper.md]
archive_when: "a staff or admin session clicking the 'who is this?' attention row can enter a name and have it recorded against that specific subject via attributeElectiveSubject, without re-importing; the UI path and the MCP tool produce the same rekey for the same input; the grant is a narrow attribution action rather than general campers.write; and tests drive the RENDERED row plus the IPC handler's authorization for both a staff and an admin session"
---

# T306 — A camp can name an unnamed submission from inside the app

Found while building [T305](T305-a-whole-sheet-planner-grid-imports-through-the-panel.md), by tracing
where an unattributed subject actually reaches a human. Every link was confirmed in the code before
this ticket was written.

## What a camp hits

A camper's planner is imported with no name on it — a first-class outcome by ADR §14.1a, not a
failure. The Roots home then shows exactly the right thing:

> "We have this camper's choices but not their name — who is this?"

and, when two sheets match:

> "Another unnamed sheet has exactly the same answers — is this two campers, or one camper's sheet
> imported twice? Name them to say which."

**Clicking it does nothing.** The app asks the question and has no way to take the answer. This is
true for **every role**, admin included — it is not a permissions gap, it is an unbuilt path.

## The chain, verified link by link

| Link | State |
|---|---|
| The row is built, with the right copy and the subject's own id in its item id | `src/ingest/attentionList.js` |
| `screenForAttentionRow` has no case for `sourceKind: 'unattributed-camper'`, so it falls through to `screenForNode(row.domainTag)` | `src/screens/attentionRowDestination.js` |
| `DOMAIN_SCREEN` holds Structure / Scheduling / Time / Facility and **no `Campers`** → returns `null` | `src/components/reconciliation/rootMapNav.js` |
| A null destination renders the row as a plain `div` with no `onClick` and no button role — genuinely inert, not a dead clickable | `src/screens/RootsHomeScreen.jsx`, `AttentionRow` |
| `attributeElectiveSubject` has **no `preload.js` bridge and no `main.js` handler** — no renderer path at all | `electron/ops/attributeElectiveSubject.js` |

`attentionList.js` asserts in its own comment that "acting on this means attributing that specific
subject and **the surface is the only place it is offered**." The statement is correct about intent
and false about the code: the offering was never built.

ADR §14.1a promises attribution is *"resolvable later without re-import."* That is true on the
machine path and untrue for a human, at every link.

## It is NOT the first caller of the op

Recorded because the first version of this finding got it wrong. `attributeElectiveSubject` **has a
live non-test consumer**: `scripts/mcp/tools.js`, via `attributeSubjectTool`. The earlier claim that
it was "called only from its own tests" came from a grep scoped to `electron/`, which could not see
`scripts/`. Corrected by the T304 session.

**So the IPC handler this ticket adds is a SECOND caller of an op already in use**, which is the
main design constraint: the same act performed through the UI and through MCP must produce the same
result. `attributeSubjectTool` calls:

```js
attributeElectiveSubject(db, {
  campId, deviceId, authorUserId, subjectId, displayName, externalId,
})
```

resolving `campId` and `deviceId` from the db itself. **Attribution REKEYS rather than renames** —
`scripts/mcp/tools.js` records why: a rename "would convert a merge bug into a worse fork bug."
Diff the handler against that tool before landing it; two call shapes is the §3.2 defect this
program has already paid for twice.

## Owner ruling, 2026-09-29 — staff too

The question put to the owner was who at a camp may say who an unnamed planner belongs to. I
recommended directors-only, on the grounds that attribution rekeys and naming two unnamed sheets
identically **merges two real children** — the one refusal §14.1a permits. **The owner ruled the
other way:**

> staff too — they know the answer

The reasoning is that the people who collected the sheets and are with the children are the ones who
know whose planner is whose, and routing every attribution through a director adds a step that adds
no knowledge. The ask was framed with the fact that the row is inert for admins too, so this is not
a grant being taken from anyone — it is a job nobody can currently do.

## The design

### 1. A narrow action, not general `campers.write`

**This is a judgement made rather than escalated, and it is the part most likely to be argued with.**
The ruling is that staff can *name an unnamed submission*. It is not that staff can rewrite any
camper record. [T304](T304-a-staff-session-can-see-what-the-import-left-unnamed.md) deliberately gave
staff `campers.read` while keeping `campers` out of `ENTITIES` so there is no staff write; widening
that to full `campers.write` would over-deliver on the ruling and undo a boundary drawn the same day.

So: a purpose-specific **`campers.attribute`** held by staff, with general `campers.write` left
admin-only. This follows the existing convention rather than inventing one — the action vocabulary
in `electron/auth/permissions.js` already contains narrow verbs beside read/write: `conflicts.resolve`,
`devices.approve`, `devices.revoke`, `groups.import`, `declined_two_row_splits.record`. `admin: ['*']`
means admins hold it automatically.

### 2. The control lives on the attention surface

Not a new screen. The codebase already ruled on this, in `scripts/mcp/tools.js`:

> "the same act is in the director's attention surface ('Needs your attention'), not a separate
> screen."

and in `src/ingest/preferenceSheet.js`, beside the `UNATTRIBUTED_SUBJECT` residue:

> "Owner ruling: unattributed campers live there. One statement, one place to act."

So the row itself takes the name. Note `attentionRowDestination.js` resolves rows to *screens*, which
is the wrong shape for an in-place action — decide deliberately whether this row gets a destination
at all or an inline affordance, and do not widen `DOMAIN_SCREEN` with a `Campers` entry just to make
the existing dispatch fit.

### 3. Two subjects with identical answers must stay two

The copy already promises the director can say whether this is two campers or one sheet imported
twice. T299 made the panel mint one subject per submission for exactly this. Naming both rows with
the same name is a **merge**, and is the director's prerogative; naming them differently keeps them
apart. The app takes no view — but it must not make the merge accidental, and `attributeElectiveSubject`
is where the rekey semantics for that already live.

## What must remain true

- **General `campers.write` stays admin-only.** Staff gain exactly one new act.
- **One rekey, two entry points.** UI attribution and MCP attribution agree for the same input.
- **No re-import.** Naming a subject never requires re-reading the sheet.
- **`forbidden` still has no second channel** (T304's finding): a denied attribution must surface as
  a visible failure, not a swallowed one. Every mutation surfaces its failure.

## Dependencies

Rebase on **PR #621** (T304) before implementing — it changes `electron/auth/permissions.js`,
`electron/ops/participantEntities.js` and `src/screens/RootsHomeScreen.jsx`, all of which this ticket
touches. T304 also amended `SECURITY.md`'s participant-access paragraph, which is the current-state
reference for this task class; read the amended text rather than a cached memory of it.

## Tests

Test-first; this is an auth boundary and a data-identity seam.

1. The rendered attention row is **actionable** — the current inert `div` becomes something a human
   can act on, asserted through the row, not through the helper.
2. **A staff session can attribute**; the handler authorizes `campers.attribute`.
3. **A staff session still cannot perform a general camper write** — the negative test that proves
   the grant was narrowed rather than widened. Without it, `campers.write` for staff passes everything
   else here.
4. Attribution through the handler and through `attributeSubjectTool` produce the **same** camper row
   for the same input.
5. Two identical-answer subjects named differently remain two campers; named identically, merge.
6. A denied or failed attribution is **surfaced**, not swallowed.
