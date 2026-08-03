---
title: "Robust grid detection — ingesting a third schedule layout family"
document_type: spec
status: draft
created: 2026-08-02
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
related_adrs:
  - docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
related_tickets:
  - docs/work/tickets/T16-ingest-prior-year-schedule.md
archive_when: the Maker's change lands, the ingest suite is green with the synthetic fixture, and Shemesh imports a correct proposal
---

# Robust grid detection — ingesting a third schedule layout family

## Summary

The PDF ingest parser silently produces **0 pages / 0 entities** for a real fourth camp
("Shemesh 2025"), because page and column detection is anchored on the literal token `Time`
in the header row, and this camp leaves its time column **unlabeled**. No header is found →
no pages → nothing downstream runs. A silent empty proposal is the exact failure mode the
ingestion ADR (§1) exists to prevent — over-inclusion is recoverable, silent omission is not.

This spec re-anchors detection on two layout-independent signals, adds a location-sub-line strip
and a positional-unit-code inference for the new family, and drops the repeating page banner. All
new behaviour is **gated behind a single per-page boolean** (`the header carries no "Time" label`),
so the two already-shipped camps execute a byte-identical code path and cannot regress.

The design was validated against the real files before writing (see **§8 Evidence**): a patched
prototype produced Camp A / Camp B output **byte-identical** to today, and produced for Shemesh the
exact target proposal — units `{K,1,2,3,4,5,R}`, 20 groups, days Mon–Fri, ~11 time blocks, and an
activity list with **no** phantom room names or bare room numbers.

This changes **no** stored-data shape, no schema, no projection, no IPC, and no commit path. It is a
methodology refinement wholly inside ADR 2026-08-01's accepted decisions. **ADR verdict: no new ADR;
a short addendum to §7 of the accepted ADR is the right-sized durable record (drafted in §5). The
database/sync gate is already cleared by the existing ADR and the existing "no migration" fact.**

---

## 1. Scope and success predicate

**In scope** — five parser/extractor rules (items a–e below), all inside `src/ingest/`.

**Success predicate** (from the brief, restated as an observable): running the ingest pipeline on the
Shemesh text yields a proposal with tiers `{K,1,2,3,4,5,R}`, 20 groups, days Mon–Fri, its time
blocks, and activities carrying **no** phantom room-names (`Kitchen`, `Pool`, `Social Hall`,
`Studio 2`, `Youth Wing`, `Classroom`) and no bare room numbers — **and** Camp A + Camp B are not
regressed (the 91 existing `src/ingest` tests stay green and their entity outputs are unchanged).

**Explicitly out of scope**: the Excel path (`sheetGrid.js`), the preview, the commit, any schema or
IPC. See §6 (do-not-change list).

**Non-goals**: 24-hour normalisation of the new camp's 12h AM/PM times (§7 risk R1); splitting
combined `A/B` activity slots; correcting source typos. These are director-review concerns, not
parser concerns, and over-inclusion is the ADR-sanctioned bias.

---

## 2. The three layouts, side by side

The parser must now serve three structures. Measured character offsets (not assumed):

| | Camp A | Camp B | **Shemesh (new)** |
|---|---|---|---|
| Family | 1 page / group | 1 page / day | 1 page / group |
| Header row | `Time  Monday … Friday` | `Time  Yeladim 1 … CIT` | `Monday … Friday` (**no Time**) |
| Time column | labelled `Time` @ col 4 | labelled `Time` @ col 3 | **unlabeled**, times @ col 0–8 |
| `Monday` starts at | char 18 | — | char 18 (**identical to A**) |
| Time cell | `9:50- Block` / `10:25 1`, 24h | `08:40–09:00` range, 24h | start above / end below block, **12h AM/PM** |
| Data cell | single line, sometimes wraps | single line, wraps over 2–3 lines | **two lines: activity over LOCATION** |
| Title | `Adom 4's - Matzo Balls` (sep) | day name | two lines: banner + `KA` (**no sep**) |
| Units | 29/33 titles carry `Unit - Bunk` | none (columns are groups) | positional codes `KA 1A RB K1(ECC)` |

