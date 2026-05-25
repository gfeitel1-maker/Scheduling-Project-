// src/screens/AuthScreen.jsx
import { useState } from 'react'
import { supabase } from '../supabase'

export default function AuthScreen() {
  const [tab, setTab] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [campName, setCampName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  function switchTab(t) { setTab(t); setError(''); setMessage('') }

  async function handleLogin(e) {
    e.preventDefault()
    setError(''); setMessage('')
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setLoading(false)
    if (error) setError(error.message)
  }

  async function handleForgot() {
    if (!email.trim()) { setError('Enter your email above first.'); return }
    setError(''); setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim())
    setLoading(false)
    if (error) setError(error.message)
    else setMessage('Check your email for a password reset link.')
  }

  async function handleSignup(e) {
    e.preventDefault()
    setError(''); setMessage('')
    if (!campName.trim()) { setError('Camp name is required.'); return }
    setLoading(true)
    const { data, error: signUpError } = await supabase.auth.signUp({ email: email.trim(), password })
    if (signUpError) { setLoading(false); setError(signUpError.message); return }

    if (data.session) {
      const { error: campError } = await supabase
        .from('camps')
        .insert({ name: campName.trim(), owner_user_id: data.user.id })
      setLoading(false)
      if (campError) { setError(campError.message); return }
    } else {
      setLoading(false)
      setMessage('Check your email to confirm your account, then log in.')
    }
  }

  return (
    <div style={page}>
      <div style={card}>
        <div style={logoBlock}>
          <div style={logo}>Shoresh</div>
          <div style={logoSub}>Camp activity scheduling</div>
        </div>

        <div style={tabs}>
          <button style={tab === 'login' ? activeTab : inactiveTab} onClick={() => switchTab('login')}>Login</button>
          <button style={tab === 'signup' ? activeTab : inactiveTab} onClick={() => switchTab('signup')}>Sign up</button>
        </div>

        {error && <div style={errorBox}>{error}</div>}
        {message && <div style={messageBox}>{message}</div>}

        {tab === 'login' && (
          <form onSubmit={handleLogin}>
            <label style={lbl}>Email</label>
            <input style={inputStyle} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
            <label style={lbl}>Password</label>
            <input style={inputStyle} type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
            <button type="submit" style={btnPrimary} disabled={!email.trim() || !password.trim() || loading}>
              {loading ? 'Logging in…' : 'Log in'}
            </button>
            <button type="button" style={linkBtn} onClick={handleForgot}>Forgot password?</button>
          </form>
        )}

        {tab === 'signup' && (
          <form onSubmit={handleSignup}>
            <label style={lbl}>Camp name</label>
            <input style={inputStyle} type="text" placeholder="Camp Achva" value={campName} onChange={e => setCampName(e.target.value)} autoFocus />
            <label style={lbl}>Email</label>
            <input style={inputStyle} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
            <label style={lbl}>Password</label>
            <input style={inputStyle} type="password" placeholder="At least 6 characters" value={password} onChange={e => setPassword(e.target.value)} />
            <button type="submit" style={btnPrimary} disabled={!campName.trim() || !email.trim() || !password.trim() || loading}>
              {loading ? 'Creating account…' : 'Sign up'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const page = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '40px 48px', maxWidth: 440, width: '100%' }
const logoBlock = { marginBottom: 28 }
const logo = { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 28, color: 'var(--primary)', letterSpacing: '-0.5px' }
const logoSub = { fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginTop: 2 }
const tabs = { display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1.5px solid var(--border)' }
const activeTab = { background: 'none', border: 'none', borderBottom: '2px solid var(--primary)', marginBottom: -2, padding: '8px 16px', fontWeight: 700, fontSize: 13, color: 'var(--primary)', cursor: 'pointer', fontFamily: 'inherit' }
const inactiveTab = { background: 'none', border: 'none', borderBottom: '2px solid transparent', marginBottom: -2, padding: '8px 16px', fontWeight: 500, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit' }
const lbl = { fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 5, marginTop: 14, color: 'var(--text-secondary)' }
const inputStyle = { width: '100%', padding: '10px 12px', border: '1.5px solid var(--border)', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', outline: 'none', background: 'var(--bg)', boxSizing: 'border-box' }
const btnPrimary = { display: 'block', width: '100%', padding: '10px 0', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 }
const linkBtn = { background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: '8px 0 0 0', fontFamily: 'inherit', display: 'block' }
const errorBox = { background: '#fff5f5', border: '1px solid #f5c6c6', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#c0392b', marginBottom: 12 }
const messageBox = { background: '#f0faf5', border: '1px solid #a8e6c8', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#1a7a4a', marginBottom: 12 }
