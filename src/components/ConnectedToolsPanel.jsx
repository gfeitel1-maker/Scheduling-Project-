import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'

// Director-authorized tool connections (docs/adr/2026-10-08-director-authorized-tool-connections.md).
// The copy is deliberately about accountability: it states what an authorization does and does not do,
// and never claims to stop someone who is already signed in to this computer.
const SCOPE_LABEL = { read: 'Read only', 'read-write': 'Read and change' }

function fmt(iso) {
  return iso ? new Date(iso).toLocaleDateString() : '—'
}

export default function ConnectedToolsPanel() {
  const [tools, setTools] = useState([])
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState('read')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [newSecret, setNewSecret] = useState(null)

  async function load() {
    try {
      setTools((await localClient.listToolAuthorizations()) || [])
    } catch (err) {
      setError(err?.message || "Couldn't load your connected tools.")
    }
  }

  useEffect(() => {
    let live = true
    localClient.listToolAuthorizations().then(
      (t) => { if (live) setTools(t || []) },
      (err) => { if (live) setError(err?.message || "Couldn't load your connected tools.") }
    )
    return () => { live = false }
  }, [])

  async function handleGrant(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { secret } = await localClient.grantToolAuthorization(label, scope)
      setNewSecret({ label: label.trim(), secret })
      setLabel('')
      await load()
    } catch (err) {
      setError(err?.message || "Couldn't authorize that tool.")
    } finally {
      setBusy(false)
    }
  }

  async function handleRevoke(id) {
    setBusy(true)
    setError(null)
    try {
      await localClient.revokeToolAuthorization(id)
      await load()
    } catch (err) {
      setError(err?.message || "Couldn't revoke that tool.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={styles.section} aria-labelledby="connected-tools-title">
      <h2 id="connected-tools-title" style={styles.sectionTitle}>Connected Tools</h2>
      <p style={styles.note}>
        Authorize the scripts and assistants that work with this camp&apos;s data, such as the MCP server and the import
        command-line tools. Each one gets its own name and secret, shows up here, and can be revoked at any time.
        This records which tools you chose to connect; it does not stop someone who is already signed in to this
        computer from reaching the camp&apos;s files.
      </p>

      {error && <div role="alert" style={styles.error}>{error}</div>}

      {newSecret && (
        <div style={styles.secretBox} data-testid="new-tool-secret">
          <div style={styles.secretLead}>
            Secret for &ldquo;{newSecret.label}&rdquo;. This is the only time it is shown, so copy it now and keep it
            with that tool&apos;s settings.
          </div>
          <code style={styles.secret}>{newSecret.secret}</code>
          <button style={S.btnSecondary} onClick={() => setNewSecret(null)}>I&apos;ve saved it</button>
        </div>
      )}

      {tools.length === 0 ? (
        <div style={styles.empty}>No tools are authorized yet.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={S.th}>Tool</th>
              <th style={S.th}>Access</th>
              <th style={S.th}>Authorized</th>
              <th style={S.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.id}>
                <td style={S.td}>{t.label}</td>
                <td style={S.td}>{SCOPE_LABEL[t.scope] ?? t.scope}</td>
                <td style={S.td}>{fmt(t.created_at)}</td>
                <td style={S.td}>
                  {t.revoked_at ? (
                    <span style={styles.revoked}>Revoked {fmt(t.revoked_at)}</span>
                  ) : (
                    <button
                      style={busy ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
                      disabled={busy}
                      onClick={() => handleRevoke(t.id)}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={handleGrant} style={styles.form}>
        <div style={styles.field}>
          <label htmlFor="tool-label" style={S.label}>Tool name</label>
          <input
            id="tool-label"
            style={S.input}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Greg's laptop MCP"
          />
        </div>
        <div style={styles.field}>
          <label htmlFor="tool-scope" style={S.label}>Access</label>
          <select id="tool-scope" style={S.input} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="read">Read only</option>
            <option value="read-write">Read and change</option>
          </select>
        </div>
        <button
          type="submit"
          className="press-97"
          style={busy || !label.trim() ? { ...S.btnPrimary, ...S.buttonDisabled } : S.btnPrimary}
          disabled={busy || !label.trim()}
        >
          Authorize tool
        </button>
      </form>
    </section>
  )
}

const styles = {
  section: { marginBottom: 36 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 12,
    marginTop: 0,
  },
  note: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: 620, marginTop: 0, marginBottom: 14 },
  error: {
    color: 'var(--warning)',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 12,
  },
  secretBox: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 14,
    marginBottom: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    alignItems: 'flex-start',
  },
  secretLead: { fontSize: 13, color: 'var(--text)', lineHeight: 1.5 },
  secret: { fontFamily: 'var(--font-mono)', fontSize: 12.5, wordBreak: 'break-all', userSelect: 'all' },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    background: 'var(--surface)',
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid var(--border)',
    marginBottom: 16,
  },
  empty: { color: 'var(--text-secondary)', fontSize: 13, padding: '4px 0 16px' },
  revoked: { fontSize: 12, color: 'var(--text-secondary)' },
  form: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', maxWidth: 620 },
  field: { flex: '1 1 180px' },
}
