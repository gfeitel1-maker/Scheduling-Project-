---
title: "ADR: Productionize Automerge + libp2p as the sync/data layer; SQLite becomes a rebuildable projection"
document_type: adr
status: accepted
authority: normative
implementation_state: in_progress
date: 2026-09-06
decided: 2026-09-06
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
# NOTE: the superseded ADR (2026-08-17-shared-project-multi-transport-sync.md) lives on the
# sibling `claude/shoresh-future-architecture-364e03` branch, not on the main line — so this is
# left empty here to avoid a dangling reference; the supersession is recorded in prose below.
supersedes: []
extends: []
depends_on_external: ["@automerge/automerge@3.4.1", "libp2p@2.10.0 (pinned — v3 broke the stream API)"]
related_discovery:
  - experiments/future-arch/ENGINE_SELECTION.md
  - experiments/future-arch/PRODUCTIONIZATION_AUDIT.md
  - experiments/future-arch/RULES_LAYER_SOURCES.md
  - experiments/future-arch/HOLEPUNCH_RESEARCH.md
  - experiments/future-arch/cr-sqlite-libp2p/
related_adrs:
  - docs/adr/2026-09-04-projection-failure-detection-and-recovery.md
  - docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md
  - docs/adr/2026-08-12-drag-live-write-serialization.md
program: shoresh-future-architecture
---

# ADR: Productionize Automerge + libp2p as the sync/data layer; SQLite becomes a rebuildable projection

> **Status: ACCEPTED (2026-09-06).** This is a **scoping ADR**. It records the decision and the shape of the
> conversion — the seam, the KEEP/REPLACE/REMOVE map, the new rules layer, and a staged path
> skeleton. It does **not** authorize implementation. Each stage in the staged path is its own
> future review-loop slice, planned and approved separately. Where this document says "proposed,"
> nothing has been built; where it says "proven," a running prototype (`experiments/future-arch/cr-sqlite-libp2p/`)
> has already demonstrated the claim, headless, on this machine.

## Supersedes

> **Branch note:** the superseded ADR (`docs/adr/2026-08-17-shared-project-multi-transport-sync.md`)
> was authored on the sibling `claude/shoresh-future-architecture-364e03` branch and does **not**
> exist on the main line, so the `supersedes:` frontmatter field here is intentionally empty to
> avoid a dangling reference. The supersession relationship is recorded in prose immediately below;
> if that ADR is ever brought to `main`, restore the frontmatter link.

This ADR **supersedes** `docs/adr/2026-08-17-shared-project-multi-transport-sync.md` ("Shared-project
model over a multi-transport, referee-less sync engine"), which recommended embedding **Syncthing**
as the sync engine under a shared-project mental model. That ADR's shared-project mental model (a
camp project behaves like a collaborative document) is **preserved** here — it is the framing this
ADR also uses — but the concrete engine choice changes. Syncthing is not deleted from consideration;
per the owner's optionality principle (`experiments/future-arch/ENGINE_SELECTION.md` lines 25-32), it
is **held, not killed**, as a document-format/transport option behind the same seams. The
2026-08-17 ADR's file is being updated with a status line pointing here; its content is left intact
as the historical record of that evaluation.

## Context

Shoresh's current sync/data layer (Electron + SQLite + a hand-rolled per-field op-log +
WebSocket LAN transport with a privileged Host role) is described in full in `CLAUDE.md`'s
Architecture section and in the ADRs listed under `related_adrs` above. It works, but:

1. It has no WAN/NAT-traversal story — sync only works when devices are mDNS-reachable on the
   same LAN.
2. Its conflict model is a single-writer, seq-ordered op-log with an explicit `conflicts` table for
   detected field-level collisions — sound, but hand-built and hand-maintained (`electron/ops/operations.js`,
   656 lines of bespoke LWW/conflict-detection logic).
