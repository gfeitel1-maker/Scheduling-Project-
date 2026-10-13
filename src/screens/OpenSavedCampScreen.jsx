import { useState } from 'react'
import AuthWatermark from '../components/AuthWatermark'
import { S, useEnterTransition } from '../styles/shared'
import { WarningTriangleIcon } from '../components/icons'
import IndeterminateBar from '../components/schedule/IndeterminateBar'
import CampBootstrapScreen from './CampBootstrapScreen'
import { campFileFailureText, summarizeCounts } from './campFileMessages'

const DONE_HOLD_MS = 600

function Card({ children, busy }) {
  const enter = useEnterTransition('liftFade')
  return (
    <div style={{ ...S.authPage, position: 'relative', overflow: 'hidden' }}>
      <AuthWatermark />
      <div style={{ ...S.authCard, position: 'relative', overflow: 'hidden', ...enter }}>
        {busy && <IndeterminateBar label={busy} />}
        {children}
      </div>
    </div>
  )
}

// Said in place with a sentence the director can act on. "Try another file" only while nothing was written;
// "Start over" once a camp was made for the file.
export function CampFileFailurePanel({ reason, fileName, canTryAnother, onTryAnother, onStartOver }) {
  const [starting, setStarting] = useState(false)
  const [startOverFailed, setStartOverFailed] = useState(false)

  async function handleStartOver() {
    setStarting(true)
    setStartOverFailed(false)
    let result
    try { result = await onStartOver() } catch { result = { ok: false } }
    if (result?.ok === false) {
      setStartOverFailed(true)
      setStarting(false)
    }
  }

  return (
    <div>
      <div role="alert" style={S.authErrorBox}>
        <WarningTriangleIcon style={{ marginTop: 2 }} />
        <span>
          {fileName ? <strong>{fileName}: </strong> : null}
          {campFileFailureText(reason)}
        </span>
      </div>
      {startOverFailed && (
        <div role="alert" style={{ ...S.authErrorBox, marginTop: 8 }}>
          <WarningTriangleIcon style={{ marginTop: 2 }} />
          <span>Couldn't start over. Quit Shoresh, open it again, and choose Start over.</span>
        </div>
      )}
      {canTryAnother && <button type="button" style={S.authBtnPrimary} onClick={onTryAnother}>Try another file</button>}
      {onStartOver && (
        <button type="button" style={canTryAnother ? { ...S.authLinkBtn, display: 'block', margin: '14px auto 0' } : S.authBtnPrimary} disabled={starting} onClick={handleStartOver}>
          {starting ? 'Starting over…' : 'Start over'}
        </button>
      )}
    </div>
  )
}

function ProgressList({ stage }) {
  const rows = [
    ['Checking the file', true],
    ['Loading your camp', stage === 'done'],
    ['Done', stage === 'done'],
  ]
  return (
    <ol aria-live="polite" style={{ listStyle: 'none', padding: 0, margin: '16px 0 0', fontSize: 14 }}>
      {rows.map(([label, complete], i) => {
        const active = !complete && (i === 0 || rows[i - 1][1])
        return (
          <li key={label} style={{ padding: '6px 0', color: complete ? 'var(--text)' : active ? 'var(--text)' : 'var(--text-secondary)', fontWeight: active ? 600 : 400 }}>
            <span aria-hidden="true" style={{ display: 'inline-block', width: 20 }}>{complete ? '✓' : active ? '…' : ''}</span>
            {label}
          </li>
        )
      })}
    </ol>
  )
}

export default function OpenSavedCampScreen({ onBack, onPick, onOpen, onFinish, onStartOver, holdDoneMs = DONE_HOLD_MS }) {
  const [step, setStep] = useState('pick') // pick | form | working | failed
  const [picked, setPicked] = useState(null)
  const [choosing, setChoosing] = useState(false)
  const [failure, setFailure] = useState(null)
  const [stage, setStage] = useState('loading')

  async function handlePick() {
    setChoosing(true)
    let result
    try { result = await onPick() } catch { result = { ok: false, reason: 'unreadable' } }
    setChoosing(false)
    if (result?.ok) { setPicked(result); setStep('form'); return }
    if (result?.reason === 'canceled') return
    setFailure({ reason: result?.reason, fileName: result?.fileName, written: false })
    setStep('failed')
  }

  async function handleOpen(values) {
    setStep('working')
    setStage('loading')
    let result
    try { result = await onOpen(values) } catch (err) { result = { ok: false, reason: 'load_incomplete', detail: { message: err?.message } } }
    if (result?.ok) {
      setStage('done')
      await new Promise((r) => setTimeout(r, holdDoneMs))
      onFinish()
      return
    }
    setFailure({ reason: result?.reason, fileName: picked?.fileName, written: true })
    setStep('failed')
  }

  if (step === 'form') {
    return (
      <CampBootstrapScreen
        onBack={() => { setPicked(null); setStep('pick') }}
        onSubmit={handleOpen}
        fromFile={{ fileName: picked.fileName, campName: picked.campName, summary: summarizeCounts(picked.counts) }}
      />
    )
  }

  if (step === 'working') {
    return (
      <Card busy="Opening your saved camp">
        <div style={S.authTitle}>Opening your camp</div>
        <ProgressList stage={stage} />
      </Card>
    )
  }

  if (step === 'failed') {
    return (
      <Card>
        <div style={S.authTitle}>Couldn't open that camp</div>
        <CampFileFailurePanel
          reason={failure?.reason}
          fileName={failure?.fileName}
          canTryAnother={!failure?.written}
          onTryAnother={() => { setFailure(null); setStep('pick') }}
          onStartOver={failure?.written ? onStartOver : null}
        />
      </Card>
    )
  }

  return (
    <Card>
      <div style={S.authBackRow}>
        <button type="button" style={S.authBackBtn} onClick={onBack}>← Back</button>
      </div>
      <div style={S.authTitle}>Open a saved camp</div>
      <div style={{ ...S.authSubtitle, textAlign: 'center' }}>
        Choose a camp file made with Save whole camp. It ends in .shoresh-camp. Shoresh checks it before it creates anything.
      </div>
      <button type="button" style={{ ...S.authBtnPrimary, opacity: choosing ? 0.4 : 1 }} disabled={choosing} onClick={handlePick}>
        Choose a camp file
      </button>
    </Card>
  )
}
