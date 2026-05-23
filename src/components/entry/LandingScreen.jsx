import { useState } from 'react'
import { supabase } from '../../supabase'

// screen: 'open' | 'notFound' | 'create' | 'confirm'
export default function LandingScreen({ onEnter }) {
  const [screen, setScreen] = useState('open')
  const [name, setName] = useState('')
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [confirmUrl, setConfirmUrl] = useState('')
  const [nameError, setNameError] = useState('')
  const [createdCampId, setCreatedCampId] = useState(null)

  async function handleOpen() {
    if (!name.trim()) return
    setSearching(true)
    setNameError('')
    const { data, error } = await supabase
      .from('camps')
      .select('id')
      .ilike('name', name.trim())
      .maybeSingle()
    setSearching(false)
    if (error) {
      setNameError('Connection failed. Please try again.')
      return
    }
    if (data) {
      onEnter(data.id)
    } else {
      setScreen('notFound')
    }
  }

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    setNameError('')
    const { data, error } = await supabase
      .from('camps')
      .insert({ name: name.trim() })
      .select('id')
      .single()
    setCreating(false)
    if (error) {
      if (error.code === '23505') {
        setNameError('A camp with this name already exists. Try opening it instead.')
      } else {
        setNameError('Failed to create camp. Check your connection and try again.')
      }
      return
    }
    const url = `${window.location.origin}${window.location.pathname}?camp=${data.id}`
    setConfirmUrl(url)
    setCreatedCampId(data.id)
    setScreen('confirm')
  }

  return (
    <div style={page}>
      <div style={card}>
        <div style={logoBlock}>
          <div style={logo}>Shoresh</div>
          <div style={logoSub}>Camp activity scheduling</div>
        </div>

        {screen === 'open' && (
          <OpenScreen
            name={name}
            setName={setName}
            searching={searching}
            onOpen={handleOpen}
            onCreateNew={() => { setScreen('create') }}
          />
        )}

        {screen === 'notFound' && (
          <NotFoundScreen
            name={name}
            onCreate={handleCreate}
            creating={creating}
            onBack={() => setScreen('open')}
            nameError={nameError}
          />
        )}

        {screen === 'create' && (
          <CreateScreen
            name={name}
            setName={setName}
            onCreate={handleCreate}
            creating={creating}
            onBack={() => setScreen('open')}
            nameError={nameError}
          />
        )}

        {screen === 'confirm' && (
          <ConfirmScreen
            url={confirmUrl}
            campName={name.trim()}
            onProceed={() => onEnter(createdCampId)}
          />
        )}
      </div>
    </div>
  )
}

function OpenScreen({ name, setName, searching, onOpen, onCreateNew }) {
  return (
    <div>
      <div style={heading}>Open your camp</div>
      <div style={bodyText}>Enter your camp name to continue.</div>
      <label style={lbl}>Camp name</label>
      <input
        style={inputStyle}
        placeholder="e.g. Camp Achva"
        value={name}
        autoFocus
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && name.trim() && onOpen()}
      />
      <button
        style={{ ...btnPrimary, ...((!name.trim() || searching) ? { background: '#cce9ec', cursor: 'default' } : {}) }}
        onClick={onOpen}
        disabled={!name.trim() || searching}
      >
        {searching ? 'Searching…' : 'Open camp'}
      </button>
      <div style={divider} />
      <div style={hintRow}>
        <span style={hintText}>New to Shoresh?</span>
        <button style={linkBtn} onClick={onCreateNew}>Create a new camp</button>
      </div>
    </div>
  )
}

function NotFoundScreen({ name, onCreate, creating, onBack, nameError }) {
  return (
    <div>
      <div style={{ ...iconCircle, background: '#fff0f0', color: '#F0585D' }}>✕</div>
      <div style={heading}>Camp not found</div>
      <div style={bodyText}>
        No camp named <strong>"{name.trim()}"</strong> exists yet. Would you like to create it?
      </div>
      {nameError && <div style={errorMsg}>{nameError}</div>}
      <button
        style={btnPrimary}
        onClick={onCreate}
        disabled={creating}
      >
        {creating ? 'Creating…' : `Create "${name.trim()}"`}
      </button>
      <button style={{ ...btnSecondary, marginTop: 8 }} onClick={onBack}>← Try a different name</button>
    </div>
  )
}

function CreateScreen({ name, setName, onCreate, creating, onBack, nameError }) {
  return (
    <div>
      <button style={backBtn} onClick={onBack}>← Back</button>
      <div style={heading}>Create a new camp</div>
      <div style={bodyText}>Give your camp a name. Anyone who knows this name can access the schedule.</div>
      <label style={lbl}>Camp name</label>
      <input
        style={inputStyle}
        placeholder="e.g. Camp Achva"
        value={name}
        autoFocus
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && name.trim() && onCreate()}
      />
      {nameError && <div style={errorMsg}>{nameError}</div>}
      <button
        style={{ ...btnPrimary, ...((!name.trim() || creating) ? { background: '#cce9ec', cursor: 'default' } : {}) }}
        onClick={onCreate}
        disabled={!name.trim() || creating}
      >
        {creating ? 'Creating…' : 'Create camp'}
      </button>
    </div>
  )
}

function ConfirmScreen({ url, campName, onProceed }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div>
      <div style={{ ...iconCircle, background: '#e6f7f8', color: '#00ADBB' }}>✓</div>
      <div style={heading}>{campName} is ready</div>
      <div style={bodyText}>
        Bookmark this link — it's how you and your team will access this camp on any device.
      </div>
      <div style={urlBox}>
        <span style={urlText}>{url}</span>
        <button
          style={{ ...copyBtn, ...(copied ? { background: '#00AA59' } : {}) }}
          onClick={copy}
        >
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
      <button style={{ ...btnPrimary, marginTop: 12 }} onClick={onProceed}>
        Open {campName} →
      </button>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const page = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '40px 48px', maxWidth: 480, width: '100%' }
const logoBlock = { marginBottom: 32 }
const logo = { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 28, color: 'var(--primary)', letterSpacing: '-0.5px' }
const logoSub = { fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginTop: 2 }
const heading = { fontWeight: 600, fontSize: 15, marginBottom: 6 }
const bodyText = { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }
const lbl = { fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 6 }
const inputStyle = { width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', marginBottom: 12, outline: 'none', background: 'var(--bg)' }
const btnPrimary = { display: 'block', width: '100%', padding: '10px 0', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 0 }
const btnSecondary = { display: 'block', width: '100%', padding: '10px 0', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 500, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }
const backBtn = { background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: 0, marginBottom: 20, fontFamily: 'inherit' }
const divider = { height: 1, background: 'var(--border)', margin: '20px 0' }
const hintRow = { textAlign: 'center', fontSize: 12 }
const hintText = { color: 'var(--text-secondary)', marginRight: 4 }
const linkBtn = { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }
const iconCircle = { width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16, fontSize: 18 }
const errorMsg = { fontSize: 12, color: 'var(--warning)', marginBottom: 10, padding: '8px 10px', background: '#fff5f5', borderRadius: 5, border: '1px solid #f5c6c6' }
const urlBox = { background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }
const urlText = { flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--primary)', wordBreak: 'break-all' }
const copyBtn = { flexShrink: 0, background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 4, padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }
