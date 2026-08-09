---
title: "Shared export formula/CSV-injection sanitizer"
document_type: adr
authority: normative
status: accepted
date: 2026-08-08
supersedes: []
implementation_state: implemented
program: onboarding-reconciliation
affects:
  - src/utils/exportSchedule.js
  - src/utils/exportWorkbook.js
  - src/screens/GroupsScreen.jsx
  - src/screens/ActivitiesScreen.jsx
  - src/screens/AnchorsScreen.jsx
  - src/screens/DaysScreen.jsx
  - src/screens/TiersScreen.jsx
  - src/screens/TimeBlocksScreen.jsx
  - src/screens/ImportScreen.jsx
  - src/ingest/workbookToSource.js
  - docs/work/onboarding-reconciliation/IMPLEMENTATION_SEQUENCE.md
---

# Shared export formula/CSV-injection sanitizer

**Status: PROPOSED.** A standalone hardening ticket that must land **before** S4 ships a round-trip
workbook (IMPLEMENTATION_SEQUENCE "Standalone tickets"; decision gate #4). It is separable from S4 —
it retrofits the export code that already exists — and is written as its own ADR so it can be built,
reviewed, and merged on its own.

This ADR is a **hard requirement (Security F1)**, not a nicety: every xlsx/CSV Shoresh writes today
(`exportSchedule.js`, six per-screen `downloadTemplate`s) emits user-controlled strings — activity
names, group names, unit names, time-block labels — into cells with no escaping. Any of those strings
that begins with `=`, `+`, `-`, or `@` is interpreted by Excel/Sheets/LibreOffice as a **formula** when
the file is reopened, which is the classic CSV/formula-injection payload (`=HYPERLINK`, `=cmd|…`,
`=WEBSERVICE(...)` exfiltration). Because S4 turns export→edit→**re-import** into a routine round-trip,
a poisoned cell is no longer only a downstream-spreadsheet risk — it is a payload the director will be
invited to open and hand back to us.

---

## Context

- `exportSchedule.js` builds every sheet with `XLSX.utils.aoa_to_sheet`, writing raw activity/anchor/
  group/day/block strings (lines 10–45). No sanitization.
- Each setup screen's `downloadTemplate` (`GroupsScreen.jsx` ~296, and the five siblings) hand-builds a
  header + example row with `aoa_to_sheet` — the same unescaped path.
- S4's enrichment workbook (see the companion ADR) will export **all** editable entity fields pre-
  populated from live data, which is exactly the corpus most likely to contain a leading-operator string
  a director typed last season.

There is no shared string-output boundary today, so the fix must **create one** and route every export
through it, rather than patching call sites ad hoc (an ad-hoc patch guarantees the next new export forgets
it).

### Candidate approaches considered

- **A. Sanitize at each call site inline.** *Rejected* — no single boundary; the S4 workbook and every
  future export must each remember to escape. This is how injection bugs regrow.
- **B. A shared `sanitizeCell(value)` utility that every export routes its string cells through, plus a
  thin `aoaToSanitizedSheet` helper (chosen).** One reviewable boundary; retrofit is mechanical; the
  workbook and all templates share it. **Selected.**
- **C. Rely on the `xlsx` library or a post-process.** *Rejected* — SheetJS does **not** neutralize
  formula-injection on write (it is a documented consumer responsibility); there is no library flag to
  lean on.

---

## Decision

### 1. A shared sanitizer utility (`src/utils/exportSanitize.js`)

```js
// Prefix any cell whose string value begins with a formula trigger with a
// single leading apostrophe, the spreadsheet-standard "treat as literal text"
// escape. Applied to STRING cells only — numbers/dates are written as typed.
// F5: leading newline is an injection vector in some parsers — include it.
const FORMULA_TRIGGERS = /^[=+\-@\t\r\n]/
export function sanitizeCell(value) {
  if (typeof value !== 'string') return value
  return FORMULA_TRIGGERS.test(value) ? `'${value}` : value
}
// aoa (array-of-arrays) convenience: sanitize every string cell, then hand to
// XLSX.utils.aoa_to_sheet. The one call the exports use.
export function aoaToSanitizedSheet(rows) {
  return XLSX.utils.aoa_to_sheet(rows.map((r) => r.map(sanitizeCell)))
}
```

- The escape is the **leading-apostrophe** convention (Excel/Sheets/LibreOffice all honor it as "this
  cell is literal text"). It is chosen over stripping/replacing the character because it is **lossless**:
  the visible value is unchanged for the reader, and — critically for the S4 round-trip — the importer
  strips a leading apostrophe on read **only when doing so is safe** (§3, the conditional strip) so the
  value survives export→re-import unchanged. It also covers leading TAB/CR/LF, which some parsers treat
  as injection vectors (F5).
- The trigger set is exactly `= + - @` (plus tab/CR/LF) — the OWASP CSV-injection set. A leading `-` is
  included even though it is often a legitimate negative sign, because `-` on a string cell (not a number
  cell) is a documented payload prefix; numeric values are written as numbers and never reach the string
  branch, so real negatives are unaffected.

### 2. Retrofit every current export

- `exportSchedule.js`: replace both `aoa_to_sheet` calls with `aoaToSanitizedSheet`.
- Each `downloadTemplate` (Groups, Activities, Anchors, Days, Tiers, TimeBlocks): same one-line swap.
- The S4 enrichment-workbook exporter is **built on this utility from the start** (companion ADR).

### 2a. Cell styling must LAYER ON TOP of sanitized cells — never a `.v` build (F3)

S4a needs cell-level styling (the locked/greyed `shoresh_id` and the `Status`-color fill). The dangerous
implementation is to hand-build cell objects (`ws[addr] = { v: value, s: style }`), because that path
sets `.v` **directly** and **bypasses `sanitizeCell` entirely** — a poisoned name would be written live.

**Rule (normative):** every sheet is first built with `aoaToSanitizedSheet(rows)`; styling then
**mutates the already-sanitized worksheet** — it may set `ws['!cols']`, `ws['!protect']`, and the `.s`
style property of an **existing** cell object, but it must **never create a cell or assign `.v`/`.w`**.
The sanitized value is the single source of every cell's content.

```js
const ws = aoaToSanitizedSheet(rows)      // values sanitized here, once
ws['!cols'] = [...]                        // width/lock metadata — no value touched
styleStatusColumn(ws)                      // mutates existing cells' .s only, never .v
```

**Gate:** a lint/grep test asserts no export module assigns `.v` on a cell it built by hand, and no
export constructs a worksheet by any path other than `aoaToSanitizedSheet` (the same grep gate as §4,
widened to forbid `\.v\s*=` on export cell objects).

### 3. Round-trip symmetry — the CONDITIONAL apostrophe strip (RISK G / Security F2)

Because S4 re-imports what it exported, the workbook read adapter (`workbookToSource`, companion ADR)
must reverse the escape. But the naive "strip any one leading apostrophe" is **wrong two ways**, both
proven by the review:

1. **Data loss on legitimate apostrophes.** A real value like `'Round the Campfire` (a director's actual
   label) would lose its apostrophe → a rename and a phantom diff on every round-trip. The apostrophe
   here is **guarding ordinary text**, not a sanitizer escape.
