---
title: "ADR: The optional camp map (M6) — synced background image + free-position geometry"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-16
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_specs: []
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-08-12-drag-live-write-serialization.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md, docs/adr/2026-08-09-s1b-host-local-aliases.md, docs/adr/2026-08-15-locations-concurrent-create-collision.md]
supersedes: []
affects: []
---

# ADR: The optional camp map (M6) — synced background image + free-position geometry

**Status: PROPOSED.** M6 is the final slice of the camp-locations initiative
(`docs/adr/2026-08-15-camp-locations-entity.md`). That ADR locked the one-entity model, the
`locations.map_geometry TEXT` `{x,y,w,h}` shape, and deferred exactly one question to this slice:
**Q7 — is the map visible on staff tablets?** The owner answered **yes** on 2026-08-16. That
answer forecloses the host-local storage the parent ADR's "M6 Designer note" left open as a
possibility and forces the one genuinely new problem this ADR exists to solve: **a background
raster must replicate to every device without becoming the thing that makes sync slow, large, or
fragile.** There is zero blob/image storage precedent anywhere in this repository — every prior
"big value" (schedule snapshots, template_slots.flags, source_aliases) is either small JSON or, in
`source_aliases`' case, deliberately kept off the wire entirely (`docs/adr/2026-08-09-s1b-host-local-aliases.md`).
This ADR is that precedent's replicated counterpart: the same size-discipline the codebase has
never needed before, made explicit and bounded from the start.

## Context

Read directly against the current worktree (`3cfc80f`, locations M1–M5 merged):

- `locations.map_geometry TEXT` already exists (v32), nullable, registered everywhere it needs to
  be, and inert — no consumer reads or writes the value yet.
- `operations.value` (`electron/db/schema.sql`) has **no application-level size limit today**.
  `appendOp` (`electron/ops/operations.js:91-129`) validates the field name against the entity's
  `PROJECTIONS` allowlist and coerces JS type, but never checks byte length. The only existing
  size guard anywhere in the op-log/sync stack is `MAX_BULK_REPLACE_ROWS = 5000` — a **row-count**
  cap on `bulk_replace`, not a byte-size cap on any field's `value`. The WebSocket server
  (`electron/sync/syncServer.js:947`, `new WebSocketServer({ port })`) sets no `maxPayload`, so `ws`'s
  own default (100 MiB) is the only structural ceiling in the whole path today. **Everything this
  ADR proposes is a self-imposed bound, not a wall the codebase already had — that is the gap this
  ADR fills.**
- Offline catch-up replays missed ops individually, oldest-first, full value each
  (`electron/sync/syncServer.js:292`, `SELECT * FROM operations WHERE seq > ? ORDER BY seq ASC`) — a
  returning device pays once, per missed op, not per session.
- First-pairing sync is a **snapshot**, not op replay: `DOMAIN_SNAPSHOT_TABLES`/`DOMAIN_TABLE_COLUMNS`
  (`electron/sync/syncClient.js:33,54`) send current materialized rows for every registered table.
- `camps` is read via `SELECT ... FROM camps LIMIT 1` constantly — CLAUDE.md calls this out as the
  app's data-isolation mechanism, and it is exercised on session bootstrap and by nearly every
  screen. **Any column added to `camps` is paid on every one of those reads, whether or not the
  director ever opens the map.**
- The shipped write-serialization primitive is `claimAndRun` (`src/screens/schedule/useSlotMutations.js:150-176`),
  established by `docs/adr/2026-08-12-drag-live-write-serialization.md` after a **reversed** first
  design that gated only the screen, not the database. That ADR's mandate — copy the pattern per
  new consumer, never extract a shared abstraction on the first pass, never clear the queue — is a
  hard constraint on D7 below.
- The CSS-exception boundary (`docs/adr/2026-08-06-schedule-canvas-visual-layer.md` §8) is scoped,
  explicitly, to `src/components/schedule/` — "does not extend beyond it." Any styling decision for
  the map must either stay inline or justify a **second, separately-scoped** exception under the
  same §8 rationale, not silently ride on the first one.
- `locations`' own concurrent-create problem (`docs/adr/2026-08-15-locations-concurrent-create-collision.md`)
  exists because two devices can mint two different UUIDs for the same name. That problem has no
  analogue here (D1): a camp's map is a **singleton**, and its id is a pure function of the one
  thing every device already agrees on (`camp_id`), so there is nothing to collide.

## Candidate approaches considered (the crux: image-sync mechanism)

Per role: divergence is required for architecturally-significant work. The divergence here is
narrower than a green-field design because four upstream ADRs already lock the surrounding
shape (one-entity model, `map_geometry` field shape, write-queue pattern, CSS boundary) — what
remains open is genuinely the image-storage mechanism, and it has exactly three structurally
different candidates, evaluated directly against the codebase evidence above (the same evidence-
over-frames methodology the parent ADR's own D3 used, by its own account, in preference to a fifth
abstract `adhd` pass once the real constraint was in hand):

