---
title: "Camper ids stop embedding the display name — a high-entropy id plus a replicated, purgeable name->id lookup for sheet import"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-10-01
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - SECURITY.md
related_adrs:
  - docs/adr/2026-09-17-individual-elective-scheduling.md
  - docs/adr/2026-09-19-multi-device-erasure-propagation.md
  - docs/adr/2026-09-30-elective-run-durability.md
related_specs: []
related_tickets:
  - docs/work/tickets/T233-multi-device-erasure-propagation.md
---

# Camper ids stop embedding the display name — a high-entropy id plus a replicated, purgeable name->id lookup for sheet import

**A note on the ticket number in the board item.** The board item that spawned this ADR
(`q-camper-id-embeds-display-name`) cited "T233." `T233` already names a different, implemented
ticket — `docs/work/tickets/T233-multi-device-erasure-propagation.md`, the Host-signed purge
tombstone work this ADR builds on. That citation appears to be a mix-up (the two problems are
adjacent — this ADR exists because T233's own guess-resistance analysis is what surfaced the
cleartext id as the deeper issue), not a correction to make silently. This document does not
claim a ticket number; one should be allocated via `npm run ticket:next` when this proposal is
accepted and handed to Maker.

## Context

`electron/ops/electiveDerivedIds.js`'s `deriveCamperId` has a `name` mode (used whenever a sheet
row carries no `external_id`) that returns a **length-prefixed concatenation**, not a hash:

```
camper1:8.camp_id.<len>.name.<len>.<canonicalized-display-name>
```

The function's own comment says so explicitly ("Length-prefixed concatenation, NOT a hash" —
`electiveDerivedIds.js:61-74`). `commitElectiveRun.js` (`electron/ops/commitElectiveRun.js:326`)
writes this string as `campers.id` on the sheet-import path whenever no `external_id` is present
— which is the common case for a paper-form camp.

