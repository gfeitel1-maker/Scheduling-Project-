import { useEffect, useRef, useState } from 'react'
import { S } from '../styles/shared'

function formatMMSS(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function LoginScreen({ campName, onSubmit }) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [status, setStatus] = useState('default') // default | submitting | error | locked
  const [flash, setFlash] = useState(false)
  const [retryAt, setRetryAt] = useState(null)
  const [remainingMs, setRemainingMs] = useState(0)
  const pinRef = useRef(null)

  useEffect(() => {
    if (status !== 'locked' || !retryAt) return
    const tick = () => {
      const left = retryAt - Date.now()
      if (left <= 0) {
        setStatus('default')
        setPin('')
        setRetryAt(null)
        setRemainingMs(0)
        if (pinRef.current) pinRef.current.focus()
      } else {
        setRemainingMs(left)
      }
    }
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [status, retryAt])

  async function handleSubmit(e) {
    e.preventDefault()
    if (status === 'submitting' || status === 'locked') return
    setStatus('submitting')
    const result = await onSubmit(name.trim(), pin)

    if (result && result.locked) {
      setRetryAt(Date.now() + result.retryAfterMs)
      setRemainingMs(result.retryAfterMs)
      setStatus('locked')
      return
    }
    if (!result) {
      setPin('')
      setStatus('error')
      setFlash(true)
      setTimeout(() => setFlash(false), 350)
      return
    }
    // success — parent swaps to Shell once its session state updates
  }

  const disabled = status === 'locked'
  const dots = [0, 1, 2, 3]

  return (
    <div style={S.authPage}>
      <style>{'@keyframes shoresh-pin-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }'}</style>
      <div style={S.authCard}>
        <div style={S.authLogoBlock}>
          <div style={S.authLogo}>Shoresh</div>
          <div style={S.authLogoSub}>{campName || 'Camp activity scheduling'}</div>
        </div>

        <div style={{ ...S.authTitle, fontSize: 19 }}>Sign in</div>

        {status === 'error' && (
          <div style={S.authErrorBox}>
            <span>⚠</span>
            <span>That PIN doesn't match {name.trim() || 'that name'}. Try again — you have a few attempts left.</span>
          </div>
        )}

        {status !== 'locked' && <div style={{ ...S.authSubtitle, marginBottom: 20 }}>Enter your name and PIN to continue.</div>}

        <form onSubmit={handleSubmit}>
          <label style={{ ...S.authLabel, marginTop: 0 }}>Name</label>
          <input
            style={{ ...S.authField, opacity: disabled ? 0.6 : 1 }}
            type="text"
            placeholder="e.g. Sarah Cohen"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={disabled}
            autoFocus
          />

          <label style={S.authLabel}>PIN</label>
          <input
            ref={pinRef}
            style={{ ...S.authField, opacity: disabled ? 0.6 : 1 }}
            type="password"
            inputMode="numeric"
            placeholder="••••"
            value={pin}
            onChange={e => setPin(e.target.value)}
            disabled={disabled}
          />

          {status === 'error' && (
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', margin: '18px 0 6px' }}>
              {dots.map(i => (
                <div
                  key={i}
                  style={{
                    width: 14, height: 14, borderRadius: '50%',
                    border: '1.5px solid var(--warning)',
                    background: 'var(--warning)',
                    animation: flash ? 'shoresh-pin-shake 0.35s' : 'none',
                  }}
                />
              ))}
            </div>
          )}

          {status === 'locked' && (
            <div style={S.authLockoutBox}>
              <div style={{ fontSize: 20, marginBottom: 8 }}>⏱</div>
              <div style={S.authLockoutTitle}>Just a moment</div>
              <div style={S.authLockoutDesc}>
                Too many attempts. For security, sign-in is paused briefly. It'll unlock automatically —
                no need to do anything.
              </div>
              <div style={S.authLockoutTimer}>{formatMMSS(remainingMs)}</div>
            </div>
          )}

          <button
            type="submit"
            style={{
              ...S.authBtnPrimary,
              opacity: disabled ? 0.4 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
            disabled={disabled}
          >
            {status === 'submitting' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
