import { S } from '../styles/shared'

// Props:
//   cohorts       — array of cohort rows from DB
//   activeCohort  — currently selected cohort object
//   onChange      — fn(cohortId: string)
export default function CohortPicker({ cohorts, activeCohort, onChange = () => {} }) {
  if (!cohorts || cohorts.length <= 1) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <span style={{
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--text-secondary)',
      }}>
        Program
      </span>
      <select
        value={activeCohort?.id ?? ''}
        onChange={e => onChange(e.target.value)}
        style={{ ...S.input, width: 'auto', minWidth: 160 }}
      >
        {cohorts.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </div>
  )
}
