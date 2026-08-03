import { S } from '../../styles/shared'

export default function ExclusionConfirmDialog({ entityName, weekName, slotCount, onCancel, onConfirm }) {
  return (
    <div style={S.overlay}>
      <div style={{ ...S.modalSm, maxWidth: 440 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>
          Turn off "{entityName}" for {weekName}?
        </div>
        <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 8 }}>
          "{entityName}" is used in {slotCount} {slotCount === 1 ? 'place' : 'places'} in {weekName}'s schedule. Turning it off empties those cells — everything else in the week stays exactly where it is.
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
          Turning it back on later does not refill those cells — you'll place it again where you want it.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={S.btnSecondary}>Cancel</button>
          <button onClick={onConfirm} style={S.btnDanger}>
            Turn off and clear {slotCount} {slotCount === 1 ? 'place' : 'places'}
          </button>
        </div>
      </div>
    </div>
  )
}
