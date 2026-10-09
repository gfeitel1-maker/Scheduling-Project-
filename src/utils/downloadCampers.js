import { localClient } from '../localClient'
import { buildCamperRows, downloadCamperWorkbook } from './exportCamperWorkbook.js'

// T353 — the camper export's runner, mirroring downloadWorksheet.js. Read-only.
// Throws on a failed read so the caller surfaces it via describeWriteFailure.
// Returns how many sheet rows were exported; 0 means nothing was downloaded.
export async function runCamperDownload() {
  const [campers, groups, preferences, choices] = await Promise.all([
    localClient.list('campers'),
    localClient.list('groups'),
    localClient.list('elective_preferences'),
    localClient.list('elective_choices'),
  ])
  const args = { campers, groups, preferences, choices }
  const count = buildCamperRows(args).length - 1
  if (count > 0) downloadCamperWorkbook(args)
  return count
}
