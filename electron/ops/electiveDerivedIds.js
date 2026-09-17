// Deterministic id derivation for the individual-elective participant
// entities (ADR docs/adr/2026-09-17-individual-elective-scheduling.md D4,
// designed in docs/work/specs/2026-09-17-t194-participant-substrate-design.md
// §2).
//
// WHY THIS EXISTS. `UNIQUE_FIELD_ENTITIES` (electron/ops/operations.js)
// expresses only single-column uniqueness, so a composite like
// (run_id, camper_id, occurrence_id) cannot be registered. Without a derived
// id, two devices generating the same draft run mint two rows with DIFFERENT
// ids; those are two independent Automerge map keys, so the merge records no
// conflict, both rows survive, and a camper is silently assigned twice. Making
// the id a function of the key makes the duplicate unrepresentable before it
// reaches SQLite — the write becomes an ordinary per-field last-write-wins on
// one record, which the existing conflict machinery already serializes.
//
// WHY IT LIVES UNDER electron/. electron-builder's `files` list (package.json)
// ships only `electron/**`, `dist/**` and `package.json` — `src/` is NOT
// packaged. An electron-side import of a src/ module works under
// `npm run electron:dev` and fails in the INSTALLED app, at migration time, on
// a real database. The v66 migration calls this module, so the same constraint
// binds. See electron/ops/scheduleTemplateId.js's header, which records the
// same rule. The renderer may import in this direction safely (Vite bundles
// this pure module into dist/).
//
// It is a SEPARATE module from scheduleTemplateId.js rather than an addition
// to it: that file carries a load-bearing back-compat contract about its
// one-argument form that the v21 migration depends on.
//
// THESE IDS ARE NOT A PARSING CONTRACT. The components are legible in a SQLite
// shell deliberately, for diagnosis — but nothing may recover a run, a camper
// or an occurrence by inspecting the string. The row's own `run_id`,
// `camper_id` and `occurrence_id` columns are the only authority. Same rule
// scheduleTemplateId.js states for its ':manual' suffix.

// Derivation version. Bumping it is a deliberate, visible re-keying of every
// row of that kind — it is not a free change.
const V = 1

// Length-prefixed concatenation, NOT a hash.
//
// Length prefixing is provably injective: the string is uniquely decodable, so
// distinct component tuples cannot produce the same id. Plain delimiter joining
// (the deriveScheduleTemplateId precedent) is injective only because its
// components happen never to contain the delimiter — an accident, not a
// property. A hash would also be injective in practice but carries a non-zero
// collision surface on the least debuggable failure in this feature, needs
// node:crypto in a module the migration loads, and destroys shell
// debuggability. The cost paid here is that the id LOOKS parseable; see the
// prohibition above.
function join(components) {
  return components.map((c) => `${c.length}.${c}`).join('')
}

// Every component of every derivation except the choice label is an opaque
// surrogate id minted by crypto.randomUUID() (or itself derived). Restricting
// them to the uuid/slug alphabet closes delimiter injection and
// Unicode-normalization skew AT THE SOURCE rather than mitigating it.
//
// Throwing rather than escaping is deliberate: an escape function is a second
// normalization rule that can drift between app versions; a throw cannot. The
// preference importer (T195) is responsible for resolving human input to ids
// BEFORE an id is derived here.
// uuid + slug alphabet, PLUS ':' and '.'.
//
// Those two are here because THESE IDS COMPOSE: an offering's key contains a
// derived CHOICE id, and a preference's contains one too. A derived id is
// `echo1:5.run-112.swimadvanced`, so an alphabet of [A-Za-z0-9_-] would reject
// the function's own output and make the composition in §2.3 unbuildable. The
// integration scenario caught this; the unit tests could not, because each one
// passed a hand-written flat id.
//
// Admitting them costs nothing. Injectivity does NOT depend on the delimiter
// being absent from components — that is the entire reason for length-prefixing
// (see `join`), and it is what separates this from the deriveScheduleTemplateId
// precedent. What the guard actually buys is keeping WHITESPACE, punctuation
// and non-ASCII — i.e. human free text, where Unicode-normalization skew lives
// — out of every key component. It still does that: no space, no '&', no
// combining mark, no zero-width character passes.
const OPAQUE = /^[A-Za-z0-9_.:-]+$/

function opaque(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`electiveDerivedIds: component ${name} must be a non-empty string`)
  }
  if (!OPAQUE.test(value)) {
    throw new Error(
      `electiveDerivedIds: component ${name} must be an opaque id matching [A-Za-z0-9_.:-]+`
    )
  }
  return value
}

