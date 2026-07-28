---
title: "A joining device must receive current camp domain data, and schedule template identity must be collision-proof"
document_type: adr
authority: normative
status: accepted
date: 2026-07-28
supersedes: []
implementation_state: shipped
affects: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
---

# A joining device must receive current camp domain data, and schedule template identity must be collision-proof

**Status:** accepted 2026-07-28 — implemented in two slices. Slice 1 (electron
sync layer, migrations v21/v22, tests) landed with this ADR. Slice 2 (the
renderer: deterministic id at the two mint sites, template resolution, and the
write-gate in `ScheduleScreen.jsx`) is deliberately held back until a parallel
UI branch lands, and MUST land after the v21 re-key migration, never before.

**Revision note (this version):** a Red-Hat + Governor correction round found
four defects in the first draft of this ADR's own proposed fix — not in the
underlying bug, in the fix. Two are corrected mechanisms (Findings 1 and 2
below), one closes a data-loss window the first draft didn't address at all
(Finding 3), one withdraws a false claim (Finding 4). All four are reflected
in the Decision and Consequences below; nothing in the Context or the
Considered Options changed.

## Context

`sendFullSyncIfFirstPairing` (`electron/sync/syncServer.js:104-120`) ships exactly
two tables on a device's first-ever successful `authenticate`: `users` and
`camps`. `sendMissedOps` (`electron/sync/syncServer.js:161-209`), for that same
first connection, baselines `devices.last_synced_seq` to
`currentMaxOpSeq(db)` (`syncServer.js:151-154`) and returns without sending
any `operations` rows — the comment at `syncServer.js:161-177` documents this
as deliberate: a first-time device isn't replayed the entire pre-existing op
history. Net effect, confirmed in code: a second device pairs, authenticates,
is fully writable (every mutating IPC/WS path is already gated by
`authorize()`, not by having any data), and every `localClient.list(...)`
call for every camp-config table returns `[]`. `ScheduleScreen.jsx:214-218`
resolves the working template via
`list('schedule_templates').find(x => x.camp_id === campId)`; against an
empty table this returns `undefined`, so `generate()` (`ScheduleScreen.jsx:246-264`)
and `placeAnchors()` (`ScheduleScreen.jsx:624-633`) each independently mint a
fresh `crypto.randomUUID()` and write a new `schedule_templates` row. Two (or
more) devices that each do this end up with distinct, permanently divergent
"Master Template" rows. `appendBulkReplaceOp`'s conflict detection
(`electron/ops/operations.js:291-...`, wired at `syncServer.js:530-594`) is
scoped per `template_id`, so two builds under two different template ids
never contend and no conflict is ever recorded in the `conflicts` table —
this is silent by construction, not a narrowly-missed edge case.

Three defects, all required to fix for the observable evidence in
`docs/work/tickets/T7-joining-device-gets-empty-camp.md`:

1. First pairing does not transfer current camp-configuration state.
2. Template identity is resolved by an unordered `.find()` over a table each
   device can independently insert into, with no invariant preventing two
   distinct rows for the same camp.
