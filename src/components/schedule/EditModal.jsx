import React, { useState } from 'react'
import { ANCHOR_COLOR, activityColor } from './SlotCell'
import { S } from '../../styles/shared'

export default function EditModal({ slot, activities, eligibleActivities, currentActivity, currentAnchor, weatherAlt, weatherMode, onSave, onClose }) {
  const [selected, setSelected] = useState(slot.activityId || '')

  if (slot.type === 'anchor') {
    return (
      <div style={S.overlay}>
        <div style={S.modalLg}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, marginBottom: 8, color: ANCHOR_COLOR }}>⚓ Anchor: {currentAnchor?.name}</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>Anchors are fixed and cannot be changed here.</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={onClose} style={S.btnPrimary}>Close</button></div>
        </div>
      </div>
    )
  }

  return (
    <div style={S.overlay}>
      <div style={S.modalLg}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Assign Activity</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, fontFamily: 'var(--font-mono)' }}>Currently: {currentActivity?.name || 'Empty'}</div>

        {weatherMode && weatherAlt && (
          <div style={{ background: '#EEF4FD', border: '1px solid #2F7DE1', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>
            <span style={{ color: '#2F7DE1', fontWeight: 600 }}>Weather alternative: </span>{weatherAlt.name}
            <button onClick={() => { setSelected(weatherAlt.id); setTimeout(() => onSave(weatherAlt.id), 50) }} style={{ ...S.btnPrimary, padding: '4px 10px', marginLeft: 10, fontSize: 12 }}>Swap</button>
          </div>
        )}

        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 16 }}>
          <div style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', background: selected === '' ? 'var(--surface-elevated)' : '', borderBottom: '1px solid var(--border)' }} onClick={() => setSelected('')}>— Clear slot —</div>
          {eligibleActivities.map((a, i) => (
            <div key={a.id} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 500, background: selected === a.id ? 'var(--surface-elevated)' : '', borderBottom: i < eligibleActivities.length - 1 ? '1px solid var(--border)' : '', display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => setSelected(a.id)}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: activityColor(i), display: 'inline-block', flexShrink: 0 }} />
              {a.name}
              {a.priority === 'high' && <span style={{ fontSize: 10, background: 'var(--primary)', color: '#fff', borderRadius: 3, padding: '1px 5px', marginLeft: 'auto' }}>HIGH</span>}
            </div>
          ))}
          {eligibleActivities.length === 0 && (
            <div style={{ padding: '16px 12px', fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>No eligible activities for this group</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={S.btnSecondary}>Cancel</button>
          <button onClick={() => onSave(selected || null)} style={S.btnPrimary}>Save</button>
        </div>
      </div>
    </div>
  )
}