The decisive measurement: **Shemesh's `Monday` sits at char 18, exactly where Camp A's does, and its
body times occupy chars 0–8.** A synthesized time column ending at char 8 reproduces Camp A's exact
`columns[0].start = floor((8+18)/2) = 13` — so the new family reuses the proven column geometry
rather than inventing a parallel one.

---

## 3. The design (items a–e)

### The gate: one boolean, computed per page

```
hasTimeLabel(headerTokens) === /^time$/i.test(headerTokens[0]?.text)
```

Every new behaviour below is entered only when `!hasTimeLabel`. Camp A and Camp B label their time
column, so for them the value is always `true` and **every new branch is skipped**. This is the
regression guarantee, stated once and reused five times (see §4).

---

### a. Re-anchoring page + column detection without the `Time` literal

**Header detection.** Replace the single `Time`-token test (duplicated in `findHeaderLine` and
`splitPages`) with one shared predicate:

```
isHeaderLine(tokens):
  (A)  tokens.length >= 3 && /^time$/i.test(tokens[0].text)          // Camp A & B — unchanged
  OR (B)  dayCount(tokens) >= 3 && dayCount >= ceil(tokens.length*0.6) // Shemesh — days-only header
```

Signal (A) is tried first and is byte-identical to today, so any document that labels its time column
selects exactly the header line it selected before. Signal (B) recognises a row that is predominantly
day-names — the reliable cross-camp signal when the time column is blank. `dayCount` reuses the
existing `isDayName` closed set and the `0.6` threshold already used by `detectOrientation`.

*Why (B) does not fire spuriously on Camp A/B*: Camp A's only day-name-majority line is its header
(caught by (A) first, same line). Camp B's data rows are group names, `dayCount = 0`. **Proven**: the
patched prototype selects 33 / 5 pages for A / B (identical to today) and 20 for Shemesh.

**Identifying the unlabeled time (left) column.** The time column is invisible in Shemesh's header,
so its extent is read from the **body**, which is the second cross-camp signal named in the brief —
"the left column is a run of time-ranges". Scan the page body for lines whose first token starts at
the left margin and satisfies the existing `looksLikeTime`; take the maximum `end` of those tokens
(char 8 for Shemesh). Then:

```
if hasTimeLabel:  columns = columnSpans(headerTokens).slice(1)              // UNCHANGED
else:             synthetic = [{text:'', start:0, end:timeEnd}, ...headerTokens]
                  columns   = columnSpans(synthetic).slice(1)
```

By synthesizing a leading "time" token that ends where the body's times end, the **same** `columnSpans`
+ `slice(1)` runs, and the first day column's left boundary lands at char 13 — exactly a `Time`
label's boundary. Downstream label-vs-cell splitting (`token.end <= columns[0].start`) is therefore
unchanged, and no day column is lost. *(Slicing the header directly, without the synthetic token,
would give `Monday` a `start` of 0 and pull the body's times into the Monday column — the bug this
step avoids.)*

**How the time column's start/end times are read.** The block's period label already accumulates
every token left of `columns[0].start`. In Shemesh the **start** time sits on the line above the data
block and the **end** time on the line below; both fall in the left column, so both land in the label,
and the existing `normalizeTimeLabel` (which joins the first two times as `start-end`) yields e.g.
`09:40-10:20` with **no change**. This mechanism was already built for Camp A's two-line time cell; it
serves Shemesh's above/below layout for free.

---

### b. Activity vs. location on the two-line cell (the subtle one)

Shemesh prints an activity directly above its room: `Movement` over `102`, `Free Swim` over `Pool`.
The location line must be stripped (ADR strip decision) — but Camp B genuinely wraps `Little` over
`Playground`, and that wrap must **not** be stripped. The fill-width heuristic alone cannot tell them
apart: Shemesh's location line is full-width (one room per day), so `isValueRow` reports it as a row,
not a wrap.

