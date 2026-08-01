import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'

// T18 / CONSTITUTION Art. V. `pairing_status` is a database enum and was
// rendered raw — a director saw "authorized", "pending", "revoked", or the
// null-leak placeholder "unknown" as a status badge. These say what the state
// means for the device in front of them.
const PAIRING_STATUS_LABEL = {
  authorized: 'Allowed in',
  pending: 'Waiting for approval',
  denied: 'Turned away',
  revoked: 'No longer allowed',
}

function pairingStatusLabel(status) {
  return PAIRING_STATUS_LABEL[status] ?? 'Not set up yet'
}

export default function DeviceManagerScreen({ campId, role }) {
  const [pending, setPending] = useState([])
  const [allDevices, setAllDevices] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState({})

  useEffect(() => { load() }, [campId])

  useEffect(() => {
    const interval = setInterval(() => { load() }, 5000)
    return () => clearInterval(interval)
  }, [])

  async function load() {
    try {
      const [p, d] = await Promise.all([
        localClient.listPendingPairingRequests(),
        localClient.listDevices(),
      ])
      setPending(p || [])
      setAllDevices(d || [])
    } catch (err) {
      setError(err?.message || 'Failed to load devices')
    }
  }

  async function handleApprove(deviceId) {
    setBusy((b) => ({ ...b, [deviceId]: true }))
    try {
      await localClient.approveDevice(deviceId)
      load()
    } catch (err) {
      setError(err?.message || 'Failed to approve device')
    } finally {
      setBusy((b) => ({ ...b, [deviceId]: false }))
    }
  }

  async function handleDeny(deviceId) {
    setBusy((b) => ({ ...b, [deviceId]: true }))
    try {
      await localClient.denyDevice(deviceId)
      load()
    } catch (err) {
      setError(err?.message || 'Failed to deny device')
    } finally {
      setBusy((b) => ({ ...b, [deviceId]: false }))
    }
  }

  async function handleRevoke(deviceId) {
    setBusy((b) => ({ ...b, [deviceId]: true }))
    try {
      await localClient.revokeDevice(deviceId)
      load()
    } catch (err) {
      setError(err?.message || 'Failed to revoke device')
    } finally {
      setBusy((b) => ({ ...b, [deviceId]: false }))
    }
  }

  function fmt(iso) {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Device Manager</h1>
      </div>

      {error && (
        <div style={styles.errorBanner}>{error}</div>
      )}

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Pending Pairing Requests</h2>
        {pending.length === 0 ? (
          <div style={styles.empty}>No pending pairing requests.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={S.th}>Device Name</th>
                <th style={S.th}>ID</th>
                <th style={S.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((device) => (
                <tr key={device.id}>
                  <td style={S.td}>{device.name || '—'}</td>
                  <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{device.id.slice(0, 8)}</td>
                  <td style={S.td}>
                    <div style={styles.actions}>
                      <button
                        style={busy[device.id] ? { ...S.btnPrimary, ...S.buttonDisabled } : S.btnPrimary}
                        disabled={!!busy[device.id]}
                        onClick={() => handleApprove(device.id)}
                      >
                        Approve
                      </button>
                      <button
                        style={busy[device.id] ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
                        disabled={!!busy[device.id]}
                        onClick={() => handleDeny(device.id)}
                      >
                        Deny
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>All Devices</h2>
        {allDevices.length === 0 ? (
          <div style={styles.empty}>No devices found.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={S.th}>Device Name</th>
                <th style={S.th}>ID</th>
                <th style={S.th}>Status</th>
                <th style={S.th}>Authorized At</th>
                <th style={S.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {allDevices.map((device) => {
                const isRevoked = !!device.revoked_at
                const isAuthorized = !!device.authorized_at && !isRevoked
                return (
                  <tr key={device.id}>
                    <td style={S.td}>{device.name || '—'}</td>
                    <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{device.id.slice(0, 8)}</td>
                    <td style={S.td}>
                      <span style={isRevoked ? styles.badgeRevoked : isAuthorized ? styles.badgeAuthorized : styles.badgePending}>
                        {pairingStatusLabel(device.pairing_status)}
                      </span>
                    </td>
                    <td style={S.td}>{fmt(device.authorized_at)}</td>
                    <td style={S.td}>
                      {isAuthorized && role === 'admin' && (
                        <button
                          style={busy[device.id] ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
                          disabled={!!busy[device.id]}
                          onClick={() => handleRevoke(device.id)}
                        >
                          Revoke
                        </button>
                      )}
                      {isRevoked && (
                        <span style={styles.revokedLabel}>Revoked</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

const styles = {
  page: {
    maxWidth: 900,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    margin: 0,
    color: 'var(--text)',
  },
  section: {
    marginBottom: 36,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 12,
    marginTop: 0,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    background: 'var(--surface)',
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid var(--border)',
  },
  empty: {
    color: 'var(--text-secondary)',
    fontSize: 13,
    padding: '12px 0',
  },
  actions: {
    display: 'flex',
    gap: 8,
  },
  // Deliberately NOT S.errorBanner. This screen authorizes and revokes device
  // access; a failed revoke must be impossible to scroll past, so it keeps the
  // solid high-contrast band rather than the shared tinted treatment.
  errorBanner: {
    background: 'var(--warning)',
    color: '#fff',
    padding: '8px 14px',
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
  },
  badgeAuthorized: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 99,
    background: 'var(--primary)',
    color: '#fff',
    fontSize: 11,
    fontWeight: 600,
  },
  badgePending: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 99,
    background: 'var(--warning)',
    color: '#fff',
    fontSize: 11,
    fontWeight: 600,
  },
  badgeRevoked: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 99,
    background: 'var(--border)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 600,
  },
  revokedLabel: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
}