// The ONE component that is not opaque.
//
// Owner ruling R2 (2026-09-17): elective_choices keys on the normalized label,
// not on its member activities. Editing a choice's members therefore keeps the
// same choice, and campers' existing preferences stay attached — stability
// under member edits was chosen over key purity. That makes the label
// load-bearing, and the canonicalizer below is the single authority on it.
//
// The label key cannot be validated against OPAQUE: a real camp label is
// 'Arts & Crafts' or a Hebrew name, and its canonical key keeps those
// characters. It is validated instead by the only rule that matters for
// convergence — that it is the canonicalizer's OWN output. Passing a raw label
// is the mistake that would let two devices key the same choice differently,
// so it throws rather than being silently accepted. Injectivity does not depend
// on this check: `join` is injective over arbitrary strings.
function labelKeyComponent(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('electiveDerivedIds: label key must be a non-empty string')
  }
  if (value !== electiveChoiceLabelKey(value)) {
    throw new Error(
      'electiveDerivedIds: label key must be the output of electiveChoiceLabelKey(), not a raw label'
    )
  }
  return value
}

// Canonical spelling of the choice-label key.
//
// This re-spells src/ingest/preview.js's `whitespaceInsensitiveName` rather
// than importing it, because this module must stay reachable from a packaged
// build (see the header) and src/ is not packaged. The two are held in
// agreement by electron/ops/electiveChoiceLabelKey.keyParity.test.js, following
// the src/engine/anchorActivityLink.keyParity.test.js precedent — a comment
// cannot fail a build, and that test can.
//
// SEMANTICS, DELIBERATE: whitespace is DELETED, not collapsed to one space, so
// 'Swim Advanced' and 'SwimAdvanced' are the SAME choice. For locations that
// rule was rejected (src/ingest/locationsFromActivities.js:33) because a
// missing space there is a different room. For an elective choice label inside
// ONE run it is the right rule: a director does not offer two distinct
// electives whose names differ only in spacing, whereas two devices importing
// the same sheet very plausibly differ in exactly that. Colliding them is the
// convergence this key exists to produce. It does NOT normalize Unicode
// confusables, NFD/NFC or zero-width characters — those still produce distinct
// choices, asserted in the test corpus rather than assumed away.
export function electiveChoiceLabelKey(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
}

// Key: (run_id, elective_set_id, day_id, time_block_id, tier_id).
export function deriveElectiveOccurrenceId(runId, electiveSetId, dayId, timeBlockId, tierId) {
  return `eocc${V}:${join([
    opaque('run_id', runId),
    opaque('elective_set_id', electiveSetId),
    opaque('day_id', dayId),
    opaque('time_block_id', timeBlockId),
    opaque('tier_id', tierId),
  ])}`
}

// Key: (run_id, normalized label). See labelKeyComponent and R2 above.
export function deriveElectiveChoiceId(runId, labelKey) {
  return `echo${V}:${join([opaque('run_id', runId), labelKeyComponent(labelKey)])}`
}

// Key: (choice_id, occurrence_id, activity_id).
export function deriveElectiveChoiceOfferingId(choiceId, occurrenceId, activityId) {
  return `ecof${V}:${join([
    opaque('choice_id', choiceId),
    opaque('occurrence_id', occurrenceId),
    opaque('activity_id', activityId),
  ])}`
}

// Key: (run_id, camper_id, choice_id).
//
// Owner ruling R1 (2026-09-17): this is the spec's key, NOT ADR D4's
// (run_id, camper_id, occurrence_id, activity_id) — D12, written later in the
// same document, moved preferences to point at a CHOICE, and the row has no
// occurrence_id or activity_id column to key on. A correction note is appended
// to D4 recording the drafting order.
export function deriveElectivePreferenceId(runId, camperId, choiceId) {
  return `epref${V}:${join([
    opaque('run_id', runId),
    opaque('camper_id', camperId),
    opaque('choice_id', choiceId),
  ])}`
}

// Key: (run_id, camper_id, occurrence_id). The uniqueness invariant of the
// whole feature (ADR D4). activity_id is deliberately NOT in the key: re-placing
// the same camper in the same occurrence must hit the SAME row.
export function deriveElectiveAssignmentId(runId, camperId, occurrenceId) {
  return `easgn${V}:${join([
    opaque('run_id', runId),
    opaque('camper_id', camperId),
    opaque('occurrence_id', occurrenceId),
  ])}`
}
