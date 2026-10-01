import { randomUUID } from 'node:crypto'
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
//
// WHAT THIS DOES NOT GUARANTEE (Red Hat, T265 round 3). An unbumped V does
// NOT mean "this encoding has been stable." deriveElectivePreferenceId's own
// shape changed TWICE on this branch under this same V = 1: the 3-component
// form inherited from `main`, to a 4-component occurrence-required form
// (T265 round 1), to the 5-component two-arm form (round 5, this file's own
// comment on that function). Each change was judged, on this branch, as
// acceptable without a bump because this repo has no LIVE camp data
// anywhere to re-key. That defence covers a fresh production database. It
// does NOT cover a developer's own local `shoresh-dev` database that already
// ran an elective commit on an earlier round of this branch, or a paired
// device holding an Automerge document with an earlier round's ids already
// written — those ids are now stale and will not match a freshly-derived id
// for the same logical row. A reader must not infer stability from an
// unbumped V on this branch; check the git history of this function's own
// body, not just this constant, before assuming two ids from different
// points in this branch's history are comparable.
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

export function opaque(name, value) {
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

// A component that is not opaque. (It was the ONE such component until T279
// round 2 added the coordinate pair; see coordinateComponents below, which is
// admitted on the same terms and shares this canonicalizer.)
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

// Key: (camp_id, submission + arrival), (camp_id, external_id) or
// (camp_id, name key). Owner-approved 2026-09-18 (T226).
//
// Keyed on the CAMP, not a run: a camper persists across assignment runs, and
// re-importing next week's sheet must land on the same child.
//
// THREE KEY MODES, and the mode is part of the key. `external_id` is correct
// whenever the sheet carries one — a camp-management export does, a paper form
// does not — and it survives a spelling correction to the name, which a
// name-keyed id cannot. Without one we fall back to the normalized display
// name, which is the only thing always present. A PROVISIONAL SUBJECT has
// neither: see the `sub` mode below.
//
// The mode tag ('sub' / 'ext' / 'name') is not decoration: without it a camper
// whose external_id is the literal string 'Ari Green' would derive the same id
// as a camper named Ari Green, and one child would silently become the other.
//
// WHAT THIS DELIBERATELY DOES NOT SOLVE. Two real children with the same name
// and no external id collapse onto ONE id. That is not a bug to be fixed here
// by adding an ordinal — a row ordinal breaks the moment a director re-sorts
// the sheet, trading a visible collision for a silent fork on re-import. The
// importer surfaces same-name campers to the director as an explicit decision
// instead (T226). Convergence is preserved either way: both devices derive the
// same id from the same sheet, which is what the merge machinery needs.
//
// THE `sub` MODE (T299) — a PROVISIONAL SUBJECT, from a planner grid with no
// name column, keyed on (submission, arrival).
//
// It used to borrow the `ext` arm, passing the submission's content hash where
// a camp roster id belongs. That made a provisional subject's identity a pure
// function of the sheet's CONTENT, and two children who picked the same
// activities — archery and swim, at a camp offering eight things — collapsed
// onto ONE camper row holding both children's answers. Confirmed by execution,
// not inference: `submissionKeyFromRows` returns the same key for two
// byte-identical row sets, so `deriveCamperId` returned the same id.
//
// The fix is NOT entropy in the key. Three different truths produce identical
// bytes — two children who agree, one child's sheet sent twice, a copy-paste
// error in the source — and the SECOND is the behaviour the content key exists
// to produce: re-importing the same submission must converge rather than
// accumulate duplicates. An ordinal or a timestamp here would separate the two
// children and ALSO fork a retry, which is exactly the trade this module's
// comment above warns about.
//
// So the key carries the one fact that genuinely differs, and it is not a
// property of the bytes at all: WHICH IMPORT THIS SUBMISSION ARRIVED IN. Two
// children handing in matching sheets are two import actions; one import action
// repeated is one arrival. The caller states it, because only the caller knows
// — the director's panel mints one per file selection, and on the machine path
// an agent declares one per submission (T303: `arrival_id` on
// preference_sheet_preview/commit, `arrivalId` on runPreferenceSheetCli).
//
// A MACHINE CALLER THAT DECLARES NOTHING falls back to the run id derived from
// the file's bytes, which is what keeps an agent's retry after an ambiguous
// timeout idempotent (deriveImportedElectiveRunId). That fallback cannot
// separate two children who chose the same activities — under it, identical
// bytes ARE one submission arriving once — so the import reports
// INDISTINGUISHABLE_SUBMISSION when it lands on a submission already imported
// rather than merging in silence. The fallback is a stated default, not a guess.
//
// ORDERING WITHIN ONE IMPORT IS NOT THE SAME FACT and is not used here. A
// position — row ordinal, sheet index — describes how the file happened to be
// sorted, not whose sheet it is, and re-sorting the file would re-key the child.
// Arrival is a fact about the submission; ordering is a fact about the page.
//
// `arrivalId` is REQUIRED with a submission key rather than defaulting to
// content-only, and it throws in the style of `deriveElectivePreferenceId`'s
// coordinate guard. A default would silently restore the collision for any
// caller that forgot to say which import it was performing — writing a value we
// could not resolve without saying so, which is this ticket's own defect class
// reappearing at our own API boundary.
//
// A `sub`-mode id can never equal an `ext`- or `name`-mode id: the mode tags are
// distinct length-prefixed literals and the component counts differ. So naming a
// subject (electron/ops/attributeElectiveSubject.js) is always a rekey onto a
// canonical id, and naming TWO subjects the same child merges them there — which
// is why this ticket adds no second merge mechanism.
export function deriveCamperId(
  campId,
  { submissionKey = null, arrivalId = null, externalId = null, displayName = null } = {}
) {
  // Checked FIRST because it is the most specific mode: a provisional subject
  // carries a filename as its `displayName` and no roster id at all, so falling
  // through to `name` would key one child on another's filename.
  const submission = String(submissionKey ?? '').trim()
  const arrival = String(arrivalId ?? '').trim()
  if (submission.length > 0) {
    if (arrival.length === 0) {
      throw new Error(
        'electiveDerivedIds: a provisional subject keyed on a submission needs an arrivalId — the ' +
          'import it arrived in. Without one, two children whose sheets happen to match collapse ' +
          'onto one camper (T299).'
      )
    }
    return `camper${V}:${join([
      opaque('camp_id', campId),
      'sub',
      opaque('submission_key', submission),
      opaque('arrival_id', arrival),
    ])}`
  }

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

// ADR docs/adr/2026-10-01-camper-id-high-entropy-format.md, Option B.
//
// `deriveCamperId` above is REPURPOSED by that ADR, not discarded: its output is
// now only the id of a `camper_identity_keys` LOOKUP row (camp_id/key_mode/
// key_value -> camper_id), never `campers.id` directly. `campers.id` for every
// newly-created camper is this function's output instead — an opaque, random,
// high-entropy token that carries no information about the camper (no name, no
// external id, nothing derivable), so a purged camper's id reveals nothing about
// who they were even before `camper_identity_keys`' own purge/tombstone handling
// runs.
//
// `camper2:` (not `camper1:`, the prefix `deriveCamperId` still produces) is
// deliberate and visually load-bearing during the pre-production transition: a
// row whose id still reads `camper1:...name...` is pre-ADR data a developer's
// local dev database may still hold (see the ADR's "Tombstones & digest keys
// already written" section — existing campers.id values are NOT re-keyed by the
// migration), while `camper2:` marks every camper actually minted under this
// scheme. This is not a parsing contract (see the prohibition at the top of this
// file) — nothing may recover a camper by inspecting the string.
export function mintCamperId() {
  return `camper2:${randomUUID()}`
}

// Key: (camp_id, source_sha256). FOR THE SHEET-IMPORT PATH ONLY.
//
// WHY. Every id below is run-scoped, so a run id that is freshly minted per
// commit re-mints every choice and every preference under it. A resent sheet
// therefore duplicated the whole run — campers converged (their ids key on the
// camp) while runs, choices and preferences did not, which is precisely the
// two-device convergence ADR D4 requires of this substrate.
//
// The semantics this buys, exactly: committing the SAME BYTES twice converges
// onto ONE run with the same choices and preferences — an idempotent
// re-import, which is what a retry after an ambiguous MCP timeout wants.
// Committing a CORRECTED sheet (different bytes) is a NEW run, which is right
// because it is a different document, and the director wants both on record.
//
// NOT a change to commitElectiveRun's default. The renderer's solve path must
// keep minting a random run id: a solve has no document identifying it, and two
// solves of the same inputs are legitimately two runs. This is a caller-side
// decision, and only the import caller can make it.
export function deriveImportedElectiveRunId(campId, sourceSha256) {
  return `erun${V}:${join([opaque('camp_id', campId), opaque('source_sha256', sourceSha256)])}`
}

// A CAMP SEEDLING — a remembered column mapping. Key: (camp_id, kind, match_key).
// T312, and the derivation is the ruling rather than a convenience.
//
// This entity REPLICATES (owner ruling 2026-09-29, ADR §6.3), and conflict
// detection is keyed per (entity, entity_id, field). So two devices confirming
// DIFFERENT readings of the SAME form must land on the same id, or the merge
// records no conflict, both rows survive, and an arbitrary one wins — the exact
// shape D4's derived assignment id exists to prevent, one entity over. Minting
// this per confirmation with randomUUID would look correct on one device and
// lose a director's decision silently on two.
//
// `matchKey` is the output of headerMatchKey (src/ingest/mappingSeedling.js),
// which is `hdr-` plus hex — it passes `opaque()` for the same reason
// `sourceSha256` does above, and for the same reason it must: a raw header
// string carries whitespace and punctuation and would be rejected here, which is
// the guard doing its job rather than an obstacle to route around. Header text
// reaches an id ONLY through that normalising digest.
//
// A NEW PER-KIND PREFIX at version 1, deliberately not a bump of the module-wide
// `V`: that constant is shared by eight other id kinds including camper ids, and
// moving it would re-derive every one of them. Same reasoning as `epref2:`.
export function deriveCampSeedlingId(campId, kind, matchKey) {
  return `seed1:${join([
    opaque('camp_id', campId),
    opaque('kind', kind),
    opaque('match_key', matchKey),
  ])}`
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

// Key: (run_id, camper_id, occurrence_id, choice_id).
//
// Owner ruling R1 (2026-09-17): this was the spec's key, NOT ADR D4's
// (run_id, camper_id, occurrence_id, activity_id) — D12, written later in the
// same document, moved preferences to point at a CHOICE, and at the time the
// row had no occurrence_id or activity_id column to key on. A correction note
// is appended to D4 recording the drafting order.
//
// SUPERSEDED, NOT CONTRADICTED (T265, v78, docs/adr/2026-09-26-per-cell-
// elective-preferences.md Decision 1). R1's own stated condition — "the row
// has no occurrence_id column" — no longer holds: elective_preferences gained
// occurrence_id at schema v78 because a director's ranking CAN BE per (day,
// period) cell. A linked choice spans multiple occurrences, and a camper can
// rank it differently per cell; the 3-tuple key collapsed every such row onto
// one id (T251's fixture measured 177 such collisions across 429 rows).
//
// ROUND 5 AMENDMENT — occurrence_id is OPTIONAL, not required. Owner ruling,
// verbatim: "we are reading someone's data. we are not choosing how they
// import it." A real camp produces both a per-cell grid AND a single
// whole-run ranked list (docs/adr/2026-09-17-individual-elective-scheduling.md
// :481), and this app does not get to prefer one. A row naming an
// occurrence_id is scoped to that cell; a row with none is a WHOLE-RUN
// FALLBACK, and `occurrenceId` here is `null` for it — never coerced to a
// placeholder string, which would let a fallback collide with (or be
// mistaken for) a real occurrence.
//
// TWO DERIVATION ARMS, not one arm with a sentinel occurrence value. A
// sentinel string occupying the SAME component slot as a real occurrence_id
// can only be guaranteed collision-free by restricting the alphabet real
// occurrence ids may use — a constraint this module cannot impose on
// `deriveElectiveOccurrenceId`'s callers. Instead the two arms differ in
// STRUCTURE: the scoped arm emits a literal 'occ' tag followed by the
// occurrence component; the fallback arm emits a literal 'all' tag with NO
// occurrence component at all. `join` is length-prefixed and therefore
// decodes deterministically component-by-component — two component
// SEQUENCES that differ in their tag value ('occ' vs 'all', which can never
// be equal strings) or in their component COUNT (5 vs 4) cannot encode to
// the same string, regardless of what any occurrence_id, camper_id or run_id
// value happens to be. This is the same injectivity argument `join`'s own
// comment makes for length-prefixing in general — it is not a new,
// unverified property of this function, and does not depend on trusting any
// particular sentinel value to stay unused.
//
// A COORDINATE component (T279 round 2, owner ruling): a (day label, period
// label) pair as WRITTEN ON THE SOURCE FILE.
//
// This is the SECOND family of non-opaque components in this module, so the
// claim above that the choice label is "the ONE component that is not opaque"
// is corrected rather than left standing. It is admitted on exactly the same
// terms: `join` is length-prefixed and therefore provably injective whatever
// the component contains, so free text cannot forge a collision — the OPAQUE
// guard buys normalization-skew resistance, not injectivity.
//
// And the skew is handled the same way the choice label handles it, by the SAME
// canonicalizer rather than a second normalization rule: `electiveChoiceLabelKey`
// lowercases and strips whitespace, so 'Monday'/'monday'/' Monday ' are one
// coordinate and not three. A second rule here is exactly the drift this
// module's "throwing rather than escaping" comment refuses.
//
// The two halves are passed as SEPARATE components, never concatenated, so
// ('Monday 1', '') and ('Monday', '1') cannot collide.
function coordinateComponents(dayLabel, periodLabel) {
  return [
    'at',
    electiveChoiceLabelKey(dayLabel ?? ''),
    electiveChoiceLabelKey(periodLabel ?? ''),
  ]
}

// PREFERENCE DERIVATION VERSION, separate from the module-wide V — and the
// separation is deliberate, not laziness.
//
// T279 round 2 changed this function's shape (a third, coordinate-scoped arm),
// and the owner's instruction was to bump deliberately and say so rather than
// let the shape drift silently under an unbumped version, as this module's own
// comment on V warns has already happened twice. Bumping the module-wide V would
// have done that — but V is shared by EIGHT id kinds including `camper${V}`, so
// bumping it re-keys every CAMPER id in the database, and camper ids are
// referenced by assignments and attendance. That is a blast radius this change
// has not earned. A per-kind version re-keys exactly the rows whose shape
// changed and nothing else, which is what the V comment's own words ("re-keying
// of every row OF THAT KIND") describe.
//
// Pre-production: no live camp data anywhere to re-key. A developer's local
// shoresh-dev database that already ran an elective commit holds `epref1:` rows
// that will not match a freshly-derived id — stated rather than glossed, per the
// V comment's warning about exactly that case.
const PREFERENCE_V = 2

// UNIQUENESS (Governor round-5 requirement, EXTENDED in T279 round 2): THREE
// arms, in descending strength of scope, because a preference can be scoped by
// two different kinds of fact.
//
//   'occ' — an occurrence_id: a cell of ONE particular candidate schedule. Two
//           different occurrences derive two different ids.
//   'at'  — a COORDINATE as read off the file: what the CHILD asked for. Two
//           different cells derive two different ids EVEN WITH NO TEMPLATE, which
//           is the whole point of the arm.
//   'all' — neither: the whole-run fallback. Every fallback preference for one
//           (run, camper, choice) derives the SAME id, so a second whole-run
//           ranking of the same choice overwrites the first rather than creating
//           a second row.
//
// WHY THE 'at' ARM HAD TO EXIST. Without it, a per-cell sheet imported before
// any schedule exists had occurrence_id NULL on every row, fell into 'all', and
// two cells naming one activity collapsed onto one id — the importer discarding
// a child's answer because it could not yet express it as a row. ADR §3.1 always
// said the record "names a coordinate (day, period), never an occurrence_id";
// this is storage finally matching the record.
//
// The arms cannot collide with each other: 'occ', 'at' and 'all' are distinct
// length-prefixed literals.
export function deriveElectivePreferenceId(runId, camperId, occurrenceId, choiceId, coordinate = null) {
  // STRICT AT THE INSIDE, permissive at the outside.
  //
  // ADR §14.1 rules that the CLI and the MCP tools must never refuse a file they
  // can read. That governs what this software does with a DIRECTOR'S or an
  // AGENT'S FILE; it says nothing about a malformed INTERNAL CALL, and reading it
  // as though it did would be expensive here. A coordinate object whose
  // properties are misspelled or renamed is a programming error, not camp data.
  //
  // What this guard closes, confirmed by execution rather than inspection:
  // `{ wrongKey: 'Monday', other: 'Period 3' }` and
  // `{ wrongKey: 'Friday', other: 'Period 6' }` both fell through to the 'all'
  // arm and derived the IDENTICAL id, indistinguishable from passing no
  // coordinate at all. A caller with a typo therefore got whole-run FALLBACK
  // rows while believing it had passed a coordinate — silently re-merging exactly
  // what the 'at' arm was added to keep apart. That is this ticket's own defect
  // class (writing a value we could not resolve, without saying so) reappearing
  // at our own API boundary, so it throws in the style of `opaque()` rejecting a
  // malformed component rather than quietly encoding it.
  //
  // PRESENCE OF THE KEY, NOT ITS VALUE, is what is required. A single-day sheet
  // (periods only, no day axis) legitimately passes `dayName: null`, and that
  // must keep working — it is pinned in the frozen vectors precisely so nobody
  // "fixes" this throw by rejecting null legs and breaks every real single-day
  // sheet. A coordinate with both keys present and both null says "this row has
  // no cell", which is the whole-run fallback, and is allowed through.
  if (coordinate != null) {
    const shaped =
      typeof coordinate === 'object' && ('dayName' in coordinate || 'periodLabel' in coordinate)
    if (!shaped) {
      throw new Error(
        'electiveDerivedIds: coordinate must be an object carrying dayName and/or periodLabel ' +
          '(ADR 2026-09-27 §3.1\u2019s canonical record) — pass null for no coordinate rather than ' +
          'an object this function cannot read, which would silently derive a whole-run fallback id'
      )
    }
  }

  const hasCoordinate = coordinate != null && (coordinate.dayName != null || coordinate.periodLabel != null)
  const scope = occurrenceId != null
    ? ['occ', opaque('occurrence_id', occurrenceId)]
    : hasCoordinate
      ? coordinateComponents(coordinate.dayName, coordinate.periodLabel)
      : ['all']
  return `epref${PREFERENCE_V}:${join([
    opaque('run_id', runId),
    opaque('camper_id', camperId),
    ...scope,
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

// LINKED ELECTIVE BUNDLE CHOICE derivation version (T301,
// docs/adr/2026-09-29-linked-elective-bundles.md D3), separate from V and
// PREFERENCE_V for the same reason PREFERENCE_V is separate from V: a
// different id kind with its own shape, and bumping the shared V would
// re-key camper ids along with everything else V governs.
const BUNDLE_CHOICE_V = 1

// Key: (run_id, bundle_id, tier_id). A linked bundle's per-tier expansion
// (T301, ADR D3). Keyed on the bundle's own opaque, never-renamed id — NOT
// its label — so renaming a bundle never re-keys its choices, and two
// bundles of one activity that transiently share a label (decision 3 permits
// more than one bundle per activity) still derive distinct ids. Every
// component is an opaque surrogate (run_id, bundle_id, tier_id are all
// randomUUID-derived), so the result matches OPAQUE and needs no carve-out in
// derivedChoiceId() the way the label-keyed deriveElectiveChoiceId needed
// CHOICE_ID_PREFIX — smaller blast radius, and the reason this is its own
// function rather than a tier parameter grafted onto deriveElectiveChoiceId,
// which would also break R2's contract that that function's key is exactly
// (run_id, normalized label).
export function deriveLinkedElectiveChoiceId(runId, bundleId, tierId) {
  return `elbc${BUNDLE_CHOICE_V}:${join([
    opaque('run_id', runId),
    opaque('bundle_id', bundleId),
    opaque('tier_id', tierId),
  ])}`
}
