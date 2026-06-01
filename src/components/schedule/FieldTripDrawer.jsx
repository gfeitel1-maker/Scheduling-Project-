// src/components/schedule/FieldTripDrawer.jsx
import { useState } from 'react'

const PRESET_STAMPS = ['Field Trip', 'Special Event', 'Service Project']

const OVERLAY_COLOR = '#f59e0b'
const OVERLAY_BG = '#f59e0b18'

export default function FieldTripDrawer({ isOpen, onClose, activeStamp, onSelectStamp }) {
  const [customLabel, setCustomLabel] = useState('')

  function handleStampClick(label) {
    onSelectStamp(activeStamp === label ? null : label)
  }

  function handleCustomStamp() {
    const trimmed = customLabel.trim()
    if (!trimmed) return
    onSelectStamp(activeStamp === trimmed ? null : trimmed)
  }

  return (
    <>
      {/* Backdrop — only blocks interaction when open */}
      {isOpen && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'transparent',
            zIndex: 40,
          }}
        />
      )}

      {/* Drawer panel */}
      <div style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: 240,
        height: '100vh',
        background: 'var(--surface-elevated)',
        borderLeft: '1px solid var(--border)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
        zIndex: 50,
        transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.22s ease-out',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 16px',
        gap: 8,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 14, color: 'var(--text)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Field Trip Stamps
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-secondary)', lineHeight: 1, padding: 4 }}
            title="Close"
          >✕</button>
        </div>

        {activeStamp && (
          <div style={{ background: '#f59e0b20', border: '1px solid #f59e0b', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: '#92400e', marginBottom: 4 }}>
            <strong>Stamp mode:</strong> Click any slot to place "{activeStamp}".<br />
            <button
              onClick={() => onSelectStamp(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', color: '#92400e', fontSize: 11, padding: 0, marginTop: 4 }}
            >Cancel stamp</button>
          </div>
        )}

        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
          Presets
        </div>

        {PRESET_STAMPS.map(label => (
          <button
            key={label}
            onClick={() => handleStampClick(label)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 7,
              border: `1.5px solid ${activeStamp === label ? OVERLAY_COLOR : 'var(--border)'}`,
              background: activeStamp === label ? OVERLAY_BG : 'var(--surface)',
              color: activeStamp === label ? '#92400e' : 'var(--text)',
              fontSize: 13,
              fontWeight: activeStamp === label ? 700 : 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'border-color 0.15s, background 0.15s',
            }}
          >
            {label}
          </button>
        ))}

        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 8 }}>
          Custom
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            value={customLabel}
            onChange={e => setCustomLabel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCustomStamp()}
            placeholder="Label…"
            style={{
              flex: 1,
              padding: '7px 8px',
              border: '1.5px solid var(--border)',
              borderRadius: 6,
              fontSize: 12,
              outline: 'none',
              background: 'var(--surface)',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={handleCustomStamp}
            disabled={!customLabel.trim()}
            style={{
              padding: '7px 10px',
              background: customLabel.trim() ? OVERLAY_COLOR : 'var(--border)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              cursor: customLabel.trim() ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
          >
            Use
          </button>
        </div>
      </div>
    </>
  )
}