3. The owner's stated principle for "local-first" is **optionality** — the ability to swap the
   underlying document format/engine — not commitment to any single engine
   (`experiments/future-arch/ENGINE_SELECTION.md` line 26: *"For this to be local-first, to me, is
   about giving the **option** to use another format if wanted."*).

The owner ran a structured, staged prototyping program (`ENGINE_SELECTION.md`) evaluating
cr-sqlite+libp2p, then Automerge+libp2p, against two independent axes — the **data/merge layer**
(how changes are stored and reconciled) and the **transport/discovery layer** (how changes travel).
cr-sqlite was **demoted** on discovery that its last release was January 2024 and its installer is
broken on modern Node (`ENGINE_SELECTION.md` lines 68-70) — a maturity risk, not a design flaw.
Automerge (`@automerge/automerge` v3.4.1, actively maintained as of Aug 2026) was **promoted** in
its place, tested headless at 9/9 (`test-automerge.mjs`): independent edits converge; a genuine
same-slot conflict converges to a deterministic winner **and** `getConflicts()` exposes both
competing values, so the conflict can be surfaced to a human rather than silently dropped. libp2p
was tested at 4/4 for LAN transport (`test-libp2p.mjs`, pinned to v2.10.0 after v3 broke the
documented stream API) and further proven end-to-end:

- **PROVEN, same-Wi-Fi, real hardware**: `cr4-node.mjs` — two machines auto-discover via mDNS,
  connect, and converge on a live edit, no daemon, no relay, no account
  (`ENGINE_SELECTION.md` lines 131-137).
- **PROVEN, cross-network (different Wi-Fis, one on cellular hotspot/CGNAT), real hardware**:
  `cr4-dht-node.mjs` — the public DHT found the peer across networks, direct dial failed (CGNAT is
  un-punchable, as predicted), and the two nodes connected and synced via a public circuit relay,
  end-to-end noise-encrypted even over that relay (`ENGINE_SELECTION.md` lines 103-115).
- **NOT YET TESTED**: a true **direct** hole-punch (dcutr) between two punchable home-Wi-Fi peers
  (neither behind symmetric/CGNAT). The cross-network result above went via relay because the test
  hardware happened to be CGNAT; a home↔home pair is the remaining case to confirm a direct punch.
  State this honestly — it is the one un-closed item in an otherwise-proven transport story.
- **PROVEN, projection**: `test-projection.mjs` (7/7) — an Automerge doc projects into queryable
  SQLite; deleting SQLite and rebuilding from the Automerge document **alone** reproduces state
  deterministically; a genuine same-slot conflict lands as a surfaceable flag row.

The owner decided (2026-09-05, `ENGINE_SELECTION.md` line 3): **Automerge + libp2p is the route.
Productionize it**, on a fresh branch off current main, staged, full review loop, because main has
moved independently (~405 commits) since the prototype branch diverged and other sessions are
actively building on the current sync/op-log code this route retires parts of.

A read-only audit of `origin/main@8bf3a33` (`experiments/future-arch/PRODUCTIONIZATION_AUDIT.md`)
then mapped exactly what this conversion costs against the real, current codebase — not the
prototype's toy schema. That audit, plus a follow-up sweep of the domain-invariant surface
(`experiments/future-arch/RULES_LAYER_SOURCES.md`), are the factual backbone of this ADR.

## Decision

**Convert Shoresh's sync/data layer to Automerge (data model, merge, conflict resolution) +
libp2p (transport, discovery, NAT traversal). SQLite is demoted from authoritative store to a
rebuildable projection of an Automerge document.**

The Automerge document (one per camp, mirroring today's "one SQLite db per device, one camp per
device") becomes the thing that is authoritative and synced. SQLite remains the query engine every
existing read path already depends on, but it is now **derived, not authoritative** — deletable and
rebuildable from the document at any time, the same guarantee `test-projection.mjs` already proved
headless. Every domain entity table Shoresh has today (`groups`, `activities`, `schedule_templates`,
etc.) is kept, unchanged in shape, as a **projection target**.

This decision does not, by itself, resolve every question raised below (Host-as-privileged-role,
hard-cutover-vs-dual-write, WAN priority) — those are recorded as open questions for the owner in
their own section, deliberately not pre-answered here.

## The seam: `src/localClient.js`

`src/localClient.js` (131 lines, `export const localClient = {...}`) is the renderer's single
chokepoint onto `window.shoresh.*` IPC calls. Confirmed by the audit's own greps
(`PRODUCTIONIZATION_AUDIT.md` §2): `grep -rl "window.shoresh" src/` returns exactly the real
implementation, its mock (`src/localClient.mock.js`, 1,365 lines), and two files where the only
matches are comments. `grep -rl "from '.*localClient'" src/` returns 73 files, 36 of them
non-test consumers (screens, hooks, one component, two util modules) — an exact match to the
audit's claim, not an approximation.

An Automerge-backed provider sits behind this same seam:

- The renderer never imports `electron/ops/**` or `electron/sync/**` directly. It only calls
  `localClient.list(...)`, `.write(...)`, etc., which resolve to `ipcRenderer.invoke('shoresh:...')`.
- `electron/preload.js`'s ~70 IPC **channel names** stay stable. `electron/ipcSurfaceParity.test.js`
  is the existing regression gate that proves the surface hasn't drifted — it keeps running,
  unmodified in intent, through every stage of this migration. A stage that changes a channel's
  response shape without updating this test is a stage that has broken the seam.
- Each `ipcMain.handle('shoresh:*', ...)` handler in `electron/main.js` (2,106 lines, ~70
  registrations) is re-pointed to read/write the Automerge document and read the SQLite projection,
  instead of the op-log — returning the **same response shape** it returns today.

Given those two conditions, all 36 renderer consumers, `src/engine/**` (a pure function over plain
data, per `CLAUDE.md`, entirely unaware of IPC), and every screen/hook are provably untouched. This
is the strongest evidence the audit surfaces for "the conversion is containable": the insulation is
real and testable via a gate that already exists, not aspirational.

**Two caveats, both must be re-checked, not assumed away, before any migration stage touches them:**

1. **Push-event payload shape.** `onOpApplied`, `onOpConflict`, `onFullSyncApplied` in
   `electron/preload.js` are push events, not request/response — the event still firing with the
   same name is not sufficient if a renderer consumer inspects the payload's internal shape (today,
   presumably op-log-shaped: a single applied op) rather than treating it as "something changed,
   refetch." Automerge's change-notification is a patch/diff, not a single field-op. Required
   action before Stage 1 below touches these channels: grep every consumer of `onOpApplied` /
   `onOpConflict` for payload-shape assumptions, not just presence, and either preserve the shape
   at the IPC boundary (translate Automerge patches into the old payload shape) or update every
   consumer found and extend `ipcSurfaceParity.test.js` to assert on payload shape for these three
   channels specifically, not just channel names.
2. **`src/localClient.mock.js` is a full parallel implementation** (1,365 lines) of the same
   surface, used by 37 test files. It must be kept in parity with whatever the real provider does
   at every stage — a stage that changes `localClient`'s real behavior without a matching mock
   update produces tests that pass against a lie. Treat mock-parity as a checklist item on every
   stage, the same way `ipcSurfaceParity.test.js` is.

## KEEP / REPLACE / REMOVE

Summarized from `PRODUCTIONIZATION_AUDIT.md` §1 (line counts are `wc -l` on non-test `.js` files,
`origin/main@8bf3a33`):

**KEEP, untouched or near-untouched**
- `src/**` — all 36 non-test `localClient` consumers, `src/engine/**` (schedule engine, pure
  function, zero IPC coupling).
- `electron/ops/ingest.js` (2,499 lines) — almost entirely reconciliation/import domain logic
  (compound-cell handling, two-row splits, alias matching, S1a–S4b conflict classification) with
  nothing to do with op-log mechanics. **One mechanical dependency must be re-verified**: the
  held-import atomicity guarantee at `ingest.js:1038-1042` (a thrown `HELD` sentinel rolls back the
  whole SQLite transaction, leaving the DB byte-identical on a held import) — see "Must-preserve
  invariants" below.
- `electron/db/localDb.js` (2,766 lines) and `electron/db/schema.sql` (1,048 lines) — the
  migration ladder and domain entity tables are preserved almost 1:1 **as the projection schema**;
  only the `operations`/`conflicts` tables and the migration steps that were pure op-log bookkeeping
  (e.g. adding `parent_op_id`/`client_write_id` columns) are removed.
- `electron/auth/localAuth.js`, `authorize.js`, `permissions.js`, `deviceTrust.js` — pure local
  policy, transport-agnostic, re-pointed at the (still-queryable) projection but logically
  unchanged.
- Host-only decision tables' write paths (`confirmAlias.js`, `confirmCompoundCellPattern.js`,
  `locationWordDecisions.js`, `declinedSplits.js`, `openReconciliationDecisions.js`,
  `migrationReviews.js`, ~501 lines combined) — these already write directly to host-local SQLite,
  bypassing sync entirely; lowest-risk migration path is literally unchanged.
