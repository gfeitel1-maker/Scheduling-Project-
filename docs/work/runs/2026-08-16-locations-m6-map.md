---
task: M6 — optional camp map (background image + drag-to-position geometry)
document_type: run
date: 2026-08-16
round: 2
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_specs: [docs/work/specs/2026-08-15-camp-spatial-model-assessment.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-08-12-drag-live-write-serialization.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md, docs/adr/2026-08-09-s1b-host-local-aliases.md]
related_runs: [docs/work/runs/2026-08-16-locations-m5-week-availability.md]
selected_agents: [governor, architect, designer, maker, code-reviewer, verifier, tester, red-hat, security, grader]
omitted_agents: []
deterministic_checks: [test, lint, build, integration]
human_gates: [ADR approval for the image-sync + write-path design, Designer spec approval]
verdict: pass
completion_evidence: [electron/db/schema.sql, electron/ops/projections.js, electron/ops/operations.js, electron/auth/permissions.js, electron/sync/syncClient.js, src/screens/LocationsScreen.jsx, src/screens/locations/useLocationGeometryMutations.js, src/screens/locations/mapImageProcessing.js, src/components/locations/locationMap.css, test/integration/scenarios/23-camp-map-sync.js, docs/adr/2026-08-16-locations-optional-map.md, docs/work/tickets/T85-devices-table-never-synced-cross-device-op-drop.md]
archive_when: M6 merged to main
---

# Run: M6 — optional camp map

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1. FINAL locations slice. Owner authorized
> auto-land of locations slices; ADR + Designer spec are human gates.

## Brief

**Product outcome:** A director can (optionally) upload a background picture of their camp grounds and drag
each place onto it to position/size it — a visual map. **Owner decision (Q7, 2026-08-16): the map is visible
on STAFF TABLETS too**, so the background image must SYNC to every device (not host-local). A camp that never
opens the map is unaffected in every respect (`map_geometry` stays NULL, no readiness/engine dependency).

**Success predicate:**
1. **Geometry:** dragging/resizing a place writes `locations.map_geometry` = `{x,y,w,h}` fractions 0..1
   (per the parent ADR shape), NULL = not placed. One op on release, serialized per `location.id` via a
   COPY of the shipped `claimAndRun` write-queue (`useSlotMutations.js`), citing
   `docs/adr/2026-08-12-drag-live-write-serialization.md` — NOT a shared abstraction on the first pass
   (ARCHITECTURE_STANDARD §9), and NO queue-clear (a clear reopened the race that ADR fixed).
2. **Background image (SYNCED, Q7):** stored so it replicates to every device, BOUNDED to protect sync —
   almost certainly client-side downscale + a hard size cap + a dedicated synced entity so a large raster
   never bloats the hot op-log/full-sync path. Architect designs the exact mechanism (there is ZERO
   blob/image precedent in the repo — this is net-new; see §design questions).
3. **UI:** a "Map" view on the existing `LocationsScreen` (a List | Map toggle/tab — lowest footprint, a
   camp ignores it by never opening it). Free x/y/w/h positioning + resize handles, NOT grid-snapping.
4. **Optional invariant preserved:** engine (`buildSchedule.js`) never reads geometry; readiness never
   requires it; null geometry on every location is the normal fully-functional state.
5. test/lint/build/integration (image sync round-trip) green.

**What does not count as done:** a host-local image (owner chose synced — staff tablets); an unbounded raster
in the op-log (must be size-capped + downscaled or the sync payload explodes on every device); extracting a
shared drag/queue abstraction between the schedule grid and the map (copy + cite, per the ADR); grid-snapping
interaction (the map is free positioning); making the map required or letting null geometry nag/gate anything;
widening the `src/components/schedule/` CSS-exception boundary without justifying it under the 2026-08-06 §8
rationale.

## Standing context (Explore map, 2026-08-16 — corrected)

