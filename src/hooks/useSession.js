// src/hooks/useSession.js
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export async function resolveCampId(session) {
  if (!session) return null
  const { data, error } = await supabase
    .from('camps')
    .select('id')
    .eq('owner_user_id', session.user.id)
    .maybeSingle()
  if (error) console.error('resolveCampId:', error)
  return data?.id ?? null
}

export function useSession() {
  const [session, setSession] = useState(null)
  const [campId, setCampId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (!active) return
      setSession(s)
      setCampId(await resolveCampId(s))
      if (active) setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, s) => {
      if (!active) return
      setSession(s)
      setCampId(await resolveCampId(s))
      if (active) setLoading(false)
    })

    return () => { active = false; subscription.unsubscribe() }
  }, [])

  return { session, campId, loading }
}
