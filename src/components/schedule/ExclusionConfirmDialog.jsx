import { S, useEnterTransition } from '../../styles/shared'

export default function ExclusionConfirmDialog({ entityName, weekName, slotCount, onCancel, onConfirm }) {
  const enterStyle = useEnterTransition('liftFade')
  return (
    <div style={{ ...S.overlay, ...enterStyle }}>
      <div style={{ ...S.modalSm, maxWidth: 440 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>
          Turn off "{entityName}" for {weekName}?
        </div>
        <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 8 }}>
          "{entityName}" is currently placed in {slotCount} {slotCount === 1 ? 'time slot' : 'time slots'} in {weekName}'s schedule. Turning it off doesn't touch those now — they stay right where they are until you rebuild this schedule, and it won't be placed there again after that.
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
          Turning it back on later does not refill those time slots — you'll place it again where you want it.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="press-97" onClick={onCancel} style={S.btnSecondary}>Cancel</button>
          <button onClick={onConfirm} style={S.btnDanger}>
            Turn off anyway
          </button>
        </div>
      </div>
    </div>
  )
}
