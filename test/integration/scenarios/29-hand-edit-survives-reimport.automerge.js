/**
 * Scenario 29 (libp2p): a director's correction survives a re-import on the
 * OTHER device.
 *
 * This is the defect that 5,000 passing unit tests did not surface, written as
 * the thing a person actually does:
 *
 *   1. the office computer imports last year's spreadsheet;
 *   2. the director fixes a name on the iPad — a hand edit;
 *   3. the correction replicates, and the office computer shows it;
 *   4. months later, the office computer re-imports the spreadsheet.
 *
 * Step 4 used to silently revert step 2. `ingest.js` protects a hand edit by
 * asking whether the field's latest write was human, and that answer came from
 * the `operations` table — which on the office computer has NO row for an edit
 * that arrived as a document merge. Worse, ingest's provenance map evaluated to
 * 'import', positively recording the director's own correction as having come
 * from the spreadsheet.
 *
 * Silent in both directions, which is what made it expensive: the director who
 * made the correction watched it replicate correctly, and the one who
 * re-imported saw a clean import. It surfaced only as "didn't I already fix
 * that?"
 *
 * docs/adr/2026-09-09-field-provenance-in-the-document.md.
 *
 * Deliberately asserted through `isHumanOwned` — the question ingest actually
 * asks — rather than by driving a whole ingest run. What is on trial is whether
 * the ANSWER survives a device boundary; ingest's own behaviour given a correct
 * answer is covered by its unit tests. Testing the mechanism the bug lived in,
 * on two real devices, is the point.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor, configureDualWrite } from '../harnessAutomerge.js'
import { isHumanOwned } from '../../../electron/ops/fieldProvenance.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    configureDualWrite(tmpDir)

    // The office computer, with an imported activity.
    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()
    await host.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swiming', source: 'import' })

    // The iPad joins and sees it.
    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)
    await waitFor(() => client.domainRow('activities', 'act-1')?.name === 'Swiming', 10000)
      .catch(() => { throw new Error('the imported activity never reached the second device') })

    // The director fixes the typo ON THE IPAD. A hand edit.
    await client.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swimming', source: 'human' })

    // It reaches the office computer.
    await waitFor(() => host.domainRow('activities', 'act-1')?.name === 'Swimming', 10000)
      .catch(() => { throw new Error('the correction never reached the office computer') })

    // THE ASSERTION. On the office computer — which never made this edit and has
    // no operation row for it — the field must still be known to be human-owned,
    // or the next re-import overwrites the director's correction.
    if (!isHumanOwned(host.db, 'activities', 'act-1', 'name')) {
      throw new Error(
        'the office computer does not know a human made this edit — a re-import there would ' +
        'silently revert the director\'s correction'
      )
    }

    // And the device that MADE the edit knows it too (the local write path,
    // which is the half that was never broken — asserted so a regression that
    // fixes one path and breaks the other cannot pass).
    if (!isHumanOwned(client.db, 'activities', 'act-1', 'name')) {
      throw new Error('the device that made the hand edit lost track of its own provenance')
    }

    // The other half of the rule: a field NOBODY hand-edited must stay
    // import-owned on both devices, or every imported field becomes frozen
    // against future re-imports — the same bug wearing the opposite face.
    await host.write({ entity: 'activities', entity_id: 'act-2', field: 'name', value: 'Archery', source: 'import' })
    await waitFor(() => !!client.domainRow('activities', 'act-2'), 10000)
      .catch(() => { throw new Error('the second imported activity never replicated') })

    for (const [label, device] of [['office computer', host], ['iPad', client]]) {
      if (isHumanOwned(device.db, 'activities', 'act-2', 'name')) {
        throw new Error(`${label} wrongly claims an imported field was hand-edited`)
      }
    }

    // And ownership hands BACK: a later import write on one device clears the
    // human marker everywhere, so a director who accepts an imported value is
    // not left with a field frozen against every future import.
    await host.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swimming Pool', source: 'import' })
    await waitFor(() => client.domainRow('activities', 'act-1')?.name === 'Swimming Pool', 10000)
      .catch(() => { throw new Error('the accepted import value never replicated') })

    for (const [label, device] of [['office computer', host], ['iPad', client]]) {
      if (isHumanOwned(device.db, 'activities', 'act-1', 'name')) {
        throw new Error(`${label} still claims a human owns a field an import has since taken back`)
      }
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
