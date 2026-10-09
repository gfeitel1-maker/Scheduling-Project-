// The one definition of the hard per-field length caps. Its own module because both
// operations.js (appendOp) and projections.js (applyProjection, the single sink every
// SQLite write passes through) need it, and operations.js already imports projections.js.
export const MAX_FIELD_VALUE_LENGTH = {
  camp_maps: { image_data: 1_400_000 }, // chars; ~1MB base64 + slack, never truncated, hard reject
}

export function exceedsMaxFieldLength(entity, field, value) {
  const max = MAX_FIELD_VALUE_LENGTH[entity]?.[field]
  return Boolean(max) && typeof value === 'string' && value.length > max
}
