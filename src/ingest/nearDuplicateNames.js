// T144 — docs/work/tickets/T144-word-form-name-variants-never-reach-a-director.md
//
// Two typo classes reach ingestion, and only one of them is safely automatic.
//
// WHITESPACE/CASE ("Lunch2" -> "Lunch 2") is handled upstream by
// buildActivityNameCanonicalMap and needs no human: the names are the same
// string once you stop counting spaces.
//
// WORD-FORM ("Swim Return" -> "Swim Returning") is what this module finds, and
// it is deliberately NOT merged automatically anywhere in the pipeline — see
// preview.js's whitespaceInsensitiveName note. No deterministic rule can be
// trusted with it: "Lunch 1" and "Lunch 2" differ by as little as these do, and
// a wrong merge malforms generation. So this module only ever PROPOSES, and a
// director decides.
//
// That makes PRECISION the whole design goal, which inverts the bias every
// other inference module in this directory carries. fixedEvents.js and
// multiBlockCandidates.js over-include on purpose (a wrong proposal costs one
// untick). Here a wrong proposal costs a director a judgement call about two
// names that were never related — a question they should not have been asked,
// on a screen whose entire job is to be trustworthy. So the rule is narrow by
// construction: one name must be EXACTLY the other plus a grammatical suffix.
//
// Promoted from the read-only detector in scripts/ingest-sweep.mjs, which has
// been printing exactly these for developers while no product surface showed
// them to anyone.

// Compared space- and case-insensitively, so "classroom"/"Classrooms" pair and
// a stray space cannot hide a variant. This mirrors whitespaceInsensitiveName
// (preview.js) rather than importing it, because that module is about identity
// for dedup and this is about similarity for proposal — same transformation
// today, different reasons to change.
const foldKey = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '')

// The suffixes a camp actually types: plurals, past tenses, gerunds, and the
// doubled-consonant spellings of the latter two ("Returning" is stem + "ning"
// only if you split before the doubled n). Anything else — "Artistry" on "Art",
// a number, a second word — is a different name.
const WORD_ENDING = /^(s|es|ed|d|ing|ning|ping|ting|ring|ging)$/

// Below this, a "stem" is too short for a shared prefix to mean anything.
const MIN_STEM_LENGTH = 4

/**
 * @param {Array<{name: string, count?: number}>} namesWithCounts
 *        every distinct name seen in one import, with how often it occurred.
 * @returns {Array<{canonical: string, variant: string, canonicalCount: number, variantCount: number}>}
 *        one entry per proposed merge, never both directions of a pair.
 *        `canonical` is the spelling to keep. Deterministically ordered.
 */
export function findNameVariantCandidates(namesWithCounts = []) {
  const entries = []
  const seenKeys = new Set()
  for (const item of namesWithCounts) {
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    if (!name) continue
    const key = foldKey(name)
    // A list that already contains two spellings folding to the SAME key is
    // the whitespace/case case, which is not ours — the upstream canonical map
    // owns it. Keep the first and move on rather than proposing a merge that
    // has already happened by the time anyone could answer.
    if (!key || seenKeys.has(key)) continue
    seenKeys.add(key)
    entries.push({ name, key, count: Number.isFinite(item?.count) ? item.count : 0 })
  }

  const out = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]
      const b = entries[j]
      // Identify which is the stem: one key must be a strict prefix of the
      // other, and what remains must be a word ending on its own.
      const [shortEntry, longEntry] = a.key.length <= b.key.length ? [a, b] : [b, a]
      if (shortEntry.key.length < MIN_STEM_LENGTH) continue
      if (!longEntry.key.startsWith(shortEntry.key)) continue
      const tail = longEntry.key.slice(shortEntry.key.length)
      if (!WORD_ENDING.test(tail)) continue

      // Frequency decides which spelling survives — the camp's own dominant
      // usage, the same principle buildActivityNameCanonicalMap elects by. The
      // stem is NOT automatically right: a camp that wrote "Swim Returning"
      // twelve times and "Swim Return" once means the former.
      let canonical = shortEntry
      let variant = longEntry
      if (longEntry.count > shortEntry.count) {
        canonical = longEntry
        variant = shortEntry
      }
      out.push({
        canonical: canonical.name,
        variant: variant.name,
        canonicalCount: canonical.count,
        variantCount: variant.count,
      })
    }
  }

  // Deterministic: the same import must ask the same questions in the same
  // order however the upstream name list happened to be ordered.
  out.sort((x, y) => x.canonical.localeCompare(y.canonical) || x.variant.localeCompare(y.variant))
  return out
}
