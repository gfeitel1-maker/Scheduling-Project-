// One sentence a director can act on for each reason the main process gives when a camp file cannot be opened
// (electron/ops/campFile/validateCampFile.js REJECTION_REASONS).
export const CAMP_FILE_FAILURE_TEXT = {
  not_a_camp_file: "That isn't a Shoresh camp file. Choose a file ending in .shoresh-camp that was made with Save whole camp.",
  too_large: 'That file is too big to be a camp file. Choose the file that Save whole camp made.',
  newer_version: 'That camp was saved by a newer version of Shoresh. Update Shoresh on this computer, then try again.',
  unknown_entity: "That file holds information Shoresh doesn't recognize, so nothing was opened. Use the original file, or save the camp again from the old computer.",
  unknown_field: "That file holds information Shoresh doesn't recognize, so nothing was opened. Use the original file, or save the camp again from the old computer.",
  bad_type: "Part of that file isn't in the form Shoresh expects, so nothing was opened. Use the original file, or save the camp again from the old computer.",
  dangling_reference: 'That file is missing pieces that other parts of it depend on, so nothing was opened. Save the camp again from the old computer and use the new file.',
  count_mismatch: "That file looks cut off or damaged: what it holds doesn't match what it says it holds. Copy it over again, or save the camp again from the old computer.",
  camp_not_empty: 'This computer already has a camp, so a saved camp cannot be opened into it. Start over to begin with a clean camp, then open the file.',
  load_incomplete: 'Opening the camp stopped partway, so this camp cannot be used. Start over, then try the file again.',
}

export const CAMP_FILE_FALLBACK_TEXT = "That file couldn't be opened. Try again, or start over."

export const campFileFailureText = (reason) => CAMP_FILE_FAILURE_TEXT[reason] ?? CAMP_FILE_FALLBACK_TEXT

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
export function summarizeCounts(counts = {}) {
  return [plural(counts.groups ?? 0, 'group', 'groups'), plural(counts.activities ?? 0, 'activity', 'activities'), plural(counts.locations ?? 0, 'location', 'locations')].join(', ')
}
