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

export default function VersionsDropdown({ snapshots, isOpen, role, onToggle, onRestore, onSaveNamed, onRenameAutoSave, onDelete }) {
  const isAdmin = role === 'admin'
  const [nameInput, setNameInput] = useState('')
  const [renamingId, setRenamingId] = useState(null)
  // Two-step inline confirm rather than a modal — matches the rename affordance
  // beside it, and keeps an irreversible action one deliberate click away.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const dropRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) { setConfirmingDeleteId(null); onToggle() }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen, onToggle])

  const btnStyle = {
    padding: '6px 12px',
    border: `1px solid ${isOpen ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 6,
    background: isOpen ? 'color-mix(in srgb, var(--accent) 8%, var(--surface))' : 'var(--surface)',
    color: isOpen ? 'color-mix(in srgb, var(--accent) 60%, var(--text))' : 'var(--text)',
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    position: 'relative',
  }

  return (
    <div ref={dropRef} style={{ position: 'relative' }}>
      <button onClick={() => { setConfirmingDeleteId(null); onToggle() }} style={btnStyle}>
        📋 Versions ▾
      </button>

      {isOpen && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
          boxShadow: '0 8px 24px rgba(0,0,0,0.10)', width: 360, overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 15, fontWeight: 600 }}>Version History</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Auto-saved before each regeneration</div>
          </div>

          {/* Snapshot list */}
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {snapshots.length === 0 && (
              <div style={{ padding: '16px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>No versions saved yet.</div>
            )}
            {snapshots.map((snap) => {
              // `on_screen` is derived from the version's payload by
              // snapshotMatchesSchedule — it says this version IS the week being
              // displayed. It used to be `i === 0`, which only meant "newest":
              // the auto-save taken before a regeneration was labelled as the
              // week on screen straight after it had been replaced, and the week
              // preserved by the v26 migration was labelled that way despite
              // never having been shown. It is normal for no version to match.
              //
              // It is a label and nothing more. It must never remove Restore:
              // hiding Restore on the newest row is what made the preserved week
              // impossible to bring back, and restoring the week you are already
              // looking at is a harmless no-op, not something to prevent.
              const isOnScreen = snap.on_screen === true
              const isRenaming = renamingId === snap.id

              return (
                <div key={snap.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px',
                  borderBottom: '1px solid var(--border)',
                  background: isOnScreen ? 'color-mix(in srgb, var(--primary) 3%, transparent)' : undefined,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isRenaming ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && renameValue.trim()) {
                              onRenameAutoSave(snap.id, renameValue.trim())
                              setRenamingId(null)
                            }
                            // Nested inside the ScheduleScreen "⋯" overflow
                            // menu, which has its own Escape handler to close
                            // the whole menu — cancelling a rename must not
                            // bubble out and take the overflow menu with it.
                            if (e.key === 'Escape') { e.stopPropagation(); setRenamingId(null) }
                          }}
                          style={{ ...S.input, padding: '3px 6px', fontSize: 12, width: '100%' }}
                          placeholder="Version name…"
                        />
                        <button className="press-97"
                          onClick={() => {
                            if (renameValue.trim()) onRenameAutoSave(snap.id, renameValue.trim())
                            setRenamingId(null)
                          }}
                          style={{ ...S.btnPrimary, padding: '3px 8px', fontSize: 11 }}
                        >Save</button>
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 600, color: snap.is_auto ? 'var(--text-secondary)' : 'var(--text)', fontStyle: snap.is_auto ? 'italic' : 'normal', overflowWrap: 'anywhere' }}>
                          {snap.is_auto ? 'Auto-save' : snap.name}
                        </div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', marginTop: 1 }}>
                          {formatTime(snap.created_at)}
                        </div>
                      </>
                    )}
                  </div>

                  {isOnScreen && !isRenaming && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', background: 'color-mix(in srgb, var(--primary) 8%, transparent)', padding: '2px 6px', borderRadius: 10, whiteSpace: 'nowrap' }}>
                      on screen now
                    </span>
                  )}

                  {!isRenaming && snap.is_auto && (
                    <button
                      onClick={() => { setRenamingId(snap.id); setRenameValue('') }}
                      style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                    >
                      rename
                    </button>
                  )}

                  {!isRenaming && (
                    // `restorable === false` means this version recorded no schedule
                    // data (saved before the write bug was fixed) — there is nothing
                    // to restore. Offering it as if it worked is the T8 defect, so it
                    // is disabled and labelled rather than silently doing nothing.
                    // `undefined` is treated as restorable so a freshly saved snapshot
                    // is never wrongly greyed out.
                    <button
                      onClick={() => { onRestore(snap); onToggle() }}
                      disabled={!isAdmin || snap.restorable === false}
                      title={
                        snap.restorable === false ? 'This version recorded no schedule data and cannot be restored'
                          : !isAdmin ? 'Director only'
                            : undefined
                      }
                      style={{
                        fontSize: 11, fontWeight: 700,
                        color: (isAdmin && snap.restorable !== false) ? 'var(--primary)' : 'var(--text-secondary)',
                        background: 'none', border: 'none',
                        cursor: (isAdmin && snap.restorable !== false) ? 'pointer' : 'not-allowed',
                        padding: '3px 6px', borderRadius: 5, fontFamily: 'inherit',
                        opacity: (isAdmin && snap.restorable !== false) ? 1 : 0.6,
                      }}
                    >
                      {snap.restorable === false ? 'Empty' : 'Restore'}
                    </button>
                  )}

                  {!isRenaming && isAdmin && (
                    confirmingDeleteId === snap.id ? (
                      <button
                        onClick={() => { onDelete(snap.id); setConfirmingDeleteId(null) }}
                        onBlur={() => setConfirmingDeleteId(null)}
                        autoFocus
                        title="Permanently delete this version"
                        style={{ fontSize: 10, fontWeight: 700, color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: 'none', borderRadius: 5, cursor: 'pointer', padding: '3px 6px', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                      >
                        Delete?
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmingDeleteId(snap.id)}
                        title={snap.restorable === false ? 'Delete this empty version' : 'Delete this version'}
                        style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                      >
                        delete
                      </button>
                    )
                  )}
                </div>
              )
            })}
          </div>

          {/* Save footer */}
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface-elevated)' }}>
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && nameInput.trim()) {
                  onSaveNamed(nameInput.trim())
                  setNameInput('')
                }
              }}
              style={{ ...S.input, fontSize: 12, marginBottom: 6 }}
              placeholder="Name current version…"
            />
            <button
              onClick={() => { if (nameInput.trim()) { onSaveNamed(nameInput.trim()); setNameInput('') } }}
              disabled={!nameInput.trim()}
              style={{ width: '100%', padding: 6, borderRadius: 7, background: nameInput.trim() ? 'var(--primary)' : 'var(--border)', color: nameInput.trim() ? '#fff' : 'var(--text-secondary)', border: 'none', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: nameInput.trim() ? 'pointer' : 'default' }}
            >
              Save as named version
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
