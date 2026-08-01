import { useState, useEffect } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { localClient } from '../localClient'
import { S } from '../styles/shared'

// What is left of the old Camp Setup screen: the camp's name.
//
// That screen used to be a second pathway through setup — its own list of
// steps, its own progress bar, its own idea of what "done" meant. Product
// owner, 2026-08-01: "there are currently two pathways to setting up a camp and
// only one is needed — which should be the sidebar." The sidebar is now that
// pathway, with a mark and a count per area, and the step list is gone.
//
// The explanations it carried moved to the screens they describe
// (src/components/screenIntroText.js) rather than being deleted with it — a
// sidebar row can say "Units", but not what a unit is.
//
// The name had nowhere else to live, so it lives here, under System. This is
// not a setup pathway; it is one setting.

export default function CampScreen({ campId }) {
  const [campName, setCampName] = useState('')
  const [savedName, setSavedName] = useState('')
  const [saving, setSaving] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    localClient.getCamp()
      .then(camp => {
        if (cancelled || !camp) return
        setCampName(camp.name || '')
        setSavedName(camp.name || '')
      })
      .catch(() => { if (!cancelled) setError('The camp could not be read just now.') })
    return () => { cancelled = true }
  }, [campId])

  async function saveName() {
    if (!campName.trim() || campName === savedName) return
    setSaving(true)
    setError(null)
    try {
      const token = localStorage.getItem('shoresh_token')
      const result = await localClient.write(token, 'camps', campId, 'name', campName.trim())
      if (result && result.error) throw new Error(result.error)
      setSavedName(campName.trim())
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 2000)
    } catch (err) {
      setError(describeWriteFailure(err, 'That name could not be saved.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      {error && <div style={{ ...S.errorBanner, marginBottom: 16 }}>{error}</div>}

      <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        What this camp is called. It appears above the sidebar and on anything you export.
      </p>

      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          color: 'var(--text-secondary)', whiteSpace: 'nowrap',
        }}>
          Camp name
        </div>
        <input
          value={campName}
          onChange={e => { setCampName(e.target.value); setNameSaved(false) }}
          onKeyDown={e => e.key === 'Enter' && saveName()}
          style={{
            flex: 1, padding: '7px 10px', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 14, outline: 'none',
            background: 'var(--bg)', color: 'var(--text)',
            fontFamily: 'var(--font-sans)',
          }}
          placeholder="Camp name"
        />
        <button
          onClick={saveName}
          disabled={saving || !campName.trim() || campName === savedName}
          style={{
            ...S.btnPrimary, whiteSpace: 'nowrap', fontSize: 13,
            opacity: (saving || !campName.trim() || campName === savedName) ? 0.45 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {nameSaved && (
          <div style={{ fontSize: 11, color: 'var(--success)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
            ✓ Saved
          </div>
        )}
      </div>
    </div>
  )
}
