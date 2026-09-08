/**
 * Two directors disagree about the same slot — the owner's own case, and the
 * exit criterion for docs/adr/2026-09-08-crdt-conflict-reconciliation.md.
 *
 *   "if they create the exact same record ... it doesn't matter. the same idea
 *    was generated." ... "[if they differ] they are not the same and need to be
 *    reconciled." ... "flag it and make someone choose. if they are doing it in
 *    real time like that then they are working together not separately, so just
 *    make it a choice that both need to see."
 *
 * So this asserts four things in order, against real libp2p nodes and real
 * SQLite, with both Clients having JOINED for real:
 *
 *   1. two devices set one slot to different activities;
 *   2. BOTH see the disagreement — not just the one whose edit lost;
 *   3. neither device silently keeps a winner it made up;
 *   4. one director chooses, and both converge on that choice with nothing
 *      broadcast — the conflict clears by the same mechanism that raised it.
 *
 * Under the op-log this behaviour came from a `conflicts` row and an explicit
 * resolveConflict. Losing it in the cutover would be a correctness regression,
 * which is exactly why this scenario exists.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'
import { applyBulkReplace } from '../../../electron/automerge/campDocument.js'
import { resolveConflictInDoc } from '../../../electron/automerge/reconcile.js'

const SLOT = 'slot-group1-period2'

function pendingConflicts(device) {
  return device.db
    .prepare("SELECT entity, entity_id, field FROM conflicts WHERE resolved_at IS NULL AND id LIKE 'crdt:%'")
    .all()
}

export async function run() {
  const dirs = []
  let host, clientA, clientB

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()

    clientA = new AmClient(`${tmpDir}/clientA.db`)
    clientA.open()
    await clientA.join(host)

    clientB = new AmClient(`${tmpDir}/clientB.db`)
    clientB.open()
    await clientB.join(host)

    // Parents first, in the DOCUMENT rather than only in SQLite (template_slots
    // carries NOT NULL template_id and an FK on activity_id).
    await host.write({ entity: 'schedule_templates', entity_id: 'tpl-1', field: 'name', value: 'Week 1' })
    for (const id of ['basketball', 'archery', 'playground']) {
      await host.write({ entity: 'activities', entity_id: id, field: 'name', value: id })
    }

    // The slot is created the way the app creates one — a bulk replace of the
    // template's scope, not per-field writes. `template_slots` is the one
    // bulk-replace entity, so a slot with no entry in `template_slots_scopes`
    // is cleared again by projectAll's scope-level delete-reconcile the moment
    // it is written. Building the fixture the wrong way here would fail this
    // scenario for a reason that has nothing to do with what it tests.
    await host.node.applyLocal(
      applyBulkReplace(host.getDoc(), {
        entity: 'template_slots',
        scope_id: 'tpl-1',
        rows: [{ id: SLOT, template_id: 'tpl-1', activity_id: 'basketball' }],
      })
    )
    await waitFor(() => clientA.domainRow('template_slots', SLOT)?.activity_id === 'basketball', 6000)
    await waitFor(() => clientB.domainRow('template_slots', SLOT)?.activity_id === 'basketball', 6000)

    // Two directors, same minute, different decisions.
    await clientA.write({ entity: 'template_slots', entity_id: SLOT, field: 'activity_id', value: 'archery' })
    await clientB.write({ entity: 'template_slots', entity_id: SLOT, field: 'activity_id', value: 'playground' })

    // (2) BOTH devices surface it, and so does the Host. This is the owner's
    // "a choice that both need to see" — and it costs no synced state, because
    // each device derives it from the document it already has.
    for (const [label, device] of [['host', host], ['clientA', clientA], ['clientB', clientB]]) {
      await waitFor(() => pendingConflicts(device).length > 0, 8000)
        .catch(() => { throw new Error(`${label} never surfaced the disagreement`) })
      const rows = pendingConflicts(device)
      if (rows.length !== 1) throw new Error(`${label}: expected 1 conflict, got ${rows.length}`)
      if (rows[0].entity !== 'template_slots' || rows[0].entity_id !== SLOT || rows[0].field !== 'activity_id') {
        throw new Error(`${label}: wrong conflict recorded: ${JSON.stringify(rows[0])}`)
      }
    }

    // (3) Nobody invented a third answer.
    for (const [label, device] of [['host', host], ['clientA', clientA], ['clientB', clientB]]) {
      const value = device.domainRow('template_slots', SLOT)?.activity_id
      if (value !== 'archery' && value !== 'playground') {
        throw new Error(`${label}: slot holds an unexpected value while contested: ${value}`)
      }
    }



    // (4) A director chooses. Resolution is an ordinary document write that
    // dominates both values — there is no "resolved" message to send.
    //
    // Routed through resolveConflictInDoc rather than a plain write because a
    // director's most likely choice is the value already on their screen, and a
    // plain assignment of an unchanged value is the one shape that risks
    // writing no operation at all. See that function's comment.
    await clientA.node.applyLocal(
      resolveConflictInDoc(clientA.getDoc(), {
        entity: 'template_slots', entityId: SLOT, field: 'activity_id', value: 'archery',
      })
    )


    for (const [label, device] of [['host', host], ['clientA', clientA], ['clientB', clientB]]) {
      await waitFor(() => pendingConflicts(device).length === 0, 8000)
        .catch(() => { throw new Error(`${label} still shows the conflict after it was resolved`) })
      await waitFor(() => device.domainRow('template_slots', SLOT)?.activity_id === 'archery', 8000)
        .catch(() => { throw new Error(`${label} did not converge on the director's choice`) })
    }

    return 'PASS'
  } finally {
    await host?.close()
    await clientA?.close()
    await clientB?.close()
    cleanupDirs(dirs)
  }
}
