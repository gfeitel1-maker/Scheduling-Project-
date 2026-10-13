import { useState } from 'react'
import { localClient } from '../../localClient'

const linkButton = {
  display: 'block', width: '100%', textAlign: 'left',
  padding: '4px 0', border: 'none', background: 'none',
  fontSize: 11, fontFamily: 'var(--font-mono)', cursor: 'pointer',
  color: 'var(--text-secondary)',
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function savedText(result) {
  const c = result.counts ?? {}
  const parts = [plural(c.groups ?? 0, 'group', 'groups'), plural(c.activities ?? 0, 'activity', 'activities'), plural(c.locations ?? 0, 'location', 'locations')]
  return `Saved ${result.fileName} — ${parts.join(', ')}. Keep it somewhere private.`
}

// Save whole camp: confirm (the file is unprotected; campers are left out), save in place, then say what was saved.
// Text states only, so reduced motion loses nothing.
export default function SaveCampControl() {
  const [step, setStep] = useState('idle')
  const [message, setMessage] = useState(null)

  async function handleSave() {
    setStep('saving')
    setMessage(null)
    try {
      const result = await localClient.saveCampFile()
      if (result?.ok) setMessage({ ok: true, text: savedText(result) })
      else if (result?.reason !== 'canceled') setMessage({ ok: false, text: result?.message || "The camp couldn't be saved. Try again." })
    } catch {
      setMessage({ ok: false, text: "The camp couldn't be saved. Try again." })
    }
    setStep('idle')
  }

  return (
    <div>
      <button type="button" onClick={() => { setMessage(null); setStep('confirm') }} disabled={step !== 'idle'} style={linkButton}>
        Save whole camp
      </button>
      {step === 'confirm' && (
        <div role="alertdialog" aria-label="Confirm save whole camp" style={{ fontSize: 11, margin: '2px 0 6px', color: 'var(--text)' }}>
          <div>This file isn't protected — keep it somewhere private.</div>
          <div>Camper lists and elective choices aren't included; import them again after opening.</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
            <button type="button" onClick={handleSave} style={{ ...linkButton, width: 'auto', color: 'var(--primary)' }}>Choose where to save</button>
            <button type="button" onClick={() => setStep('idle')} style={{ ...linkButton, width: 'auto' }}>Cancel</button>
          </div>
        </div>
      )}
      {step === 'saving' && <div role="status" style={{ fontSize: 11, margin: '2px 0 6px', color: 'var(--text-secondary)' }}>Saving your camp…</div>}
      {message && (
        <div role={message.ok ? 'status' : 'alert'} style={{
          fontSize: 11, margin: '2px 0 6px',
          color: message.ok ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)',
        }}>
          {message.text}
        </div>
      )}
    </div>
  )
}