2. **Asymmetry between writers.** Excel's *quotePrefix* stores **no apostrophe character** in the cell
   value (the flag lives in cell metadata), while community SheetJS `writeFile` writes a **literal `'`**
   into the string. The two read back differently, so an unconditional strip corrupts one of them.

**Fix — strip a single leading `'` ONLY when the remainder still begins with a formula trigger.** That
is the only case the sanitizer could have produced: `sanitizeCell` adds `'` **exclusively** in front of a
trigger char. So the reverse is exactly:

```js
const STARTS_TRIGGER = /^[=+\-@\t\r\n]/
export function unescapeCell(value) {
  if (typeof value !== 'string') return value
  // Strip a leading apostrophe ONLY if what follows is a trigger char — i.e.
  // only when this apostrophe could have been our sanitizer's escape. An
  // apostrophe guarding ordinary text ('Round the Campfire) is left intact.
  return value.startsWith("'") && STARTS_TRIGGER.test(value.slice(1))
    ? value.slice(1)
    : value
}
```

- `'=SUM(A1)` → `=SUM(A1)` (our escape reversed).
- `'Round the Campfire` → **unchanged** (the apostrophe guards ordinary text — never stripped).
- Excel quotePrefix (`=SUM` stored with no leading `'`) → unchanged, already the literal value.

