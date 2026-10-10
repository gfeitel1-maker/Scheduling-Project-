// Ask a question once, however many times the file raises it.
//
// Importing one real camp file produced 240 buttons on one screen, and most of
// them were the same question over and over: 25 identical "This looks like an
// elective period. Create an empty 'Indoor Elective' elective set?" cards, and
// 49 identical "Use this value / Keep current" pairs. Nothing on screen told
// them apart, so a director answering the twenty-fifth could not have answered
// it differently from the first even if they wanted to.
//
// Two decisions are the same QUESTION when they are about the same item: same
// kind, same entity, same item name. Different items are never merged — one
// answer must not silently apply to sixteen different activities. A decision
// with no item name falls back to its reason sentence, the words the card
// puts in front of the director.
//
// What this deliberately does NOT do is merge the decisions themselves. Each
// keeps its own id and its own answer is staged separately — the group is a
// presentation of several decisions, not one decision standing in for them. So
// the commit payload is identical to a director who had clicked through all
// twenty-five by hand.
//
// The evidence (which row, which column) does differ between members, and
// collapsing hides it. That is the right trade here: the card never showed the
// row or column in the first place, so the difference was not actionable — it
// was just repetition. A future card that DOES distinguish them would want to
// stop grouping, which is why the signature is built from the rendered text
// rather than from the decision kind alone.

// A decision pinned to a slot (day + block) is a different question per slot even
// for the same item, so its reason sentence (which names the slot) or its
// from/to slots stay in the key.
function signatureOf(decision) {
  const slotted = decision?.kind === 'all_camp_override'
  const who = slotted ? decision.reason : decision?.entityName ?? decision?.reason ?? null
  return JSON.stringify([decision?.kind ?? null, decision?.entity ?? null, who, decision?.from ?? null, decision?.to ?? null])
}

/**
 * @param decisions the unanswered decisions a lane is about to render
 * @returns [{ decision, ids, count }] in first-appearance order — `decision` is
 *          the first member, to render; `ids` is every member, to answer.
 */
export function groupIdenticalDecisions(decisions = []) {
  const groups = new Map()
  for (const decision of decisions) {
    const key = signatureOf(decision)
    const existing = groups.get(key)
    if (existing) { existing.ids.push(decision.id) }
    else groups.set(key, { decision, ids: [decision.id] })
  }
  return [...groups.values()].map((g) => ({ ...g, count: g.ids.length }))
}
