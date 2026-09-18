import { whitespaceInsensitiveName } from '../../src/ingest/preview.js'

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
// WHY IT LIVES UNDER electron/. It is projection-layer and migration-layer
// machinery, alongside the PROJECTIONS registry and scheduleTemplateId.js that
// it sits next to; the renderer imports it in the same direction it imports
// other electron/ops primitives. It is NOT here because of a packaging
// constraint — round 1 of this ticket said so, wrongly, and that claim is
// corrected here and in scheduleTemplateId.js. electron-builder's `files` list
// is ['electron/**/*', 'dist/**/*', 'src/**/*', 'package.json']: src/ IS
// packaged (added to fix a packaged ERR_MODULE_NOT_FOUND), and ten electron/
// modules already import from src/ in shipped code — electron/ops/ingest.js
// imports from src/ingest/preview.js, the very module this one shares its
// canonicalizer with.
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

// A DERIVED CHOICE ID used as a component of another derivation.
//
// Round-2 H3. `deriveElectiveChoiceId`'s output contains a choice LABEL KEY,
// and `electiveChoiceLabelKey` only lowercases and deletes whitespace — it does
// not restrict the alphabet, deliberately (see its comment). So a choice id for
// 'Arts & Crafts' is `echo1:5.run-113.arts&crafts`, and for a Hebrew label it is
// Hebrew. Neither matches OPAQUE. Feeding that id to `opaque()` threw, which
// made the offering and preference derivations unusable for every label outside
// [A-Za-z0-9_.:-] — i.e. for the normal case at a Hebrew-named camp.
//
// The fix is NOT to widen OPAQUE. OPAQUE guards the true surrogate components
// (run_id, camper_id, activity_id, day_id, …), where keeping whitespace,
// punctuation and non-ASCII out closes Unicode-normalization skew at the
// source; that purchase is worth keeping. This validator is narrower: a
// choice_id component must either be this module's OWN choice-id output, or an
// opaque surrogate (which is what a hand-written test id and any future
// non-derived choice id look like). A raw human label is still refused, loudly,
// because passing one is the mistake that would let two devices key the same
// choice differently.
//
// Injectivity is unaffected either way: `join` is length-prefixed and therefore
// injective over arbitrary strings, which is the whole reason it is not a plain
// delimiter join. Nothing about the alphabet is load-bearing for convergence.
const CHOICE_ID_PREFIX = `echo${V}:`

function derivedChoiceId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('electiveDerivedIds: component choice_id must be a non-empty string')
  }
  if (value.startsWith(CHOICE_ID_PREFIX)) return value
  if (OPAQUE.test(value)) return value
  throw new Error(
    'electiveDerivedIds: component choice_id must be a derived choice id (deriveElectiveChoiceId) ' +
      'or an opaque id matching [A-Za-z0-9_.:-]+ — not a raw label'
  )
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
// This IS `whitespaceInsensitiveName` — imported, not re-spelled. Round 1 kept
// a second copy here and justified it with a packaging claim that is false (see
// the header); with that reason gone there is nothing left to pay a duplicated
// normalization rule for, and a single definition cannot drift. The wrapper
// survives because the NAME is the contract: this is the choice-label key, and
// every call site should say so.
//
// SEMANTICS, DELIBERATE: whitespace is DELETED, not collapsed to one space, so
// 'Swim Advanced' and 'SwimAdvanced' are the SAME choice. For locations that
// rule was rejected (src/ingest/locationsFromActivities.js:33) because a
// missing space there is a different room. For an elective choice label inside
// ONE run it is the right rule: a director does not offer two distinct
// electives whose names differ only in spacing, whereas two devices importing
// the same sheet very plausibly differ in exactly that. Colliding them is the
// convergence this key exists to produce.
//
// WHAT IT DOES NOT CLOSE, asserted in the test corpus rather than assumed away:
// Unicode confusables, NFD vs NFC, and zero-width characters all still produce
// DISTINCT choices. One more, found in round 2: lowercasing runs BEFORE
// whitespace is stripped, so Greek final sigma makes the key non-injective
// across a space boundary — 'ΣΟΦΟΣ ΣΟΦΟΣ' keys as 'σοφοςσοφος' while
// 'ΣΟΦΟΣΣΟΦΟΣ' keys as 'σοφοσσοφος', which the "missing space is the same
// choice" rule says should collide. Left as-is deliberately: the operation
// order is `whitespaceInsensitiveName`'s, shared repo-wide by ten call sites,
// and changing it here alone would re-key every choice for a case that cannot
// arise in a Hebrew/English camp's elective labels.
export function electiveChoiceLabelKey(label) {
  return whitespaceInsensitiveName(label)
}

// Key: (camp_id, external_id) or (camp_id, name key). Owner-approved
// 2026-09-18 (T226).
//
// Keyed on the CAMP, not a run: a camper persists across assignment runs, and
// re-importing next week's sheet must land on the same child.
//
// TWO KEY MODES, and the mode is part of the key. `external_id` is correct
// whenever the sheet carries one — a camp-management export does, a paper form
// does not — and it survives a spelling correction to the name, which a
// name-keyed id cannot. Without one we fall back to the normalized display
// name, which is the only thing always present.
//
// The mode tag ('ext' / 'name') is not decoration: without it a camper whose
// external_id is the literal string 'Ari Green' would derive the same id as a
// camper named Ari Green, and one child would silently become the other.
//
// WHAT THIS DELIBERATELY DOES NOT SOLVE. Two real children with the same name
// and no external id collapse onto ONE id. That is not a bug to be fixed here
// by adding an ordinal — a row ordinal breaks the moment a director re-sorts
// the sheet, trading a visible collision for a silent fork on re-import. The
// importer surfaces same-name campers to the director as an explicit decision
// instead (T226). Convergence is preserved either way: both devices derive the
// same id from the same sheet, which is what the merge machinery needs.
export function deriveCamperId(campId, { externalId = null, displayName = null } = {}) {
  const external = String(externalId ?? '').trim()
  if (external.length > 0) {
    return `camper${V}:${join([opaque('camp_id', campId), 'ext', opaque('external_id', external)])}`
  }
  // Same canonicalizer as the choice-label key, for the same reason: two
  // devices transcribing one sheet plausibly differ in spacing or case, and
  // that must not fork the camper.
  const nameKey = electiveChoiceLabelKey(String(displayName ?? ''))
  if (nameKey.length === 0) {
    throw new Error('electiveDerivedIds: a camper needs an external_id or display_name to derive an id')
  }
  return `camper${V}:${join([opaque('camp_id', campId), 'name', nameKey])}`
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
    derivedChoiceId(choiceId),
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
    derivedChoiceId(choiceId),
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