This makes the escape **provably reversible without touching legitimate apostrophes**, closes the
rename/data-loss and phantom-diff bug (RISK G), and keeps the two writer behaviors consistent (F2).
A fixture asserts a legit apostrophe-leading value (`'Round the Campfire`) survives export→re-import
**byte-identical** (no strip, no phantom diff), alongside the escaped-payload round-trip.

### 3a. Import size / complexity cap — fail closed (F4)

`ImportScreen`'s `XLSX.read` has **no size or complexity limit** — a crafted xlsx (zip bomb, millions of
rows/sheets) OOMs the host. Before parsing, the import path enforces a **byte-size cap** on the file and,
after parse, a **bounded sheet count and per-sheet row count**; exceeding any bound **rejects the file**
with a clear message and imports nothing (**fail closed** — never a partial parse). Concrete initial
bounds (tunable, recorded so they are a decision not an accident): ≤ 10 MB file, ≤ 32 sheets, ≤ 20 000
rows/sheet — comfortably above any real camp, far below a resource-exhaustion payload. This guard lives
at the ImportScreen read boundary and is shared by the schedule and workbook paths.

---

## No schema change

This is pure output-boundary logic and a read-time unescape. No table, column, projection, or wire
change. **Rollback is a code revert.**

---

## Completion evidence

1. `sanitizeCell('=1+1')` → `"'=1+1"`; `sanitizeCell('+A1')`, `'-2+3'`, `'@SUM'`, a leading tab, a
   leading newline (F5) → all prefixed; a normal name (`'Archery'`), a number (`3`), a real negative
   number cell → untouched.
2. A full `exportSchedule` run over a camp containing an activity literally named `=HYPERLINK("...")`
   writes the escaped literal, and reopening the file shows text, not a live formula.
3. **Round-trip (conditional strip, RISK G/F2):** `unescapeCell("'=SUM(A1)")` → `"=SUM(A1)"`;
   `unescapeCell("'Round the Campfire")` → **unchanged** (apostrophe guarding text is never stripped);
   an Excel quotePrefix cell (no literal `'`) → unchanged. A full export→re-import of a camp containing
   a legit apostrophe-leading label diffs to **`unchanged`** (no phantom diff, no data loss). Ties the
   sanitizer to S2c/S4 idempotency (F4).
4. All six `downloadTemplate`s **and** the S4a workbook export route through `aoaToSanitizedSheet` (grep
   gate: no remaining raw `aoa_to_sheet` on a user-string path).
5. **F3 styling gate:** grep asserts no export module assigns `.v` on a hand-built cell object; the S4a
   status/lock styling mutates only `!cols`/`!protect`/existing-cell `.s` on an already-sanitized sheet.
   A test poisons a name (`=HYPERLINK`) in a styled column and asserts the reopened cell is inert text.
6. **F4 cap:** an over-cap file (byte size, sheet count, or row count) is rejected with a clear message
   and imports nothing (fail closed); a normal camp workbook passes.

---

## Open questions for Governor

None product-facing. This is a security-mechanics decision; the only cross-slice obligation is that S4's
workbook read adapter implement the apostrophe-strip (§3), which the companion ADR carries.
