import React, { useState, useRef, useEffect } from 'react'
import { S } from '../../styles/shared'

function formatTime(isoString) {
  const d = new Date(isoString)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (isToday) return `today ${timeStr}`
  if (isYesterday) return `yesterday ${timeStr}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr
}

export default function VersionsDropdown({ snapshots, isOpen, onToggle, onRestore, onSaveNamed, onRenameAutoSave }) {
  const [nameInput, setNameInput] = useState('')
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const dropRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) onToggle()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen, onToggle])

  const btnStyle = { padding: '6px 12px', border: `1px solid ${isOpen ? '#E8A020' : 'var(--border)'}`, borderRadius: 6, background: isOpen ? '#FFF3DC' : 'var(--surface)', color: isOpen ? '#9A6200' : 'var(--text)', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', position: 'relative' }

  return (
    <div ref={dropRef} style={{ position: 'relative' }}>
      <button onClick={onToggle} style={btnStyle}>📋 Versions ▾</button>

      {isOpen && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.10)', width: 320, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 15, fontWeight: 600 }}>Version History</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Auto-saved before each regeneration</div>
          </div>

          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {snapshots.length === 0 && <div style={{ padding: '16px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>No versions saved yet.</div>}
            {snapshots.map((snap, i) => {
              const isCurrent = i === 0
              const isRenaming = renamingId === snap.id
              return (
                <div key={snap.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderBottom: '1px solid var(--border)', background: isCurrent ? '#00ADBB08' : undefined }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isRenaming ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && renameValue.trim()) { onRenameAutoSave(snap.id, renameValue.trim()); setRenamingId(null) } if (e.key === 'Escape') setRenamingId(null) }} style={{ ...S.input, padding: '3px 6px', fontSize: 12, width: '100%' }} placeholder="Version name…" />
                        <button onClick={() => { if (renameValue.trim()) onRenameAutoSave(snap.id, renameValue.trim()); setRenamingId(null) }} style={{ ...S.btnPrimary, padding: '3px 8px', fontSize: 11 }}>Save</button>
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 600, color: snap.is_auto ? 'var(--text-secondary)' : 'var(--text)', fontStyle: snap.is_auto ? 'italic' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{snap.is_auto ? 'Auto-save' : snap.name}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', marginTop: 1 }}>{formatTime(snap.created_at)}</div>
                      </>
                    )}
                  </div>
                  {isCurrent && !isRenaming && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', background: '#00ADBB14', padding: '2px 6px', borderRadius: 10, whiteSpace: 'nowrap' }}>current</span>}
                  {!isCurrent && !isRenaming && snap.is_auto && <button onClick={() => { setRenamingId(snap.id); setRenameValue('') }} style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}>rename</button>}
                  {!isCurrent && !isRenaming && <button onClick={() => { onRestore(snap); onToggle() }} style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 6px', borderRadius: 5, fontFamily: 'inherit' }}>Restore</button>}
                </div>
              )
            })}
          </div>

          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface-elevated)' }}>
            <input value={nameInput} onChange={e => setNameInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && nameInput.trim()) { onSaveNamed(nameInput.trim()); setNameInput('') } }} style={{ ...S.input, fontSize: 12, marginBottom: 6 }} placeholder="Name current version…" />
            <button onClick={() => { if (nameInput.trim()) { onSaveNamed(nameInput.trim()); setNameInput('') } }} disabled={!nameInput.trim()} style={{ width: '100%', padding: 6, borderRadius: 7, background: nameInput.trim() ? 'var(--primary)' : 'var(--border)', color: nameInput.trim() ? '#fff' : 'var(--text-secondary)', border: 'none', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: nameInput.trim() ? 'pointer' : 'default' }}>Save as named version</button>
          </div>
        </div>
      )}
    </div>
  )
}
