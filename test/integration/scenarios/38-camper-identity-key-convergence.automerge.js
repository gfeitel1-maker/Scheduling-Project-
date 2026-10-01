/**
 * Scenario 38 — T321, ADR docs/adr/2026-10-01-camper-id-high-entropy-format.md
 * acceptance criterion 3: two devices importing the identical sheet for a
 * camper NEITHER has seen before, without syncing with each other first,
 * converge on ONE `camper_id` once their documents merge.
 *
 * WHY A UNIT TEST DOES NOT DISCHARGE THIS (mirrors scenario 31's own
 * argument, one entity over). A unit test of deriveCamperId or of
 * resolveOrMintCamperId against a single SQLite db proves the derivation is
 * deterministic and proves the resolve-or-mint LOGIC. It cannot prove two
 * independent devices actually land on the SAME Automerge map key and that a
 * REAL merge resolves the contest — that is a property of the document and
 * the sync engine, not of the function.
 *
 * THE FIXTURE. Devices A and B both join for real, then PARTITION. Each
 * independently resolves the SAME logical camper ('Ari Green', no external
 * id) — exactly ADR decision 3's "two devices mint two different random
 * camper ids for the same logical camper before syncing" — by writing
 * directly to `camper_identity_keys[lookupId]` the way
 * electron/ops/camperIdentityResolver.js's resolveOrMintCamperId does on a
 * cache miss (mint a random camperId, write the mapping row), through the
 * harness's document-level `write()` rather than the op-log (appendOp), so
 * this test exercises the SAME merge path scenario 31 does for assignments.
 *
 * WHY THIS WOULD FAIL WITHOUT THE DERIVED LOOKUP KEY (the non-vacuity arm,
 * same discriminator scenario 31 uses): if each device instead wrote its
 * mapping row under ITS OWN randomly-minted camperId as the ROW'S OWN id
 * (the Option-B-rejected shape), the two rows would be two independent
 * Automerge map keys — the merge would keep BOTH, camper_identity_keys would
 * have two entries for the same logical camper, and neither device could
 * ever again resolve 'Ari Green' to a single answer. Keying the mapping row
 * on `deriveCamperId`'s output instead collapses the contest onto ONE
 * Automerge map key, which last-write-wins resolves to exactly one
 * `camper_id` — the assertion below.
 */
import { setupTwoJoinedDevices, partitionClients, healPartition, cleanupDirs, waitFor } from '../harnessAutomerge.js'
import { deriveCamperId, mintCamperId, electiveChoiceLabelKey } from '../../../electron/ops/electiveDerivedIds.js'

const DISPLAY_NAME = 'Ari Green'
const KEY_VALUE = electiveChoiceLabelKey(DISPLAY_NAME)

