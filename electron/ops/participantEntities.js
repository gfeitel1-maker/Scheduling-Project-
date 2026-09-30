// The participant domain: the seven entities T194 adds at schema v66
// (docs/adr/2026-09-17-individual-elective-scheduling.md D8/D9).
//
// ONE DEFINITION, imported everywhere. Round 1 hand-copied this list into seven
// places — the audit PII guard, the restore decisions, the MCP entity-map
// exclusion and four tests. That shape has a recorded incident in this repo
// (feedback_derive_gate_inputs_from_committed_state, and the menu guard whose
// role list had the same blind spot as the menu it guarded): an EIGHTH
// participant entity added in T195/T196 would be caught by the authorization
// parity test — which compares against a hand-kept sibling list — while
// silently losing the audit PII guard and the MCP exclusion, because those two
// triggers are membership tests against copies nobody remembered to update.
// Deriving every guard's trigger from this constant is what closes that.
//
// Adding an entity here is therefore a deliberate act with consequences: it
// becomes admin-only, audit-guarded, unrestorable and excluded from the MCP
// entity map, and the parity tests will tell you if any of those did not follow.
export const PARTICIPANT_ENTITIES = Object.freeze(
  new Set([
    'campers',
    'elective_assignment_runs',
    'elective_occurrences',
    'elective_choices',
    'elective_choice_offerings',
    'elective_preferences',
    'elective_assignments',
    // T243 (v74, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-
    // slices.md) — the eighth participant entity this module's header
    // comment anticipated. A finalized run's per-camper, per-cell export
    // snapshot: PII-adjacent for the same reason elective_assignments is —
    // it denormalizes a named child's whole schedule.
    'elective_run_outer_snapshots',
    // T320 (v83, docs/adr/2026-09-30-elective-run-durability.md item 4) —
    // the ninth. A commit-time eligibility finding: admin-only, same
    // participant-domain posture as its siblings above. Governor ruling R2:
    // the ADR's own registry list named `permissions.js` ENTITIES for this
    // entity, which is WRONG IN DIRECTION — permissions.js derives staff
    // read+write by flatMapping every ENTITIES member into BOTH, so adding
    // it there would silently GRANT staff read+write on run findings. This
    // registration here is what actually keeps it admin-only.
    'elective_run_findings',
  ])
)

// T304 — the ONE narrow relaxation of "the participant domain is admin-only".
//
// Owner ruling, 2026-09-29, amending ADR D9 (see that ADR's D9 amendment note):
// the `staff` role in this product means ADMINISTRATIVE staff, and a child's
// name is not a secret from the people who are with that child. D9's PII
// rationale therefore does not reach `campers.read`. The concrete need is that
// an elective import's unresolved residue — a submission whose camper has no
// name yet — gets raised on the Roots home, which is a staff-reachable screen.
//
// READ ONLY, AND ONE ENTITY. This set is not a general loosening:
//   - It grants no write. `campers` deliberately stays OUT of permissions.js's
//     ENTITIES, which derives `.read` AND `.write` together with no per-entity
//     opt-in. This follows the existing `camp_maps.read` precedent — an explicit
//     single grant in the staff array — which is the only way to have one
//     without the other.
//   - It does not remove `campers` from PARTICIPANT_ENTITIES above, so the audit
//     PII guard, the restore refusal and the MCP entity-map exclusion are all
//     unchanged.
//   - The other seven entities are untouched and remain fully admin-only.
//
// It is DERIVED FROM HERE rather than typed into permissions.js and again into
// the test that guards it, for the reason this whole module exists: a hand-kept
// second copy is how the guard and the thing it guards come to disagree.
//
// TWO IPC surfaces open for a staff session per entry here, both counted in
// T304 before the grant was written: `list(entity)`, which is the point, and
// `getEntityHistory` for one of its rows, because that handler authorizes
// `<entity>.read` and PROJECTIONS.campers exists. `listByScope` does NOT open —
// campers is absent from main.js's SCOPED_LIST_ENTITIES.
export const STAFF_READABLE_PARTICIPANT_ENTITIES = Object.freeze(new Set(['campers']))

// T306 — the ONE MUTATION a staff session may perform on a camper row, and the
// reason it is a verb of its own rather than a write.
//
// Owner ruling 2026-09-29: staff, not only directors, may say who an unnamed
// planner belongs to — "they know the answer", because the people who collected
// the sheets are with the children. The act itself is narrow: fill in the name of
// a subject that HAS no name.
//
// WHY NOT `campers.write`. attributeElectiveSubject already refuses to touch a
// camper who is already named (`if (subject.is_unattributed !== 1)`), because
// renaming an identified child re-keys their identity and orphans them from every
// other record. But that guard lives in the OP, not in the generic write path:
// main.js's write() derives its action via deriveWriteAction(), which returns a
// bare `campers.write` for any ordinary field and never routes through the op. So
// granting staff `campers.write` would hand them a path that writes display_name
// onto ANY camper row — including a named one — with the is_unattributed check
// nowhere in it. A wide grant would not merely over-deliver on the ruling; it
// would reintroduce the exact fork hazard the op exists to prevent, through a door
// the op cannot see. A narrow verb keeps every caller on the guarded path.
//
// ONE IPC surface opens for a staff session per entry here: attributeSubject.
// Nothing else authorizes `<entity>.attribute`.
export const STAFF_ATTRIBUTABLE_PARTICIPANT_ENTITIES = Object.freeze(new Set(['campers']))

// Spellings that are NOT the registered entity name but plainly mean it — the
// near misses a caller reaches for. Every guard in this repo that keys on an
// exact string match has the same blind spot: `targetType: 'camper'` (singular)
// or `'elective_run'` matches nothing, so the guard silently does not fire and
// the caller believes it did.
//
// DERIVED from the set above, never hand-kept, so a new entity gets its near
// misses for free. Callers passing one of these are refused with the real name.
export const PARTICIPANT_ENTITY_NEAR_MISSES = Object.freeze(
  new Map(
    [...PARTICIPANT_ENTITIES].flatMap((entity) => {
      const spellings = new Set()
      if (entity.endsWith('s')) spellings.add(entity.slice(0, -1))
      if (entity.startsWith('elective_')) {
        const short = entity.slice('elective_'.length)
        spellings.add(short)
        if (short.endsWith('s')) spellings.add(short.slice(0, -1))
      }
      spellings.delete(entity)
      return [...spellings]
        .filter((s) => !PARTICIPANT_ENTITIES.has(s))
        .map((spelling) => [spelling, entity])
    })
  )
)