- `electron/db/projectManager.js`, `electron/db/rollback/*` — orthogonal to sync mechanism (but see
  the backup caveat under "Must-preserve invariants").

**REPLACE**
- `electron/ops/operations.js` (656 lines) — the op-log's own LWW/conflict engine
  (`detectConflict`, `recordConflict`, `parent_op_id` causal ordering, bulk-replace mechanics).
  Automerge's CRDT merge replaces all of it; the `conflicts` table's genuine-conflict class either
  disappears (Automerge auto-merges at the property level) or narrows to a much smaller
  app-level "which value is canonical" UX conflict.
- `electron/ops/projections.js` (905 lines) — becomes the Automerge→SQLite projector. Same
  responsibility (materialize a normalized read-model into SQLite), different input (an Automerge
  document / patch-diff instead of one op replayed in seq order).
- `electron/sync/syncServer.js` (914), `syncClient.js` (1,654 — the largest file in
  `electron/sync/`), `catchup.js` (294), `opDelivery.js` (69), `discovery.js` (39) — the WebSocket
  Host/Client protocol, catch-up-from-seq logic, ack/retry wrapper, and mDNS discovery. Automerge's
  own sync protocol (`generateSyncMessage`/`receiveSyncMessage`) already is the "which changes does
  the peer not have yet" negotiation `catchup.js` hand-implements today; libp2p ships its own
  mDNS/DHT discovery, and additionally solves WAN NAT traversal, which `discovery.js` does not
  attempt at all today.
