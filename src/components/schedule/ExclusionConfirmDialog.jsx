import { S, useEnterTransition } from '../../styles/shared'

export default function ExclusionConfirmDialog({ entityName, weekName, slotCount, onCancel, onConfirm }) {
  const enterStyle = useEnterTransition('liftFade')
  return (
    <div style={{ ...S.overlay, ...enterStyle }}>
      <div style={{ ...S.modalSm, maxWidth: 440 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>
          Turn off "{entityName}" for {weekName}?
        </div>
        <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 20 }}>
          Placed in {slotCount} {slotCount === 1 ? 'slot' : 'slots'} in {weekName}. They stay until you rebuild.
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