**Discriminator — adjacency, not content, not width:**

> A **location line** is a data line whose **immediately preceding non-blank line was also a data
> line** (no time line and no blank line between them). A **time line resets** the adjacency.

Rationale from the structure: in Shemesh an activity and its room are always vertically adjacent, while
two different periods are always separated by at least a time line (period start/end) or a blank line.
So:

- `09:40` (time, resets) / `Playground` (activity, kept) / `Playground` (prev was data → **location,
  dropped**) / `10:20` (time).
- `102 Social Hall Kitchen …` full-width and `217` single-column tails are both dropped, because both
  follow a data line — width is irrelevant.
- **Critically**, `02:40 … / Mindfulness / 103 104 … / 03:20 / 03:25 Sof Hayom` shares one
  blank-delimited block, yet `Sof Hayom` follows the **time** line `03:20`, so adjacency is reset and
  `Sof Hayom` is **kept**. The naive rule "drop everything after the first row in a block" was drafted
  first and **silently dropped `Sof Hayom`** — caught in prototyping (§8). Dropping a real fixed event
  is precisely the omission the ADR forbids; the adjacency rule is what preserves it.

*Why this cannot touch Camp A/B*: the whole branch is gated on `!hasTimeLabel`. Camp A's nested swim
sub-schedule and Camp B's `Little`/`Playground` wrap never enter it. **Proven**: A/B `parseTextGrid`
output is byte-identical; Shemesh's activity list contains none of the seven named room words and no
bare number, while retaining `Boker Tov/Snack`, `Sof Hayom`, `Pick Up`, `Lunch`.

---

### c. Unit inference from separator-less codes

Shemesh titles are codes with no separator: `KA KB K1 (ECC) K2 (ECC) 1A … RB`. The existing
`splitUnitAndGroup` needs whitespace-delimited `Unit - Bunk`, so it yields 20 groups / 0 units.

**Rule (applied only when `!hasTimeLabel`):**

```
inferUnitFromCode(title):
  m = title.match(/^([A-Za-z]|\d+)\s*[A-Za-z0-9]{1,2}(\s*\([^)]*\))?$/)
  return m ? m[1] : null            // the grade prefix; null if it is not a code
```

- letter-led → single leading letter is the unit: `KA→K`, `RB→R`, `K1 (ECC)→K`, `K2 (ECC)→K`
- digit-led → leading digit run is the unit: `1A→1`, `2C→2`, `5B→5`

The **group keeps its full code** as its name (`KA`, `1A`, `K1 (ECC)`) and is filed under the inferred
unit via the existing `groupUnits` map — the section letter is used only to *derive* the unit, never
substituted as the group name (`A` alone is neither unique nor meaningful).

**False-positive guard**: the `{1,2}`-char section length and `$` anchor mean a word-like title cannot
match — `Zahav` (Z-a-h-a-v) fails (`ah` then `av` left over), so it stays whole with `unit=null`. The
`(ECC)` parenthetical is tolerated and carried. Combined with the `!hasTimeLabel` gate, Camp A's
`Zahav`/`Gesher` and its separator titles, and Camp B's group-columns, are all untouched — they never
reach this function. **Proven**: units come out exactly `{K,1,2,3,4,5,R}`; all 20 groups map to the
right unit; A/B entity output unchanged.

Direction of the bias is ADR §7: **over-include units** — a wrong unit the director deletes costs a
moment, a missing one costs the retyping this feature removes.

---

### d. Two-line title (drop the repeating banner)

Each page carries a repeating banner `Shemesh Camp 2025` on the line above the real title (the code).
`splitPages` already picks the **nearest non-blank line above the header** as the title, so it already
picks `KA`, not the banner. The remaining problem: the banner physically sits inside the **previous**
page's body span and would become a phantom activity.

