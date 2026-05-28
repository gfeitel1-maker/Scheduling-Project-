import { supabase } from '../supabase'

// Called once when a campId first becomes available.
// Creates a "Main" cohort if the camp has none — covers newly created camps.
// Existing camps are handled by migration 20260527050000.
export async function ensureCohort(campId) {
  const { count } = await supabase
    .from('cohorts')
    .select('id', { count: 'exact', head: true })
    .eq('camp_id', campId)
  if (count === 0) {
    await supabase.from('cohorts').insert({
      camp_id: campId,
      name: 'Main',
      session_week_start: 1,
      session_week_end: 1,
      capacity_source: 'groups_per_slot',
      anchor_model: 'fixed',
    })
  }
}