- `electron/ops/deleteRecord.js` (566), `restore.js` (307), and the week/event/elective-set delete
  family (~767 lines combined) — **mechanics** replaced (writes become Automerge document
  mutations wrapped in one `change()` call instead of op-log writes); soft-delete/cascade/undo
  **policy** kept.
- `main.js` handler **bodies** (not the ~70 channel registrations, which stay) — re-pointed from
  `electron/ops/*` calls to Automerge-doc reads/writes + projection reads.

**REMOVE**
- `electron/ops/projectionRepair.js` (93 lines) and the `projection_failures` table
  (`schema.sql:299`, indexed at 308) — confirmed, not assumed, a genuine deletion. See "Projection
  repair is not moot" below: the *mechanism* this file exists for is not moot, but its *specific
  implementation* (replay every op for an entity in seq order from `operations`) has no `operations`
  table left to replay from.

**Aggregate**: the mechanically-replaced subset (`operations.js` + `projections.js` +
`syncServer.js` + `syncClient.js` + `catchup.js` + `opDelivery.js` + `discovery.js` +
delete-mechanics fraction of the delete family + `schema.sql`'s `operations`/`conflicts` tables +
a fraction of `main.js`'s handler bodies + `projectionRepair.js` removed outright) is **roughly
7,000–8,000 lines**. `ingest.js`'s 2,499 lines of reconciliation domain logic and `localDb.js` /
`schema.sql`'s combined ~2,766-line migration ladder are preserved, not replaced — they are not
part of that count.

## The rules/validation layer above Automerge (load-bearing new insight)

**Automerge converges the document. It does not enforce domain invariants.** The current op-log's
single-writer, seq-ordered replay gave Shoresh invariants for free that a CRDT hands back as this
project's own problem. The canonical example: delete-a-location and assign-an-activity-to-that-
location both merge cleanly under a CRDT — the result is a syntactically valid document with a
`location_id` pointing at nothing. This is not hypothetical for Shoresh — it is already latent
behavior in the schedule engine today:

> `src/engine/buildSchedule.js:326-339` — a **null OR dangling `location_id` is treated as
> UNCONSTRAINED.** This is the single most load-bearing line in this ADR's rules-layer argument: a
> broken reference does not error today, it silently *removes a constraint* (e.g. an activity
> anchored to the flagpole quietly stops being held at the flagpole, with no flag, no error, no
> visible signal to the director). Under the current op-log, this line is rarely exercised because
> single-writer ordering makes most dangling-reference races structurally impossible. Under
> Automerge, concurrent delete+assign is a first-class, expected occurrence, and this line becomes
> the thing that decides whether that occurrence is silent or surfaced.

This is why the rules layer is scoped here as its **own stage**, not a bolt-on to the projection
work. Today, referential integrity between `location_id` and its six referrer kinds is enforced by
**convention, not the database** — no SQL foreign key exists on `location_id` in `anchor_activities`,
`events`, `special_day_slots`, `event_slots` — so SQLite would not have caught this class of bug
either; what protected Shoresh so far was the op-log's ordering, not the schema. That protection
disappears under a CRDT and must be replaced by explicit application-level validation.

**Invariant catalogue the rules layer must hold** (from `RULES_LAYER_SOURCES.md`, reconstructed
from merged code, not prose docs):

1. **Referrer completeness on merge/delete** — re-point or NULL every referrer of a deleted/merged
   location (the shipped #286 fix, `electron/ops/deleteRecord.js`'s `locationReferenceRows` /
   `deleteOrMergeLocation`, covering the six referrer kinds and which clear to NULL vs. row-delete).
2. **Place capacity + contention**, including the specific gap that anchors constrain scheduling
   but are never flagged when they conflict (#282, #290).
3. **The location approval gate** — a declined room must never come into existence via *any* of the
   seven creation paths (#283).
4. **Host-only never-replicate tables** (full list and mechanism below).
5. **Ingest's atomic all-or-nothing rollback** (`ingest.js:1038-1042`).

**The fan-out that makes this non-trivial**: per the "Life of a Location" lifecycle trace, there are
**seven creation paths and two different id schemes**, only one of which ever learns a real
capacity (`electron/ops/locationId.js` + `locationCreate.js` for the two declared-creation paths,
with identity deliberately trim-only and case-sensitive per Constitution Art. V accept-and-mark;
`src/ingest/textGrid.js:283,303,349-372` and `src/ingest/extractEntities.js:620-633` for the two
paths where a location is *inferred* rather than declared). Validating one write path proves
nothing about the other six. The rules layer must be designed against all seven, not the one that
happens to be exercised first.

**Schema note — do not clean up as a side effect**: `schema.sql:693-711`'s `locations` table
includes `map_geometry`/`map_id` columns that are dormant today but a game-style map is being built
against these same rows (`project_camp_map_phaser_world` in memory). These columns must survive the
projection-schema redesign unchanged.

## Must-preserve invariants

- **Atomic ingest rollback.** Confirmed at `ingest.js:1038-1042`: a `HELD` `Symbol` thrown after
  populating a `conflicts` array rolls back the whole SQLite transaction. Automerge's `change()`
  callback is atomic for mutations *made inside that one call* — the same accumulate-then-throw
  pattern is plausible — but this is a **proposed** equivalence, not a proven one. **No
  Automerge-native multi-key transaction primitive spanning arbitrary async work has been tested
  against this specific pattern.** This ADR requires a dedicated, isolated **spike** (see Stage 0
  below) proving or disproving that throwing inside an Automerge `change()` callback guarantees
  zero mutations recorded — including any nested calls — before any part of `ingest.js`'s 2,499
  lines is migrated. If the spike disproves the equivalence, ingestion needs a different atomicity
  mechanism (e.g. staging mutations in a plain JS object and committing them into one `change()`
  call only after all validation passes), which is itself a design decision, not an implementation
  detail.
- **Host-only tables never replicate.** Confirmed as a real, repeatedly-commented invariant
  (`schema.sql` lines 103, 124, 146, 171, 183, 210: *"Host-only table... NEVER included in any
  full-sync SELECT/payload..."*), enforced today by **allowlist-by-omission**:
  `electron/ops/campScopedEntities.js`'s `DIRECT_CAMP_ENTITIES` / `PARENT_SCOPED_ENTITIES` /
  `DOMAIN_PARENT_SCOPED_ENTITIES` are the only tables `electron/sync/catchup.js:2` includes in a
  full-sync payload — the six host-only tables (`compound_cell_decisions`,
  `location_word_decisions`, `declined_two_row_splits`, `source_aliases`, `import_evidence`,
  `host_signing_key`) are simply never listed, not blocked by a separate denylist. Under Automerge
  the equivalent, and a **stronger** guarantee if built correctly, is: these tables are never
  modeled as Automerge document fields at all — structurally impossible to leak into the shared
  CRDT history, rather than merely unlisted from a sync payload. A design mistake here (accidentally
  putting one of these six tables' data into the shared doc) would leak reconciliation-provenance
  data device-to-device baked permanently into CRDT history, with no export/full-sync step to grep
  for after the fact. **Required**: a schema-diff test, analogous in spirit to the existing
  allowlist-by-omission pattern but explicit, asserting these six tables (plus `devices` — see
  below) have no Automerge-document counterpart, written before the first entity migrates.
- **`devices` is a special case of the host-only-table pattern.** Per
  `docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md`: `devices` is never replicated
  but *is* stub-seeded on receipt of a peer-authored op, specifically to avoid the FK-drop failure
  that ADR fixes (a receiving device silently drops any op authored by a device it has no local
  `devices` row for, because `operations.device_id NOT NULL REFERENCES devices(id)` under
  `foreign_keys=ON`). Under Automerge there is no per-op FK to violate in the same way — Automerge
  documents don't enforce SQL foreign keys — but the underlying problem (a device needs to know
  *something* about a peer device to attribute/trust its edits) doesn't disappear; it needs its own
  design pass under libp2p peer identity (see "Membership/identity," Stage 5 below), not a silent
  assumption that it's solved by CRDT convergence.
- **`ipcSurfaceParity.test.js`** is the load-bearing regression gate proving the IPC surface hasn't
  drifted. It must keep running through every stage. Confirm during Stage 1 whether it currently
  asserts on channel names only or also on payload shapes — given the push-event caveat above,
  payload-shape assertions for `onOpApplied`/`onOpConflict`/`onFullSyncApplied` should be added if
  not already present.
- **Projection repair is not moot — it changes source, per
  `docs/adr/2026-09-04-projection-failure-detection-and-recovery.md`.** That ADR's mechanism
  (detect materialization drift as a distinct, queryable ledger; recover by entity-scoped replay)
  is a **portable design**, not op-log-specific machinery: `repairProjectionForEntity` under
  Automerge re-derives an entity *from the current document state* instead of *replaying its ops in
  seq order from `operations`*. The `projection_failures` ledger table itself likely becomes
  unnecessary — a full projection rebuild from an Automerge document is idempotent and always
  converges, so there is no per-op failure mode left to diagnose the way there was under
  seq-ordered replay — but the underlying *need* (a device's projection can fall out of step with
  truth and must be repairable, not just detectable) survives and needs its own equivalent design,
  not a silent "CRDTs don't have this problem" assumption.
- **Backups.** `electron/db/projectManager.js` handles project export/backup/restore against
  SQLite today. Once SQLite is derived data, backing up the SQLite file alone is **not sufficient**
  — the Automerge document (or its append-only change log) is the thing that must be backed up; the
  SQLite file becomes reconstructible-but-not-authoritative. This needs explicit handling in
  `projectManager.js`'s replacement, not an afterthought bolted on after the fact.
- **Schema-version handshake across devices.** Not confirmed either way in the audit (time-boxed
  out) — open question, not a confirmed risk: does the current protocol have an explicit
  schema-version exchange at connection time for op-log field additions, and if so, what is its
  Automerge-document equivalent? Automerge documents do not have a schema-migration story as mature
  as SQL's; this needs explicit design before devices on different app versions are expected to
  sync against the same document, and is called out again under Stage 5/6 below.

## Open questions for the owner — RESOLVED 2026-09-06

All three were answered by the owner on 2026-09-06. Recorded here as decided; each still gets its
own design pass at the relevant stage, but the direction is no longer open.

1. **Does "Host" survive as a privileged/signing role once transport is peer-to-peer via libp2p?**
   **DECIDED: yes — Host stays a privileged signing role.** The app's Host/Client authority model
   (one device holds the Ed25519 `host_signing_key` and mints `camp` tokens; others verify but never
   mint) is preserved; libp2p's transport becoming peer-to-peer does **not** make the *authority*
   model symmetric. Stage 5's membership/identity work therefore maps the existing host-signing-key
   onto the Host peer's identity under libp2p rather than redesigning toward a symmetric/leaderless
   authority model. The mechanism for designating *which* peer is Host still gets its own design pass
   (and likely its own ADR) at Stage 5 — but the question of whether the asymmetry survives is
   settled: it does.
2. **Hard cutover vs. dual-write migration window.** **DECIDED: hard cutover.** Clarified with the
   owner that this choice is invisible at the product level — live simultaneous editing of one
   schedule is guaranteed by Automerge under *either* migration strategy; the choice is purely
   internal (how the codebase flips from op-log to Automerge). Given pre-production status and no
   installed camp devices requiring a staged rollout, Stage 6 is a **flag-day replacement**: build
   the Automerge+libp2p path to full parity behind a flag, prove equivalence with running tests, then
   retire `operations`/`conflicts` and the WS sync files in one clean move. No dual-write coexistence
   window.
3. **WAN NAT-traversal priority vs. LAN-only-first.** **DECIDED: LAN first, then WAN — and this
   matches the intended product model.** The owner's mental model *is* the prototype's pairing model:
   two devices pair on the same network first, then can find each other across different networks
   later (`cr4-dht-node.mjs`: same-Wi-Fi mDNS pairing saves the peer's stable id; the DHT then
   resolves it cross-network). So LAN-only libp2p (Stage 4) shipping before WAN traversal (Stage 7)
   is not a compromise on the reason libp2p was chosen — it is the first half of the actual intended
   flow. WAN remains wanted and in scope, sequenced after LAN.

## Consequences

- Shoresh gains a maintained, actively-developed CRDT (Automerge) and a NAT-traversal-capable P2P
  transport (libp2p) in place of ~7,000–8,000 lines of hand-maintained op-log and WebSocket
  Host/Client protocol — trading bespoke-but-fully-understood code for well-maintained-but-external
  dependencies whose failure modes (the libp2p v2→v3 stream-API break already hit once, mid-prototype)
  are now Shoresh's operational risk to track, not avoid.
- A domain-invariant rules layer becomes a **first-class, explicit component** that did not
  previously need to exist as its own thing, because single-writer op-log ordering provided most of
  its guarantees implicitly. This is real new surface area, not a wash — see the rules-layer
  section above.
- SQLite's role changes from source of truth to rebuildable cache. Every place that currently treats
  a SQLite read as authoritative (which is everywhere, today, correctly) continues to work
  unchanged *as long as the projector keeps it faithfully in sync* — the projector becomes a new
  single point whose correctness the whole app depends on, mitigated by the fact that a full rebuild
  from the Automerge document is provably idempotent (proven in `test-projection.mjs`).
- Membership/identity, atomic-ingest-under-Automerge, and the rules layer are each independently
  hard enough to warrant their own design pass and possibly their own ADR before implementation —
  this ADR deliberately does not pre-answer them.
- The transport swap (libp2p replacing WebSocket) is, by the audit's own account, the *smaller* of
  the two migrations; the data-model swap (Automerge replacing the op-log) is the harder one and the
  one this ADR spends most of its weight on, consistent with `ENGINE_SELECTION.md`'s own framing
  that the data/merge-layer choice is the "bigger migration to change later" of the two axes.

## Staged, reversible, test-first path (skeleton — pending owner approval)

This is a skeleton, not a committed sequence. Each stage is its own small, reversible, test-first
slice, run through the normal Governor/Architect/Maker/Verifier review loop as a separate piece of
work — this ADR authorizes none of them by itself.

- **Stage 0 — Spike: Automerge `change()` abort semantics vs. the ingest `HELD` pattern.**
  Smallest possible isolated test proving or disproving that `ingest.js:1038-1042`'s atomicity
  guarantee survives under Automerge. Gates whether `ingest.js`'s 2,499 lines of domain logic move
  over cleanly or need restructuring. Must run before Stage 2 touches anything ingest-adjacent.
- **Stage 1 — Automerge document + incremental projector, for one low-risk entity table**, running
  in parallel with the existing op-log for that one entity, behind a flag. A leaf table with no
  cascade/delete complexity, chosen specifically to prove the projection round-trips correctly
  (including a full-rebuild-from-doc test, mirroring `test-projection.mjs`) before anything
  camp-wide is touched. `localClient`'s shape and `ipcSurfaceParity.test.js` are the acceptance
  gate: this entity's IPC methods behave identically from the renderer's point of view.
- **Stage 2 — The rules/validation layer**, scoped against the full invariant catalogue above
  (referrer completeness, place capacity/contention, the location approval gate, host-only
  exclusion, ingest atomicity) and against all seven location-creation paths, not just the one
  Stage 1 happened to exercise. This stage is called out as its own stage, not a detail folded into
  Stage 1 or Stage 4, because the audit and `RULES_LAYER_SOURCES.md` both independently converged
  on it being the load-bearing new work this conversion introduces.
- **Stage 3 — Port the host-only-table exclusion as a structural guarantee** (not modeled in the
  Automerge schema at all, for the six host-only tables plus the `devices` special case), with an
  explicit schema-diff test, before any host-only-table-adjacent entity migrates.
- **Stage 4 — libp2p transport spike, LAN-only first** (mDNS discovery + Automerge's own sync
  protocol over a libp2p stream), replacing `discovery.js` and a minimal slice of
  `syncServer.js`/`syncClient.js`, proving parity with today's LAN-only Host/Client flow before
  attempting DHT/dcutr WAN traversal. This is where "PROVEN, same-Wi-Fi" (`cr4-node.mjs`) graduates
  from prototype to production code path.
- **Stage 5 — Widen the projector to all camp-scoped entities**, using
  `campScopedEntities.js`'s existing `DIRECT_CAMP_ENTITIES`/`PARENT_SCOPED_ENTITIES` allowlist as
  the literal migration checklist — it is already the authoritative list of what syncs today.
  Membership/identity redesign (Ed25519 host-signing-key → libp2p `PeerId` mapping, the
  Host-as-privileged-role open question above) is scoped as its own design pass within or
  alongside this stage, not folded silently into the transport work, because it is
  security-consequential and not obviously reversible.
- **Stage 6 — Retire `operations`/`conflicts` and the WS sync files** (`syncServer.js`,
  `syncClient.js`, `catchup.js`, `opDelivery.js`) once the projector + libp2p path has full parity.
  This is the actual cutover, done last, only after every prior stage has running tests proving
  equivalence — and only after Open Question 2 (hard cutover vs. dual-write window) is answered.
- **Stage 7 — WAN NAT traversal** (DHT + dcutr), including confirming the still-untested direct
  home↔home punch. Additive to what Stage 4's LAN-only path already proves; not a blocker for the
  core CRDT conversion, per Open Question 3 above, pending owner confirmation of that sequencing.

The real ordering, and whether any of these stages merge or split further, is Governor's and the
owner's call at planning time for each stage — this skeleton exists so the shape of the work
survives session handoff, not to lock in a sequence prematurely.