**Rule**: detect the banner as *the line immediately above the title that repeats on ≥ half the pages*
(`Shemesh Camp 2025`, 20×). Then, during body parsing, treat any line equal to the banner like a blank
line (close the block, skip it). A camp whose titles are distinct with no shared line above them yields
**no** banner (Camp A/B → `banner = null`, the skip is a no-op). Banner detection is gated to
strip-mode pages, adding a second layer of Camp A/B safety.

---

### e. Regression-safety argument (concrete)

The argument is structural, not statistical: **the union of all new code sits behind
`!hasTimeLabel`, and Camp A + Camp B have `hasTimeLabel === true` on every page.** Therefore they run
the pre-existing statements only. Verified end-to-end by the prototype (§8):

- `parseTextGrid(campA)` → 33 pages, **`JSON.stringify` identical** to `origin/main`.
- `parseTextGrid(campB)` → 5 pages, **identical**.
- `extractEntities` over the patched parse of Camp A and Camp B → **identical** to `extractEntities`
  over the original parse (entity outputs unchanged, as the predicate requires).

The 91 existing tests exercise Camp A / Camp B fixtures exclusively; identical parse + unchanged
extractor ⇒ they stay green by construction. The Maker still runs them (§4.6).

---

## 4. Ordered implementation plan (for the Maker)

All changes are in `src/ingest/`. Order matters: detection before geometry before strip.

1. **`textGrid.js` — shared header predicate.** Add `hasTimeLabel(tokens)`, `isDayHeader(tokens)`,
   `isHeaderLine(tokens)` (§3a). Point both `findHeaderLine` and the header scan in `splitPages` at
   `isHeaderLine`. *Gate:* `findHeaderLine(['nothing','here']) === -1` still holds; A/B page counts
   stay 33 / 5.

2. **`textGrid.js` — unlabeled column geometry.** Add `leadingTimeExtent(lines, headerIndex,
   endIndex, firstDataStart)`. In `parseTextGrid`, compute `labeled = hasTimeLabel(headerTokens)`;
   when `!labeled`, build `columns` from a synthesized leading time token (§3a). Add
   `timeColumnLabeled: labeled` to each pushed page object (additive; existing consumers ignore
   unknown fields).

3. **`textGrid.js` — banner.** Have `splitPages` return `{ pages, banner }`; detect the repeating
   pre-title line (§3d). In the body loop, `if (banner && line.trim() === banner) { closeBlock();
   continue }`.

4. **`textGrid.js` — location strip.** In `closeBlock`, track `prevHadData`; a data line with
   `stripLocations (= !labeled) && prevHadData` is a location and is skipped; a line with no data
   resets `prevHadData` (§3b). *This is the only behavioural change to the block assembler and it is
   fully gated.*

5. **`extractEntities.js` — positional unit inference.** Add `inferUnitFromCode(title)` (§3c). In
   `extractEntities`, the `orientation.columns === 'days'` branch must, **when the page is
   unlabeled** (`page.timeColumnLabeled === false`), set `group = title` and
   `unit = inferUnitFromCode(title)` instead of calling `splitUnitAndGroup`. Camp A pages
   (`timeColumnLabeled === true`) keep calling `splitUnitAndGroup` unchanged. *Do not change
   `splitUnitAndGroup` itself* — leaving it untouched is what protects Camp A's `Zahav`.

6. **Tests — new, with a SYNTHETIC fixture.** Commit a **fabricated** camp fixture that reproduces
   Shemesh's *structure* with invented names (see §4.7). Add cases asserting: days-only header is
   found; the unlabeled time column is not swallowed into the first day; location sub-lines are
   stripped (a known room word and a bare number are absent from activities); a fixed event that
   shares a block with the period above it survives; positional codes yield the expected units and
   group→unit links; the banner is dropped. Re-run the whole `src/ingest` suite (`npx vitest run
   src/ingest`) and confirm all 91 prior tests plus the new ones are green.

### 4.7 The fixture must not carry real names

