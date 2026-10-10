import { appearancePhrase } from './appearsAt.js'
import { formatBlockTime12h } from './blockTimeText.js'
import { fieldLabel } from '../screens/recordLabels.js'

// The plain-camp name for each kind of record, so a review card never shows a
// schema name like "fixed_events".
const NOUN = {
  fixed_events: 'Fixed event',
  activities: 'Activity',
  groups: 'Group',
  tiers: 'Age division',
  time_blocks: 'Time block',
  days_of_operation: 'Day',
  locations: 'Place',
  cohorts: 'Program',
  events: 'Event',
  special_days: 'Special day',
  elective_sets: 'Elective set',
}

const ADD_PHRASE = {
  groups: 'the group',
  tiers: 'the age division',
  time_blocks: 'the time block',
  days_of_operation: 'the day',
  locations: 'the place',
  cohorts: 'the program',
}

export function entityNoun(entity) {
  return NOUN[entity] ?? String(entity ?? '').replace(/_/g, ' ')
}

function fieldNames(fields) {
  const labels = fields.map((f) => fieldLabel(f).toLowerCase())
  return labels.length <= 1 ? (labels[0] ?? 'something') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

function valueText(value) {
  return value != null && typeof value === 'object' ? null : String(value)
}

/**
 * What answering "yes" to a confirm_value card will do, in the director's words.
 * Null for any kind this does not title (the card keeps its own wording).
 */
export function decisionTitle(decision, { placements = [], allGroupNames = [] } = {}) {
  if (decision.kind !== 'confirm_value') return null
  const name = decision.entityName
  if (!name) return null

  if (decision.entity === 'fixed_events') {
    const seen = appearancePhrase(placements, name, allGroupNames)
    if (seen) return `Make ${name} a fixed event for ${seen.groups} at ${seen.times}?`
    return decision.timeBlock
      ? `Make ${name} a fixed event at ${formatBlockTime12h(decision.timeBlock)}?`
      : `Make ${name} a fixed event?`
  }

  const fields = Array.isArray(decision.field) ? decision.field : []
  if (fields.length > 0) {
    const value = valueText(decision.proposedValue)
    return fields.length === 1 && value != null
      ? `Set ${name}’s ${fieldNames(fields)} to ${value}?`
      : `Update ${name}’s ${fieldNames(fields)}?`
  }

  if (decision.entity === 'activities') {
    const seen = appearancePhrase(placements, name, allGroupNames)
    return seen ? `Add ${name} as an activity for ${seen.groups} at ${seen.times}?` : `Add ${name} as an activity?`
  }

  return `Add ${ADD_PHRASE[decision.entity] ?? 'the record'} "${name}"?`
}
