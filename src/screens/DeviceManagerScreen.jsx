import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition } from '../styles/shared'
import { deriveDeviceRowState } from './deviceRowState'

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

// T322 S3b — the per-peer purge badge copy. The four never-claims from the
// scoping note (docs/work/specs/2026-10-01-t233-s3-per-peer-erasure-state-ui-
// design.md §4) are load-bearing here, not decoration:
//   1. never "deleted"/"gone"/"wiped" — the record is *suppressed*, not destroyed;
//   2. never cryptographic/physical — this is guess-resistant logical erasure;
//   3. never certainty about a peer it cannot hear from — UNKNOWN means unknown;
//   4. never a count it cannot back — only states the self-report supports.
const ERASURE_COPY = {
  LOGICALLY_ERASED: {
    label: 'Hidden',
    // Attributed on purpose: this is the peer's own self-report over the
    // authenticated channel, not something this device independently verified
    // (schema.sql's peer_tombstone_reports note — "advisory display data only").
    // Stating it as unattributed fact would overclaim in exactly the honesty-
    // sensitive way the never-claims guard against.
    title:
      'This device reports that it has applied the purge: the camper is hidden ' +
      'from view there. The record is suppressed, not deleted — its raw data may ' +
      'remain in sync history. This is guess-resistant logical erasure, not ' +
      'cryptographic.',
  },
  UNKNOWN: {
    label: 'Not confirmed',
    title:
      'This device has not reported applying the purge. It may be offline or not ' +
      'yet caught up — its state is unknown, never silently treated as erased.',
  },
  // A device that is not currently in the camp (pending, denied, or revoked)
  // cannot report over the authenticated channel, so a "not yet caught up"
  // reading would be misleading — a revoked device will NEVER catch up unless
  // re-approved. Purge status is tracked only for active peers (Red Hat MEDIUM).
  NOT_TRACKED: {
    label: '—',
    title: 'Purge status is tracked only for devices currently in the camp.',
  },
}

