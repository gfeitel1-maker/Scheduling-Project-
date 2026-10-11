import { useEffect, useRef, useState } from 'react'
import { Flag, LinkButton, FailureFlag } from '../../components/learned/parts.jsx'
import { failureCopy } from '../../components/learned/failureCopy.js'
import Collapse from '../../components/learned/Collapse.jsx'
import { meta } from '../../components/learned/learnedStyles.js'

const UNDO_MS = 8000

function Meter({ filled, total = 3 }) {
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', gap: 4, marginRight: 8, verticalAlign: 'middle' }}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: i < filled ? 'var(--primary)' : 'var(--border)',
            boxShadow: i < filled ? 'none' : '0 0 0 1px color-mix(in srgb, var(--text-secondary) 30%, transparent)',
            transition: 'background var(--motion-fast) var(--ease-out)',
          }}
        />
      ))}
    </span>
  )
}

function Editor({ row, onSave, onCancel, busy }) {
  const [choice, setChoice] = useState(row.verdict)
  return (
    <div role="group" aria-label="Change this answer" style={styles.editor} onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}>
      <div style={{ ...meta, marginBottom: 6 }}>
        {row.rowKind === 'pattern' ? 'This changes your most recent answer behind the pattern.' : 'Pick the answer Shoresh should remember.'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {row.choices.map(([verdict, label]) => (
          <button
            key={verdict}
            type="button"
            aria-pressed={choice === verdict}
            onClick={() => setChoice(verdict)}
            style={{ ...styles.chip, ...(choice === verdict ? styles.chipOn : null) }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {choice !== row.verdict && (
          <LinkButton busy={busy} busyLabel="Saving..." minWidth={64} onClick={() => onSave(choice)}>Save</LinkButton>
        )}
        <LinkButton tone="secondary" onClick={onCancel}>Cancel</LinkButton>
      </div>
    </div>
  )
}

/**
 * One learned answer or pattern. A control the viewer may not use is not rendered, never disabled.
 * `api` carries the four writes; `flash` is a result flag the parent keeps for a few seconds after a
 * reload (an edited record gets a new id, so its row remounts).
 */
export default function LearnedRow({ row, canWrite, api, flash, campChangedFlag, onLinger, onChanged, onStale, announce, nested = false }) {
  const [mode, setMode] = useState('idle')
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(false)
  const [expired, setExpired] = useState(false)
  const timer = useRef(null)
  const lingering = useRef(false)

  useEffect(() => () => {
    clearTimeout(timer.current)
    if (lingering.current) onLinger?.(row.id, false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function linger(next) {
    lingering.current = true
    onLinger?.(row.id, true)
    setMode(next)
    timer.current = setTimeout(() => {
      lingering.current = false
      setExpired(true)
      onLinger?.(row.id, false)
    }, UNDO_MS)
  }

  async function run(name, call, onOk) {
    setPending(name)
    setError(null)
    try {
      const res = await call()
      if (res?.ok === false) throw Object.assign(new Error(String(res.error ?? 'failed')), { error: res.error })
      onOk(res)
    } catch (err) {
      const c = failureCopy(err)
      setError({ message: c.message, retry: c.stale ? null : () => run(name, call, onOk) })
      if (c.stale) onStale?.()
    } finally {
      setPending(null)
    }
  }

  const isPattern = row.rowKind === 'pattern'
  const memoryId = isPattern ? row.latestId : row.id
  const forgetAnswer = () => run('forget', () => api.forget(row.id), () => {
    announce?.('Forgotten. Shoresh will ask this question again.')
    linger('forgotten')
  })
  const forgetPattern = () => run('forgetPattern', () => api.forgetPattern(row.template, row.key), () => {
    announce?.('Pattern forgotten.')
    linger('patternForgotten')
  })
  const undo = () => run('undo', () => api.change(row.id, row.verdict), (res) => {
    clearTimeout(timer.current)
    lingering.current = false
    onLinger?.(row.id, false)
    onChanged?.(res.id, 'Remembered again')
  })
  const save = (verdict) => run('change', () => api.change(memoryId, verdict), (res) => {
    announce?.('Updated.')
    onChanged?.(res.id, 'Updated')
  })
  const keep = () => run('keep', async () => {
    let last = null
    for (const id of (isPattern ? row.keepIds : [row.id])) {
      last = await api.keep(id)
      if (last?.ok === false) return last
    }
    return last
  }, (res) => {
    announce?.('Kept under your name.')
    onChanged?.(res?.id, 'Kept under your name')
  })

  const gone = mode === 'forgotten' || mode === 'patternForgotten'
  const stateFlag = mode === 'forgotten' ? { text: 'Forgotten', tone: 'neutral' }
    : mode === 'patternForgotten' ? { text: 'Pattern forgotten', tone: 'neutral' } : row.flag
  const why = mode === 'forgotten' ? 'Shoresh will ask this question again.'
    : mode === 'patternForgotten' ? 'Your earlier answers are kept. New similar questions will ask you again.' : row.why

  return (
    <li style={{ ...styles.row, ...(nested ? styles.nested : null) }} aria-busy={pending ? true : undefined}>
      <div style={styles.line1}>
        <span style={{ fontSize: nested ? 13 : 14, fontWeight: 600, color: 'var(--text)' }}>{row.title}</span>
        <span style={styles.flags}>
          <span key={stateFlag.text}><Flag tone={stateFlag.tone} title={row.neverApply?.reason}>{stateFlag.text}</Flag></span>
          {row.asRecorded && !gone && <Flag tone="neutral">as recorded</Flag>}
          {flash && !gone && <Flag tone="success">{flash}</Flag>}
          {campChangedFlag && !gone && <Flag tone="caution">Your camp changed since you answered</Flag>}
        </span>
      </div>
      {error && <FailureFlag message={error.message} onRetry={error.retry} />}
      <div style={{ ...meta, marginTop: 2 }}>{nested ? null : (gone ? '' : 'Why: ')}{why}</div>

      {isPattern && !gone && (
        <>
          {row.neverApply ? (
            <div style={{ marginTop: 4 }}>
              <Flag tone="caution" title={row.neverApply.reason}>{row.neverApply.flag}</Flag>
              <span style={{ ...meta, marginLeft: 6 }}>{row.neverApply.line}</span>
              <div style={{ ...meta, marginTop: 4 }}><Meter filled={row.meter} />{row.progress}</div>
            </div>
          ) : (
            <div style={{ ...meta, marginTop: 4 }}><Meter filled={row.meter} /><span style={{ color: 'var(--text)' }}>Progress:</span> {row.progress}</div>
          )}
          <div style={{ ...meta, marginTop: 2 }}>Confidence: {row.confidence}</div>
        </>
      )}

      {!gone && (
        <div style={styles.line5}>
          <span style={meta}>{row.who}</span>
          {canWrite && !nested && mode === 'idle' && (
            <span style={styles.actions}>
              {row.canKeep && (
                <LinkButton
                  busy={pending === 'keep'} busyLabel="Keeping..." minWidth={112} onClick={keep}
                  title="Re-record this under your name so Shoresh can count it. The answer doesn't change."
                >
                  {isPattern ? `Keep these ${row.keepIds.length} answers` : 'Keep this answer'}
                </LinkButton>
              )}
              {row.choices.length > 0 && <LinkButton onClick={() => setMode('editing')}>Change</LinkButton>}
              {isPattern
                ? <LinkButton tone="danger" onClick={() => setMode('confirm')}>Forget this pattern</LinkButton>
                : <LinkButton tone="danger" busy={pending === 'forget'} busyLabel="Forgetting..." minWidth={96} onClick={forgetAnswer}>Forget answer</LinkButton>}
            </span>
          )}
        </div>
      )}

      {mode === 'forgotten' && canWrite && !expired && (
        <div style={{ marginTop: 4 }}>
          <LinkButton busy={pending === 'undo'} busyLabel="Undoing..." minWidth={56} onClick={undo}>Undo</LinkButton>
        </div>
      )}

      {mode === 'editing' && <Editor row={row} busy={pending === 'change'} onSave={save} onCancel={() => setMode('idle')} />}

      {mode === 'confirm' && (
        <div style={styles.editor} onKeyDown={(e) => { if (e.key === 'Escape') setMode('idle') }}>
          <div style={{ fontSize: 13, color: 'var(--text)' }}>
            {`Stop using this pattern? Your ${row.supporters.length} answers behind it stay.`}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <LinkButton tone="danger" busy={pending === 'forgetPattern'} busyLabel="Forgetting..." minWidth={96} onClick={forgetPattern}>Forget pattern</LinkButton>
            <LinkButton autoFocus onClick={() => setMode('idle')}>Keep pattern</LinkButton>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Forgetting one answer only affects that question.</div>
        </div>
      )}

      {isPattern && !gone && row.supporters.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={styles.disclose}>
            {open ? `Hide the ${row.supporters.length} answers` : `Show the ${row.supporters.length} answers behind this`}
          </button>
          <Collapse open={open} ms={220}>
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: '0 0 0 14px' }}>
              {row.supporters.map((s) => (
                <LearnedRow key={s.id} row={s} nested canWrite={false} api={api} />
              ))}
            </ul>
          </Collapse>
        </div>
      )}
    </li>
  )
}

const styles = {
  row: { borderBottom: '1px solid var(--border)', padding: '12px 0', listStyle: 'none' },
  nested: { padding: '6px 0', borderBottom: 'none' },
  line1: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' },
  flags: { display: 'inline-flex', gap: 6, flexWrap: 'wrap' },
  line5: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 4 },
  actions: { display: 'inline-flex', gap: 2, flexWrap: 'wrap', marginLeft: 'auto' },
  editor: { marginTop: 8, padding: '8px 0' },
  chip: {
    padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
    fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
  },
  chipOn: { background: 'var(--primary)', border: '1px solid var(--primary)', color: 'var(--surface)' },
  disclose: { border: 'none', background: 'none', padding: '2px 0', fontFamily: 'inherit', fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' },
}