3. (Found during review, not in the original ticket text, but a direct
   consequence of fixing #1 without also fixing this: a device is fully
   writable from the instant it authenticates, but its local domain tables
   only become populated once `full_sync` — an asynchronous, retryable,
   arbitrarily-delayed exchange — actually completes. Nothing today gates a
   schedule-mutating action on that completion, and nothing today tells an
   already-mounted screen that data has arrived.

## Decision

**1. Extend the existing `full_sync` row-snapshot mechanism to cover every
camp-scoped domain table, sent once per device's first pairing, in addition
to (not instead of) the existing per-op incremental catch-up — confirmed by
a genuine, application-level acknowledgment, not a transport-level one.**

`sendFullSyncIfFirstPairing` already establishes the pattern this reuses:
ship whole-table row snapshots as plain JSON arrays, applied via
`INSERT OR REPLACE` inside one transaction (`syncClient.js:166-193`'s
`applyFullSync`, currently `camps`/`users` only). This is extended, not
replaced, to also snapshot: `cohorts`, `days_of_operation`, `groups`,
`tiers`, `time_blocks`, `activities`, `anchor_activities`,
`schedule_templates`, `day_override_templates`, `template_slots`,
`template_overlays`, `day_override_template_slots` — the exact same
camp-scoped entity set `electron/main.js`'s `list()` IPC handler already
exposes to the renderer via `DIRECT_CAMP_ENTITIES`/`PARENT_SCOPED_ENTITIES`
(`electron/main.js:46-79`), extracted into one shared registry both `main.js`
and `syncServer.js` import, so the two lists cannot drift apart.
`schedule_snapshots` is deliberately excluded — see Consequences.

**Correction (Finding 1):** the first draft of this ADR claimed a
transport-level send acknowledgment (`sendWithAck`) was sufficient to gate
the Host's one-time `last_synced_at` latch. That is necessary but not
sufficient. `sendWithAck` only confirms the bytes left the Host; it says
nothing about whether the Client's `applyFullSync` transaction actually
committed. `applyFullSync` (`syncClient.js:166-193`) wraps every row of every
table in one `db.transaction()` with no internal try/catch — any exception
during apply rolls the whole batch back — and the `full_sync` branch that
calls it (`syncClient.js:283-286`) sends no reply today; the entire message
dispatch, including that branch, is wrapped in a silent catch-all
(`syncClient.js:394-396`) that swallows the failure with no signal back to
the Host. Combined with the one-time latch at `syncServer.js:105-106`, an
application-level failure (not a dropped connection — a live connection
where the Client's own apply throws) would have permanently stranded that
device: the Host would see a successful transport send, latch
`last_synced_at`, and never offer this device a snapshot again. This is
corrected by adding a real application-level acknowledgment — see the design
doc for the exact message shape and control flow.

**2. `schedule_templates.id` becomes a pure function of `camp_id`, not a
random UUID, and every existing row is re-keyed to that same derivation as
part of the migration — not just backstopped by a `UNIQUE(camp_id)`
constraint on new rows.**

Every call site that currently does
`tid = crypto.randomUUID(); writeFields('schedule_templates', tid, {camp_id, name})`
when no template is loaded (`ScheduleScreen.jsx:260-264` in `generate()`,
`ScheduleScreen.jsx:629-633` in `placeAnchors()`) instead computes
`tid = deriveScheduleTemplateId(campId)`, a pure, collision-free string
derivation every device computes identically and independently — no network
round-trip, no lock, no coordination required.

**Correction (Finding 2):** the first draft deliberately left existing
`schedule_templates` rows un-re-keyed, reasoning that a `UNIQUE(camp_id)`
constraint plus a thrown-exception recovery path would backstop the rare
mismatch case. Both the mechanism and the "rare" framing were wrong.
`schedule_templates.ensureExists` (`electron/ops/projections.js:207-213`) is
`INSERT OR IGNORE`. Under `UNIQUE(camp_id)`, a create attempt using the
deterministic id for a camp whose *existing* row has a **different**
(pre-existing, random-UUID) id does not throw — the `INSERT OR IGNORE` is
silently absorbed by the `camp_id` conflict, no row is created under the new
id, and the subsequent field `UPDATE` (`applyProjection`, `projections.js:304+`)
affects zero rows. The op is logged; nothing is materialized. And this is not
a rare, hard-to-hit case: the real production camp already has exactly this
shape (one `schedule_templates` row, a random-UUID id, for a real camp with
real data) — a device that races ahead of `full_sync` (see Finding 3) and
calls `generate()` before that snapshot lands would compute the deterministic
id, collide silently with the legacy row, and — because `list('schedule_templates')`
still shows nothing under that id — believe no template exists and proceed to
build a schedule from whatever (likely still-empty) local `groups`/`days`/
`activities` state it has, then `bulk_replace` that onto `template_slots`
under the orphaned deterministic id. This is corrected by re-keying: the same
migration that adds `UNIQUE(camp_id)` also rewrites every existing
`schedule_templates.id` to `deriveScheduleTemplateId(camp_id)`, cascading the
rename to every table that references it. After this migration, an existing
camp's canonical row *is* the deterministic id, on every device, before any
sync activity ever runs — see the design doc for the exact rename procedure
(a plain `UPDATE` of a referenced primary key is not safe under
`foreign_keys = ON`; the migration must not attempt one).

`schedule_templates` still gains `UNIQUE(camp_id)` as a defense-in-depth
backstop, but with re-keying in place, both correctly- and previously-
created rows will always have the same key that any future create attempt
would compute — see Consequences for what backstop role the constraint
actually plays after this correction, versus what the first draft claimed.

**3. (New — Finding 3) A device that has not yet completed its first domain
sync must not be permitted to run schedule-mutating actions, and completion
must be pushed to any already-mounted screen, not merely readable on next
load.**

The first draft fixed *what* ships and *how templates are keyed*, but not
*when a device is allowed to write*. A device is writable (every IPC/WS
mutation path is gated by `authorize()`, never by data completeness) from
the instant it authenticates — which can be well before its `full_sync`
snapshot has arrived, since that snapshot is itself now an asynchronous,
retryable exchange (Finding 1). A user on a freshly-paired device whose
Schedule screen loads before the snapshot lands sees an empty camp and a
fully-enabled "Generate" button. Clicking it does not just risk the identity
issue in Finding 2 — even with Finding 2 fully closed, `generate()` builds a
schedule from whatever local `groups`/`days`/`time_blocks`/`activities`/
`anchors` state currently exists (empty or partial, mid-sync) and
`bulk_replace`s that onto the *same, now-correctly-identified* template a
real camp may already be running — silently overwriting real, live schedule
data with an empty/garbage one. This is a data-loss risk, not merely a UX
rough edge, and it is the concrete mechanism that made Finding 2 reachable in
the first place. The fix gates `generate()`, `placeAnchors()`, and
`restoreSnapshot()` — every `ScheduleScreen` action that performs a
`bulk_replace` against `schedule_templates`/`template_slots` — on a
per-device "first sync complete" flag, and pushes a completion event to the
renderer the moment that flag is set so an already-open screen re-loads
rather than sitting on stale (empty) state until the user manually
navigates away and back. See the design doc for the exact flag, its storage,
and the push mechanism; both parts are required — gating alone leaves a
correctly-disabled button with no signal of when it becomes usable, and a
push signal alone does not stop a click that lands in the race window.

## Considered options

- **Replay the op-log from `seq 0` for a first-time device, instead of a
  row-snapshot.** Rejected. Architecturally purer in the sense that every
  mutation is already in the log, but two concrete problems in this specific
  codebase: (a) it drags along whatever historical anomalies exist in that
  log — this project has already produced at least one confirmed case
  (`schedule_templates` missing from `PROJECTIONS` until 2026-07-26 meant
  `template_slots`/`schedule_templates` ops were logged but never
  materialized for a period, per `docs/current/PLATFORM_STATE.md`'s Known Issues) — and a
  first-join replay has no way to distinguish "stale-but-now-fixed" history
  from current truth without re-deriving it op-by-op, which is exactly the
  work a row-snapshot skips by construction. (b) it is O(entire camp
  history) per join, growing every season, on a non-technical user's laptop
  over camp WiFi, versus O(current camp configuration size) for a row
  snapshot — bounded by how many groups/activities/slots a camp actually
  has, not how many times anyone has ever clicked Regenerate.
- **Ship the Host's `.sqlite` file directly on pairing.** Rejected on two
  independent, not-merely-inconvenient grounds. First, it directly conflicts
  with an already-established security invariant: `host_signing_key`'s
  private key "never leaves the Host device" and is "never included in any
  full-sync SELECT" (`electron/db/schema.sql:57-61`,
  `docs/adr/2026-07-25-device-trust-revocation.md`) — a raw file copy ships
  it unless the file is filtered/rebuilt per-recipient, at which point this
  is no longer "just copy the file," it is reimplementing row-snapshot
  full_sync over a slower, harder-to-resume channel. Second, `device_identity`
  (`electron/db/localDb.js`'s `getOrCreateDeviceId`) and
  `devices.device_secret_identifier` are per-install identity a Client must
  keep as its own; overwriting them with the Host's copies breaks the device
  trust model this app already hardened once
  (`docs/adr/2026-07-25-device-trust-revocation.md`). Third, and specific to
  this deployment's stated constraints (flaky camp WiFi): a binary file
  transfer needs new chunking/resume/checksum machinery this protocol does
  not have today (the WS layer currently only carries whole JSON messages);
  a dropped transfer mid-file is a materially worse failure mode than a
  dropped JSON message that simply gets retried whole on next reconnect (see
  Consequences below on the application-level ack).
- **Let two `schedule_templates` rows exist and pick a winner
  deterministically after the fact (e.g., lowest `id` once both have
  replicated).** Rejected — considered specifically because it was a lower-risk-
  looking alternative to changing the id-minting code path. It does not
  actually satisfy the ticket's requirement ("shipping data without fixing
  [the resolution mechanism] only narrows the window"): before the two rows
  fully replicate to every device, two independently-built, independently
  bulk-replaced schedules can both exist and both look valid on their
  respective originating device, since `bulk_replace` conflict detection is
  scoped per `template_id` and two different template ids never contend
  (this is the exact mechanism of today's bug). A camp director could print
  and start running a schedule that later silently stops being "the" schedule
  once devices reconcile — a materially worse failure for this deployment
  (real people, printed paper, running camp) than preventing the fork from
  occurring at all.

## Consequences

- **`schedule_snapshots` is not part of the first-pairing snapshot.** Each
  row stores a full point-in-time JSON blob of every slot and overlay
  (`schema.sql:329-337`); a season's worth of auto-snapshots (one is taken
  before every regenerate, `ScheduleScreen.jsx:266-274`) is unbounded growth
  over time, which is exactly the property that disqualified full op-log
  replay above — shipping it as a "bounded, current-config" snapshot would
  reintroduce the same problem in miniature. A newly-joined device's Versions
  dropdown starts empty; it fills in from the next snapshot taken *after*
  that device has joined and is connected, via the ordinary (already
  correct, untouched) `sendMissedOps` path. This is a disclosed,
  intentionally scoped limitation, not an oversight — it does not affect any
  of T7's observable completion evidence, which concerns live schedule data,
  not historical undo points.
- **A Host closed mid-transfer, or a Client whose apply genuinely fails, must
  not permanently strand a device — both now retry, not just the transport
  case.** The Host only latches `last_synced_at` after receiving a real
  `full_sync_applied` acknowledgment sent by the Client *after* its
  transaction commits (see design doc). A transport failure (connection
  drops before the message arrives), an application failure (the Client's
  transaction throws and rolls back), and a lost acknowledgment (the ack
  itself never makes it back to the Host) are now all indistinguishable from
  the Host's point of view and all resolve the same way: `last_synced_at`
  stays unset, and the next reconnect (the existing auto-reconnect loop,
  `syncClient.js:419-441`) retries the *entire* snapshot from scratch. This
  is safe specifically because every insert is `INSERT OR REPLACE` — a
  redundant full re-send, or a re-send after a partial-then-rolled-back
  attempt, is idempotent.
- **Any single invalid row anywhere in a `full_sync` payload aborts the
  entire apply — this is the intended behavior, not an unresolved gap.** An
  earlier version of this design claimed a malformed row would be skipped
  individually while the rest of the batch still applied. That claim is
  false given a single shared transaction under `foreign_keys = ON`: a
  skipped row that is itself an FK target for a later table's row (e.g. a
  skipped `schedule_templates` row whose id a valid `template_overlays` row
  references) makes that later insert throw, aborting all fourteen tables
  regardless of the per-row `continue`. Rather than build cross-table
  referential pruning to make the original claim true, the design validates
  every row of every table up front and applies all-or-nothing: if anything
  fails validation, nothing is inserted, no acknowledgment is sent, and (per
  the ack fix above) the Host retries the whole snapshot on the next
  reconnect. This is deliberately conservative — a `full_sync` payload that
  fails validation at all is treated as untrustworthy in its entirety, not
  partially salvaged — and it is *only* an acceptable choice because the ack
  fix above turns "this attempt failed" into "try again," not "fail
  forever." Before that fix, whole-batch-abort-with-silent-swallow was the
  worse failure mode described in Finding 1; after it, whole-batch-abort is
  simply the conservative, low-machinery choice.
- **A device that has not completed its first sync cannot mutate the
  schedule, and an already-open Schedule screen is told the moment it can.**
  `generate()`, `placeAnchors()`, and `restoreSnapshot()` all check a
  per-device "first sync complete" flag before running; the Host itself is
  marked complete trivially at its own bootstrap (it has no other Host to
  sync from). A Client's flag flips the moment its `full_sync` transaction
  commits and is acknowledged, and that same moment pushes a renderer event
  so a mounted Schedule screen reloads instead of sitting on stale empty
  state. This closes the concrete mechanism that made Finding 2 reachable
  (a mutating action running against incomplete local data) rather than only
  closing the identity-collision symptom.
- **One harmless, disclosed conflict-log entry on the rare simultaneous
  first-ever-create race** — this only remains reachable for a camp with
  *zero* existing schedule data (a genuinely brand-new camp; an existing
  camp's row is re-keyed by migration before any device would ever attempt a
  create against it). If two devices, neither of which has ever synced any
  template data, both call `generate()`/`placeAnchors()` within the same
  narrow window, they write the *same* `entity_id` (the deterministic id)
  with the *same* value for `camp_id`/`name`. `detectConflict` has no
  "identical value" special case, so the second write to arrive is recorded
  in `conflicts` and needs an explicit (trivial — both sides show the same
  value) resolution via the existing Conflicts screen. This is accepted as
  materially better than the previous behavior (silent, undetected, and
  permanent) and is not generalized into a broader "same-value writes never
  conflict" rule, which would be a larger, riskier change to conflict
  semantics than this ticket calls for.
- **The `UNIQUE(camp_id)` constraint's actual role, corrected.** With
  re-keying (Finding 2) in place, every device's `schedule_templates` row for
  a given camp — pre-existing or freshly created — always has the same id,
  so a create attempt against an *existing* camp's template can now only ever
  collide on the *primary key* (the intended, harmlessly-absorbed
  `INSERT OR IGNORE` case every other entity's `ensureExists` already relies
  on), never on the separate `camp_id` side-constraint with a mismatched id.
  The constraint's only remaining job is defense-in-depth against a future
  regression that reintroduces non-deterministic ids, or a manual DB edit —
  not, as the first draft incorrectly claimed, a routine recovery path for
  today's normal write pattern. If it ever *does* fire (only reachable via
  such a regression), the resulting silent-no-op behavior described in
  Finding 2's mechanism — not a thrown exception, as the first draft also
  incorrectly claimed — would recur for whatever id lost the race. This
  residual failure mode is disclosed, not further hardened, in this slice:
  removing it completely would mean rewriting `ensureExists` for every
  `PROJECTIONS` entity to distinguish "silently absorbed, expected" from
  "silently absorbed, a real collision" — a materially larger change than
  this ticket's scope, and not needed while the deterministic-id mechanism
  is what's actually preventing the collision from occurring.
- **Migration v21's dedupe survivor choice is local and unsynced — disclosed,
  not fixed.** The dedupe step (run only when a camp_id already has more
  than one `schedule_templates` row) picks `MIN(rowid)` on whichever device
  happens to run the migration, with no coordination across devices; two
  devices independently migrating a camp that genuinely had duplicate rows
  before this ships could in principle pick different survivors. This is not
  live today: production has exactly one device and exactly one
  `schedule_templates` row for its one camp, so the dedupe loop's
  `HAVING COUNT(*) > 1` does not fire at all on the only real data that
  exists. Making survivor selection deterministic and synced across devices
  would require a real op-log-driven reconciliation step, not a small fix,
  so this is accepted and disclosed rather than solved in this slice.
- Every device in a camp must run a build that computes the *same*
  `deriveScheduleTemplateId(campId)` function and has applied the same
  schema migrations. This is not a new category of risk: it is the same
  cross-device consistency assumption this project already relies on for
  `PROJECTIONS`, `BULK_REPLACE_ENTITIES`, and the single-camp-per-db
  invariant itself — none of which are enforced by a protocol-level version
  check today. Out of scope here; flagged as an open question for Governor
  below only in the sense of "is this an acceptable risk to accept without a
  version-negotiation mechanism," not as a design gap specific to this
  ticket.