export async function run() {
  const dirs = []
  let host, clientA, clientB

  try {
    const setup = await setupTwoJoinedDevices()
    host = setup.host
    clientA = setup.clientA
    clientB = setup.clientB
    const { tmpDir, campId } = setup
    dirs.push(tmpDir)

    const lookupId = deriveCamperId(campId, { displayName: DISPLAY_NAME })

    // ---- PARTITION. Each device restarts onto a fresh node not dialed to the
    // Host, so the writes below genuinely cannot reach the other side.
    await partitionClients({ tmpDir, clientA, clientB, campId })

    // ---- Both independently resolve the SAME new camper, through the
    // document-level write the resolver's mint path performs. Neither knows
    // the other is doing it.
    const mintedByDevice = {}
    for (const [label, client] of [['clientA', clientA], ['clientB', clientB]]) {
      // Derived HERE, per device, from the same inputs — not a shared constant
      // reused — mirroring scenario 31's SHARED_ID discipline.
      const id = deriveCamperId(campId, { displayName: DISPLAY_NAME })
      if (id !== lookupId) throw new Error(`derivation is not a pure function of its key: ${id}`)

      const mintedCamperId = mintCamperId()
      mintedByDevice[label] = mintedCamperId

      await client.write({ entity: 'camper_identity_keys', entity_id: lookupId, field: 'camp_id', value: campId })
      await client.write({ entity: 'camper_identity_keys', entity_id: lookupId, field: 'key_mode', value: 'name' })
      await client.write({ entity: 'camper_identity_keys', entity_id: lookupId, field: 'key_value', value: KEY_VALUE })
      await client.write({ entity: 'camper_identity_keys', entity_id: lookupId, field: 'camper_id', value: mintedCamperId })
      await client.write({ entity: 'campers', entity_id: mintedCamperId, field: 'camp_id', value: campId })
      await client.write({ entity: 'campers', entity_id: mintedCamperId, field: 'display_name', value: DISPLAY_NAME })
    }

    // NON-VACUITY GUARD: confirm the two devices really did mint DIFFERENT
    // camper ids before the merge — otherwise "they converge" would be true
    // for a trivial reason (nothing to resolve).
    if (mintedByDevice.clientA === mintedByDevice.clientB) {
      throw new Error('mintCamperId produced the same id twice — the scenario setup is not testing a real contest')
    }

    // Each device has its OWN camper_id for the lookup, pre-merge.
    for (const [label, d] of [['clientA', clientA], ['clientB', clientB]]) {
      const row = d.domainRow('camper_identity_keys', lookupId)
      if (row?.camper_id !== mintedByDevice[label]) {
        throw new Error(`${label}: expected its own local mapping pre-merge, got ${JSON.stringify(row)}`)
      }
    }

    // ---- HEAL.
    await healPartition({ host, clientA, clientB })

    // Wait until both devices have genuinely seen the OTHER side's write —
    // the false green this scenario would otherwise be most likely to
    // produce. A device whose own write still stands is not evidence of a
    // merge; one whose row now agrees with the OTHER device's IS.
    await waitFor(() => {
      const a = clientA.domainRow('camper_identity_keys', lookupId)?.camper_id
      const b = clientB.domainRow('camper_identity_keys', lookupId)?.camper_id
      return !!a && a === b
    }, 10000).catch(() => {
      const a = clientA.domainRow('camper_identity_keys', lookupId)?.camper_id
      const b = clientB.domainRow('camper_identity_keys', lookupId)?.camper_id
      throw new Error(`devices never converged — clientA=${a}, clientB=${b}`)
    })
    await waitFor(() => !!host.domainRow('camper_identity_keys', lookupId)?.camper_id, 10000).catch(() => {
      throw new Error('host never received the merged mapping row')
    })

    // (1) THE INVARIANT — exactly ONE camper_id for the lookup, agreed by
    // every device. This is the assertion criterion 3 exists for.
    const winner = clientA.domainRow('camper_identity_keys', lookupId).camper_id
    for (const [label, d] of [['host', host], ['clientA', clientA], ['clientB', clientB]]) {
      const row = d.domainRow('camper_identity_keys', lookupId)
      if (!row) throw new Error(`${label}: the lookup row is missing after merge`)
      if (row.camper_id !== winner) {
        throw new Error(`${label}: disagrees on the winner (${row.camper_id} vs ${winner})`)
      }
    }

    // (2) The winner is ONE of the two minted ids — not a third, invented
    // value, and not undefined/empty.
    const mintedIds = Object.values(mintedByDevice)
    if (!mintedIds.includes(winner)) {
      throw new Error(`winner ${winner} is not one of the two minted ids: ${mintedIds.join(', ')}`)
    }

    // (3) DISTINCT KEYS STAY DISTINCT (arm 2, same discipline as scenario 31):
    // a DIFFERENT camper, resolved under a DIFFERENT lookup key, must NOT be
    // pulled into this contest — otherwise a constant/overbroad key would
    // pass (1) and (2) for the wrong reason.
    const otherLookupId = deriveCamperId(campId, { displayName: 'Noa Katz' })
    const otherCamperId = mintCamperId()
    await clientA.write({ entity: 'camper_identity_keys', entity_id: otherLookupId, field: 'camp_id', value: campId })
    await clientA.write({ entity: 'camper_identity_keys', entity_id: otherLookupId, field: 'key_mode', value: 'name' })
    await clientA.write({ entity: 'camper_identity_keys', entity_id: otherLookupId, field: 'key_value', value: electiveChoiceLabelKey('Noa Katz') })
    await clientA.write({ entity: 'camper_identity_keys', entity_id: otherLookupId, field: 'camper_id', value: otherCamperId })
    await waitFor(() => !!host.domainRow('camper_identity_keys', otherLookupId)?.camper_id, 10000).catch(() => {
      throw new Error('host never received the second camper mapping row')
    })
    if (host.domainRow('camper_identity_keys', lookupId).camper_id !== winner) {
      throw new Error('writing a SECOND, unrelated camper mapping disturbed the first contest\'s winner')
    }
    if (host.domainRow('camper_identity_keys', otherLookupId).camper_id !== otherCamperId) {
      throw new Error('the second, unrelated camper mapping did not survive on its own key')
    }
    if (lookupId === otherLookupId) {
      throw new Error('the derivation is constant in displayName — arm 3 proved nothing')
    }

    return 'PASS'
  } finally {
    await host?.close()
    await clientA?.close()
    await clientB?.close()
    cleanupDirs(dirs)
  }
}
