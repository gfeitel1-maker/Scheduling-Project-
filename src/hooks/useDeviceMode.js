import { useCallback, useEffect, useState } from 'react'
import { localClient } from '../localClient'

const MODE_KEY = 'shoresh-mode'
const TOKEN_KEY = 'shoresh-token'
const JOIN_HOST_KEY = 'shoresh-join-host'
const DEFAULT_HOST_PORT = 7777

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// Drives the App.jsx state machine: which top-level screen to show, given
// what's been persisted on this device (mode, join target, session token)
// and what the local backend currently reports (camp existence).
export function useDeviceMode() {
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState(() => localStorage.getItem(MODE_KEY))
  const [joinHost, setJoinHost] = useState(() => readJSON(JOIN_HOST_KEY))
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [camp, setCamp] = useState(null)

  const refreshCamp = useCallback(async () => {
    const c = await localClient.getCamp()
    setCamp(c || null)
    return c || null
  }, [])

  useEffect(() => {
    let active = true
    async function init() {
      const c = await refreshCamp()
      if (!active) return

      if (mode === 'host' && c) {
        await localClient.chooseMode({ mode: 'host', campName: c.name, port: DEFAULT_HOST_PORT })
      } else if (mode === 'client' && joinHost) {
        await localClient.chooseMode({ mode: 'client', host: joinHost.host, port: joinHost.port })
      }

      if (active) setLoading(false)
    }
    init()
    return () => { active = false }
    // Runs once on mount only — mode/joinHost read from their initial (persisted) values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chooseHost = useCallback(() => {
    localStorage.setItem(MODE_KEY, 'host')
    setMode('host')
  }, [])

  const chooseJoin = useCallback(() => {
    localStorage.setItem(MODE_KEY, 'client')
    setMode('client')
  }, [])

  const selectJoinHost = useCallback(async (host) => {
    await localClient.chooseMode({ mode: 'client', host: host.host, port: host.port })
    localStorage.setItem(JOIN_HOST_KEY, JSON.stringify(host))
    setJoinHost(host)
    await refreshCamp()
  }, [refreshCamp])

  const bootstrapCamp = useCallback(async ({ campName, adminName, adminPin }) => {
    await localClient.chooseMode({ mode: 'host', campName, port: DEFAULT_HOST_PORT })
    await localClient.bootstrapCamp({ campName, adminName, adminPin })
    await refreshCamp()
  }, [refreshCamp])

  const login = useCallback(async (name, pin) => {
    const result = await localClient.login(name, pin)
    if (result && result.token) {
      localStorage.setItem(TOKEN_KEY, result.token)
      setToken(result.token)
    }
    return result
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
  }, [])

  const backToModeSelect = useCallback(() => {
    localStorage.removeItem(MODE_KEY)
    localStorage.removeItem(JOIN_HOST_KEY)
    setMode(null)
    setJoinHost(null)
  }, [])

  let phase
  if (loading) phase = 'loading'
  else if (!mode) phase = 'mode-select'
  else if (mode === 'host' && !camp) phase = 'bootstrap'
  else if (mode === 'client' && !joinHost) phase = 'join'
  else if (!token) phase = 'login'
  else phase = 'session'

  return {
    phase,
    mode,
    camp,
    joinHost,
    chooseHost,
    chooseJoin,
    selectJoinHost,
    bootstrapCamp,
    login,
    logout,
    backToModeSelect,
  }
}
