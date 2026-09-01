---
title: "Machine access — finish the MCP surface + portable schedule export"
document_type: plan
status: active
created: 2026-09-01
governing_docs: [docs/adr/2026-08-21-mcp-ingestion-server.md]
---

# Machine access — finish the MCP surface + portable schedule export

Driven by the Product Premise §14–§16 (director's work stays portable; open machine
access via CLI/MCP; expose meaningful **domain actions**, not arbitrary data access; the
app stays useful with no AI present). First customer is the owner, driving his own camp
db from Claude and moving schedules out to his own tools.

**Not an ADR.** The load-bearing architecture decisions (headless core, stdio transport,
read-default/`--allow-write` gate, single read seam) were already made and ratified in
`docs/adr/2026-08-21-mcp-ingestion-server.md` (W10). This plan **finishes and extends**
that surface; it does not reopen those choices.

Weather (Premise §11) is explicitly **out of scope** — held for its own domain session.

## Survey ground truth (verified 2026-09-01, not assumed)

- **The MCP server is built and tested**, contrary to the W10 ADR's stale
  `implementation_state: not-yet-implemented` frontmatter. `scripts/mcp/server.js` (stdio
  wiring + argv only) + `scripts/mcp/tools.js` (pure handlers) + `scripts/mcp/tools.test.js`
  (329 lines, passing). Real `@modelcontextprotocol/sdk`.
- **Live verbs:** `ingest_preview`, `ingest_commit` (gated on `--allow-write`),
  `list_entities`, `setup_summary`, `schedule_state`. `schedule_state` **re-runs the pure
  engine** over stored placement (`assembleScheduleEngineInputs` → `buildSchedule`) and
  returns freshly-computed `findings`/`conflicts` — so Premise §16 "validate schedule" is
  substantially already served, just not labelled as such.
- **Gaps:** (1) not wired into `package.json` — can't be launched by name, and not wired
  into the owner's Claude client config, so it isn't actually usable yet. (2) No
  `export_schedule` verb. (3) No stable, versioned, machine-readable schedule export
  format — `src/utils/exportSchedule.js`'s `exportToExcel` is Excel-only and
  side-effectfully calls `XLSX.writeFile` (renderer/browser-download only; unusable
  headless).
- **Export cell-resolution is domain knowledge worth sharing, not duplicating.** The
  anchor / event / elective / activity cell-label logic in `exportSchedule.js`
  (`electiveCellLabel`, `eventCellLabel`, the per-day + master-sheet loops) is the same
  resolution a JSON export needs — as structured references, not label strings. A shared
  pure resolver feeding both formats keeps Excel and JSON from drifting.
- **No `require()`/CJS**; ESM throughout. MCP runs under Node, not Electron → the
  better-sqlite3 ABI note applies (`npm rebuild better-sqlite3` before running it).

## Sequence

M1 → M2 → M3, then M4 deferred. M1 is nearly free and is the prerequisite to *using* any
of it, so it goes first. M2 is the highest-value single artifact (the format the owner
consumes to move schedules anywhere). M3 is mostly confirmation/labelling.

---

## M1 — Make the MCP runnable and honest — DONE (2026-09-01)

**Intent:** the owner can launch the existing server by name and drive his camp db from
Claude. Nothing new is built; this closes the "built but unusable" gap.

**Two blockers surfaced during execution — the server had NEVER run end-to-end:**
1. **`@modelcontextprotocol/sdk` was a declared devDependency but never installed** (absent
   from both worktree and main-checkout `node_modules`). Tests passed only because
   `tools.js` doesn't import the SDK — only `server.js` does. `npm install` resolved it (it
   was already in the lockfile).
