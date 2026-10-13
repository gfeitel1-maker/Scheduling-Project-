import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import { DEVICE_REVOKED_REASON } from '../hooks/useDeviceMode'

// docs/adr/2026-10-13-revoked-device-local-reset.md. Shown only when the main process reports startFreshAvailable (the
// verified gate: a trusted revoke entry, the cache, and the removed mark); never inferred from a close code. Two explicit clicks, no typing.
const MODE_KEY = 'shoresh-mode'
const TOKEN_KEY = 'shoresh-token'
const ROLE_KEY = 'shoresh-role'

export default function StartFreshOnThisComputer({ notice = null }) {
  const [removed, setRemoved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)
  const [camps, setCamps] = useState([])

  useEffect(() => {
    let active = true
    const read = () => localClient.getSyncStatus().then((s) => { if (active) setRemoved(s?.startFreshAvailable === true) }).catch(() => {})
    read()
    const off = localClient.onSyncStatusChanged?.(read)
    return () => { active = false; off?.() }
  }, [])

  async function openConfirm() {
    try {
      const res = await localClient.startFreshPreview()
      setCamps(res?.ok ? res.camps ?? [] : [])
    } catch { setCamps([]) }
    setConfirming(true)
  }

  async function startFresh() {
    setBusy(true)
    setError(null)
    try {
      const res = await localClient.startFreshOnThisComputer()
      if (res?.ok) {
        for (const k of [MODE_KEY, TOKEN_KEY, ROLE_KEY]) {
          try { localStorage.removeItem(k) } catch { /* storage unavailable: the main process clears the window storage too */ }
        }
        setDone(true)
      } else {
        setError('Nothing was cleared. Shoresh will restart in a few seconds.')
        setConfirming(false)
      }
    } catch (err) {
      setError(err?.message || 'Something went wrong, and nothing was cleared.')
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  if (!removed) return null

  return (
    <div style={styles.box}>
      {notice !== DEVICE_REVOKED_REASON && <p style={styles.lead}>{DEVICE_REVOKED_REASON}</p>}
      {done && <p style={styles.lead}>Shoresh is restarting.</p>}
      {!done && !confirming && (
        <button type="button" style={S.btnDanger} onClick={openConfirm}>Start fresh on this computer</button>
      )}
      {!done && confirming && (
        <>
          <p style={styles.note}>
            This clears Shoresh on this computer only, including its backups (they only open on this computer as it was).
            The camp&apos;s information is still on your other computers. Anything changed here after it was removed will be lost.
            A &lsquo;Save whole camp&rsquo; file you kept elsewhere is not affected and can still be opened.
            Any other camp you have opened on this computer will no longer open here either.
          </p>
          {camps.map((c) => (
            <p key={c.file} style={styles.note}>
              {c.outsideShoresh
                ? `${c.name} (${c.file}) is stored outside Shoresh's folder. Shoresh will not touch it, but it will no longer open on this computer.`
                : `Before you continue, use Save whole camp in ${c.name} so you can open it again.`}
            </p>
          ))}
          <div style={styles.row}>
            <button type="button" style={S.btnSecondary} onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            <button type="button" style={busy ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger} onClick={startFresh} disabled={busy}>Yes, start fresh</button>
          </div>
        </>
      )}
      {error && <p style={styles.error}>{error}</p>}
    </div>
  )
}

const styles = {
  box: { display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start', marginBottom: 20 },
  lead: { fontSize: 14, fontWeight: 600, color: 'var(--text)', margin: 0, lineHeight: 1.5 },
  note: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 },
  row: { display: 'flex', gap: 8 },
  error: { color: 'var(--danger)', fontSize: 13, fontWeight: 600, margin: 0 },
}
