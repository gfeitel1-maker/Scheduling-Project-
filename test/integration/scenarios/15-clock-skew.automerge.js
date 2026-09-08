/**
 * Scenario 15 (libp2p): a device with a wrong clock still converges correctly.
 *
 * The WS original asserted that a skewed `created_at` in a submitted op did not
 * cause the Host to reject it, and that `host_seq` ordering stayed monotonic.
 * Neither of those things exists here: there is no submitted op, no Host-
 * assigned sequence, and no server to reject anything.
 *
 * What survives is the property a camp actually depends on, and it is worth
 * asserting rather than assuming — camp devices genuinely do have wrong clocks,
 * and a sync engine that ordered by wall time would corrupt a schedule when a
 * tablet came back from a winter in a cupboard with its clock reset.
 *
 * Automerge orders by causal history, not by time. So a device whose clock is a
 * year in the past must still: have its writes accepted, converge with everyone
 * else, and — the sharp part — NOT win or lose a genuine same-field
 * disagreement on the strength of its timestamp. A conflict is a conflict
 * whatever the clocks say, and it goes to a human.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'
import { reconcile } from '../../../electron/automerge/reconcile.js'

export async function run() {
  const dirs = []
  let host, skewed, normal
  const realNow = Date.now

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()
    await host.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swimming' })

    skewed = new AmClient(`${tmpDir}/skewed.db`)
    skewed.open()
    await skewed.join(host)

    normal = new AmClient(`${tmpDir}/normal.db`)
    normal.open()
    await normal.join(host)

    await waitFor(() => !!skewed.domainRow('activities', 'act-1'), 8000)
    await waitFor(() => !!normal.domainRow('activities', 'act-1'), 8000)

    // From here, this process believes it is a year ago. Every timestamp any
    // code path records — audit rows, conflict rows, doc-store filenames — is
    // taken from this.
    const yearAgo = realNow() - 365 * 24 * 60 * 60 * 1000
    Date.now = () => yearAgo

    await skewed.write({ entity: 'activities', entity_id: 'act-2', field: 'name', value: 'Written in the past' })

    // A backdated write is still just a write.
    await waitFor(() => !!host.domainRow('activities', 'act-2'), 8000)
      .catch(() => { throw new Error('a write from a device with a skewed clock never arrived') })
    await waitFor(() => !!normal.domainRow('activities', 'act-2'), 8000)
      .catch(() => { throw new Error('a backdated write reached the Host but not the other device') })

    // And the sharp part: a genuine disagreement is still a disagreement. The
    // backdated device must not silently lose (or win) on its timestamp.
    Date.now = realNow
    await normal.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Archery' })
    Date.now = () => yearAgo
    await skewed.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Canoeing' })
    Date.now = realNow

    await waitFor(() => reconcile(host.getDoc()).conflicts.length > 0, 8000)
      .catch(() => {
        throw new Error('a real disagreement was resolved by clock order instead of being surfaced')
      })

    const conflict = reconcile(host.getDoc()).conflicts[0]
    const values = conflict.values.map((v) => v.value).sort()
    if (values.join('|') !== 'Archery|Canoeing') {
      throw new Error(`expected both choices to survive for a human, got ${JSON.stringify(values)}`)
    }

    return 'PASS'
  } finally {
    Date.now = realNow
    await host?.close()
    await skewed?.close()
    await normal?.close()
    cleanupDirs(dirs)
  }
}