2. **`schedule_state` crashed headlessly** — the documented **T71** issue biting for real:
   `import.meta.env.DEV` is `undefined` under plain Node (defined only under Vite/Vitest),
   throwing at 3 sites in `src/engine/buildSchedule.js` + 1 in `src/engine/weekCatalog.js`.
   The verb had never worked via the real launch path; green tests masked it because they
   run under Vitest. **Fix:** `import.meta.env?.DEV` (optional chaining) at all 4 sites — a
   pure defensive null-guard, zero behavior change (unchanged under Vite/Vitest; under Node
   the DEV-only assertion is skipped, identical to a production Vite build where `DEV` is
   false). Touches neither flag taxonomy nor placement priority → no human gate.
   `scheduling-engine` mandatory gate run: `buildSchedule.test.js` + `weekCatalog.test.js`
   = **103/103 pass**. This resolves T71's "if the engine is ever called from a plain-Node
   script…" warning (PLATFORM_STATE Known Issues — now stale, flag for update-state).

**Evidence (against the real dev db `~/Library/Application Support/shoresh-dev/shoresh.sqlite`):**
- `setup_summary` → `{age_divisions:3, programs:1, groups:15, locations:0, activities:27,
  days_of_operation:5, time_blocks:9, weeks:1}`.
- `schedule_state({route:'generated'})` → `ok:true, slots:675, findings:0`.
- No-arg launch prints `--db <path> is required`, exit 1.
- `scripts/mcp/tools.test.js` 15/15 pass.

**Success predicate (observable):**
- `npm run mcp -- --db <path>` launches the stdio server; from a connected MCP client,
  `setup_summary` / `list_entities` / `schedule_state` return real data from that db.
- The W10 ADR's `implementation_state` frontmatter reflects reality (`implemented`, dated),
  with a one-line pointer to this plan.
- A short `scripts/mcp/README.md` documents launch, the `--allow-write` gate, the ABI
  rebuild step, and the exact client-config snippet the owner pastes into his Claude
  config.

**Seam/files:** `package.json` (`"mcp"` script), `docs/adr/2026-08-21-mcp-ingestion-server.md`
(frontmatter fix only — factual, no decision change), new `scripts/mcp/README.md`. Owner's
personal Claude client config is a per-machine step done *with* the owner, not committed.

**Test note:** mechanical/tooling. No new logic; existing `tools.test.js` already covers
the handlers. Verify the `npm run mcp` invocation resolves and the ABI note is correct.

**Task class:** test-infrastructure (tooling/packaging).

---

## M2 — Stable, portable JSON schedule export (the §14 artifact) — M2a/b/c DONE (2026-09-01), M2d deferred

**Status:** M2a (resolver + versioned builder), M2b (Excel refactor onto the shared
resolver), and M2c (`export_schedule` MCP verb) are shipped and verified. M2d (renderer
"Export as JSON") is deferred to a small follow-up — see its note below.

**Evidence:**
- `src/utils/scheduleCells.js` (`buildScheduleLookups` / `resolveSlotCell` / `formatCellLabel`)
  + `src/utils/exportScheduleJson.js` (`buildScheduleExport`, xlsx-free) — the single cell
  source both formats share.
- `exportToExcel` refactored onto it; **existing `exportSchedule.test.js` stays green with no
  assertion changes** (behavior preserved).
- `export_schedule` MCP verb added + registered; read-only; same `needs_week` resolution as
  `schedule_state`.
- Tests: `scheduleCells.test.js` + `exportScheduleJson.test.js` + `exportSchedule.test.js`
  + `scripts/mcp/tools.test.js` = **all green (tools 18/18, +3 export cases)**. Lint clean.
- Headless proof (real dev db): `export_schedule({route:'generated'})` → `format_version: 1`,
  15×5×9 axes, **540 cells** (150 anchor + 390 activity), each a structured reference with a
  resolved name.


**Intent:** one versioned, documented, machine-readable representation of a candidate
schedule that the owner (and any downstream tool) can rely on — the format that answers
"where does this schedule go? wherever I want."

Decomposed so the data-shape seam is test-first (a data/logic seam per the constitution),
and the two output formats provably share one resolver.

### M2a — Shared structured cell resolver + versioned export builder (test-first)

- Extract a pure `resolveScheduleCells({ slots, activities, anchors, groups, days,
  timeBlocks, electiveSets, electiveSetActivities, events })` → structured cell records:
  `{ group_id, day_id, time_block_id, kind: 'activity'|'anchor'|'event'|'elective'|'empty',
  ref_id, name, members? }`. This is the single source of "what is in this cell",
  reusing the exact fallbacks (`Elective (removed)` / `Event (removed)`) already in
  `exportSchedule.js`.