> The Explore agent accidentally read a STALE worktree (`reverent-tesla-761eee` @ 4a2b4d7, "LocationsScreen
> doesn't exist"). CORRECTED against the real M6 worktree (`locations-m3-screen` @ 3cfc80f): LocationsScreen
> EXISTS (M3), M2–M5 all merged. The architecture findings below are valid; the "what's built" claims were
> stale.

- **`map_geometry` (M1):** `locations.map_geometry TEXT`, nullable, registered in PROJECTIONS
  (`projections.js:167`), DOMAIN_TABLE_COLUMNS (`syncClient.js:66`), DOMAIN_SNAPSHOT_TABLES, MOCK_WRITE_ALLOWLIST
  (`localClient.mock.js:287`). Inert — no consumer reads/writes the VALUE (only registry/allowlist entries).
  Backfill wrote NULL for every row. Shape (parent ADR): `{x,y,w,h}` fractions 0..1.
- **Write-queue to COPY:** `claimAndRun(keys, claimId, dispatch)` in `src/screens/schedule/useSlotMutations.js`
  (~:154) — claim-and-drop async queue keyed by an identity string, one write on release with a `gestureId`.
  For the map: key = `location.id`, single key per gesture (simplest case — no multi-cell, no route dim).
  Parent ADR mandates copy-not-extract + cite `2026-08-12`; Red Hat mandatory on the write path.
- **Drag infra:** `@dnd-kit/core ^6.3.1` used as the sensor/keyboard-a11y layer + an FSM shape
  (`Idle→Pointing→Dragging→Resolving→Idle`, `dragFSM.js`). Reusable: sensors + FSM shape. NOT reusable:
  grid cell-key hit-testing / `gridGeometry.js` (the map is continuous x/y/w/h, not lattice-snapping).
- **CSS scope:** the ONE scoped stylesheet exception is boundaried to `src/components/schedule/`
  (`2026-08-06` §8). A map outside that dir either stays inline (`src/styles/shared.js` `S`) or justifies a
  SECOND scoped stylesheet under the same §8 rationale (attribute-selector drag/hover states off React) —
  an explicit design decision, not an automatic grant.
- **No image/blob storage exists** anywhere (grep: only crypto in localAuth/syncClient). The synced-image
  path is genuinely net-new.

## Design questions for the Architect (with a recommendation + confidence each) → ADR

1. **[Q7 = SYNCED] The image-sync mechanism.** How does a background raster replicate to every device without
   wrecking sync? Options to weigh: (a) base64 in a synced TEXT field on a DEDICATED entity (isolates the
   bloat from the hot path) with a HARD size cap + mandatory client-side downscale (e.g. max ~1600px longest
   edge, JPEG, target a few hundred KB); (b) base64 on the `camps` row (simpler, but every camp read carries
   it); (c) a chunked/streamed approach (heaviest). Confirm the op-log/full-sync can carry the chosen size,
   the conflict story for a large single field, and the size guard. Recommend one. Red Hat + Security both
   review this surface.
2. **The per-`location.id` write-queue copy.** Confirm the copy site (a new `useLocationGeometryMutations`-
   style hook), the single-key/no-route simplification, no queue-clear, cite `2026-08-12`.
3. **Interaction model.** Free x/y/w/h + resize handles on a continuous background, reusing `@dnd-kit` sensors
   + the FSM shape but NOT grid hit-testing. How much of `dragFSM.js` to mirror vs. build fresh.
4. **Styling scope.** Inline `S` vs. a second scoped stylesheet — decide against the `2026-08-06` §8 boundary,
   justify explicitly.
5. **Image upload surface (Security).** `<input type="file">` accept images; validate type/size/dimensions
   BEFORE storing (decompression-bomb / size-DoS guard); the image is untrusted input rendered back — confirm
   no XSS/SSRF vector (it's a data: URL / bytes, not a remote fetch).
6. **UI home.** Map as a List|Map toggle on LocationsScreen (recommended) vs. a separate screen. Confirm the
   optional-invariant (null geometry never gates/nags).

## Agents

| Agent | Selected | Why |
|---|---|---|
| Governor | yes | routing |
| Architect | yes | image-sync mechanism (net-new), write-queue copy, interaction model, styling scope → ADR |
| Designer | yes | the map view is a new visual/interaction surface (drag, resize, upload, empty state) — spec required |
| Maker | yes | builds to ADR + Designer spec, test-first |
| Code Reviewer | yes | plan fidelity + the copy-not-extract discipline |
| Verifier | yes | test/lint/build/integration (image sync round-trip) |
| Tester | yes | the director's upload→place→(staff-sees-it) experience |
| Red Hat | yes | **mandatory** — geometry write path (drag serialization) + the new synced-image surface (payload/sync) |
| Security | yes | image upload + sync (untrusted binary, size-DoS, decompression bomb) |
| Grader | yes | consolidates |

## ADR + owner approval (2026-08-16)

ADR `docs/adr/2026-08-16-locations-optional-map.md` **ACCEPTED by owner 2026-08-16.** Crux: new
`camp_maps` singleton entity (`id = camp_id`) holding a downscaled/capped (~1MB base64) JPEG, isolated
from the hot `camps`-read path; size guard enforced TWICE (client downscale + a NEW `MAX_FIELD_VALUE_LENGTH`
check in `appendOp` — closes a real gap: the op-log has no value-size limit today, on either the local or
the remote-Client WS path). Geometry write = copy `claimAndRun` (cite `2026-08-12`, no queue-clear).
Interaction = `@dnd-kit` sensors + a new `mapDragFSM.js` (continuous x/y/w/h + resize, NOT grid hit-testing).
Styling = a SECOND scoped stylesheet `locationMap.css` (cited under `2026-08-06` §8, not a widening).
Security = always-re-encode-through-canvas (neutralizes polyglots), SVG excluded, 40MP decompression-bomb
guard. UI = List|Map toggle on LocationsScreen. Optional invariant preserved (engine/readiness untouched).

**Owner decision (D6): map-image upload is ADMIN-ONLY** (staff keep read — Q7 — and keep place-repositioning
via existing `locations.write`; only replacing the whole background image is admin-gated). Governor calls on
the Architect's other two open items: **unplaced tray = listed** (D10 — hand to Designer, recommend showing
which places still need placing); **D2 downscale numbers (1600px / JPEG 0.82→0.6 / 750KB cap)** = accepted as
Maker's starting point, verify against real camp images, one-line to adjust.

## Designer spec + owner sign-off (2026-08-16)

Spec `docs/work/specs/2026-08-16-m6-map-design.md` (approved) + interactive mockup
`docs/work/specs/m6-map-mockup.html`. Visual decisions: List|Map toggle reuses ScheduleScreen's REAL
persistent segmented control (`:861-865`, NOT the `:736/:783` week-picker the ADR mis-cited — Designer
caught it; no design change, just which code Maker copies); places = ACTIVITY_COLORS outline + ~10% wash
(photo stays visible); labels in a solid `surface-elevated`@90% chip (guaranteed contrast over any photo,
not a text-shadow); resize handle reuses the grid's `.overlay-fill-handle`; dragging state universally navy
(state-not-identity); conflict = two `<img>` thumbnails via one new `FIELD_LABELS` sentinel in
ConflictsScreen (D3, smallest diff); remove-image reuses `ConfirmDangerDialog` with honest "not
Trash-recoverable" copy. Activation `distance: 5` (matches ADR/code, not the brief's stale 8).

**Owner sign-off 2026-08-16: APPROVED as shown.** Resize = single bottom-right corner handle (recommended).
Owner noted the mockup's drag demo didn't respond in their viewer (a static-prototype limitation — the built
feature makes every placed box drag/resize; that IS M6). **Owner flagged a future follow-up: they have their
own spec to enhance the map later** — captured as a post-M6 improvement, out of this slice's scope.

## Decision

Owner-approved ADR + Designer spec → dispatching Maker (test-first, to the ADR's 10-row registry checklist +
5 invariants + the Designer spec). Then panel (Verifier + integration [image sync round-trip] + Red Hat
**mandatory** on the geometry write-queue + the synced-image surface + Security on upload/DoS/decompression-
bomb + Code Reviewer + Tester) → Grader → auto-land. FINAL slice; on merge the camp-locations initiative is
complete (seasons + the owner's map-enhancement spec = separate future programs).

**Correction (2026-08-16, M6 fix round):** Red Hat's adversarial pass on the geometry write-queue surfaced a
pre-existing, app-wide sync defect while probing M6's cross-device delivery promise (Q7, "staff see the map
on their tablets") — filed as **T85**
(`docs/work/tickets/T85-devices-table-never-synced-cross-device-op-drop.md`). The `devices` table is never
replicated between peers, so a receiver silently fails to apply an op authored by a device it doesn't
already hold, both over live broadcast and on reconnect catch-up. This is NOT caused by M6 and affects every
synced entity, not just the map — but it does mean the ADR's D4 "live updates" description overclaims what
the platform delivers today (D4 has its own correction note). Owner decision: land M6 now; T85 is its own
high-priority initiative, sequenced separately and ahead of any other single feature slice.

## Architect design summary (2026-08-16)

ADR filed at `docs/adr/2026-08-16-locations-optional-map.md` — status `proposed`, `implementation_state`
`not-started`. This is the human gate; nothing below is built yet.

**Crux decision (image-sync mechanism):** a new dedicated singleton entity, `camp_maps` (`id = camp_id`,
one row per camp), holding a client-downscaled + always-re-encoded JPEG capped at ~1MB base64 text —
isolated from the hot `camps` read path, registered as an ordinary `DIRECT_CAMP_ENTITIES`/`PROJECTIONS`
entity (mirrors `locations`' own M1 wiring). A field on `camps` was rejected (every session-bootstrap read
would carry it); chunked transfer was rejected (the cap keeps the value comfortably inside a single
SQLite/IPC/WS payload, so chunking would solve a problem the cap already prevents). The size guard is
enforced twice: client-side downscale (1600px longest edge, JPEG 0.82→0.6, 750KB raw hard cap) as the
happy path, and a NEW `MAX_FIELD_VALUE_LENGTH` registry check inside `appendOp` itself as the authoritative
gate — closes the confirmed gap that `operations.value` has no size limit today, and covers both the local
write path and a remote Client's WS submission to the Host.

**Other decisions (D1–D10 in the ADR):** geometry write path copies `claimAndRun` verbatim into a new
`useLocationGeometryMutations` hook (single key = `location.id`, no multi-cell atomicity, no queue-clear,
cites the 2026-08-12 ADR); interaction model reuses `@dnd-kit` sensors and mirrors `dragFSM.js`'s shape in
a new `mapDragFSM.js` (grid hit-testing NOT reused — continuous coordinates); styling gets a SECOND scoped
stylesheet (`src/components/locations/locationMap.css`), explicitly justified under the 2026-08-06 ADR §8
rationale rather than widening the schedule-grid exception; upload is validated (type allowlist, SVG
excluded, 40-megapixel decompression-bomb guard, always re-encoded through canvas — this doubles as the
XSS/polyglot defense) before ever reaching the op-log; UI is a List | Map toggle on `LocationsScreen`
mirroring `ScheduleScreen`'s existing Manual/Generated route-toggle idiom; map-image WRITE is recommended
admin-only (staff keep read, satisfying Q7, and keep write on `map_geometry`/pin position — only the shared
background image itself is narrowed), a deliberate carve-out from how `locations` itself was wired in M1.

**Human-gate decisions for the owner to confirm alongside ADR approval** (see the ADR's "Open questions for
Governor"): (1) map-image upload admin-only vs. staff-writable — technical recommendation is unambiguous,
this is a role-policy product call; (2) whether an unplaced location (`map_geometry IS NULL`) should show
in an "unplaced" tray on the Map view or stay list-only until dragged on — Designer-spec-level, not
architectural; (3) a quick sanity-check of the D2 downscale numbers against a few real camp map images
before Maker builds to them, since they're a reasoned starting point, not independently benchmarked.

Everything else in the ADR (schema shape, registry wiring, sync mechanism, write-queue copy, conflict
story, CSS scoping) is a technical call already made, not open for owner selection.
