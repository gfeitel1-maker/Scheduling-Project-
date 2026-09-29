import React, { useState } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition } from '../styles/shared'

// T306 — the answer to the question the Roots home already asks.
//
// The import lands a child's preferences with no name whenever their planner
// carries none, which is a first-class outcome rather than a failure (ADR
// 2026-09-27 §14.1a: the identity comes from the SUBMISSION, not the page). The
// attention surface then asks "we have this camper's choices but not their name —
// who is this?". Until T306 that row was inert for every role, admin included:
// nothing in the app could take the answer.
//
// WHY A DIALOG AND NOT AN INLINE FIELD. Owner decision, 2026-09-29. Two reasons
// beyond taste: the attention rail is a capped list with an overflow chip, so a row
// that grows in place shifts the rail under the reader; and the hard case — two
// unnamed sheets holding identical answers — needs a sentence of explanation that
// does not fit on a row. It stays ON the attention surface (no navigation away),
// which is what the standing ruling requires: "unattributed campers live there. One
// statement, one place to act."
//
// THE REFUSAL PATH IS A RETURN VALUE, NOT A THROW. attributeElectiveSubject
// declines an already-named camper by returning {ok:false,error} with a message
// naming the reason. A caller that only try/catches would render that refusal as
// success, which is the swallowed-failure class this repo keeps ruling against — so
// `ok` is checked explicitly and the op's own sentence is what the director reads.
export default function NameSubjectDialog({ subjectId, label, why, onCancel, onNamed }) {
  const [name, setName] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState(null)
  const enterStyle = useEnterTransition('liftFade')

  const trimmed = name.trim()

  async function save() {
    setWorking(true)
    setError(null)
    let result
    try {
      result = await localClient.attributeSubject({ subjectId, displayName: trimmed })
    } catch (err) {
      // A THROW here is the authorization and argument path, not the op's own
      // refusal: requireAuthorized throws for a role that cannot attribute.
      setError(
        /admin role required|forbidden/i.test(err?.message ?? '')
          ? 'This device’s account is not allowed to name campers.'
          : err?.message || 'That name could not be saved.'
      )
      setWorking(false)
      return
    }
    if (!result?.ok) {
      setError(result?.error || 'That name could not be saved.')
      setWorking(false)
      return
    }
    onNamed?.(result)
  }

  return (
    <div style={overlay}>
      <div style={{ ...panel, ...enterStyle }} role="dialog" aria-modal="true" aria-label="Name this camper">
        <div style={title}>Whose sheet is this?</div>

        {/* The label the import kept — its filename — which is how a director
            recognises WHICH submission they are naming. */}
        <p style={body}>
          These choices arrived as <strong>{label || 'an unnamed sheet'}</strong>. Naming the camper
          keeps their answers exactly as they are — nothing needs importing again.
        </p>

        {/* The two-identical-sheets case, in the words the attention row already
            used. This is the sentence that does not fit on a rail row. */}
        {why && <div style={context}>{why}</div>}

        <label htmlFor="name-subject-input" style={S.label}>
          Camper’s name
        </label>
        <input
          id="name-subject-input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed && !working) save()
          }}
          placeholder="First and last name"
          style={S.input}
        />

        {error && <div style={{ ...S.errorBanner, marginTop: 14, marginBottom: 0 }}>{error}</div>}

        <div style={actions}>
          <button type="button" className="press-97" onClick={onCancel} disabled={working} style={S.btnSecondary}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={working || !trimmed} style={S.btnPrimary}>
            {working ? 'Saving…' : 'Save name'}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '24px 16px',
}

const panel = {
  background: 'var(--surface-elevated)',
  borderRadius: 12,
  padding: 28,
  width: 520,
  maxWidth: '100%',
}

const title = {
  fontSize: 19,
  fontWeight: 700,
  color: 'var(--text-primary)',
  marginBottom: 10,
}

const body = {
  fontSize: 14,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
  margin: '0 0 12px',
}

const context = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--text-secondary)',
  background: 'var(--surface-sunken, rgba(0,0,0,0.04))',
  borderRadius: 8,
  padding: '10px 12px',
  marginBottom: 16,
}

const actions = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
  marginTop: 20,
}