- Build `buildScheduleExport({ ...bundle, camp, week, route })` → a **versioned** object:
  `{ format_version: 1, camp: {id,name}, week, route, groups, days, time_blocks, cells }`.
  Pure — returns the object; writing is the caller's job (no `XLSX.writeFile`-style side
  effect).
- **Success predicate:** given a fixed slot bundle, `buildScheduleExport` returns the
  documented shape; every cell kind (activity/anchor/event/elective/empty) round-trips with
  a stable `format_version`; the shape is pinned by a test so a later change is a loud diff.

### M2b — Refactor `exportToExcel` onto the shared resolver (no behavior change)

- `exportToExcel` consumes `resolveScheduleCells` instead of its inline label logic.
- **Success predicate:** `src/utils/exportSchedule.test.js` stays green with no assertion
  changes (behavior-preserving); the label strings Excel emits are unchanged.

### M2c — `export_schedule` MCP verb

- New verb over `assembleScheduleEngineInputs` (already used by `schedule_state`) +
  `buildScheduleExport`. Args `{ route, week_id? }`, same `needs_week` resolution as
  `schedule_state`. Read-only (available without `--allow-write`).
- **Success predicate:** `export_schedule({route})` returns the same `format_version: 1`
  object shape as M2a for a seeded db; multi-week dbs return `needs_week` consistently with
  `schedule_state`.

### M2d — Renderer "Export as JSON" alongside Excel — DONE (2026-09-01)

A second quiet toolbar button, "Export data (JSON)", sits beside "Export to Excel". Both run
the SAME route-resolution flow (`handleExportClick(format)`): with one route started it
exports directly; with both, `ExportChooserModal` asks which — **every time, remembering
nothing** (invariant preserved; the modal's subtitle is now format-aware via a `formatLabel`
prop). The JSON path calls the shared pure `buildScheduleExport` and triggers a
`camp_schedule.json` blob download. Envelope filled from renderer state (`campId`, resolved
`weekId`/`weeks`); camp name is left to the MCP path, which has it.

- **Evidence:** `ScheduleScreen.test.jsx` **65/65** (pins the new button on the toolbar);
  lint clean. JSON shape itself is covered by `exportScheduleJson.test.js` (M2a).

**Task class:** architecture (export contract / data-flow; the `format_version` is a stable
public contract). M2b/M2d also touch ui-ux; the stricter gate list applies.

---

## M3 — Confirm and label the read/validate surface

**Intent:** make explicit that "validate a schedule" is already served, rather than build a
duplicate. Verify `schedule_state`'s findings/conflicts are the same the renderer shows for
the same stored placement, and surface that in the tool description + README so the owner
knows the verb exists for that purpose.

**Success predicate:** a documented note (README + tool description) states that
`schedule_state` returns engine-computed findings/conflicts for a stored candidate; a test
asserts parity between `schedule_state`'s findings and the renderer's for one seeded fixture.
If a genuine gap is found (a finding the renderer shows that the verb omits), it becomes a
small follow-up ticket — not a new tool.

**Task class:** scheduling-engine (touches engine-output parity) + documentation.

---

## M4 — Deferred: write verbs beyond ingest

Not built now. Premise §16 warns against arbitrary data access — any future write verb must
be a **domain action** (e.g. "commit a generated candidate", "apply a named change") with
its own auth/identity story, gated behind `--allow-write`, and justified by an actual owner
workflow. Revisit only when a concrete need names itself.

---

## Out of scope (named so it isn't silently assumed)

- **No local HTTP/`wss` API server.** Local-first has no server; a localhost API is a new
  inbound-network + auth surface on a device that deliberately has none. CLI + MCP over the
  local db file cover the first-customer need. Revisit only if a same-LAN tool needs live
  reads.
- **The internal WS sync protocol** (`submit_op`/`full_sync`, camp-token-bound) is *not* a
  public API and must not be exposed as one.
- **Weather** (§11) — separate domain session.
