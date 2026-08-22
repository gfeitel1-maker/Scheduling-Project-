import { useEffect, useRef, useState } from 'react'
import { S, useEnterTransition } from '../styles/shared'
import treeArt from '../assets/brand/tree-full-wide-login.png'

function formatMMSS(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function LoginScreen({ campName, onSubmit, notice }) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [status, setStatus] = useState('default') // default | submitting | error | locked | connection-error
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
    let result
    try {
      result = await onSubmit(name.trim(), pin)
    } catch (err) {
      console.error('[login] onSubmit rejected:', err)
      setStatus('connection-error')
      return
    }

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

  const disabled = status === 'locked' || status === 'submitting'
  const dots = [0, 1, 2, 3]
  const heroTransition = useEnterTransition('liftFade')

  return (
    <div style={loginStyles.page}>
      <style>{
        '@keyframes shoresh-pin-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }' +
        '@media (max-width: 860px) { .shoresh-login-hero { display: none !important; } }'
      }</style>

      <div className="shoresh-login-hero" style={{ ...loginStyles.heroPanel, ...heroTransition }}>
        <img src={treeArt} alt="Shoresh tree with roots, the brand mark for camp scheduling" style={loginStyles.heroArt} />
        <div style={loginStyles.heroWordmark}>Shoresh</div>
        <div style={loginStyles.heroTagline}>From Roots to Rhythm</div>
      </div>

      <div style={loginStyles.formPanel}>
        <div style={S.authCard}>
          <div style={S.authLogoBlock}>
            <div style={S.authLogo}>Shoresh</div>
            <div style={S.authLogoSub}>{campName || 'Camp activity scheduling'}</div>
          </div>

          <div style={{ ...S.authTitle, fontSize: 19 }}>Sign in</div>

        {notice && (
          <div style={S.authNoticeBox}>
            <span>ⓘ</span>
            <span>{notice}</span>
          </div>
        )}

        {status === 'error' && (
          <div style={S.authErrorBox}>
            <span>⚠</span>
            <span>That PIN doesn't match {name.trim() || 'that name'}. Try again — you have a few attempts left.</span>
          </div>
        )}

        {status === 'connection-error' && (
          <div style={S.authErrorBox}>
            <span>⚠</span>
            <span>Couldn't reach the app right now. Check your connection and try again.</span>
          </div>
        )}

        {status !== 'locked' && status !== 'error' && status !== 'connection-error' && <div style={{ ...S.authSubtitle, marginBottom: 20 }}>Enter your name and PIN to continue.</div>}

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
    </div>
  )
}

const loginStyles = {
  page: {
    display: 'flex',
    minHeight: '100vh',
    background: 'var(--bg)',
  },
  heroPanel: {
    flex: '1 1 46%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '48px 32px',
    background: 'linear-gradient(160deg, var(--primary-dark), var(--primary))',
    boxSizing: 'border-box',
  },
  heroArt: {
    width: '100%',
    maxWidth: 420,
    height: 'auto',
    marginBottom: 20,
  },
  heroWordmark: {
    fontFamily: 'var(--font-brand-display)',
    fontWeight: 600,
    fontSize: 40,
    color: '#fff',
    letterSpacing: '-0.3px',
  },
  heroTagline: {
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    color: 'color-mix(in srgb, #fff 78%, transparent)',
    letterSpacing: '0.02em',
  },
  formPanel: {
    flex: '1 1 54%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    boxSizing: 'border-box',
  },
}
