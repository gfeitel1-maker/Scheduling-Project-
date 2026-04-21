import { useState, useEffect } from 'react'
import Shell from './components/layout/Shell'
import CampSetup from './screens/CampSetup'
import TiersScreen from './screens/TiersScreen'
import GroupsScreen from './screens/GroupsScreen'
import TimeBlocksScreen from './screens/TimeBlocksScreen'
import ActivitiesScreen from './screens/ActivitiesScreen'
import AnchorsScreen from './screens/AnchorsScreen'
import ScheduleScreen from './screens/ScheduleScreen'
import { supabase } from './supabase'

const SCREENS = {
  setup: CampSetup,
  tiers: TiersScreen,
  groups: GroupsScreen,
  timeblocks: TimeBlocksScreen,
  activities: ActivitiesScreen,
  anchors: AnchorsScreen,
  schedule: ScheduleScreen,
}

const MON_FRI = [
  { label: 'Monday',    day_of_week: 1, sort_order: 1 },
  { label: 'Tuesday',   day_of_week: 2, sort_order: 2 },
  { label: 'Wednesday', day_of_week: 3, sort_order: 3 },
  { label: 'Thursday',  day_of_week: 4, sort_order: 4 },
  { label: 'Friday',    day_of_week: 5, sort_order: 5 },
]

async function seedDays(campId) {
  const { count } = await supabase
    .from('days_of_operation')
    .select('id', { count: 'exact', head: true })
    .eq('camp_id', campId)
  if (count === 0) {
    await supabase.from('days_of_operation').insert(
      MON_FRI.map(d => ({ ...d, camp_id: campId }))
    )
  }
}

function CampIdGate({ onEnter }) {
  const [value, setValue] = useState('')

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: 'var(--bg)',
    }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '40px 48px', maxWidth: 480, width: '100%',
        textAlign: 'center',
      }}>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 28,
          color: 'var(--primary)', letterSpacing: '-0.5px', marginBottom: 8,
        }}>Shoresh</div>
        <div style={{ color: 'var(--text-secondary)', marginBottom: 28, fontSize: 14 }}>
          Enter your camp ID to continue. You can find this in your Supabase project under
          Table Editor → camps → id column.
        </div>
        <input
          style={{
            width: '100%', padding: '10px 12px', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 13, fontFamily: 'var(--font-mono)',
            marginBottom: 12, outline: 'none', background: 'var(--bg)',
          }}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && value.trim() && onEnter(value.trim())}
        />
        <button
          onClick={() => value.trim() && onEnter(value.trim())}
          style={{
            width: '100%', padding: '10px 0', background: 'var(--primary)',
            color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600,
            fontSize: 14,
          }}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [campId, setCampId] = useState(() => localStorage.getItem('campId') || null)
  const [screen, setScreen] = useState('setup')

  useEffect(() => {
    if (campId) {
      localStorage.setItem('campId', campId)
      seedDays(campId)
    }
  }, [campId])

  if (!campId) {
    return <CampIdGate onEnter={id => setCampId(id)} />
  }

  const Screen = SCREENS[screen] || CampSetup

  return (
    <Shell currentScreen={screen} onNavigate={setScreen} campId={campId}>
      <Screen campId={campId} onNavigate={setScreen} />
    </Shell>
  )
}
