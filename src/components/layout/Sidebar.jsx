import { useState, useEffect, useCallback } from 'react'
import { localClient } from '../../localClient'

// Nav is grouped into two labelled sections so the setup workflow (build the
// camp's structure, top to bottom) reads as distinct from day-to-day
// operations (view/adjust the live schedule, resolve conflicts, manage
// devices). Conflicts + Device Manager are operational, not setup, so they
// live in the second group rather than interleaved among the setup steps.
const NAV_SECTIONS = [
  {
    title: 'Setup',
    items: [
      { key: 'setup',        label: 'Camp Setup' },
      { key: 'cohorts',      label: 'Programs' },
      { key: 'tiers',        label: 'Units' },
      { key: 'groups',       label: 'Groups' },
      { key: 'days',         label: 'Days' },
      { key: 'timeblocks',   label: 'Time Blocks' },
      { key: 'activities',   label: 'Activities' },
      { key: 'anchors',      label: 'Fixed Events' },
      { key: 'dayoverrides', label: 'Day Overrides' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { key: 'schedule',  label: 'Schedule' },
      { key: 'conflicts', label: 'Conflicts' },
    ],
    // Appended only for admins (Device Manager is admin-only).
    adminItems: [
      { key: 'devices', label: 'Device Manager' },
    ],
  },
]

export default function Sidebar({ current, onNavigate, campId, role, badges = {} }) {
  const [campName, setCampName] = useState('')
  const [projectPath, setProjectPath] = useState(null)
  const [backupStatus, setBackupStatus] = useState(null) // null | 'running' | 'ok' | 'error'

  useEffect(() => {
    if (!campId) return
    localClient.getCamp()
      .then(data => { if (data) setCampName(data.name) })
      .catch(() => { /* fail silent — leave campName unset */ })
  }, [campId])

  useEffect(() => {
    if (!window.shoresh?.getCurrentProject) return
    window.shoresh.getCurrentProject()
      .then(info => { if (info?.path) setProjectPath(info.path) })
      .catch(() => { /* non-fatal */ })
  }, [campId])

  const handleBackupNow = useCallback(async () => {
    if (!window.shoresh?.backupProject) return
    setBackupStatus('running')
    try {
      const result = await window.shoresh.backupProject()
      setBackupStatus(result?.error ? 'error' : 'ok')
    } catch {
      setBackupStatus('error')
    }
    // Reset status label after 3 s.
    setTimeout(() => setBackupStatus(null), 3000)
  }, [])

  return (
    <aside style={{
      width: 200, minWidth: 200, background: 'var(--surface)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', height: '100%',
    }}>
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 22,
          color: 'var(--primary)', letterSpacing: '-0.3px',
        }}>Shoresh</div>
        {campName && (
          <div style={{
            fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginTop: 2,
          }}>{campName}</div>
        )}
      </div>

      <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>
        {NAV_SECTIONS.map((section, sIdx) => {
          const items = [
            ...section.items,
            ...(role === 'admin' && section.adminItems ? section.adminItems : []),
          ]
          return (
            <div key={section.title}>
              <div style={{
                padding: sIdx === 0 ? '4px 20px 6px' : '14px 20px 6px',
                marginTop: sIdx === 0 ? 0 : 8,
                borderTop: sIdx === 0 ? 'none' : '1px solid var(--border)',
                fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                color: 'var(--text-secondary)',
              }}>
                {section.title}
              </div>
              {items.map(item => (
                <button
                  key={item.key}
                  onClick={() => onNavigate(item.key)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '8px 20px', border: 'none', background: 'none',
                    fontSize: 13, fontWeight: current === item.key ? 600 : 400,
                    color: current === item.key ? 'var(--primary)' : 'var(--text)',
                    borderLeft: current === item.key
                      ? '3px solid var(--primary)'
                      : '3px solid transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (current !== item.key) e.currentTarget.style.background = 'var(--bg)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    {item.label}
                    {Boolean(badges[item.key]) && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        minWidth: 16, height: 16, padding: '0 5px', borderRadius: 99,
                        background: 'var(--warning)', color: '#fff',
                        fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
                        lineHeight: '16px',
                      }}>
                        {badges[item.key]}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )
        })}
      </nav>

      <div style={{
        padding: '10px 20px', borderTop: '1px solid var(--border)',
        fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
      }}>
        {projectPath && (
          <div
            title={projectPath}
            style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              marginBottom: 6, cursor: 'default',
              color: 'var(--text-secondary)',
            }}
          >
            {projectPath.split(/[\\/]/).pop()}
          </div>
        )}
        {role === 'admin' && (
          <button
            onClick={handleBackupNow}
            disabled={backupStatus === 'running'}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '4px 0', border: 'none', background: 'none',
              fontSize: 11, fontFamily: 'var(--font-mono)',
              color: backupStatus === 'ok'
                ? 'var(--success, #22c55e)'
                : backupStatus === 'error'
                  ? 'var(--danger, #ef4444)'
                  : 'var(--text-secondary)',
              cursor: backupStatus === 'running' ? 'wait' : 'pointer',
              marginBottom: 4,
            }}
          >
            {backupStatus === 'running' ? 'Backing up…'
              : backupStatus === 'ok' ? 'Backup saved'
              : backupStatus === 'error' ? 'Backup failed'
              : 'Backup now'}
          </button>
        )}
        v0.1.0
      </div>
    </aside>
  )
}
