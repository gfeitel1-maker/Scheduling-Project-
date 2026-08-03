import { useState, useRef, useEffect } from 'react'
import { S } from '../../styles/shared'

// Director language only ("Week 1 ▾") — no "template"/"slot"/"kind"/"candidate"
// (CONSTITUTION Art. V). Switching weeks is pure navigation: onSelect just
// changes what's on screen, no confirm, nothing saved or destroyed
// (docs/adr/2026-08-02-schedule-weeks-first-class.md).
export default function WeekSwitcher({ weeks, weekId, onSelect, onCreate, onRename, onArchive, onUnarchive, onDuplicate, onDuplicateSuccess, onDelete }) {
  const [isOpen, setIsOpen] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [duplicatingId, setDuplicatingId] = useState(null)
  const [successBanner, setSuccessBanner] = useState(null)
  const dropRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) {
        setIsOpen(false); setRenamingId(null); setCreating(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  const current = weeks.find(w => w.id === weekId)
  const active = weeks.filter(w => String(w.is_archived) !== '1')
  const archived = weeks.filter(w => String(w.is_archived) === '1')

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
  }

  return (
    <div ref={dropRef} style={{ position: 'relative' }}>
      <button onClick={() => setIsOpen(o => !o)} style={btnStyle}>
        {current ? current.name : 'Week'} ▾
      </button>

      {isOpen && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
          boxShadow: '0 8px 24px rgba(0,0,0,0.10)', width: 260, overflow: 'hidden',
        }}>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {active.map(w => {
              const isRenaming = renamingId === w.id
              return (
                <div key={w.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px',
                  borderBottom: '1px solid var(--border)',
                  background: w.id === weekId ? 'color-mix(in srgb, var(--primary) 5%, transparent)' : undefined,
                }}>
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && renameValue.trim()) {
                          onRename(w.id, renameValue.trim())
                          setRenamingId(null)
                        }
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      onBlur={() => setRenamingId(null)}
                      style={{ ...S.input, padding: '3px 6px', fontSize: 12, flex: 1 }}
                    />
                  ) : (
                    <button
                      onClick={() => { onSelect(w.id); setIsOpen(false) }}
                      style={{
                        flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: 13, fontWeight: w.id === weekId ? 700 : 500,
                        color: w.id === weekId ? 'var(--primary)' : 'var(--text)', padding: '2px 0',
                      }}
                    >
                      {w.name}
                    </button>
                  )}
                  {!isRenaming && onRename && (
                    <button
                      onClick={() => { setRenamingId(w.id); setRenameValue(w.name) }}
                      title="Rename this week"
                      style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                    >
                      rename
                    </button>
                  )}
                  {!isRenaming && onDuplicate && (
                    <button
                      onClick={async () => {
                        setDuplicatingId(w.id)
                        try {
                          const result = await onDuplicate(w.id)
                          if (result?.ok) {
                            setSuccessBanner({ sourceName: w.name, newName: result.newName })
                            setTimeout(() => setSuccessBanner(null), 3000)
                            if (onDuplicateSuccess) onDuplicateSuccess(result)
                          }
                        } finally {
                          setDuplicatingId(null)
                        }
                      }}
                      disabled={duplicatingId === w.id}
                      title="Duplicate this week"
                      style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: duplicatingId === w.id ? 'wait' : 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                    >
                      duplicate
                    </button>
                  )}
                  {!isRenaming && onArchive && weeks.length > 1 && (
                    <button
                      onClick={() => onArchive(w.id)}
                      title="Archive this week"
                      style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                    >
                      archive
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {successBanner && (
            <div style={{
              padding: '8px 12px',
              background: 'color-mix(in srgb, var(--success) 12%, var(--surface))',
              borderTop: '1px solid color-mix(in srgb, var(--success) 30%, var(--border))',
              fontSize: 12,
              color: 'color-mix(in srgb, var(--success) 70%, var(--text))',
              lineHeight: 1.5,
            }}>
              Duplicated '{successBanner.sourceName}' as '{successBanner.newName}'. Activities, groups, and days are shared across all weeks.
            </div>
          )}
          {archived.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-elevated)' }}>
              <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
                Archived
              </div>
              {archived.map(w => (
                <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)' }}>{w.name}</span>
                  {onUnarchive && (
                    <button
                      onClick={() => onUnarchive(w.id)}
                      title="Bring this week back"
                      style={{ fontSize: 10, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                    >
                      unarchive
                    </button>
                  )}
                  {onDelete && weeks.length > 1 && (
                    <button
                      onClick={() => { setIsOpen(false); onDelete(w) }}
                      title="Permanently delete this week"
                      style={{ fontSize: 10, color: 'var(--warning)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                    >
                      Delete permanently
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {onCreate && <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', background: 'var(--surface-elevated)' }}>
            {creating ? (
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  autoFocus
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newName.trim()) {
                      onCreate(newName.trim())
                      setNewName(''); setCreating(false)
                    }
                    if (e.key === 'Escape') setCreating(false)
                  }}
                  placeholder="Week name…"
                  style={{ ...S.input, fontSize: 12, flex: 1 }}
                />
                <button
                  onClick={() => { if (newName.trim()) { onCreate(newName.trim()); setNewName(''); setCreating(false) } }}
                  disabled={!newName.trim()}
                  style={{ ...S.btnPrimary, padding: '3px 10px', fontSize: 11 }}
                >Add</button>
              </div>
            ) : (
              <button
                onClick={() => { setNewName(`Week ${weeks.length + 1}`); setCreating(true) }}
                style={{ width: '100%', padding: 6, borderRadius: 7, background: 'var(--primary)', color: '#fff', border: 'none', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >
                + New Week
              </button>
            )}
          </div>}
        </div>
      )}
    </div>
  )
}
