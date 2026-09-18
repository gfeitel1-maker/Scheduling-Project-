/**
 * Scenario 32 — the ordinary registration proof for the seven participant
 * entities (T194). Modelled on 17-joining-device-domain-data.
 *
 * Two claims, both of which a unit test cannot make:
 *
 *   1. A device that JOINS a camp holding rows in all seven tables receives
 *      all seven. This exercises DOMAIN_SNAPSHOT_ORDER with foreign_keys = ON
 *      and fails loudly if the FK-safe order is wrong — a child applied before
 *      its parent throws, and the joining device silently comes up short.
 *
 *   2. A projection rebuild FROM THE DOCUMENT restores every row. This is what
 *      proves the rows genuinely live in the Automerge document rather than
 *      only in the receiving device's SQLite — i.e. that PROJECTIONS,
 *      MODELED_ENTITIES and the regenerated genesis all agree. An entity
 *      missing from PROJECTIONS has its writes SILENTLY DISCARDED, which is a
 *      failure that looks exactly like success until a rebuild.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'
import { projectAll } from '../../../electron/automerge/projector.js'
import {
  deriveElectiveOccurrenceId,
  deriveElectiveChoiceId,
  deriveElectiveChoiceOfferingId,
  deriveElectivePreferenceId,
  deriveElectiveAssignmentId,
  electiveChoiceLabelKey,
} from '../../../electron/ops/electiveDerivedIds.js'

const RUN = 'run-1'
const CAMPER = 'camper-1'
const OCC = deriveElectiveOccurrenceId(RUN, 'set-1', 'day-1', 'tb-1', 'tier-1')
const CHOICE = deriveElectiveChoiceId(RUN, electiveChoiceLabelKey('Swim Advanced'))
const OFFERING = deriveElectiveChoiceOfferingId(CHOICE, OCC, 'act-1')
const PREF = deriveElectivePreferenceId(RUN, CAMPER, CHOICE)
const ASSIGN = deriveElectiveAssignmentId(RUN, CAMPER, OCC)

// id + the one field that proves the row is not just a stub created by
// ensureExists. A stub carries '' for its NOT NULL columns, so asserting a
// real value is what distinguishes "the row arrived" from "a placeholder was
// seeded locally".
const EXPECT = [
  ['campers', CAMPER, 'display_name', 'A Child'],
  ['elective_assignment_runs', RUN, 'name', 'Week 1 electives'],
  ['elective_occurrences', OCC, 'elective_set_id', 'set-1'],
  ['elective_choices', CHOICE, 'label', 'Swim Advanced'],
  ['elective_choice_offerings', OFFERING, 'activity_id', 'act-1'],
  ['elective_preferences', PREF, 'rank', 1],
  ['elective_assignments', ASSIGN, 'activity_id', 'act-1'],
]

function assertAll(label, device) {
  for (const [table, id, field, value] of EXPECT) {
    const row = device.domainRow(table, id)
    if (!row) throw new Error(`${label}: ${table} row ${id} is missing`)
    if (row[field] !== value) {
      throw new Error(`${label}: ${table}.${field} is ${JSON.stringify(row[field])}, expected ${JSON.stringify(value)}`)
    }
  }
}

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir()
    dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()

    // Parents before children, in the document. The run is the FK target for
    // four of the five parent-scoped tables; the choice is the fifth's.
    await host.write({ entity: 'elective_assignment_runs', entity_id: RUN, field: 'name', value: 'Week 1 electives' })
    await host.write({ entity: 'elective_assignment_runs', entity_id: RUN, field: 'status', value: 'draft' })

    await host.write({ entity: 'campers', entity_id: CAMPER, field: 'display_name', value: 'A Child' })

    await host.write({ entity: 'elective_occurrences', entity_id: OCC, field: 'run_id', value: RUN })
    await host.write({ entity: 'elective_occurrences', entity_id: OCC, field: 'elective_set_id', value: 'set-1' })

    await host.write({ entity: 'elective_choices', entity_id: CHOICE, field: 'run_id', value: RUN })
    await host.write({ entity: 'elective_choices', entity_id: CHOICE, field: 'label', value: 'Swim Advanced' })

    await host.write({ entity: 'elective_choice_offerings', entity_id: OFFERING, field: 'choice_id', value: CHOICE })
    await host.write({ entity: 'elective_choice_offerings', entity_id: OFFERING, field: 'occurrence_id', value: OCC })
    await host.write({ entity: 'elective_choice_offerings', entity_id: OFFERING, field: 'activity_id', value: 'act-1' })

    await host.write({ entity: 'elective_preferences', entity_id: PREF, field: 'run_id', value: RUN })
    await host.write({ entity: 'elective_preferences', entity_id: PREF, field: 'camper_id', value: CAMPER })
    await host.write({ entity: 'elective_preferences', entity_id: PREF, field: 'choice_id', value: CHOICE })
    await host.write({ entity: 'elective_preferences', entity_id: PREF, field: 'rank', value: 1 })

    await host.write({ entity: 'elective_assignments', entity_id: ASSIGN, field: 'run_id', value: RUN })
    await host.write({ entity: 'elective_assignments', entity_id: ASSIGN, field: 'camper_id', value: CAMPER })
    await host.write({ entity: 'elective_assignments', entity_id: ASSIGN, field: 'occurrence_id', value: OCC })
    await host.write({ entity: 'elective_assignments', entity_id: ASSIGN, field: 'activity_id', value: 'act-1' })

    assertAll('host', host)

    // (1) A second device joins for real and receives all seven.
    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    await waitFor(() => !!client.domainRow('elective_assignments', ASSIGN)?.activity_id, 10000).catch(
      () => {
        throw new Error('the joining device never received the participant rows')
      }
    )
    assertAll('joining client', client)

    // (2) A projection rebuild from the DOCUMENT restores every row. Wipe the
    // projected tables first, so a pass cannot come from the rows simply still
    // being there. Children before parents, foreign_keys = ON.
    for (const t of [
      'elective_assignments',
      'elective_preferences',
      'elective_choice_offerings',
      'elective_choices',
      'elective_occurrences',
      'elective_assignment_runs',
      'campers',
    ]) {
      client.db.prepare(`DELETE FROM ${t}`).run()
    }
    if (client.domainRow('campers', CAMPER)) throw new Error('the wipe did not wipe')

    projectAll(client.db, client.getDoc())
    assertAll('after projection rebuild', client)

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
