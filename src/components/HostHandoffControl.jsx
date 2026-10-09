import { useEffect, useState } from 'react'
import { S } from '../styles/shared'

// "Hand hosting to <device>" on one Devices row (docs/adr/2026-10-09-host-succession-simple.md, UI;
// DESIGN_STANDARD §5, §8). Shown only for a device the host reports as eligible: an admin device
// connected on the LAN. Progress and the result live on the control itself: text always, plus a quiet
// 2px bar that holds still under reduced motion. Never a banner, never a disabled placeholder.

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  ))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

function progressText(state, name) {
  if (state === 'offered') return `Waiting for ${name} to confirm…`
  if (state === 'sent') return `Sending to ${name}…`
  return 'Restarting…'
}

export default function HostHandoffControl({ device, status, onStart }) {
  const reducedMotion = usePrefersReducedMotion()
  const name = device.name || 'this device'
  const handoff = status?.handoff

  // Past the decision point this computer is no longer the host, but the handoff it gave is still
  // its to report: the successor could not finish, holds the key, and retries while both stay open.
  if (handoff?.role === 'giver' && handoff.state === 'committed' && handoff.peerDeviceId === device.id) {
    const r = status.lastResult
    if (r && r.ok === false && r.reason === 'activation_failed' && r.peerDeviceId === device.id) {
      return (
        <div style={styles.wrap}>
          <div role="status" style={styles.result}>
            {`${name} received hosting but could not finish setting it up. It keeps the hosting key and tries again on its own. Keep both computers open and on this network; if it keeps failing, restart ${name}.`}
          </div>
        </div>
      )
    }
  }

  if (!status?.isHost || !status.eligibleDeviceIds?.includes(device.id)) return null

  if (handoff && handoff.role === 'giver') {
    if (handoff.peerDeviceId !== device.id) return null
    return (
      <div style={styles.wrap}>
        <div role="status" style={styles.progress}>{progressText(handoff.state, name)}</div>
        {!reducedMotion && (
          <div style={styles.track}>
            <div className="shoresh-indeterminate-fill" style={styles.fill} />
          </div>
        )}
      </div>
    )
  }
  if (handoff) return null

  const failed = status.lastResult && status.lastResult.ok === false && status.lastResult.peerDeviceId === device.id
  return (
    <div style={styles.wrap}>
      <button className="press-97" style={S.btnSecondary} onClick={() => onStart(device.id)}>
        Hand hosting to {name}
      </button>
      {failed && (
        <div role="status" style={styles.result}>
          {`Handoff did not complete. ${name} was not changed; this computer is still the host.`}
        </div>
      )}
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', marginTop: 6 },
  progress: { fontSize: 12.5, color: 'var(--text-secondary)' },
  track: {
    width: 160,
    height: 2,
    overflow: 'hidden',
    background: 'color-mix(in srgb, var(--primary) 12%, transparent)',
    borderRadius: 1,
  },
  fill: {
    height: '100%',
    width: '30%',
    background: 'var(--primary)',
    borderRadius: 1,
    animation: 'shoresh-indeterminate 1100ms linear infinite',
  },
  // Caution, not danger: nothing was lost and this computer is still the host (DESIGN_STANDARD §4).
  result: { fontSize: 12.5, color: 'color-mix(in srgb, var(--accent) 65%, var(--text))', maxWidth: 360, lineHeight: 1.5 },
}
