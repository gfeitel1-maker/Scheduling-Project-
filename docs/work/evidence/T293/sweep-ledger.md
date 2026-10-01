# T293 anchor sweep ledger

Method: `grep -a -rn -i "anchor" --include='*.js' --include='*.jsx' --include='*.sql' --include='*.md' --include='*.csv' src electron scripts docs test`
Raw output: `anchor-sweep-raw.txt` (captured at branch point, origin/main b90f8440).
Graphify blast radius: `graphify-blast-radius.txt` — STALE (graph built 2026-09-18, predates T266/T267) and ABSTAINED on `buildSchedule()` and `setAnchorLookup()`. Grep was the primary instrument; graph silence was NOT treated as clearance.

## Baseline counts (pre-rename)

| Scope | Hits |
|---|---|
| Total | 4977 |
| docs/work (tickets, run records — whole-file historical) | 1048 |
| docs/adr (historical ADR prose) | 684 |
| docs/archive (historical by definition) | 391 |
| Live code (src, electron, scripts) + docs/current + docs/governance | ~2854 |

## Classification

**RENAME** — live code vocabulary, all layers: persisted columns (`template_slots.anchor_id`,
`template_slots.is_anchor`, `cohorts.anchor_model`, `compound_cell_decisions.anchor_name`), the
engine public contract (`anchors` input key, `anchorId` slot field, `type:'anchor'` discriminator)
and the slot JSON persisted inside `schedule_snapshots.slots`, engine symbols and the two module
files, finding kinds, the screen + nav key, and descriptive-doc mentions.

**KEEP AS HISTORICAL** — prose whose job is to record that the old term existed: ADR and ticket
bodies, `docs/archive/**`, `_Prior:`-marked and struck-through lines in descriptive docs, the v17/v77
schema.sql comments, and the migration/rollback code that must name the old column in order to
rename it. Per CLAUDE.md, whole-file historical layers (ADRs, tickets, handoffs, archive) are out of
scope by design.

**DIFFERENT SENSE — not scheduling vocabulary:** the `--anchor` CSS design token; "trust anchor" in
security prose. Left alone deliberately.

**FROZEN BASELINE:** `scripts/_buildSchedule.before.mjs` — a deliberately frozen pre-change copy
consumed by `scripts/auditSlice4.mjs`. Renaming it would defeat its purpose.

**A DIFFERENT DOMAIN, renamed anyway:** `compound_cell_decisions.anchor_name` → `base_name`. The
owner said "at any level," so it is renamed; but it is the base term inside a compound cell label
("Lunch" in "Lunch + Leave"), structurally unrelated to fixed/recurring events, so it deliberately
does NOT borrow event vocabulary — renaming it to `fixed_event_*` would manufacture a new collision
while fixing an old one. Host-only table, never replicated, trivially reversible. The NAME CHOICE is
flagged to the owner for a one-line confirm.

Final post-rename census and allowlist: see the report and the PR body.
