import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { useEnterTransition } from '../styles/shared'

// T359 slice 4. Whether the router agreed to let other camp devices reach this one directly.
// null from the getter (feature off, not started, unknown) shows nothing, and so does 'mapped':
// a working opening needs no attention, and a flag that is always on stops being read. Informational
// only - there is no setting the director could change from here, so no control is offered.
const COPY = {
  'permanent-lease': {
    line: 'Router opening stays set',
    why: (reason) => `${reason ? `Note: ${reason}.` : 'Your router will keep this opening.'} Other camp devices can reach this computer directly; nothing for you to do unless you want it closed in the router's own settings.`,
  },
  refused: {
    line: 'Router declined a direct path',
    why: () => 'Your router said no when Shoresh asked it to allow other devices in. Devices on the same Wi-Fi are not affected; a device on another network may not be able to connect directly.',
  },
  'no-gateway': {
    line: 'No router to ask',
    why: () => "Shoresh couldn't find a router that lets programs open a path, which is common on camp, school and phone-hotspot networks. Devices on the same Wi-Fi are not affected.",
  },
  'double-nat': {
    line: 'Another router sits in front of this one',
    why: () => "A second router (or your internet provider) is in front of the one Shoresh can reach, so opening a path here wouldn't help. Devices on the same Wi-Fi are not affected.",
  },
  'port-in-use': {
    line: "Shoresh's connection spot is busy",
    why: () => 'Another program on this computer is using the spot Shoresh wants for direct connections. Closing other copies of Shoresh and reopening it may free it. Devices on the same Wi-Fi are not affected.',
  },
  error: {
    line: "Couldn't check the router",
    why: () => 'Something went wrong while Shoresh was talking to the router. Devices on the same Wi-Fi are not affected.',
  },
}

export default function PortMappingFlag() {
  const [payload, setPayload] = useState(null)

  useEffect(() => {
    let alive = true
    const read = () => {
      Promise.resolve()
        .then(() => localClient.getPortMappingStatus())
        .then((next) => { if (alive) setPayload(next) }, () => { if (alive) setPayload(null) })
    }
    read()
    const timer = setInterval(read, 15000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const copy = payload && COPY[payload.status]
  return copy ? <Flag status={payload.status} copy={copy} reason={payload.reason} /> : null
}

function Flag({ status, copy, reason }) {
  const transition = useEnterTransition('slideFade', {})
  return (
    <div data-testid="port-mapping-flag" data-status={status} style={{ ...styles.row, ...transition }}>
      <span aria-hidden="true" style={styles.dot}>●</span>
      <div>
        <div data-testid="port-mapping-flag-line" style={styles.line}>{copy.line}</div>
        <div data-testid="port-mapping-flag-why" style={styles.why}>{copy.why(reason)}</div>
      </div>
    </div>
  )
}

const styles = {
  row: { display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 16px' },
  dot: { flexShrink: 0, fontSize: 8, color: 'var(--text-secondary)' },
  line: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  why: { fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, maxWidth: 560, lineHeight: 1.45 },
}
