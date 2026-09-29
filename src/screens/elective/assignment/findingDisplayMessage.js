// T300 — a finding names an activity the way the DIRECTOR spells it.
//
// THE BUG. `electiveChoiceLabelKey` (electron/ops/electiveDerivedIds.js) is
// `whitespaceInsensitiveName`: it lowercases and DELETES whitespace. It is an
// identity key — the thing that makes two devices agree that 'Archery' and
// 'archery' are one elective — and it is not display text. Every producer of an
// elective finding has only that key to hand, so every one of them interpolated
// it into a sentence a director reads: "“archery” had 4 of the 6 campers it
// needs to run". A name with a space is worse than the lowercase: 'Arts &
// Crafts' reaches the screen as 'arts&crafts'.
//
// WHY THE FIX IS HERE AND NOT IN THE PRODUCERS. `src/engine/
// buildElectiveAssignments.js` is a pure function with no access to display
// names, and `findMismatches` (./buildOfferings.js) is the same shape one layer
// out. Teaching each of them about display names would spread a display concern
// across two pure modules and still leave the next producer to rediscover the
// bug. Every one of these findings already carries the identifiers a name can be
// looked up FROM, and they all converge on a single rendered list
// (AssignmentPreview.jsx). That list is the choke point, so the resolution lives
// here and each producer keeps its one job.
//
// THE COUPLING, STATED PLAINLY. A producer hands us a finished sentence with the
// key already inside it, so this module has to find the key in that sentence to
// replace it. It anchors on the QUOTES the producers wrap labels in — curly in
// the engine, straight in findMismatches — because a bare replace would rewrite
// prose: an elective called 'Run' would turn "campers it needs to run" into
// "campers it needs to Run". If a producer ever stops quoting its labels, this
// substitution silently stops happening and the key comes back. That is why
// AssignmentPreview.test.jsx drives the REAL producers rather than hand-written
// findings — a wording or quoting change there turns those tests red here.
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'

// Both quote families the producers use, and the apostrophe forms, so a future
// sentence that quotes with ‘ ’ is covered without another edit here.
const OPEN = '[“‘"\']'
const CLOSE = '[”’"\']'

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The (key → display name) pairs a single finding licenses. Yielding pairs
// rather than one name keeps the caller kind-agnostic: a new finding kind that
// carries `activity_id`, `labelKey` or `choice_ids` is resolved without this
// module learning its name.
function* displayNamesFor(finding, activities, choices) {
  if (finding.labelKey != null) {
    // By id first — the finding names the activity it is about, and the
    // activity row is the authority on its own name. The labelKey lookup is the
    // fallback for a finding that carries no id (findMismatches' UNRANKED_
    // OFFERING), and it is safe because the key IS a function of the name.
    const activity =
      (finding.activity_id != null && activities.find((a) => a.id === finding.activity_id)) ||
      activities.find((a) => a.name != null && electiveChoiceLabelKey(a.name) === finding.labelKey)
    if (activity?.name) yield [finding.labelKey, activity.name]
  }

  // A linked choice is named by the CHOICE's label, not an activity's — the set
  // is the thing a director named. The engine's `labelOfChoice` writes the
  // choice's labelKey and falls back to the raw id when the run carries no
  // choices at all, so both spellings are candidates for replacement.
  for (const id of finding.choice_ids ?? []) {
    const choice = choices.find((c) => c.id === id)
    const name = choice?.label ?? null
    if (!name) continue
    yield [choice.labelKey ?? id, name]
  }
}

/**
 * The finding's message with every internal label key replaced by the name the
 * director gave that activity. A finding this cannot resolve is returned
 * UNCHANGED — a sentence with a key in it still tells a director what happened,
 * and dropping or blanking it would be the worse failure.
 *
 * @param {{message?: string, labelKey?: string, activity_id?: string, choice_ids?: string[]}} finding
 * @param {{activities?: {id: string, name: string}[], choices?: {id: string, label?: string, labelKey?: string}[]}} [sources]
 * @returns {string|undefined} the message, resolved where possible
 */
export function findingDisplayMessage(finding, { activities = [], choices = [] } = {}) {
  const message = finding?.message
  if (typeof message !== 'string' || message === '') return message

  let resolved = message
  for (const [key, name] of displayNamesFor(finding, activities, choices)) {
    if (!key || !name || key === name) continue
    resolved = resolved.replace(
      new RegExp(`(${OPEN})${escapeRegExp(key)}(${CLOSE})`, 'g'),
      // A function replacement, not a string: a display name containing `$&` or
      // `$1` would otherwise be interpreted as a capture reference.
      (_match, open, close) => `${open}${name}${close}`
    )
  }
  return resolved
}
