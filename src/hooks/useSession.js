// src/hooks/useSession.js
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export async function resolveCampId(session) {
  if (!session) return null
  const { data } = await supabase
    .from('camps')
    .select('id')
    .eq('owner_user_id', session.user.id)
    .maybeSingle()
  return data?.id ?? null
}

export function useSession() {
  const [session, setSession] = useState(null)
  const [campId, setCampId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s)
      setCampId(await resolveCampId(s))
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, s) => {
      setSession(s)
      setCampId(await resolveCampId(s))
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  return { session, campId, loading }
}