export default function DeviceManagerScreen({ campId, role, deviceMode }) {
  // T86, narrowed by the T332 fold-in (Code Reviewer HIGH): `denyDevice` still writes straight
  // to this device's local, never-synced `devices` table with no distributed backstop, and the
  // "Add a device" listening window is inherently Host-only (there is no code to show on a
  // Client). Both of THOSE stay gated on `canManage`. `revokeDevice`/the admin-only Revoke and
  // Confirm-removal actions below are NOT gated on it any more — their backend gate
  // (authorize()'s role check) has been mode-agnostic since T332's base change, so a client-mode
  // admin gets the identical affordance a host-mode admin does; see deriveDeviceRowState.js.
  const canManage = deviceMode !== 'client'
  const [pending, setPending] = useState([])
  const [allDevices, setAllDevices] = useState([])
  // T322 S3b — per-peer erasure state for the purge-tombstone badge. Read-only,
  // shape { hasErasure, states: { [deviceId]: 'LOGICALLY_ERASED' | 'UNKNOWN' },
  // localDeviceId }. The column appears only once a purge has actually happened
  // (hasErasure), so the common no-purge camp sees no new noise.
  const [erasure, setErasure] = useState({ hasErasure: false, states: {}, localDeviceId: null })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState({})
  // Add a device (docs/adr/2026-09-08-libp2p-join-flow.md §4). Only meaningful
  // on the Host — a Client has no code to show and cannot approve anyone.
  const [joinInfo, setJoinInfo] = useState(null)
  const [joinError, setJoinError] = useState(null)

  useEffect(() => { load() }, [campId])

  useEffect(() => {
    if (!canManage) return
    localClient.getJoinCode()
      .then(setJoinInfo)
      .catch((err) => setJoinError(err?.message || "Couldn't read this camp's code."))
  }, [canManage])

  async function toggleJoinWindow(next) {
    setJoinError(null)
    try {
      // T286 — the code is now minted fresh per window-open, so the reply
      // must be merged in full (not just `open`) or the screen would keep
      // showing whatever code was fetched at mount (stale, and no longer the
      // one the Host is actually advertising).
      const result = await localClient.setJoinWindow(next)
      setJoinInfo((info) => (info ? { ...info, ...result } : info))
    } catch (err) {
      setJoinError(err?.message || "Couldn't change whether new devices can join.")
    }
  }

  useEffect(() => {
    const interval = setInterval(() => { load() }, 5000)
    return () => clearInterval(interval)
  }, [])

  async function load() {
    try {
      const [p, d, e] = await Promise.all([
        localClient.listPendingPairingRequests(),
        localClient.listDevices(),
        localClient.listPeerErasureState(),
      ])
      setPending(p || [])
      setAllDevices(d || [])
      setErasure(e || { hasErasure: false, states: {}, localDeviceId: null })
    } catch (err) {
      setError(err?.message || "Couldn't load your devices — check your connection and refresh.")
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

  // Amendment 2026-10-03b — the manual recovery trigger for a removal this device applied with
  // no prior knowledge of the target's authority. Advisory UI only; the server-side guard in
  // clearUncorroboratedRevocation is what actually enforces this cannot clear a genuinely
  // confirmed removal.
  async function handleRecoverUncorroborated(deviceId) {
    setBusy((b) => ({ ...b, [deviceId]: true }))
    try {
      await localClient.clearUncorroboratedRevocation(deviceId)
      load()
    } catch (err) {
      setError(err?.message || 'Failed to undo this removal')
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

  // T322 S3b — the read-only per-peer purge badge for one device row. The local
  // device is not a propagation target and never self-reports, so it shows a
  // plain "This device" rather than a fabricated state (never-claim #4). A device
  // that is not an active peer (pending/denied/revoked) cannot report, so it
  // reads "—" rather than an "unknown — may catch up" copy that would mislead for
  // a revoked device (Red Hat MEDIUM). An active peer with no verdict yet falls
  // back to UNKNOWN, never silently erased.
  function renderErasureCell(device) {
    if (device.id === erasure.localDeviceId) {
      return <span style={styles.erasureLocal}>This device</span>
    }
    const inFleet = !!device.authorized_at && !device.revoked_at
    if (!inFleet) {
      return <span style={styles.erasureLocal} title={ERASURE_COPY.NOT_TRACKED.title}>{ERASURE_COPY.NOT_TRACKED.label}</span>
    }
    const state = erasure.states[device.id] ?? 'UNKNOWN'
    const copy = ERASURE_COPY[state] ?? ERASURE_COPY.UNKNOWN
    return (
      <span
        style={state === 'LOGICALLY_ERASED' ? styles.badgeErased : styles.badgeErasureUnknown}
        title={copy.title}
      >
        {copy.label}
      </span>
    )
  }

  const enterStyle = useEnterTransition('liftFade')

  return (
    <div style={{ ...styles.page, ...enterStyle }}>
      <div style={styles.header}>
        <h1 style={styles.title}>Device Manager</h1>
      </div>

      {error && (
        <div style={styles.errorBanner}>{error}</div>
      )}

      {canManage && joinInfo && (
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Add a device</h2>
          {joinError && <div style={styles.errorBanner}>{joinError}</div>}
          {joinInfo.open ? (
            <>
              <div style={styles.joinInstruction}>
                On the new device, choose <strong>Join a camp</strong> and enter this code.
              </div>
              <div style={styles.joinCode}>{joinInfo.formatted}</div>
              {/* The code is the same every time, so a director can write it
                  down once. What changes is whether this computer is listening
                  — which is what the button below controls, and why the code
                  is shown alongside it rather than on its own screen. */}
              <div style={styles.joinNote}>
                This computer is listening for new devices. Their request will appear below for you to approve.
              </div>
              <button style={S.btnSecondary} onClick={() => toggleJoinWindow(false)}>
                Stop adding devices
              </button>
            </>
          ) : (
            <>
              <div style={styles.joinInstruction}>
                Setting up {joinInfo.campName} on a second computer or tablet? Start here, then enter the code it shows you on the new device.
              </div>
              <button className="press-97" style={S.btnPrimary} onClick={() => toggleJoinWindow(true)}>
                Add a device
              </button>
            </>
          )}
        </section>
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
                    {canManage ? (
                      <div style={styles.actions}>
                        <button className="press-97"
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
                    ) : role === 'admin' ? (
                      // Tester finding (T332 fold-in, round 3): a client-mode admin has full,
                      // unconditional Revoke/Confirm-removal in the table below, so a blanket
                      // "View only from this device — use the main computer" here would
                      // contradict that on the same screen. Pairing approval specifically IS
                      // still Host-only (denyDevice has no distributed backstop), so this says
                      // nothing rather than claim something false — never a message implying
                      // this device can manage nothing.
                      null
                    ) : (
                      <span style={styles.revokedLabel}>View only from this device</span>
                    )}
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
          <div style={styles.empty}>No devices connected yet.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={S.th}>Device Name</th>
                <th style={S.th}>ID</th>
                <th style={S.th}>Status</th>
                {erasure.hasErasure && <th style={S.th}>Purge status</th>}
                <th style={S.th}>Authorized At</th>
                <th style={S.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {allDevices.map((device) => {
                const { removalPending, isRevoked, isAuthorized, canVote, canRecoverUncorroborated, detailText } = deriveDeviceRowState(device, { role })
                return (
                  <tr key={device.id}>
                    <td style={S.td}>{device.name || '—'}</td>
                    <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{device.id.slice(0, 8)}</td>
                    <td style={S.td}>
                      {removalPending ? (
                        <span style={styles.badgeRemovalPending}>Removal pending</span>
                      ) : (
                        <span style={isRevoked ? styles.badgeRevoked : isAuthorized ? styles.badgeAuthorized : styles.badgePending}>
                          {pairingStatusLabel(device.pairing_status)}
                        </span>
                      )}
                      {removalPending && (
                        <div style={styles.removalPendingDetail}>{detailText}</div>
                      )}
                    </td>
                    {erasure.hasErasure && (
                      <td style={S.td}>{renderErasureCell(device)}</td>
                    )}
                    <td style={S.td}>{fmt(device.authorized_at)}</td>
                    <td style={S.td}>
                      {/* T332 fold-in (Red Hat LOW — self-exclusion): never render the plain
                          Revoke button for the viewer's own device row, symmetric with how
                          canVote already excludes self — a director should never be able to
                          click into the server-side "cannot remove your own device" refusal. */}
                      {isAuthorized && role === 'admin' && !device.isSelf && (
                        <button
                          style={busy[device.id] ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
                          disabled={!!busy[device.id]}
                          onClick={() => handleRevoke(device.id)}
                        >
                          Revoke
                        </button>
                      )}
                      {canVote && (
                        <button
                          style={busy[device.id] ? { ...S.btnSecondary, ...S.buttonDisabled } : S.btnSecondary}
                          disabled={!!busy[device.id]}
                          onClick={() => handleRevoke(device.id)}
                        >
                          Confirm removal
                        </button>
                      )}
                      {removalPending && device.hasVoted && (
                        <span style={styles.revokedLabel}>You confirmed this removal</span>
                      )}
                      {isRevoked && (
                        <span style={styles.revokedLabel}>Revoked</span>
                      )}
                      {canRecoverUncorroborated && (
                        <div style={styles.recoverBlock}>
                          <div style={styles.recoverNote}>
                            This device was removed before the other directors could confirm it.
                          </div>
                          <button
                            style={busy[device.id] ? { ...S.btnSecondary, ...S.buttonDisabled } : S.btnSecondary}
                            disabled={!!busy[device.id]}
                            onClick={() => handleRecoverUncorroborated(device.id)}
                          >
                            Undo removal
                          </button>
                        </div>
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
  joinInstruction: {
    fontSize: 13.5,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
    marginBottom: 14,
    maxWidth: 560,
  },
  // Large, monospaced and widely tracked: this is read off a screen from a
  // few feet away and typed on another device, which is the whole job.
  joinCode: {
    fontFamily: 'var(--font-mono)',
    fontSize: 34,
    fontWeight: 700,
    letterSpacing: '0.14em',
    color: 'var(--text)',
    marginBottom: 14,
  },
  joinNote: {
    fontSize: 12.5,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
    marginBottom: 14,
    maxWidth: 560,
  },
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
    ...S.chip('var(--primary)', true, { padding: '2px 8px', borderRadius: 99, fontSize: 11, border: 'none', cursor: 'default' }),
  },
  badgePending: {
    display: 'inline-block',
    ...S.chip('var(--warning)', true, { padding: '2px 8px', borderRadius: 99, fontSize: 11, border: 'none', cursor: 'default' }),
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
  // T332 fold-in (Designer spec) — amber, distinct from Active (blue, badgeAuthorized) and
  // Removed (gray, badgeRevoked). Deliberately --accent, not --warning/--danger: this is not an
  // error or a threat, it's a removal a director cast a vote toward that has not taken effect
  // yet — the SAME chip pattern every other badge on this screen uses, just a different token.
  badgeRemovalPending: {
    display: 'inline-block',
    ...S.chip('var(--accent)', true, { padding: '2px 8px', borderRadius: 99, fontSize: 11, border: 'none', cursor: 'default' }),
  },
  removalPendingDetail: {
    fontSize: 11.5,
    color: 'var(--text-secondary)',
    marginTop: 4,
  },
  revokedLabel: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  // Amendment 2026-10-03b — advisory recovery affordance, secondary to the plain "Revoked"
  // label it sits below. The note is deliberately honest about the uncertainty (removed before
  // confirmation, not "this is definitely wrong") — the server-side guard, not this copy, is
  // what makes clicking it safe either way.
  recoverBlock: {
    marginTop: 6,
  },
  recoverNote: {
    fontSize: 11.5,
    color: 'var(--text-secondary)',
    marginBottom: 4,
    maxWidth: 220,
  },
  // T322 S3b. Deliberately muted, NOT a success-green chip: "Hidden" states a
  // confirmed-applied suppression, not that anything is safe, complete, or
  // deleted. A neutral chip keeps it a quiet flag, never a reassurance.
  badgeErased: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 99,
    background: 'var(--border)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'default',
  },
  // Warning-tinted, because "Not confirmed" is the state a director should not
  // read past — an unreached peer has not applied the purge.
  badgeErasureUnknown: {
    display: 'inline-block',
    ...S.chip('var(--warning)', true, { padding: '2px 8px', borderRadius: 99, fontSize: 11, border: 'none', cursor: 'default' }),
  },
  erasureLocal: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
}
