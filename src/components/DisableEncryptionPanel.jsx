import { useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'

// T345 (docs/adr/2026-09-28-at-rest-encryption-disable-control.md). Admin-only, type-to-confirm. The copy
// states the consequence and the scope (this computer only) before the one irreversible click.
const PHRASE = 'DISABLE ENCRYPTION'

export default function DisableEncryptionPanel() {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      const res = await localClient.disableAtRestEncryption(typed)
      if (res?.ok) setDone(true)
      else setError(res?.message || res?.error || 'unknown problem')
    } catch (err) {
      setError(err?.message || 'unknown problem')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={styles.section}>
      <h2 style={styles.sectionTitle}>Encryption on this computer</h2>
      <p style={styles.note}>
        Your camp&apos;s information is stored encrypted on this computer. Turning that off is rarely
        needed and cannot be undone from here.
      </p>
      {done && <p style={styles.flag}>Encryption is off. Shoresh is restarting.</p>}
      {!done && !open && (
        <button type="button" style={S.btnDanger} onClick={() => setOpen(true)}>Turn off encryption…</button>
      )}
      {!done && open && (
        <div style={styles.box}>
          <p style={styles.note}>
            This decrypts the camp&apos;s database and document on this computer. Camper information,
            including PIN hashes, will be readable by anyone who can open the files on this computer.
            It affects only this computer; other paired devices keep their own encryption until you turn
            it off on each of them. Older backups made while encryption was on can no longer be opened
            afterwards. Shoresh checks the result and restarts; if anything fails, encryption stays on
            and nothing is lost.
          </p>
          <label style={styles.label}>
            Type {PHRASE} to confirm
            <input style={S.input} value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoComplete="off" />
          </label>
          {error && <p style={styles.error}>Encryption is still on. {error}</p>}
          <div style={styles.row}>
            <button type="button" style={S.btnSecondary} onClick={() => { setOpen(false); setTyped(''); setError(null) }} disabled={busy}>Cancel</button>
            <button
              type="button"
              style={typed !== PHRASE || busy ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
              disabled={typed !== PHRASE || busy}
              onClick={confirm}
            >
              Turn off encryption
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

const styles = {
  section: { marginBottom: 36 },
  sectionTitle: {
    fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase',
    letterSpacing: '0.05em', marginBottom: 12, marginTop: 0,
  },
  note: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: 620, marginTop: 0, marginBottom: 14 },
  box: { display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' },
  label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--text)' },
  row: { display: 'flex', gap: 8 },
  error: { color: 'var(--danger)', fontSize: 13, fontWeight: 600, margin: 0 },
  flag: { color: 'var(--text)', fontSize: 13, fontWeight: 600, margin: 0 },
}
