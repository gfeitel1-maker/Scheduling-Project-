---
title: "A staff session can see what the import left unnamed, and an unread collection says so"
document_type: ticket
status: completed
created: 2026-09-29
task_class: security-auth
governing_docs: [docs/governance/constitution/CONSTITUTION.md, SECURITY.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/adr/2026-07-24-centralized-authorization-layer.md, docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T299-identical-submissions-are-not-one-camper.md, docs/work/tickets/T194-participant-data-substrate.md]
archive_when: "a staff session opening the Roots home sees the unattributed-subject rows T285/T299 put there — SEEING them, not acting on them, which is T306 and is out of scope here — and any collection the hook could not read is reported as unread on both the attention rail and the bento rather than rendering as zero or as nothing-to-do; each pinned by a test verified to fail against the pre-fix behaviour"
---

# T304 — A staff session can see what the import left unnamed, and an unread collection says so

Found by two independent reviews during [T299](T299-identical-submissions-are-not-one-camper.md)
(PR #618), and confirmed against the code before being written up.

## Two defects, one line

`src/hooks/useCurrentStructureCounts.js` read every structure collection as:

```js
next[entity] = await localClient.list(entity).catch(() => [])
```

Every failure became an empty array, indistinguishable from "this camp genuinely has none of
these". That single expression carried two separate defects.

### Defect 1 — a staff session was denied `campers`, silently

T299 added `campers` to `STRUCTURE_ENTITIES` so the attention surface could show unattributed
subjects. `campers` was admin-only, so for a **staff** session the read was denied, the `.catch`
swallowed the denial, and the Roots home rendered "Nothing needs you right now." for a camp with
unnamed submissions waiting.

The deny path, confirmed link by link rather than assumed:

| Step | Location |
|---|---|
| hook asks | `src/hooks/useCurrentStructureCounts.js` |
| IPC | `electron/preload.js` → `shoresh:list` |
| handler | `electron/main.js`, `list()` |
| clears the allowlist (`campers` **is** a `DIRECT_CAMP_ENTITY`) | `electron/ops/campScopedEntities.js` |
| authorizes `campers.read` | `electron/main.js`, `list()` |
| `PERMISSIONS.staff` lacks it → `deny(..., 'forbidden')` | `electron/auth/authorize.js` |
| throws `'admin role required'` | `electron/main.js`, `requireAuthorized` |
| becomes `[]` | the `.catch` above |

**`forbidden` is the one deny reason with no second channel.** It is absent from
`SESSION_INVALID_REASONS`, so unlike an expired session it never pushes `shoresh:auth-rejected` at
the renderer. T228 gave session-expiry a way to be noticed; a `forbidden` has none. The `.catch`
was the only thing in the process that saw it.

**Cost meanwhile:** each denied read runs `deny()` → `recordAuditEvent`, a `SELECT` plus an
`INSERT INTO audit_events`. There is no `DELETE FROM audit_events` anywhere in the repository — the
table is append-only by design (`docs/adr/2026-07-25-append-only-audit-event-log.md`) — so that is
one unprunable row per Roots-home visit per staff user. The participant PII guard does not fire on
it, because `deny()` passes no `targetType`.

**Latent, not live.** No screen calls `localClient.createUser` — the only reference in `src/` is its
own definition — so every user in the shipped product today is an admin. That is what made this
worth fixing deliberately rather than urgently.

### Defect 2 — the same line hides every other read failure too

Independent of role. A db error, a revoked device or an expired session on any of the eight
collections renders as zero. `countFor` in `src/screens/RootsHomeScreen.jsx` returns `0` for a
collection that failed to load, so a camp with forty activities can render **"0 Activities"** —
a confidently wrong number, which is worse than an empty list. And because `buildStructureIssues`
derives its rows from the same collections, a partial read yields a rail that is quietly
incomplete even when it is not empty.

This is the silent-failure class this repository keeps writing rules against.

## Owner ruling, 2026-09-29 — staff see it, and Roots is where it belongs

The question put to the owner was whether a staff user should see unattributed campers at all,
given ADR D9 (`docs/adr/2026-09-17-individual-elective-scheduling.md`). The ruling:

> "administrative staff are the staff in question. but even if they weren't, you would be saying
> that a camp's staff cannot read a child's name? even though they are with the child irl?
>
> i think what you are really asking is where does it get raised that there is an issue with your
> electives import. roots is the correct place."

Two things settled. The `staff` role in this product means **administrative staff**; and a child's
name is not a secret from the people who are with that child, so D9's PII rationale does not reach
`campers.read`. The import's unresolved residue gets raised on Roots, for staff.

## What changes

**Grant is `campers.read` and nothing else.** Blast radius enumerated before writing it:

- `campers` stays **out** of `ENTITIES`, because `permissions.js` derives `staffReadWrite` by
  flatMapping each entry into both `.read` and `.write` — there is no partial registration. The
  grant follows the existing `camp_maps.read` precedent: an explicit single entry in the staff
  array. Staff get no write, no delete, no restore, no bulk_replace, no import.
- `campers` stays **in** `PARTICIPANT_ENTITIES`, which also drives the audit PII guard, the restore
  decisions and the MCP entity-map exclusion. None of those is touched by this ruling.
- The other seven participant entities are untouched and remain fully admin-only.
- Exactly **two** IPC surfaces open, and they were both counted: `list('campers')`, which is the
  point; and `getEntityHistory` for a camper, because that handler authorizes `<entity>.read` and
  `PROJECTIONS.campers` exists. That second one is a deliberate consequence of the ruling, recorded
  here rather than discovered later. `listByScope` does **not** open — `campers` is absent from
  `SCOPED_LIST_ENTITIES`.
- The stored footprint is `id, camp_id, display_name, group_id, external_id, is_active,
  is_unattributed`. A name and a group, which is what D9 itself describes.

**The hook distinguishes "loaded, empty" from "could not load"**, and the screen says so on both
surfaces the owner chose: the attention rail stops claiming nothing needs attention when it could
not check, and a bento card stops printing a count it does not have.

### Defect 3 — found by running the screen, not by reading it

The two fixes above were unit-tested and green. Opening the actual Roots home against the dev
mock, with `activities` forced to fail, showed a third thing neither test suite could have caught:

> **Activities** · Scheduling
> No activities set up yet.

A confident, false claim — the camp has five — sitting in the rail between two honest signals (the
card's em dash and the "may be incomplete" notice). `buildStructureIssues`' `REQUIRED_EMPTY_AREAS`
loop reads `collections[key].length === 0`, and an unread collection arrives as `[]`, so it reported
"could not read" as "has none". Same defect as defect 2, one level down, and it would have shipped
inside the fix for it.

`buildStructureIssues` now takes an optional `unread` set and skips an emptiness check over a
collection that could not be read. The two checks after that loop need no guard, which is recorded
at the call site rather than left to be re-derived: both fail to **silence** rather than to a false
claim.

**This is the argument for running the thing.** Three test files were green across the two fixes
that were designed; the defect that survived them was visible in the first screenshot.

## Why the grant is derived, not typed twice

`electron/ops/participantEntities.js` exists because round 1 of T194 hand-copied the participant
list into seven places. A staff-readable exception typed into both `permissions.js` and the test
that guards it would rebuild exactly that defect at two files' distance. The exception is one
frozen constant in that module; `permissions.js` derives the grant from it and
`participantEntitiesAdminOnly.test.js` derives its skip from it.

## Scope boundary: seen is not actionable, and that is T306

Flagged by the session working T305/T306 while this ticket was open, and confirmed here rather
than taken on trust. The unattributed-camper row is **inert for every role**, and was before this
ticket: `screenForAttentionRow` has no case for `sourceKind: 'unattributed-camper'`, so it falls
through to `screenForNode('Campers')`, and `Campers` is in neither `DOMAIN_SCREEN` nor
`CHILD_SCREEN`. `RootsHomeScreen`'s `AttentionRow` handles that correctly — a null destination
renders a plain `div`, not a dead clickable — so there is no defect to fix here, only a limit to
state.

**T304 makes the row visible to staff. It does not make it actionable for anyone.** The row asks
"who is this?" and the app offers no in-UI way to answer. That gap is T306's scope (a destination
for the row, `attributeElectiveSubject` over IPC behind `authorize()`, and the naming control) and
is deliberately not widened into here.

One correction to the report, relevant to whoever builds T306: `attributeElectiveSubject` is **not**
called only from its own tests. `scripts/mcp/tools.js` calls it today, so the op already has a live
non-test consumer on the machine-access surface. An IPC path added later is a *second* caller of an
op that is already in use, not the first — whatever authorization and rekey behaviour it lands on
has to agree with what the MCP tool already does.

## Guards this must not weaken

`participantEntitiesAdminOnly.test.js` asserts a **negative**, and a negative test passes just as
happily when the thing it guards has been gutted. Relaxing it for one verb on one entity is exactly
the move that could hollow it out. So the relaxation is narrow and the file keeps a positive
control, plus new explicit assertions that `campers.write` and every other verb are still denied to
staff — the assertions that now carry the weight the removed one used to.

## Closed (2026-09-30)

Merged in #621. `src/ingest/attentionList.js`'s `buildStructureIssues` takes an optional `unread` set
and skips the emptiness check for a collection that could not be read, instead of reporting "has
none". `src/screens/RootsHomeScreen.jsx` renders an unread notice (`attention-unread-notice`) and a
per-card unread state (`card-count-unread-<key>`) rather than a false `0`. Staff hold `campers.read`
via a single frozen constant staff readers derive from, and `participantEntitiesAdminOnly.test.js`
(21/21) still asserts `campers.write` and every other verb denied. `useCurrentStructureCounts.test.js`
(7/7) and `attentionList.test.js` pass on this branch. All `archive_when` clauses are discharged.