The real extraction lives at `.ingest-incoming/shemesh-2025.txt` and is **gitignored in this
worktree branch** (`.gitignore` already adds `.ingest-incoming/`). The committed test fixture must be
a **structural clone with fabricated names** — invented group codes in the same shape (e.g.
`PA PB P1 (X) 2A 2B 3A RB`), invented activities and rooms, the same header/time/location/banner
layout. Never commit the real names (ADR "Consequences": committing them writes them into git
history permanently). Keep the fixture small (2–3 pages, one half-day page, one shared-block fixed
event) so it exercises every rule without bulk.

---

## 5. ADR verdict and drafted addendum

**Verdict: no new ADR.** Tested against the Architect ADR bar and Constitution rule 4:

- **New persistent data shape?** No. No table, column, projection, IPC, or stored shape changes. ADR
  §2 (entities-only whitelist) and §3 (no schema change / no migration) are untouched.
- **Changed contract other modules call?** No stored/wire/IPC contract. The only new surface is one
  additive in-module field (`page.timeColumnLabeled`) consumed one function away in the same folder.
- **Irreversible tradeoff?** No. A parser methodology refinement; reversible by removing code. Stored
  rows are identical in shape to today's.

The Database/sync gate ("ADR + migration/rollback plan") is **already cleared**: the ADR exists and
"no migration" is already recorded in ADR §3. A new ADR is not gate-required.

