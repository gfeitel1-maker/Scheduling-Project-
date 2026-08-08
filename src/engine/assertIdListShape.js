// DEV-only shape guard for engine id-list inputs (eligible_group_ids, group_ids).
// Callers must normalize id-lists to arrays at the IPC read boundary before
// they reach the engine — see normalizeActivityEligibility / parseIdList.
// T69 deleted the engine's tolerance for JSON-stringified id-lists; this
// assertion makes a violation of that contract loud in DEV instead of a
// silent hung spinner. Stripped from production builds by Vite's DEV check.
export function assertIdListShape(value, fieldName, entityId) {
  if (value != null && !Array.isArray(value)) {
    throw new Error(
      `Engine received non-array ${fieldName}${entityId != null ? ` for entity ${entityId}` : ''}. ` +
      `Expected an array of ids. Normalize at the IPC read boundary via ` +
      `normalizeActivityEligibility / parseIdList.`
    )
  }
}
