// Ask a question once, however many times the file raises it.
//
// Importing one real camp file produced 240 buttons on one screen, and most of
// them were the same question over and over: 25 identical "This looks like an
// elective period. Create an empty 'Indoor Elective' elective set?" cards, and
// 49 identical "Use this value / Keep current" pairs. Nothing on screen told
// them apart, so a director answering the twenty-fifth could not have answered
// it differently from the first even if they wanted to.
//
// Two decisions are the same QUESTION when they render the same words and the
// same options: same kind, same entity, same reason sentence. `reason` is the
// text the card puts in front of the director, so equal reasons means they were
// literally being asked the same thing.
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

function signatureOf(decision) {
  return JSON.stringify([decision?.kind ?? null, decision?.entity ?? null, decision?.reason ?? null])
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
    if (existing) existing.ids.push(decision.id)
    else groups.set(key, { decision, ids: [decision.id] })
  }
  return [...groups.values()].map((g) => ({ ...g, count: g.ids.length }))
}