**Recommended: a short addendum to ADR 2026-08-01 §7**, because §7 ("what the samples establish about
the parser") is explicitly the living, evidence-driven section the repo already amends as camps arrive
(it carries the units-correction inline). A third sample establishes new facts that belong there. This
is a documentation nicety for durability, **not** a gate. Drafted delta:

> **§7 addendum (2026-08-02) — a third layout family.** A fourth real camp (one page per group, days
> across the top, like Camp A) leaves its **time column unlabeled**, so page/column detection can no
> longer depend on a `Time` token; it now also keys on a **day-name-majority header row**, with the
> unlabeled time column located from where the body's times sit. This family prints a **location under
> each activity** (room name or number) — these are **stripped** (location metadata, not activities),
> discriminated from a genuine wrapped continuation by **vertical adjacency** (a data line directly
> under another data line, with no time line between, is a location). Its group titles are
> **separator-less positional codes** (`1A`, `KA`, `RB`, `K1 (ECC)`) from which the **unit is inferred**
> from the grade prefix, over-including per this section's existing bias. A repeating page **banner** is
> dropped. All of this is gated on the absent `Time` label, so Camp A and Camp B are provably
> unaffected. No schema, projection, IPC, or commit-path change — §2 and §3 stand.

If the product owner prefers, the same delta can live only in this spec; either satisfies the
constitution. My recommendation is the addendum, for the durable record.

---

## 6. Do NOT change (guardrails for the Maker)

- **`sheetGrid.js` and the Excel path** — out of scope; must keep working. No edits.
- **`preview.js`, `electron/ops/ingest.js`** — no edits. The whitelist, the transaction, and the
  entities-only boundary (ADR §2/§4) are untouched.
- **`INGESTIBLE_ENTITIES`** — unchanged, in both copies. No new entity type.
- **`splitUnitAndGroup`** — do not modify. Add the new `inferUnitFromCode` alongside it and branch on
  `page.timeColumnLabeled`. Changing `splitUnitAndGroup` risks Camp A's `Zahav`/`2-3A` guards.
- **The labeled code path** — the `hasTimeLabel === true` branch of every function must remain the
  original statements. Do not "unify" the two branches into one clever path; the byte-identical
  labeled path is the regression proof.
- **`normalizeTimeLabel`, `cleanCellValue`, `stripTimes`, `collapseRepeats`, `detectOrientation`,
  `tally`, `dedupe`** — no edits needed; leave them.
- **No schema, projection, migration, IPC, or op-log change.** If any appears necessary, stop and
  escalate — it would reopen ADR §2/§3.
- **Never commit the real `.ingest-incoming/` extraction.** Fixtures use fabricated names only.

---

## 7. Risks, ambiguities, and product decisions still owed

- **R1 (product decision owed) — 12h AM/PM time storage.** Shemesh times are 12h with meridiem
  (`01:00 PM`). `normalizeTimeLabel` keeps only `HH:MM`, so the time-block *label* reads `01:00-01:40`
  (human-recognisable) but `time_blocks.start_time` would store `01:00`, a 24h value meaning 1 a.m.
  for a 1 p.m. block. The label is correct to a reviewing director and this is out of the stated
  scope (items a–e), but the stored 24h field is technically wrong for PM blocks. **Recommendation**:
  ship as-is for this change (label is reviewable; director owns correction), and open a *separate*
  small ticket to normalise AM/PM → 24h in `parseTimeRange`/`normalizeTimeLabel` if start/end times
  are consumed anywhere that matters. Flagging rather than silently absorbing. **Owner: product.**

- **R2 — half-day pages over-include lone time markers.** `K1 (ECC)`/`K2 (ECC)` afternoons are blacked
  out; their surviving time markers become a handful of single-time "blocks" (`01:00`, `02:40`, …).
  This is ADR-sanctioned over-inclusion (director unticks); the count is ~16 distinct vs the ~11 core.
  No action needed; noted so it is not read as a defect.

- **R3 — coupling assumption.** Strip-mode, unit-inference, and banner-drop are all gated on "the time
  column is unlabeled". This couples three independent properties to one signal. It is correct for all
  four real camps and is the smallest responsible change, but a hypothetical 5th camp with a *labelled*
  time column **and** location sub-lines would not strip (phantom rooms would return), and one with an
  *unlabeled* time column but single-line cells would simply have nothing to strip (safe). If a camp
  ever breaks the coupling, the fix is to detect location sub-lines independently (adjacency signal
  already exists) rather than off the header. Documented, not pre-built (karpathy: no speculative
  generality).

- **R4 — combined `A/B` activity slots.** RA/RB print two activities in one slot (`Drama/Movement`,
  `Art/Maker's Space`). The extractor keeps them as one activity (it splits only on spaced dashes).
  Over-inclusion; director splits. No change.

- **R5 — `.gitignore` protection is branch-local.** `.ingest-incoming/` is gitignored on this worktree
  branch but **not** on the main clone at `/Users/gregfeitel/dev/shoresh` (confirmed:
  `git check-ignore` says NOT-IGNORED there). The real extraction is safe here; ensure the `.gitignore`
  change ships with this branch so the ignore rule reaches `main`. Minor, but it is the guard that
  keeps real camp names out of history.

---

## 8. Evidence (deterministic, gathered before writing)

A throwaway prototype (patched copy of `textGrid.js` + a faithful extractor shim) was run against the
two committed samples and the real Shemesh text. Results:

- **Regression** — `parseTextGrid` patched vs `origin/main`: `campA` 33 pages **IDENTICAL=true**;
  `campB` 5 pages **IDENTICAL=true**. `extractEntities` over patched vs original parse: **IDENTICAL**
  for both camps.
- **Shemesh** — 20 pages; page[0].title `"KA"`; page[0].columns `["Monday".."Friday"]`.
  - UNITS (7): `["K","1","2","3","4","5","R"]` — exactly the target.
  - GROUPS (20): `["KA","KB","K1 (ECC)","K2 (ECC)","1A"…"RB"]`.
  - All 20 group→unit links correct.
  - DAYS: `["Monday".."Friday"]`.
  - ACTIVITIES (45): includes `Boker Tov/Snack`, `Sof Hayom`, `Pick Up`, `Lunch`, `Shabbat`, real
    activities; **PHANTOM room/number activities: `[]`** (none of `Kitchen`/`Pool`/`Social Hall`/
    `Studio 2`/`Youth Wing`/`Classroom` and no bare number).
  - Half-day `K1 (ECC)`: morning activities present, afternoon (blacked out) yields nothing, no phantom
    locations.

The prototype and harness are in the session scratchpad (not committed). The design maps 1:1 to the
implementation plan in §4; the Maker's job is to apply the same edits to the real files and add the
synthetic-fixture tests.
