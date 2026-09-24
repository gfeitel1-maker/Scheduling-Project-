import ProvenanceDot from './ProvenanceDot.jsx'
import { provenanceDotStyles } from './provenanceDotStyles.js'

// The shared, entity-agnostic duplicate-name marker for the eight screens
// (T239) that get the derived duplicate flag without a merge action —
// unlike LocationsScreen's DuplicateLocationDot and ActivitiesScreen's
// DuplicateActivityDot, which offer a pre-existing entity-specific merge
// primitive. Reference-aware merge across these entities is a stated
// non-goal, so this wrapper has NO actions footer at all: ProvenanceDot
// omits the footer entirely when `actions` is falsy.
export default function DuplicateNameDot({ row, siblings, entityLabel }) {
  const other = siblings[0]
  return (
    <ProvenanceDot
      ariaLabel={`Possible duplicate of ${other.name}`}
      dialogLabel={`Possible duplicate for ${row.name}`}
      title="Possible duplicate"
      tierLabel={null}
    >
      <div style={provenanceDotStyles.rowSentence}>
        {siblings.length === 1
          ? `This looks like the same ${entityLabel} as "${other.name}".`
          : `This looks like the same ${entityLabel} as ${siblings.length} others (e.g. "${other.name}").`}
        {' '}Rename or delete one here to clear this.
      </div>
    </ProvenanceDot>
  )
}