1. **[CHOSEN] A dedicated, camp-scoped singleton entity (`camp_maps`) holding the capped
   base64 image, isolated from every hot read path.** Assumption: the thing that makes an
   image dangerous to sync is not that it's synced, it's that it rides along with something read
   far more often than it changes. Isolating it into its own table with its own row means every
   read that doesn't care about the map (which is nearly all of them) never touches it.
2. **A field on `camps`.** Assumption: simplicity — one row, no new table, no new registries.
   Rejected: `camps` is read on every session bootstrap and by the single-camp-lookup pattern
   CLAUDE.md documents as the app's core data-isolation mechanism. Putting a ≤1 MB text blob on
   that row means every one of those reads — most of which have nothing to do with the map —
   carries it. This is exactly the mistake candidate 1 exists to avoid, and the parent ADR's own
   `activities.location` vs. `locations.capacity` split (D2: "one column was trying to answer two
   questions... split the questions, give each its own home") is the same discipline applied here.
3. **Chunked/streamed transfer.** Assumption: a raster is "too big" for the existing single-value,
   single-message primitives. Rejected on measurement, not intuition: D2 below caps the stored
   value at **≤ 1 MB of base64 text** (target ~530 KB). That is comfortably inside a single SQLite
   TEXT value, a single Electron IPC structured-clone payload, and a single WebSocket frame under
   `ws`'s unconfigured 100 MiB default. Chunking exists to solve a problem — payloads that don't
   fit in one round trip or one memory buffer — that a capped image never approaches. Building it
   would be complexity paid for a ceiling this design never gets close to; the cap is the simpler,
   correct answer to the same worry chunking is trying to address.

Candidates 2 and 3 are not "worse forever" — 2 would be right if the image were read as often as
it changed (it isn't: it changes on upload, reads happen every time any screen touches `camps`),
and 3 would be right if the cap in D2 didn't hold (it's enforced twice — see D2 — specifically so
it does).

---

## Decision

### D1 — New entity: `camp_maps`, a camp-scoped singleton, `id = camp_id`

```sql
-- Camp map background image (M6, docs/adr/2026-08-16-locations-optional-map.md). ONE row per
-- camp, id = camp_id (not a minted uuid) — the map is a singleton the same way `camps` itself
-- is, so there is nothing for two devices to disagree about the identity of. Isolated from
-- `camps` deliberately: `camps` is read on nearly every screen (CLAUDE.md's single-camp-lookup
-- pattern); a background image large enough to matter must not ride along with that read.
-- image_data is ALWAYS re-encoded JPEG (never the uploaded file's original bytes — see D5),
-- capped at ~1MB of base64 text by BOTH the client uploader and appendOp (D2). NULL image_data
-- is the normal, fully-supported "no map" state — nothing in the app treats it as incomplete.
CREATE TABLE IF NOT EXISTS camp_maps (
  id TEXT PRIMARY KEY,              -- = camp_id
  camp_id TEXT NOT NULL UNIQUE REFERENCES camps(id),
  image_data TEXT,                  -- base64 JPEG, NULL = no map uploaded
  image_mime TEXT,                  -- always 'image/jpeg' today (D5); kept for forward compat
  image_width INTEGER,              -- POST-downscale pixel dimensions, set at upload time
  image_height INTEGER
);
```

Declared in both `schema.sql` (v33 header comment, placed near `locations`) and a v33 migration
block in `localDb.js` (`CURRENT_SCHEMA_VERSION` bumps 32 → 33), byte-identical DDL, per the v28/v30/v32
both-places precedent. **No backfill** — this is a genuinely new, empty-by-default table; every
existing camp gets a row with `image_data = NULL` created lazily by `ensureExists` on first write
(below), exactly like `locations`' own `ensureExists` seeds a blank row.

`camp_id` is redundant with `id` in principle (they are always equal) and is kept anyway,
deliberately: every generic scanning path (`list()`, `full_sync`, permission scoping) filters
`WHERE camp_id = ?` uniformly across every `DIRECT_CAMP_ENTITIES` table, and special-casing
`camp_maps` to be scanned by `id` instead would be exactly the kind of one-off exception
`ARCHITECTURE_STANDARD.md` §9 warns against introducing for a single consumer's convenience.

**Registration (mirrors `locations`' own M1 wiring exactly):**

```js
// projections.js
camp_maps: {
  table: 'camp_maps',
  key: 'id',
  fields: ['camp_id', 'image_data', 'image_mime', 'image_width', 'image_height'],
  ensureExists: (db, id) => {
    const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
    getStmt(db, 'INSERT OR IGNORE INTO camp_maps (id, camp_id) VALUES (?, ?)').run(id, camp?.id ?? null)
  },
},
```

### D2 — The size guard: capped, downscaled, enforced twice, no exceptions

**Client-side (renderer, the happy path):** before any write is attempted, the uploaded image is
always redrawn onto an offscreen `<canvas>` and re-exported:

- Decode the source file (`createImageBitmap` or an `Image` element) and read its **decoded pixel
  dimensions before drawing anything** — reject (with a clear, director-facing message) if decoded
  width × height exceeds **40 megapixels**. This is the decompression-bomb guard: a file whose
  *declared* size is small but whose *decoded* raster is enormous is caught before a single pixel
  is drawn, not after the canvas operation has already spent the memory.
- Resize so the longest edge is **≤ 1600px** (a camp map is a diagram a director drags pins onto,
  not a photograph anyone zooms into pixel-for-pixel).
- Export via `canvas.toBlob(..., 'image/jpeg', 0.82)`. Target output **≤ 400 KB** raw bytes. If the
  first pass exceeds that, re-export once more at quality 0.6. **Hard cap: 750 KB raw bytes** after
  the retry — if still over, refuse the upload with a message telling the director to pick a
  simpler image, never silently truncate or silently accept an oversized value.
- Base64-encode the final JPEG (~33% inflation) → **≤ ~1 MB of text**, which is what actually
  reaches `operations.value`.

**Server-side (main process, the authoritative gate — this is the one that matters for security,
not convenience):** the client-side path above is what a well-behaved renderer does; it is not
what stops a hostile or buggy one. `appendOp` (`electron/ops/operations.js`) is the single choke
point both the local `write()` path and the Host's `handleSubmitOp` (a remote Client's WS
submission) go through — exactly the reasoning that already made it the right place to refuse
`source_aliases` writes. Add a parallel registry, same shape as `MAX_BULK_REPLACE_ROWS`/
`BULK_REPLACE_ENTITIES`:

```js
// operations.js
export const MAX_FIELD_VALUE_LENGTH = {
  camp_maps: { image_data: 1_400_000 },  // chars; ~1MB base64 + slack, never truncated, hard reject
}
```

checked in `appendOp` immediately after the existing field-allowlist check, before the transaction
opens: `if (limit && typeof storedValue === 'string' && storedValue.length > limit) throw new
Error('value exceeds MAX_FIELD_VALUE_LENGTH for entity/field')`. This is the one genuinely new
piece of the op-log surface this ADR asks for, and it is scoped to exactly the one field that
needs it — not a generic cap applied to every entity, which would be solving a problem no other
field has. **This is what "the op-log has no size limit today" (confirmed above) becomes bounded
by**, and it is enforced identically whether the write originates from this device's own renderer
or arrives over WS from a paired Client — a compromised or buggy Client cannot bypass it by
skipping the renderer-side downscale.

**Why not also cap every field generically?** Flagged, not built here: every other field this
codebase writes is small by construction (names, ids, small JSON like `map_geometry`'s four
numbers). A blanket cap would be solving a problem that doesn't exist yet anywhere else. If a
future entity needs one, `MAX_FIELD_VALUE_LENGTH` is already the right registry to extend — this
ADR does not need to anticipate that consumer.

### D3 — Conflict resolution: ordinary field-level LWW, no new machinery, Designer must not render raw base64

`image_data` is one field on one row, so a genuine concurrent-edit conflict (two devices write
different images before either write reaches the other) goes through the **existing**
`detectConflict`/`conflicts` machinery unchanged — nothing new to build. This is rare by
construction: D6 makes uploading admin-only, and admins concurrently replacing the whole camp's
map image at the same moment is a narrow window even under that gate. It is not impossible, so it
must still be handled, just not with new infrastructure.

**Designer requirement (not a blocker for this ADR, but load-bearing for M6's UI spec, mirroring
the parent ADR's identical note for `map_geometry`):** the generic conflict-resolution surface
would, today, show the two competing `operations.value` strings — for this field that means two
~700KB base64 blobs rendered as unreadable text. **M6's Designer spec must render an `image_data`
conflict as two thumbnail previews (`<img src="data:image/jpeg;base64,...">`) side by side, never
raw text.** This is the same "render the human-legible shape, not the wire shape" discipline the
parent ADR required for `map_geometry`-as-rectangle, applied to the one field where getting it
wrong would be far worse (a wall of base64 vs. an unreadable JSON object).

### D4 — Sync wiring: ordinary registration, FK-ordered after `camps`

- `DIRECT_CAMP_ENTITIES` (`electron/ops/campScopedEntities.js`) — add `'camp_maps'`.
- `DOMAIN_SNAPSHOT_TABLES` / `DOMAIN_TABLE_COLUMNS` (`electron/sync/syncClient.js:33,54`) — add
  `camp_maps` **after** `'camps'` (FK dependency) in `DOMAIN_SNAPSHOT_TABLES`; columns
  `['id', 'camp_id', 'image_data', 'image_mime', 'image_width', 'image_height']` in
  `DOMAIN_TABLE_COLUMNS`. A first-pairing tablet receives the (already-capped) image exactly once,
  as part of its one-time snapshot — no different in kind from receiving every other camp-scoped
  table's current rows.
- **Live updates:** a director's upload broadcasts as one field-level op over the existing
  `op_applied` push, same as any other write — a one-time, bounded (≤ ~1 MB) push to every
  connected device.
  **Correction (2026-08-16, found during the M6 fix round's Red Hat pass):** this describes the
  intended wire behavior, not what the current platform actually delivers. **T85**
  (`docs/work/tickets/T85-devices-table-never-synced-cross-device-op-drop.md`) is a pre-existing,
  app-wide platform defect — NOT caused by M6, affects every synced entity — where a receiving
  device silently fails to apply an op authored by a device whose `devices` row it doesn't already
  hold, both over live broadcast and on reconnect catch-up. In practice, live cross-device delivery
  of a map upload is reliable only for the authoring device, the Host (which learns every Client at
  pairing), or after a fresh full re-pair — until T85 lands. Staff-tablet visibility of a newly
  uploaded map is NOT reliably live today; owner decision was to land M6 now and fix T85 as its own
  initiative.
- **Offline catch-up:** a device that missed N image-replacement ops while offline replays all N in
  full on reconnect (`syncServer.js:292`'s `seq > since` replay). This is bounded by *how many
  times a director has ever replaced the map*, which is realistically low single digits over a
  camp's lifetime — not a recurring cost paid per session, per reconnect, or per read.
- **Op-log growth is monotonic and disclosed, not hidden.** Every image replacement appends a new
  ≤1MB op to the log permanently (op-log is append-only, matching every other field in this
  architecture). Over a camp's lifetime this is bounded by upload frequency, not usage frequency —
  acceptable and consistent with how the rest of the op-log already behaves (nothing in this
  codebase compacts history). Not a new risk category; sized here so it's a known quantity instead
  of a surprise.

### D5 — Upload surface: allowlisted raster input, always re-encoded through canvas, never the original bytes

`<input type="file" accept="image/png,image/jpeg,image/webp">` — **SVG excluded from the accept
list and rejected if selected anyway** (checked via decoded-image validation, not filename/MIME
sniffing alone): SVG can carry `<script>`/event-handler payloads and has its own history of
XSS-via-untrusted-render, and unlike a raster it isn't neutralized just by being drawn to a canvas
in every browser engine.

**The re-encode-through-canvas step in D2 is also the security control, not just the size
control.** Because the stored `image_data` is always the canvas's own JPEG output — never the
uploaded file's original bytes, whatever format or embedded payload they contained — a polyglot
file or an image with embedded non-image data cannot survive to storage. What is decoded, drawn,
and re-exported is pixels; nothing else about the original file makes it into `operations.value`.

**Rendering back:** always `<img src="data:image/jpeg;base64,${image_data}">`, constructed from a
value this device's own SQLite row holds — never a remote URL, never `dangerouslySetInnerHTML`,
never passed through anything that interprets it as markup. There is no SSRF surface (no fetch of
anything the image references — a `data:` URL has no network step) and no XSS surface beyond what
any `<img src>` already carries (none, for image mime types).

### D6 — Permission: staff can READ the map (Q7's whole point); WRITE is admin-only

**Recommendation, high confidence:** register `camp_maps` for **read** in the staff role via an
explicit grant (`'camp_maps.read'` added to the `staff` array in `electron/auth/permissions.js`,
the same explicit-grant shape `trash.read`/`conflicts.read` already use) — **not** via the generic
`ENTITIES` array, which would derive both `.read` and `.write` for staff automatically. Leave
`camp_maps.write` **out** of the staff grant, so it resolves admin-only via `authorize()`'s
default-deny (the same mechanism that already makes `restore` admin-only despite staff holding
`.write` on the same entities).

**Why this needs a deliberate carve-out rather than mirroring `locations` wholesale:** `locations`
gained full staff read/write in M1 because editing one place's capacity/notes is exactly the kind
of day-to-day camp-domain edit staff already make everywhere else. Replacing the **entire camp's**
background image is a different blast radius — one action changes what every device, including
every other staff tablet, displays as the map, with no per-row scope to contain a mistake.
`locations.map_geometry` (repositioning a pin) stays under the existing broad `locations.write`
grant staff already hold, unchanged — only the image itself is narrowed. This is a role-policy
call, not a purely technical one, so it is flagged below for owner confirmation, but it is not left
open: build it this way unless told otherwise.

### D7 — Geometry write path: copy `claimAndRun`, do not extract it

A new hook, `src/screens/locations/useLocationGeometryMutations.js`, copying the `claimAndRun`
primitive from `useSlotMutations.js:150-176` **verbatim in structure**, simplified for the map's
narrower shape:

- **Key:** `locationKey(locationId) = locationId` — no route/template dimension. The schedule
  grid needed `route|templateId|groupId|dayId|blockId` because two candidate schedules share one
  coordinate space (`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`); the map has no
  second "route" to collide with, so the key collapses to the one thing that varies: which place.
- **No multi-cell atomicity.** `replaceSlot`'s `keys = [targetKey, sourceKey].sort()` exists
  because a slot move touches two cells atomically. A location drag/resize touches exactly one
  location's rectangle — always `keys = [locationKey]`. `claimAndRun`'s array-of-keys signature is
  kept as-is (not narrowed to a single string) purely so the copy is a copy, not a rewrite; it is
  always called with a one-element array.
- **One op per gesture, on release.** Position/size live in local React state during the drag
  (pointer-move never writes); on pointer-up, one `claimAndRun([locationId], gestureId, dispatch)`
  call where `dispatch` performs one field write:
  `repo.writeFields('locations', locationId, { map_geometry: JSON.stringify({ x, y, w, h }) })` —
  reusing whichever field-write primitive `LocationsScreen.jsx`'s existing `setupCrudRepository`
  instance already exposes for `locations` (it already writes `capacity`/`notes`/`sort_order`
  fields on this same table; `map_geometry` is one more field on an already-wired entity, not a new
  write path).
- **No queue-clear, ever — cite `docs/adr/2026-08-12-drag-live-write-serialization.md` directly in
  the code comment.** That ADR's own history is the reason: a clear-on-unmount/route-switch
  revision reopened the exact same-cell DB-divergence race the queue exists to prevent.
  **Queue lifetime — CORRECTED at build (Red Hat, 2026-08-16):** the queue is **module-scoped**
  (`const geometryWriteQueue = new Map()` outside the hook), keyed by `locationId`, NOT a per-hook
  `useRef`. This DELIBERATELY differs from `useSlotMutations` (whose per-instance ref suffices only
  because `ScheduleScreen` is a single long-lived per-session mount): `LocationsScreen` fully
  unmounts/remounts on ordinary sidebar navigation, so a per-instance queue would lose the in-flight
  tail across a navigate-away-and-back, reopening the race for a re-drag of the same location before
  its first write settled. Module scope gives the map hook the same effective lifetime the pattern
  assumes. Still no clear. Bounded, not a leak: entries are REPLACED per `locationId` key (not
  appended), so size = distinct locations ever dragged this process (a few dozen UUIDs), resetting on
  process restart; cross-camp bleed is unreachable under single-camp-per-device-db.
- **Do not extract a shared hook between `useSlotMutations` and this one.** Per
  `ARCHITECTURE_STANDARD.md` §9 and the parent ADR's explicit instruction: two call sites sharing a
  *pattern*, cited by comment, is the correct amount of reuse on a first pass. A shared abstraction
  is worth building only once a third consumer exists or the two diverge in a way that makes
  keeping them in sync error-prone — neither is true today.
- **Red Hat is mandatory on this hook once built**, per the same standard the schedule grid's write
  queue was held to, specifically probing: synchronous claim/chain (no `await` between claim and
  chain-build), and whether unmounting `LocationsScreen` mid-chain (navigating away during a drag's
  in-flight write) can leave a dangling claim — the map hook has no route-switch case but does have
  a screen-navigation case, which is the closest analogue and must get the same scrutiny.

### D8 — Interaction model: `@dnd-kit` sensors reused, grid hit-testing and `dragFSM.js` NOT reused

- **Reused as-is:** `@dnd-kit/core`'s `PointerSensor`/`KeyboardSensor` configuration
  (`useSensor(PointerSensor, { activationConstraint: { distance: 5 } })`,
  `useSensor(KeyboardSensor)`), exactly as `ScheduleScreen.jsx:202-204` configures them — this is
  what keeps keyboard-driven repositioning accessible, and there is no reason to reconfigure
  thresholds that are already tuned for this app's pointer/click disambiguation.
- **Not reused:** per-cell `useDroppable` (already rejected for the schedule grid itself, per the
  CSS ADR — up to 480 subscribers was the reason there, and it applies here too) and
  `gridGeometry.js`'s lattice math, which computes discrete row/column placement — the map has no
  lattice; a place's rectangle is four continuous fractions of the image's bounding box, computed
  directly from pointer position relative to the container's bounding rect, not resolved against a
  grid.
- **Mirror the SHAPE of `dragFSM.js` (Idle → Pointing → Dragging → Resolving), do not import it.**
  A new, small, pure reducer (`src/screens/locations/mapDragFSM.js`), same four states and the same
  reasons for each (`Pointing` is still the click-vs-drag ambiguity home; `Resolving` is still "op-
  log write not yet committed"). It is not the same file because `dragFSM.js`'s `context` payload
  and `DRAG_KINDS` are grid-shaped (`groupId`/`dayId`/`blockId`, hit resolution against cells) —
  copying the file would mean immediately deleting most of what it does. Two drag "kinds" for this
  FSM: **move** (drag the rectangle) and **resize** (drag a handle, changing `w`/`h` and possibly
  `x`/`y` for a top/left handle) — both are position/extent changes that write the same
  `map_geometry` field on release, so they share the one hook (D7) and differ only in which of
  `x/y/w/h` the gesture is allowed to change. This mirrors how the schedule grid already treats
  `EXPAND_DRAG` as its own kind for extent-changing (vs. position-changing) gestures — same idea,
  applied to a continuous surface instead of a lattice.
- **Drop feedback stays static**, per the CSS ADR's Atlassian-sourced finding (animated placement
  reads as sluggish): the rectangle follows the pointer 1:1 during drag; there is no separate
  "ghost preview vs. final position" animation to build, because there is no snapping to animate
  toward.

### D9 — Styling: a second, narrowly-scoped stylesheet, explicitly justified under §8

**Recommendation: `src/components/locations/locationMap.css`**, a **second** scoped exception,
separate from `scheduleGrid.css` and its directory. Justified under the identical §8 rationale —
inline styles have no `:hover`/`:active`/attribute-selector states, and paying for those with React
state (`useState` hover flags × up to a few dozen resize handles) is the same cost the schedule ADR
rejected canvas over. This file owns: the map container's positioning context, hover/active/drag/
resize-handle pseudo-states and data-attributes (`[data-dragging]`, `[data-resize-handle]`,
`[data-selected]`), mirroring `scheduleGrid.css`'s own `[data-drag-over]`/`[data-selected]`
convention in spirit, not by import. Per-location computed geometry (`left`, `top`, `width`,
`height` derived from `map_geometry`'s fractions × the rendered image's box) stays inline, exactly
as `scheduleGrid.css`'s own boundary keeps computed `gridRow`/`gridColumn` inline.

**What this explicitly does NOT do:** widen `src/components/schedule/`'s existing exception, touch
`scheduleGrid.css` itself, or convert `LocationsScreen.jsx`'s existing List-view CRUD rows to CSS —
those stay inline `S` (`src/styles/shared.js`), unchanged. The 2026-08-06 ADR's own words — "the
boundary is `src/components/schedule/` and does not extend beyond it" — are honored by making this
a **second, independent, cited** exception rather than an extension of the first.

### D10 — UI home: a List | Map toggle on `LocationsScreen`, mirroring the existing route-toggle idiom

Add a two-way toggle to `LocationsScreen.jsx`, visually and structurally modeled on
`ScheduleScreen.jsx`'s existing Manual/Generated route toggle (`:736`, `:783`) — same segmented-
control idiom, not a new pattern invented for this screen. `List` (default) is the existing M3 CRUD
table, unchanged. `Map` renders the new surface:

- **No image uploaded (`camp_maps.image_data IS NULL`, or no `camp_maps` row yet):** an empty
  state with the upload control — never a nag, never a gate, never a difference in what any other
  screen does. This is the concrete expression of the optional invariant: a camp that never opens
  the Map tab, or opens it and never uploads, is byte-for-byte unaffected everywhere else.
- **Image uploaded:** the background renders at its natural aspect ratio (from `image_width`/
  `image_height`, avoiding layout shift while the `data:` URL decodes); every location with non-
  NULL `map_geometry` renders as a positioned, draggable/resizable rectangle labeled with its name;
  locations with NULL `map_geometry` are listed separately (e.g. an "unplaced" tray) rather than
  silently absent — a director must be able to see *which* places still need positioning, not guess.
- **Engine and readiness are untouched — confirmed, not assumed.** `buildSchedule.js` and
  `src/engine/readiness.js` have no reference to `map_geometry` or `camp_maps` today (grepped), and
  nothing in this design adds one. This must remain a Maker/Verifier-checked invariant, not a
  one-time claim: a test asserting neither file imports or reads either name is cheap insurance.

## Registry checklist — mirrors `locations`' own M1 checklist exactly, applied to `camp_maps`

| # | Registry | File | Entry |
|---|---|---|---|
| 1 | `PROJECTIONS` | `electron/ops/projections.js` | `camp_maps` entry, D1 |
| 2 | `DIRECT_CAMP_ENTITIES` | `electron/ops/campScopedEntities.js` | add `'camp_maps'` |
| 3 | `DOMAIN_SNAPSHOT_TABLES` + `DOMAIN_TABLE_COLUMNS` | `electron/sync/syncClient.js` | add `camp_maps`, ordered **after** `'camps'` |
| 4 | `permissions.ENTITIES` / staff grant | `electron/auth/permissions.js` | **NOT** added to `ENTITIES` (would derive staff write); explicit `'camp_maps.read'` grant only (D6) |
| 5 | `RESTORE_DECISIONS` | `electron/ops/restore.js` | `camp_maps: 'refused: singleton camp-scoped row, no independent delete UI — clearing the image is an ordinary field write of image_data to NULL, not a row delete'` (mirrors the existing `camps: 'refused: singleton identity row...'` entry) |
| 6 | `MOCK_WRITE_ALLOWLIST` + table-column list | `src/localClient.mock.js` | hand-transcribed mirror, per the existing "do not import from `electron/`" rule |
| 7 | `PROJECTION_FIELD_EXCEPTIONS` | `electron/ops/projectionsCoverage.test.js` | not expected to be needed — every `camp_maps` column is in `fields` |
| 8 | `ENTITY_LABEL` | `src/screens/recordLabels.js` | optional; only needed if a per-record history panel ever surfaces `camp_maps` edits — recommend adding `camp_maps: 'Camp map'` for consistency at zero cost |
| 9 | `MAX_FIELD_VALUE_LENGTH` (NEW registry, D2) | `electron/ops/operations.js` | `{ camp_maps: { image_data: 1_400_000 } }` |
| 10 | `UNIQUE_FIELD_ENTITIES` (not needed) | `electron/ops/operations.js` | **N/A** — `camp_maps` has no name-uniqueness question; `id = camp_id` makes the concurrent-create-different-uuid problem `locations` had structurally impossible here (see "Context") |

Rows 1, 3, and 4 are this table's silent-failure modes (op discarded / first-pairing tablet never
receives the image / staff silently denied read despite Q7 requiring it) — each needs a positive
test, not just registration, per the parent ADR's own discipline for its four silent-failure rows.

## Migration (v32 → v33)

No backfill, no data to migrate — `camp_maps` starts empty on every existing camp; rows are created
lazily by `ensureExists` on first write, exactly like `locations`' own blank-row seeding. Fresh-vs-
migrated `PRAGMA table_info(camp_maps)` equivalence + idempotency twin, matching the standing
five-precedent pattern (`localDb.migrations.test.js`, `locations.migration.test.js`, etc.). No
column-order trap: every `camp_maps` column is present in the `CREATE TABLE` from the start (no
ALTER-added column), so fresh and migrated installs are identical by construction.

## Invariants — normative, each needs a test

1. **Image size is capped BEFORE it ever reaches the op-log**, enforced in `appendOp` itself
   (D2), not only in the renderer — a write exceeding `MAX_FIELD_VALUE_LENGTH.camp_maps.image_data`
   is rejected with a thrown error, for both the local `write()` path and the Host's
   `handleSubmitOp` path, before any DB transaction opens.
2. **`map_geometry` is synced, ordinary camp-domain data** — unchanged from the parent ADR; this
   ADR does not touch that decision, only implements the write path that populates it (D7).
3. **The engine and readiness never read `map_geometry` or `camp_maps`** — `buildSchedule.js` and
   `readiness.js` have zero references today; a test pins that this stays true.
4. **Optional in every respect.** `camp_maps.image_data IS NULL` (or no row at all) is the normal,
   fully-functional state for every camp that never opens the Map tab — no readiness row, no
   reconciliation chip, no nag, matching the parent ADR's `FORWARD_AREAS`/`OPTIONAL_AREAS`
   discipline for `location` itself.
5. **`camp_maps` is never independently deletable via Trash** — clearing the map is a field write
   (`image_data = NULL`), not a row delete; `RESTORE_DECISIONS` refuses it for that reason (registry
   row 5).

## What Red Hat and Security must verify (mandatory, per task_class `database-sync`)

- **Sync payload impact.** Confirm a `full_sync` snapshot with a populated `camp_maps` row stays
  well under any real-world constraint (WS default 100 MiB, IPC structured-clone) — the ≤1MB cap
  should make this trivially true, but verify the actual serialized snapshot size on a camp with a
  maximal-size image, not just the field in isolation.
- **Size-DoS.** Confirm `appendOp`'s `MAX_FIELD_VALUE_LENGTH` check actually runs before the
  transaction opens on **both** paths (local `write()` and the Host's `handleSubmitOp` for a remote
  Client's WS submission) — a gap on either path lets a compromised/buggy paired device push an
  oversized value straight to the Host's DB, bypassing the renderer entirely.
- **Decompression bomb.** Confirm the 40-megapixel decoded-dimension check runs before any canvas
  draw operation, on a crafted file whose declared size is small but decoded raster is huge.
- **SVG/polyglot rejection.** Confirm an SVG (or a polyglot file with an image extension) is
  refused, not silently drawn-and-passed-through.
- **Conflict on the large field.** Confirm a genuine concurrent `image_data` write from two devices
  surfaces via the existing `conflicts` table (no new codepath silently drops one side), and that
  the conflict payload doesn't get logged/displayed as raw base64 anywhere before the Designer's
  thumbnail rendering (D3) lands.
- **The drag write-queue race**, on `useLocationGeometryMutations` specifically: synchronous claim/
  chain (no `await` gap), and whether a mid-chain screen navigation away from `LocationsScreen`
  during a drag can leave a dangling claim — the closest analogue to the schedule queue's route-
  switch case, per D7's Red Hat mandate above.
- **Permission boundary (D6).** Confirm staff genuinely have `camp_maps.read` (Q7's requirement)
  and genuinely lack `camp_maps.write` — both directions matter; a silent-admin-only read would
  break the product requirement Q7 exists to satisfy, and a leaked write would undo D6's rationale.

## Reused vs. new

**Reused:** the `locations` M1 registry-wiring pattern (D1/registry checklist, applied verbatim to
a second entity); `claimAndRun`'s structure (D7, copied not extracted, per the drag ADR's explicit
mandate); `@dnd-kit`'s sensor configuration (D8); the `dragFSM.js` four-state *shape* (D8, mirrored
not imported); the CSS-exception §8 rationale (D9, a second cited instance, not a widened first
one); the existing `detectConflict`/`conflicts` machinery (D3, unchanged); the explicit-staff-grant
permission pattern already used for `trash.read`/`conflicts.read` (D6); the `ScheduleScreen`
Manual/Generated toggle idiom (D10); `appendOp` as the single write choke point, extended with one
new registry entry the same shape as `MAX_BULK_REPLACE_ROWS` (D2).

**New:** the `camp_maps` table and its registrations (D1, D4); `MAX_FIELD_VALUE_LENGTH` in
`operations.js` (D2) — the first byte-size guard on a field's `value` this codebase has needed;
`useLocationGeometryMutations.js` (D7); `mapDragFSM.js` (D8); `locationMap.css` (D9); the List|Map
toggle and its Map view (D10). Nothing here is a new *kind* of machinery — every new file is a
same-shape sibling of something the codebase already has one of.

## Consequences

- **Positive:** the camp-locations initiative closes with the map slice using the same op-log/
  sync/permission machinery as every other entity — no second sync architecture, no host-local
  carve-out that would have contradicted Q7. The size discipline this ADR introduces
  (`MAX_FIELD_VALUE_LENGTH`) is a small, reusable primitive the next large-value entity (if one
  ever arrives) can register into rather than re-deriving.
- **Costs / risks:** the op-log grows monotonically with every image replacement (disclosed in D4,
  bounded by upload frequency not usage frequency); `camp_maps` is the first entity in this codebase
  whose write path does client-side image processing before the op-log ever sees it, which is new
  surface for Maker to get right and for Red Hat to probe (decompression bomb, re-encode-always).
  Staff losing write access to the map image (D6) is a real behavior change from the "staff can
  write everything locations-related" pattern M1–M5 established, and needs explicit owner
  confirmation even though the technical recommendation is unambiguous.
- **Explicitly NOT decided here:** whether a director can *remove* the map image entirely from the
  Map tab UI (vs. only replacing it) — this is a small UX question for the Designer spec, not an
  architectural one (either way is the same field write, `image_data = NULL`); the exact JPEG
  quality curve if D2's two-pass (0.82 → 0.6) proves insufficient on real photos — Maker should
  treat the numbers in D2 as a starting point to verify against real camp-map images, not a
  contract to hit exactly.

## Open questions for Governor (product judgment, not technical)

1. **D6 — is map-image upload really admin-only, or should staff be able to replace it too?**
   Technical recommendation is unambiguous (admin-only, high confidence, rationale in D6); this is
   flagged because it is a role-policy choice with a real product consequence (a staff member who
   spots a wrong/outdated map today can't fix it themselves), not because the technical answer is
   unclear.
2. **D10 — should a location with `map_geometry IS NULL` be visually listed in the Map view (an
   "unplaced" tray) or simply absent until dragged on?** Recommended: listed (a director should see
   what's left to place, not have to cross-reference the List view) — but this is a Designer-spec-
   level UX call, not architecture, and should be confirmed alongside the Designer's spec approval
   gate already on this run record.
3. **Confirm the D2 numbers (1600px / JPEG 0.82→0.6 / 750KB hard cap) against a handful of real
   camp photos/diagrams before Maker builds to them** — they are a reasoned starting point from the
   brief's own suggested range, not independently benchmarked against this app's actual users'
   images. If they prove too aggressive (visibly blurry maps) or too loose (uploads regularly hit
   the hard cap and get refused), adjusting them is a one-line change, not a redesign — but it's
   worth a quick gut-check before Maker, not after Testers complain.