This is not an oversight; it is undocumented-cost-not-undocumented-tradeoff. SECURITY.md already
narrates the consequence in detail (lines 501-522, "Fleet-wide reintroduction is now prevented —
logical erasure (T233)") and the `elective_assignment_runs.snapshot_digest` amendment
(`electiveRunSnapshotCompleteness.js:109-140`, dated 2026-10-01) is the second time this exact
root cause has been worked around rather than fixed:

1. **A purge tombstone names the purged camper.** `purgeCamperRecord`
   (`electron/automerge/purgeSupportCommand.js`) mints a Host-signed tombstone carrying the
   camper's `id` (`SECURITY.md:486-488`: "the purged id + entity + signature, no name, no
   reason"). When that id *is* the canonicalized display name under a length-prefix encoding, the
   tombstone itself — a document-replicated, fleet-wide, permanent record — names the purged
   child in cleartext, for an entity this app otherwise treats as deliberately minimal-footprint
   PII (SECURITY.md: "D8 fixes it at name, group and external id... Adding a column here is an
   ADR-level change").
2. **The #686 per-camper digest keys are guess-resistant, not erasure.** `digestMapKey` in
   `electiveRunSnapshotCompleteness.js:141-143` is `sha256(run_id + ':' + camper_id)`, unkeyed.
   Its own comment (lines 123-140) already states the attack this ADR is about: "a peer who
   guesses a purged camper's name can therefore rederive the id, hash it, and confirm that camper
   was in this run," and that "the erased camper's KEY is never scrubbed from a stored map (there
   is no re-finalize path), so the oracle persists for the life of the run row." That comment also
   already rejects an HMAC fix for the digest-key problem — see Option A below, which inherits the
   identical rejection for the id itself.
3. **Every log line, export, or error message that carries a camper id carries the name.** Not
   bounded to the two paths above — any code that logs, exports, or surfaces a `camper_id` for
   debugging is, on the import path, surfacing a child's name whether or not the author intended
   PII to flow through that channel.

**The constraint this id exists to satisfy (ADR D4).** `docs/adr/2026-09-17-individual-elective-
scheduling.md` D4 requires that two devices importing the *same sheet* derive the *same* camper id
with no merge conflict — a camper persists across assignment runs and a re-imported sheet next
week must land on the same child (`electiveDerivedIds.js:216-220`). A random id (`randomUUID()`)
breaks this outright: two devices would mint two different ids for the same camper, two Automerge
map keys would both survive the merge, and the camper would silently fork into two records. This
is the central tension this ADR has to resolve — any fix must **preserve convergence**, not just
remove cleartext.

**Why this needs an ADR, not a quiet fix.** `campers.id` is referenced by five columns across four
other tables, by `elective_assignment_runs.snapshot_digest` (a derived, non-FK value computed from
it), by the purge-tombstone machinery, and by `attributeElectiveSubject.js`'s rekey path. Changing
how it is minted changes a replicated, cross-device contract (every already-paired device must
derive or resolve the same id for the same real camper) and requires a schema migration with a
rollback module — this is exactly the "changes an existing contract other modules already call"
and "makes a tradeoff that isn't obviously reversible" bar from the Constitution's Art. IV ADR
gate.

## Options considered

### Option A — deterministic keyed hash (HMAC over camp secret + canonical name/external id)

`deriveCamperId`'s `name` arm becomes `HMAC-SHA256(key = camp secret, message = camp_id + canonical
name)`. Still deterministic (two devices importing the same sheet derive the same id — D4 holds),
and the id no longer *looks* like a name, closing finding (3) above (grep/log exposure) and making
the tombstone and digest-map keys opaque the same way `randomUUID()` would.

**Why this is rejected, on evidence already in this repo, not a fresh judgment call.**
`electiveRunSnapshotCompleteness.js:126-129` already analyzed exactly this fix for the sibling
digest-key problem and rejected it: *"An HMAC would not change that: its key would have to be
replicated to be recomputable, which makes it equally readable (and no fleet secret survives a
genesis rebuild here anyway)."* That reasoning transfers unchanged to the id itself:

- `deriveCamperId` must run on **every device** that imports a sheet (D4's whole point — it is not
  a server-side operation). An HMAC key usable by every device for the *same* camp is therefore a
  **replicated secret**, which this codebase has an explicit, tested rule against for signing
  material: `hostOnlyExclusion.test.js` and `campDocument.js:79-80` enumerate the fields that
  "must NEVER follow" into the replicated document, specifically `camps.signing_secret` and
  `host_signing_key`. A *new* camp-wide HMAC key either (a) joins that never-replicates set, in
  which case only the Host can derive camper ids and every Client device cannot import a sheet
  offline or before first pairing — breaking the feature for the common case — or (b) is
  deliberately replicated to every device, in which case it is exactly as recoverable by a
  malicious or compromised camp peer as the plaintext name is today, because that peer holds both
  the key and (per the threat model already accepted in SECURITY.md: "any derivation a device can
  perform, a camp peer can perform too") the ability to guess candidate names and test membership.
- `purgeCamperRecord`'s own genesis-rebuild path (`SECURITY.md:434-452`) explicitly does **not**
  preserve `camps.signing_secret` across a purge ("confirmed not preserved... the retired legacy
  HMAC field, never read, whose loss is inert") — this repo has already decided that no
  fleet-wide signing secret survives a purge/rebuild. A *new* HMAC key used for camper-id
  derivation would need the opposite property (survive every purge, since purging one camper must
  not re-key every other camper's id), which conflicts with the precedent this codebase just set
  for the one HMAC-shaped secret it already has.
- Even in the narrow case where the key genuinely never leaves the Host, Option A only closes
  finding (3) (cosmetic cleartext exposure in logs/tombstones/digest keys). It does **not** close
  finding (1) or (2) any better than a random id would, and it adds a new secret-management surface
  (rotation, loss, cross-camp uniqueness of the key itself) for a gain this repo's own prior
  analysis says is illusory under the actual threat model (a camp peer, not an outside attacker).

**Verdict: reject.** Confidence: high. The evidence is not inference about HMAC in the abstract —
it is this repo's own dated comment rejecting the identical mechanism for the identical threat
model one layer over, plus a hard architectural fact (`hostOnlyExclusion.test.js`) about what may
and may not replicate.

### Option B — random id minted once + a replicated, convergent name→id lookup (organizer's literal proposal)

`deriveCamperId`'s `name` and `ext` arms stop deriving the camper id from the name/external id at
all. Instead:

1. A camper's id is `camper2:<randomUUID()>` (or any opaque high-entropy token) — carries no
   information about the camper.
2. A new, replicated, camp-scoped entity — call it `camper_identity_keys` — holds the mapping. Its
   **own id** is `deriveCamperIdentityKeyId(campId, keyMode, keyValue)`, i.e. exactly the
   deterministic derivation `deriveCamperId` uses today (`sub`/`ext`/`name` modes, same
   canonicalizer, same opaque-component discipline), but the *row's own id* is the derived value —
   **not** `campers.id`. The row's payload is `{ camper_id: <random>, key_mode, key_value }` (or,
   for the `name` mode, just the canonical name key, since that is already the "value" being
   looked up).
3. Sheet import resolves name/external-id → camper id by **reading** this table first (by its
   deterministic id), and only mints a fresh `camper_id` + a fresh mapping row when no row exists
   for that key.

**Convergence, worked through explicitly (this is the part the task calls "the crucial
difference").** Two devices importing the *same new camper* before syncing each other: Device A
computes `keyId = deriveCamperIdentityKeyId(campId, 'name', 'ari green')`, finds no row, mints
`randomCamperIdA`, writes `camper_identity_keys[keyId] = { camper_id: randomCamperIdA, ... }` and
`campers[randomCamperIdA] = {...}`. Device B, offline, does the same and mints
`randomCamperIdB ≠ randomCamperIdA`, writing `camper_identity_keys[keyId] = { camper_id:
randomCamperIdB, ... }`. Because `keyId` is **derived identically** on both devices, both writes
target the **same Automerge map key** — this is exactly the mechanism `electiveDerivedIds.js`'s
own header comment describes for every other entity in this file ("making the id a function of the
key makes the duplicate unrepresentable before it reaches SQLite"). The merge therefore does **not**
silently keep both: per-field last-write-wins resolves `camper_identity_keys[keyId].camper_id` to
whichever write has the later HLC/timestamp, and the *other* device's `campers[randomCamperIdB]`
row becomes an orphan — present in the document, pointing at nothing once `camper_identity_keys`
converges on `randomCamperIdA`. **This orphan is the cost of Option B**, and it must be named
rather than hand-waved: a resolver (`makeCamperIdentityResolver` or a sibling) needs to, on
detecting that a locally-known `camper_id` is not the one `camper_identity_keys` now resolves to
for a given name, treat its own prior writes under `randomCamperIdB` as needing a rekey —
structurally the same operation `attributeElectiveSubject.js` already performs today when naming a
provisional subject (moving preferences/assignments onto a canonical id and deleting the losing
row). This is new work, not free, but it reuses an existing, tested pattern rather than inventing
one.

**Privacy payoff — why this is categorically different from Option A, not just another coat of
paint.** `camper_identity_keys` does hold the canonical name in cleartext (as its row's *key*,
`deriveCamperIdentityKeyId`'s own derivation, the same way `elective_choices` already holds a
cleartext label key). But unlike a name embedded in `campers.id` — which then propagates into
every `camper_id` FK column, every purge tombstone, every digest-map key, and every log line
forever — the mapping row is a **single, identifiable, purgeable record**. `purgeCamperRecord` gains
one more delete (`DELETE FROM camper_identity_keys WHERE camper_id = ?`, mirroring the pattern
`purgeSupportCommand.js` already uses for `elective_preferences`/`elective_assignments`/etc.) and
gains one more Host-signed tombstone entity (`camper_identity_keys`, added to
`TOMBSTONE_DENYLISTED_ENTITIES` alongside `campers`). After that purge, the camper's random id
survives (as designed — it is meaningless) in every FK column and every tombstone and every digest
key, and the one place the name lived is gone, fleet-wide, through the exact mechanism T233 already
built for erasing `campers` itself. This closes finding (1) and finding (2) for real, not just
guess-resistantly — the tombstone and the digest key were never the leak; the id itself was, and
Option B moves the only cleartext-bearing structure to the one place this codebase already knows
how to purge.

**Cost, stated plainly.** A second entity, a second derivation function, a resolver that handles
the cross-device orphan case above, and a migration that back-fills `camper_identity_keys` from
every existing name/ext-mode `campers.id` (so sheet re-import for an already-imported camper still
resolves to the same camper, post-migration — see Migration below).

**Verdict: recommend.** Confidence: high for the privacy payoff (derived from this repo's own
purge/tombstone machinery, not a new design), medium-high for the orphan-resolution cost being
contained to a bounded, already-patterned piece of work (`attributeElectiveSubject.js`'s rekey is
the precedent, but it has never had to run automatically/invisibly at import time the way this
would — see Acceptance criteria and Open questions).

### Option C — hybrid: random id + derived mapping key, but skip the mapping table and tombstone the name component of the id directly

Considered and rejected quickly. The appeal is avoiding a second table by keeping
`camper_identity_keys`'s *logic* but folding its row into `campers` itself (e.g., a `name_key`
column on `campers`, cleared on purge instead of the whole row). Rejected because `campers.id`
would then still need to be the *target* of convergence for two devices importing the same new
camper, which only works if `campers.id` **is** the derived key (Option B's actual blocker is
convergence, not storage location) — putting `name_key` on `campers` doesn't change that `campers`
itself would still need a random, not derived, id, and two devices would still fork on `campers.id`
with nothing to converge them, since the convergent key would then live on a row whose own id is
not derived. This is Option B with an extra constraint (one table instead of two) that does not
survive contact with the convergence requirement; no further development needed.

## Decision

Adopt **Option B**: `campers.id` becomes a random, opaque, high-entropy token for every
newly-created camper (all three current modes — `sub`, `ext`, `name` — see "`ext`/`sub` scope"
below for which existing modes this actually changes). A new replicated entity,
`camper_identity_keys`, carries the deterministic, convergent mapping from
`(camp_id, key_mode, key_value)` to `camper_id`, keyed on exactly the derivation
`deriveCamperId`'s current body already computes — so the derivation function is **repurposed**
(it derives a lookup-row id, not a camper id) rather than discarded. Sheet import resolves
name/external-id to a camper id via this table, minting both a fresh camper id and a fresh mapping
row only on a genuine cache miss.

### `ext` and `sub` modes — in scope, same mechanism, smaller stakes

Both are in scope, folded into the same `camper_identity_keys` design, for consistency and because
excluding them would leave two of three modes carrying an un-hashed identifier in `campers.id`
indefinitely:

- **`ext` mode** embeds a camp's own external roster id (`camper1:...ext.<external_id>`) — not a
  display name, so it is lower stakes (an external id is camp-management-system internal, not
  directly a child's name), but it is still an identifier this app did not mint, embedded in a
  replicated id, and the same convergence mechanism costs nothing extra to extend to it.
- **`sub` mode** (provisional subjects, `(submission_key, arrival_id)`) embeds no human-readable
  text at all — `submissionKey` is itself a content hash. There is no privacy payoff here; it is
  included only for uniformity (one `camper_identity_keys` entity, three key modes, rather than two
  entities for two different problems).

## Migration

**Shape.** A schema migration (version number allocated at build time per this project's standing
rule — `npm run ticket:next`-adjacent discovery, never hand-picked, since another branch may have
already claimed the next version) that:

1. Creates `camper_identity_keys` (`id TEXT PRIMARY KEY`, `camp_id`, `key_mode`, `key_value`,
   `camper_id`), added to `PROJECTIONS`, `MODELED_ENTITIES`, `DIRECT_CAMP_ENTITIES`, and
   `TOMBSTONE_DENYLISTED_ENTITIES` (mirroring `campers`' own registrations — these registries are
   the actual source of truth per `campDocument.js`'s own comments, not something a migration can
   infer).
2. Back-fills one `camper_identity_keys` row for every **existing** `ext`/`name`-mode camper, by
   re-deriving `(key_mode, key_value)` from the camper's own `external_id`/`display_name` columns
   (the inverse of `deriveCamperId`'s current forward derivation — straightforward, since the
   canonicalizer (`electiveChoiceLabelKey`) is pure and already exported). This does **not**
   change `campers.id` for existing rows (see "Tombstones & digest keys already written" below) —
   it only makes the lookup table consistent with what already exists, so a sheet re-imported
   post-migration against an old-format camper still resolves to the same row via the lookup
   table rather than via a freshly-random id.
3. Changes `commitElectiveRun.js` and `attributeElectiveSubject.js` to resolve through
   `camper_identity_keys` before minting, per the Decision above.
4. **Does not re-key any existing `campers.id`.** Re-keying every FK (`elective_preferences
   .camper_id`, `elective_assignments.camper_id`, `elective_run_outer_snapshots.camper_id`,
   `elective_run_findings.camper_id`, plus the non-FK `snapshot_digest` JSON map's keys, which are
   *derived from* `camper_id` and would need recomputation too) is a strictly larger, riskier
   operation than this ADR needs to force in the same migration — see the next section for why
   leaving old ids in place is the deliberate choice, not an oversight.

**Rollback module.** A `vN_down.js` following this repo's existing convention (see
`v82_down.js`/`v83_down.js`): drops `camper_identity_keys`, lowers `schema_migrations` with
`>= N`, and states explicitly (per this repo's own rollback-authoring convention) that
`camper_identity_keys` **replicates** — so a rollback un-projects it on this device only; a
peer still on the new schema version keeps its copy and will re-send it, exactly as
`v82_down.js`'s own comment states for `camp_seedlings`. The rollback also does **not** touch
`PROJECTIONS`/`MODELED_ENTITIES`/`TOMBSTONE_DENYLISTED_ENTITIES` registrations — those are a
separate, deliberate code revert, following the same "registries are not a schema migration's job"
discipline `v82_down.js` states for itself.

## Tombstones & digest keys already written (pre-production, decided deliberately)

This repo has **no live camp data anywhere** (stated repeatedly across its own ADRs and comments,
including `electiveDerivedIds.js`'s own `V` comment and the owner ruling
`i-owner-ruling-no-mixed-versions`). Any existing purge tombstone or `snapshot_digest` map in a
developer's local `shoresh-dev` database references an *old-format* (name-embedding) camper id.
Given the no-live-data context, this ADR treats every such pre-migration tombstone/digest as
**legacy and not worth a reconciliation pass**: a developer's local dev database that already ran a
purge or finalize is not a camp's real erasure guarantee, and forcing this migration to also
re-sign every existing tombstone (which would require the Host's signing key to be available at
migration time, an assumption migrations do not currently make) is effort spent protecting data
this project has explicitly decided does not need protecting yet. **This is a deliberate decision,
not a hand-wave**: the alternative (re-deriving and re-signing every tombstone and every digest-map
entry against the new id scheme, inside the migration) is rejected because it multiplies this
migration's blast radius for a benefit (consistency of dev-only, throwaway data) this repo's own
stated posture says is worth zero. The first **real** camp's data is created entirely under the new
id scheme, so no tombstone or digest in production ever references an old-format id. Open question
4 below asks the owner to confirm this reading is correct for pre-production rather than assuming it.

## Migration back-fill does not replicate (accepted limitation, Red Hat T321 follow-up)

The v85 migration's back-fill (previous section, step 2) writes its `camper_identity_keys` rows
with raw `db.prepare(...).run(...)`, never `appendOp` — so these rows are **device-local only**:
they never reach the Automerge document and never replicate to a device that joins the camp after
the migration has already run elsewhere. This is a real gap in acceptance criterion 6's literal "a
re-imported sheet... resolves to the SAME `campers.id`" claim as stated, narrowed here rather than
silently left implicit, and it is **not** covered by the "Tombstones & digest keys already written"
exception above — that exception is about stale dev-only tombstones/digests under the
no-live-data posture; this is about a real post-migration camper on a camp a NEW device correctly
joins.

**Why this is not fixed by making the migration replicate.** No migration in `electron/db/localDb.js`
writes through `appendOp` anywhere — every migration that needs a device-local-only effect says so
explicitly (e.g. the v24 orphan-week-snapshot block, v55/`projection_failures`). `openLocalDb` runs
every migration against the raw SQLite file with no `userDataDir` or document-path argument — the
Automerge document for the camp is not reachable from inside a migration at all in this codebase's
current structure. Forcing migration-time replication here would be introducing an unprecedented
capability under the narrowest possible justification (one back-fill, in a repo with no live camp
data yet), not merely re-using an existing one. That tradeoff is rejected.

**Why this is bounded and self-healing instead.** A device joining fresh after the migration gets
the pre-existing `campers` rows (those always replicated via their own ordinary ops) but zero
`camper_identity_keys` rows for them. Re-importing an existing camper's sheet on that new device is
a genuine cache miss against `camper_identity_keys` — it mints a temporary duplicate camper id and
writes its own mapping row through the live, `appendOp`-backed resolver path (`camperIdentityResolver.js`),
which **does** replicate normally, same as any other write. Once that new mapping row reaches the
ORIGINAL (pre-migration) device and that device's next `resolveOrMintCamperId`/
`attributeElectiveSubject` touch for the same name runs, `rekeyOrphans` finds the pre-existing
camper row as the orphan — it is excluded from `camper_identity_keys` only because it predates the
migration, which `findOrphans`' matching logic does not need to know about — and moves its
preferences/assignments onto the new device's id, exactly the mechanism acceptance criterion 4
already names for two devices racing to mint the same logical camper before ever syncing.
`electron/ops/camperIdentityResolver.migrationBackfillConvergence.test.js` exercises this sequence
directly: a pre-existing camper with no identity-key row, a simulated second-device mapping arriving
via sync, and the original device's next touch moving the first device's preference data onto the
synced-in id rather than losing it.

**The accepted cost**: a temporary duplicate camper exists on the fleet between the new device's
import and the old device's next touch for that name — visible in the UI as two rows for one child
until that next touch runs. Given this repo's no-live-data posture (same posture the tombstone
section above relies on) and that the resolution is automatic rather than requiring a director to
notice and manually merge, this is accepted rather than engineered away at migration time.

## Acceptance criteria

An implementation satisfies this ADR when:

1. `deriveCamperId` (or its replacement) no longer produces a value assigned to `campers.id`;
   `campers.id` for every newly-created camper is a random, opaque token indistinguishable from a
   `randomUUID()` output by inspection.
2. A new `camper_identity_keys` entity exists, replicates (is in `PROJECTIONS`/
   `MODELED_ENTITIES`/`DIRECT_CAMP_ENTITIES`), and is in `TOMBSTONE_DENYLISTED_ENTITIES`.
3. Two devices importing the identical sheet for a camper neither has seen before, without syncing
   with each other first, converge on ONE `camper_id` once merged — proven by an integration test
   in the style of `test/integration/run.automerge.js`, not only a unit test of the derivation
   function (the existing suite's own convergence tests for `deriveCamperId` are the template).
4. The cross-device orphan case (two devices mint two different random camper ids for the same
   logical camper before syncing) is detected and resolved without silently losing either device's
   preferences/assignments — i.e., the losing device's rows are moved onto the winning camper id,
   not dropped, following `attributeElectiveSubject.js`'s existing rekey discipline.
5. `purgeCamperRecord` deletes the purged camper's `camper_identity_keys` row(s) in the same
   transaction as its other dependent-row deletes, and the purge tombstone mechanism denies
   re-projection of a tombstoned `camper_identity_keys` row the same way it denies a tombstoned
   `campers` row.
6. A re-imported sheet for an already-known camper (pre- or post-migration) resolves to the SAME
   `campers.id` it always has — the migration's back-fill is covered by a test that imports a
   sheet, migrates, and re-imports the same sheet, asserting identical `camper_id` outputs.
7. SECURITY.md's purge section (lines 501-522) is updated to remove the "camper ids are NOT
   uniformly high-entropy... `deriveCamperId` ... embeds the canonicalized DISPLAY NAME" caveat,
   replacing it with the new, narrower caveat about `camper_identity_keys` (a purged camper's
   mapping row is deleted and tombstoned exactly like the camper row itself).

## Decisions taken (organizer, 2026-10-01 — recommended defaults adopted)

These five were drafted as open questions; each carried a sensible recommended default with no
product-direction stake, so the organizer ruled them on those defaults (the "organizer rules on
defaults" standing rule). They are recorded here as settled so the only thing the owner owes on this
ADR is **acceptance of the decision as a whole** (Art. IV); the id scheme, migration shape, and
privacy posture above are what he is accepting or redirecting.

1. **Migration version number and timing.** Allocated at build time via this project's standing
   worktree-scan discovery, never hand-picked — purely mechanical.
2. **`ext` mode treatment.** Same mechanism, same migration as `name` mode (one
   `camper_identity_keys` entity, three key modes); the marginal cost once the entity exists for
   `name` mode is near zero, and excluding it would leave an un-minted identifier in `campers.id`
   indefinitely.
3. **Cross-device orphan resolution.** Silent background rekey on next touch (the existing
   `attributeElectiveSubject.js`-style rekey, triggered the next time a sheet-import/`commitElectiveRun`
   path notices its locally-cached `camper_id` no longer matches what `camper_identity_keys`
   resolves to), not a director-facing finding — this is internal plumbing with no camper-visible
   consequence. This is the one genuinely new mechanism in this ADR, so it gets a Red Hat / Architect
   pass at **build** time (not re-opened here).
4. **Pre-production legacy-tombstone posture.** No reconciliation pass is owed for a developer's
   local dev database's existing purge tombstones or digest maps — the repo's standing "no live camp
   data anywhere" posture and the T233/#686 precedent (accepting dev-database staleness across
   derivation-version bumps) already cover it. The first real camp's data is created entirely under
   the new scheme.
5. **`camper_identity_keys.key_value` for `name` mode.** Stores the canonical name key in cleartext
   (lowercased/whitespace-stripped) in that one purgeable table — storing a hash instead would break
   the lookup's whole purpose. The privacy payoff of this ADR was never "no cleartext name anywhere";
   it is "cleartext name lives in exactly one purgeable place, not smeared across every FK, tombstone
   and digest key forever."

**The one word owed:** the owner accepts this ADR (status flips to `accepted`, a ticket number is
allocated, and the build proceeds under the normal loop) or names what to change. Nothing here is
built until then.

**Accepted (ticket T321).** Per the organizer's recorded acceptance above ("Decisions taken
(organizer, 2026-10-01 — recommended defaults adopted)") and board item
`q-camper-id-embeds-display-name`, this ADR was handed to the normal Maker/Verifier/Red Hat/
Security/Code Reviewer loop under ticket T321. `status` and `implementation_state` above reflect
that the build is implemented and reviewed as of this PR.
