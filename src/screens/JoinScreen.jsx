import { useEffect, useState, useCallback, useRef } from 'react'
import { S } from '../styles/shared'
import { localClient } from '../localClient'

export default function JoinScreen({ onBack, onSelectHost }) {
  const [state, setState] = useState('searching')
  const [hosts, setHosts] = useState([])
  const mountedRef = useRef(true)
  const scanningRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const runDiscovery = useCallback(async () => {
    if (scanningRef.current) return
    scanningRef.current = true
    try {
      const found = await localClient.discoverHosts()
      if (!mountedRef.current) return
      setHosts(found || [])
      setState(found && found.length > 0 ? 'found' : 'empty')
    } finally {
      scanningRef.current = false
    }
  }, [])

  const searchAgain = useCallback(() => {
    if (scanningRef.current) return
    setState('searching')
    runDiscovery()
  }, [runDiscovery])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { runDiscovery() }, [runDiscovery])

  return (
    <div style={S.authPage}>
      <div style={S.authCard}>
        <div style={S.authBackRow}>
          <button
            style={S.authBackBtn}
            onClick={onBack}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--border)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-secondary)' }}
          >
            ← Back
          </button>
        </div>

        {state === 'searching' && (
          <>
            <div style={S.authEyebrow}>Join a camp</div>
            <div style={S.authTitle}>Looking for a camp on your network…</div>
            <div style={S.authSubtitle}>Make sure this device is on the same Wi-Fi as the Host computer.</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '22px 0', justifyContent: 'center' }}>
              <Spinner />
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Searching…</div>
            </div>
          </>
        )}

        {state === 'found' && (
          <>
            <div style={S.authEyebrow}>Join a camp</div>
            <div style={S.authTitle}>Choose a camp to connect to</div>
            <div style={S.authSubtitle}>Found on your network:</div>

            {hosts.map(h => (
              <button
                key={`${h.host}:${h.port}`}
                style={S.authHostItem}
                onClick={() => onSelectHost(h)}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.background = 'rgba(0,173,187,0.04)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--surface)' }}
              >
                <div style={S.authHostDot} />
                <div>
                  <div style={S.authHostName}>{h.name}</div>
                  <div style={S.authHostMeta}>{h.host}{h.deviceName ? ` · ${h.deviceName}` : ''}</div>
                </div>
                <div style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>›</div>
              </button>
            ))}

            <button
              style={{ ...S.authLinkBtn, marginTop: 14, opacity: scanningRef.current ? 0.5 : 1 }}
              onClick={searchAgain}
              disabled={scanningRef.current}
            >
              ↻ Search again
            </button>
          </>
        )}

        {state === 'empty' && (
          <div style={{ textAlign: 'center', padding: '30px 10px' }}>
            <div style={{ fontSize: 30, marginBottom: 12, opacity: 0.5 }}>📡</div>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 15, color: 'var(--text)', marginBottom: 6 }}>
              No camps found nearby
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 18 }}>
              Double-check that:
              <br />• This device is on the same Wi-Fi network as the Host
              <br />• The Host computer is turned on and Shoresh is running there
            </div>
            <button style={{ ...S.authBtnPrimary, marginTop: 0 }} onClick={searchAgain}>Search again</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div style={{
      width: 18, height: 18, borderRadius: '50%',
      border: '2.5px solid var(--border)', borderTopColor: 'var(--primary)',
      animation: 'shoresh-spin 0.8s linear infinite',
    }}>
      <style>{'@keyframes shoresh-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  )
}
