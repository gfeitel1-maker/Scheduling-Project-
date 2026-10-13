import { useEffect, useState } from 'react'
import AuthWatermark from '../components/AuthWatermark'
import { S, useEnterTransition } from '../styles/shared'
import { WarningTriangleIcon } from '../components/icons'
import sproutMark from '../assets/brand/sprout-mark.svg'
import IndeterminateBar from '../components/schedule/IndeterminateBar'

export default function CampBootstrapScreen({ onBack, onSubmit }) {
  const badgeEnter = useEnterTransition('liftFade')
  const [campName, setCampName] = useState('')
  const [adminName, setAdminName] = useState('')
  const [adminPin, setAdminPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Creating a camp takes about 2.5s on first run. Past 300ms a progress bar says it is working, so the
  // wait is not silent; a fast creation never shows it (design audit 2026-10-12 #8).
  const [showProgress, setShowProgress] = useState(false)
  useEffect(() => {
    if (!submitting) return
    const t = setTimeout(() => setShowProgress(true), 300)
    return () => { clearTimeout(t); setShowProgress(false) }
  }, [submitting])

  const valid = campName.trim() && adminName.trim() && /^\d{6,}$/.test(adminPin)
  // Why Create is disabled, in one line (director test 2026-10-12: it said nothing).
  const disabledReason = (() => {
    if (valid) return null
    const add = []
    if (!campName.trim()) add.push('a camp name')
    if (!adminName.trim()) add.push('your name')
    const parts = []
    if (!adminPin) add.push('a PIN of 6 or more digits')
    else if (!/^\d+$/.test(adminPin)) parts.push('use only numbers in the PIN')
    else if (adminPin.length < 6) parts.push('make the PIN 6 or more digits')
    if (add.length) parts.unshift(`add ${add.length > 1 ? `${add.slice(0, -1).join(', ')} and ${add[add.length - 1]}` : add[0]}`)
    return `To create the camp, ${parts.join(', and ')}.`
  })()

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onSubmit({ campName: campName.trim(), adminName: adminName.trim(), adminPin })
    } catch (err) {
      setError(err.message || 'Couldn’t create camp.')
      setSubmitting(false)
    }
  }

  return (
    <div style={{ ...S.authPage, position: 'relative', overflow: 'hidden' }}>
      <AuthWatermark />
      <div style={{ ...S.authCard, position: 'relative', overflow: 'hidden' }}>
        {submitting && showProgress && <IndeterminateBar label="Creating your camp" />}
        <div style={S.authBackRow}>
          <button
            style={S.authBackBtn}
            onClick={onBack}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--border)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-secondary)' }}
          >
            ← Back
          </button>
        </div>

        <img
          src={sproutMark}
          alt=""
          style={{ width: 64, height: 64, display: 'block', margin: '0 auto 14px', ...badgeEnter }}
        />

        <div style={S.authTitle}>Set up your camp</div>

        {error && <div style={S.authErrorBox}><WarningTriangleIcon style={{ marginTop: 2 }} /><span>{error}</span></div>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="bootstrap-camp-name" style={{ ...S.authLabel, marginTop: 0 }}>Camp name</label>
          <input
            id="bootstrap-camp-name"
            style={S.authField}
            type="text"
            placeholder="e.g. Camp Willowbrook"
            value={campName}
            onChange={e => setCampName(e.target.value)}
            autoFocus
          />

          <label htmlFor="bootstrap-admin-name" style={S.authLabel}>Your name</label>
          <input
            id="bootstrap-admin-name"
            style={S.authField}
            type="text"
            placeholder="e.g. Sarah Cohen"
            value={adminName}
            onChange={e => setAdminName(e.target.value)}
          />

          <label htmlFor="bootstrap-admin-pin" style={S.authLabel}>Create a PIN</label>
          <input
            id="bootstrap-admin-pin"
            style={S.authField}
            type="password"
            inputMode="numeric"
            placeholder="6 or more digits"
            aria-describedby="bootstrap-pin-hint"
            value={adminPin}
            onChange={e => setAdminPin(e.target.value)}
          />
          <div id="bootstrap-pin-hint" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>6 or more digits</div>

          <button
            type="submit"
            style={{ ...S.authBtnPrimary, opacity: valid && !submitting ? 1 : 0.4, cursor: valid && !submitting ? 'pointer' : 'not-allowed' }}
            disabled={!valid || submitting}
          >
            {submitting ? 'Creating…' : 'Create camp'}
          </button>
          {disabledReason && !submitting && (
            <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, textAlign: 'center' }}>{disabledReason}</div>
          )}
        </form>
      </div>
    </div>
  )
}
