// Records worth a second look before they become part of a camp's setup.
//
// Importing one real file produced 109 activities, including "and Mitzvah",
// "and Mitzvah Project", "Block Sports" and "Block Teva" — fragments and
// column bleed, arriving with colour dots and weekly targets, sitting in the
// palette between "Art" and "Ceramics" with nothing to tell them apart.
//
// The parser will never be clean on input this messy, and that is the wrong
// thing to chase. A camp's spreadsheet is a human document with wrapped cells,
// merged headers and typos in it; the honest move is to say which records look
// unlike the others and let the director settle it.
//
// EVERYTHING HERE FLAGS. Nothing is dropped, renamed or merged. "Art" trips a
// short-name heuristic and is a real activity; "Digital Art/Coding/Coding" has
// a doubled word that is in the camp's own file, not a parser artifact. Both
// are arguments for asking rather than deciding.
//
// A group rule was written and then deleted, which is worth recording so it is
// not rewritten. campA titles 30 of its 33 pages "<Bunk> Schedule" and the
// three that break the pattern read as activity rotations ("Maple 3- Cooking/
// Baking/ Dance") rather than bunks — a real signal. But by the time groups
// reach this function the tier and the trailing "Schedule" have already been
// stripped, so the outlier test fired on a synthetic fixture and on nothing in
// the corpus. The check belongs at the page-title layer, and needs its own
// ticket rather than machinery here that only works in a test. Separately, it
// is not clear those three ARE mistakes: the source puts them in the group
// slot, and a rotation cohort is a plausible group.

// "and Mitzvah" — a name that starts mid-sentence is the tail of a cell that
// was split in the wrong place.
const LEADING_CONJUNCTION = /^(and|or|the|a|an|of|with|for)\s/i

// "Block Sports", "Block Teva" — "Block" is the PERIOD column's word in this
// corpus ("Block 1", "Block 2"), bleeding into the activity name when a row
// label and a cell run together. Anchored, so "Cinder Block Art" is untouched.
const PERIOD_PREFIX = /^block\b/i

/**
 * @param entities the extractEntities bucket shape ({ activities, groups, … })
 * @returns [{ entity, name, reason }] — a flat list, empty for a clean file.
 */
export function findSuspectRecords(entities = {}) {
  const activities = entities.activities ?? []
  const found = []

  for (const name of activities) {
    if (LEADING_CONJUNCTION.test(name)) {
      found.push({
        entity: 'activities',
        name,
        reason: 'Begins with a joining word, so it may be half of a longer name.',
      })
    } else if (PERIOD_PREFIX.test(name)) {
      found.push({
        entity: 'activities',
        name,
        reason: 'Starts with a period name, so the time column may have run into it.',
      })
    }
  }

  return found
}
