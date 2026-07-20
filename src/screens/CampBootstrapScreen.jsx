import { useState } from 'react'
import { S } from '../styles/shared'

export default function CampBootstrapScreen({ onBack, onSubmit }) {
  const [campName, setCampName] = useState('')
  const [adminName, setAdminName] = useState('')
  const [adminPin, setAdminPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const valid = campName.trim() && adminName.trim() && adminPin.length >= 4

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onSubmit({ campName: campName.trim(), adminName: adminName.trim(), adminPin })
    } catch (err) {
      setError(err.message || 'Something went wrong. Try again.')
      setSubmitting(false)
    }
  }

  return (
    <div style={S.authPage}>
      <div style={S.authCard}>
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

        <div style={S.authRolePill}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)' }} />
          HOSTING ON THIS DEVICE
        </div>

        <div style={S.authTitle}>Set up your camp</div>
        <div style={S.authSubtitle}>
          This is a one-time setup. You'll create the first admin account — you can add more staff
          once you're in.
        </div>

        {error && <div style={S.authErrorBox}><span>⚠</span><span>{error}</span></div>}

        <form onSubmit={handleSubmit}>
          <label style={{ ...S.authLabel, marginTop: 0 }}>Camp name</label>
          <input
            style={S.authField}
            type="text"
            placeholder="Camp Achva"
            value={campName}
            onChange={e => setCampName(e.target.value)}
            autoFocus
          />

          <label style={S.authLabel}>Your name</label>
          <input
            style={S.authField}
            type="text"
            placeholder="e.g. Sarah Cohen"
            value={adminName}
            onChange={e => setAdminName(e.target.value)}
          />

          <label style={S.authLabel}>Create a PIN</label>
          <input
            style={S.authField}
            type="password"
            inputMode="numeric"
            placeholder="4 or more digits"
            value={adminPin}
            onChange={e => setAdminPin(e.target.value)}
          />
          <div style={S.authHint}>
            You'll use this PIN to log in on this and any connected device. Choose something you'll
            remember — staff PINs don't need to be complex.
          </div>

          <button
            type="submit"
            style={{ ...S.authBtnPrimary, opacity: valid && !submitting ? 1 : 0.4, cursor: valid && !submitting ? 'pointer' : 'not-allowed' }}
            disabled={!valid || submitting}
          >
            {submitting ? 'Creating…' : 'Create camp & continue →'}
          </button>
        </form>
      </div>
    </div>
  )
}
