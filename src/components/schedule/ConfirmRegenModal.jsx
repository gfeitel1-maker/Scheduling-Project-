import React from 'react'
import { S } from '../../styles/shared'

// Copy rules (CONSTITUTION.md Art. V): the director's nouns only — schedule,
// week, activity — never template/slot/candidate/route/kind. It says what will
// happen, names what is NOT affected (which is what makes an always-available
// second route feel safe), and states recovery only where it is real.
//
// "You can get this one back from Versions" is guarded: ScheduleScreen saves an
// automatic version immediately before the regenerate write. It deliberately
// stops short of "exactly as it was" — snapshot save/restore is known to drop
// merged-block and released markers, so no copy may promise a perfect restore.
export default function ConfirmRegenModal({ role, onConfirm, onCancel }) {
  const isAdmin = role === 'admin'
  return (
    <div style={S.overlay}>
      <div style={{ ...S.modalLg, maxWidth: 420 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Rebuild this schedule?</div>
        <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
          The app will propose a fresh schedule and replace the one you're looking at now, including any changes you've dragged into it.
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Anything you built on the Manual side is not touched.
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20 }}>
          You can get this one back from Versions.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={S.btnSecondary}>Cancel</button>
          <button
            onClick={onConfirm}
            disabled={!isAdmin}
            title={!isAdmin ? 'Admin only' : undefined}
            style={!isAdmin ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
          >Rebuild it</button>
        </div>
      </div>
    </div>
  )
}
