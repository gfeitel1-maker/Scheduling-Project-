/**
 * Scenario 23 (libp2p): the camp map's background image replicates.
 *
 * ADR docs/adr/2026-08-16-locations-optional-map.md (D4/D6). Kept for a reason
 * that has nothing to do with maps: this is the only scenario where a single
 * field carries a genuinely LARGE value — a base64 image rather than a name or
 * an id.
 *
 * Every other scenario would pass just as happily with a frame size limit set
 * far too low, because every other value is a few dozen bytes. This one would
 * not: `wireProtocol.js`'s MAX_FRAME_BYTES sits between the two devices, and a
 * document carrying an image is the realistic case that approaches it. If a
 * future change tightened that cap, or made a document exceed it, the symptom
 * would be "the map never arrives on the iPad" and nothing else would notice.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'

// ~256 KB of base64 — the order of magnitude a director's photographed site map
// actually is, not a token value that would prove nothing about size.
const IMAGE_DATA = 'data:image/png;base64,' + 'A'.repeat(256 * 1024)

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { campId } = await host.bootstrap()

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    await host.write({ entity: 'camp_maps', entity_id: 'map-1', field: 'camp_id', value: campId })
    await host.write({ entity: 'camp_maps', entity_id: 'map-1', field: 'image_mime', value: 'image/png' })
    await host.write({ entity: 'camp_maps', entity_id: 'map-1', field: 'image_width', value: '2048' })
    await host.write({ entity: 'camp_maps', entity_id: 'map-1', field: 'image_height', value: '1536' })
    await host.write({ entity: 'camp_maps', entity_id: 'map-1', field: 'image_data', value: IMAGE_DATA })

    // Wait on the IMAGE, not on the row. The row appears as soon as its first
    // field projects, and the image lands in a later merge — waiting on the row
    // and then reading the image is a race that fails about as often as it
    // passes, and it fails looking like a truncated image rather than like a
    // test that measured the wrong thing.
    await waitFor(() => client.domainRow('camp_maps', 'map-1')?.image_data === IMAGE_DATA, 20000)
      .catch(() => {
        const got = client.domainRow('camp_maps', 'map-1')?.image_data?.length ?? 0
        throw new Error(`the camp map never arrived intact: ${got} bytes of ${IMAGE_DATA.length}`)
      })

    // The small sibling fields, waited on the same way and for the same reason.
    await waitFor(() => {
      const w = client.domainRow('camp_maps', 'map-1')?.image_width
      return w === '2048' || w === 2048
    }, 10000).catch(() => { throw new Error('the map arrived without its dimensions') })

    // Replacing a large value must also work — the update path re-sends the
    // whole field, so it is the same size question a second time.
    const replacement = 'data:image/png;base64,' + 'B'.repeat(256 * 1024)
    await host.write({ entity: 'camp_maps', entity_id: 'map-1', field: 'image_data', value: replacement })
    await waitFor(() => client.domainRow('camp_maps', 'map-1')?.image_data === replacement, 15000)
      .catch(() => { throw new Error('replacing the camp map did not reach the second device') })

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
