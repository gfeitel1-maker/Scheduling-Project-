import React from 'react'
import { S } from '../../styles/shared'

export default function ConfirmRegenModal({ onConfirm, onCancel }) {
  return (
    <div style={S.overlay}>
      <div style={{ ...S.modalLg, maxWidth: 400 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Regenerate from Scratch?</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>This will delete your current schedule including all manual edits. Continue?</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={S.btnSecondary}>Cancel</button>
          <button onClick={onConfirm} style={S.btnDanger}>Yes, Regenerate</button>
        </div>
      </div>
    </div>
  )
}
