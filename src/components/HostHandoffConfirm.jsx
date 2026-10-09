import { useState } from 'react'
import { localClient } from '../localClient'
import { useHostHandoff } from '../hooks/useHostHandoff'
import { S, useEnterTransition } from '../styles/shared'

// The successor's single confirm (docs/adr/2026-10-09-host-succession-simple.md, UI). Mounted once
// at the app shell so it appears on whichever screen the director is on when the offer arrives.
// Both apps restart after a successful handoff, which the body says before the director agrees.
export default function HostHandoffConfirm() {
  const { status, refresh } = useHostHandoff()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const enterStyle = useEnterTransition('liftFade')

  const handoff = status?.handoff
  if (!handoff || handoff.role !== 'taker') return null

  const selfName = status.selfName || 'This computer'
  const selfInline = status.selfName || 'this computer'
  const peerName = status.peerName || 'the other computer'
  const waiting = handoff.state === 'accepted' || handoff.state === 'stored'
  const activationFailed = handoff.state === 'stored' && status.lastResult?.ok === false && status.lastResult.reason === 'activation_failed'

  async function accept() {
    setBusy(true)
    setFailed(false)
    try {
      const result = await localClient.handoffAccept()
      if (result && result.ok === false) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  async function decline() {
    await localClient.handoffDecline()
    refresh()
  }

  return (
    <div style={{ ...S.overlay, ...enterStyle }}>
      <div style={styles.panel} role="dialog" aria-modal="true" aria-label="Move hosting to this computer">
        <div style={styles.title}>{`${selfName} becomes the host for ${status.campName || 'this camp'}`}</div>
        {waiting && activationFailed ? (
          <div role="status" style={styles.body}>
            {`This computer could not finish taking over (${status.lastResult.detail || 'the change could not be saved'}). The hosting key is kept on this computer and it tries again on its own. Keep both computers open and on this network; if it keeps failing, restart this computer.`}
          </div>
        ) : waiting ? (
          <div role="status" style={styles.body}>
            {`Waiting for ${peerName} to finish. Keep both computers open and on this network; this computer restarts when it is done.`}
          </div>
        ) : (
          <>
            <p style={styles.body}>
              {`${peerName} stops being the host and ${selfInline} takes over. Both apps will restart. Keep ${peerName} open and on this network until this computer shows the camp code.`}
            </p>
            {failed && (
              <div role="status" style={styles.result}>
                Handoff did not complete. Nothing was changed on this computer.
              </div>
            )}
            <div style={styles.actions}>
              <button className="press-97" style={S.btnSecondary} onClick={decline} disabled={busy}>Cancel</button>
              <button className="press-97" style={S.btnPrimary} onClick={accept} disabled={busy}>
                {busy ? 'Working…' : 'Make this the host'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const styles = {
  panel: { background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, width: 520, maxWidth: '100%' },
  title: { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, marginBottom: 14 },
  body: { fontSize: 14, lineHeight: 1.55, margin: '0 0 14px', color: 'var(--text)' },
  result: { fontSize: 13, lineHeight: 1.55, color: 'color-mix(in srgb, var(--accent) 65%, var(--text))' },
  actions: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 },
}
