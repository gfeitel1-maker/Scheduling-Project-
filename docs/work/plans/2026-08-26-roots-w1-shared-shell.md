# Roots W1 — Shared Setup-Screen Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the mechanical redundancy across the six Roots setup sub-screens by extracting shared presentational components (helpers, `ImportModal`, `SetupScreenShell`), with zero schema and zero data-flow-ownership change.

**Architecture:** Extract pure presentational/utility units and adopt them screen-by-screen. Each screen keeps its own state, load/save logic, and the `useCrudScreen`-vs-repository decision it already made — we share *rendering and helpers*, never data orchestration. `LocationPicker` stays prop-driven; location dedup becomes a shared helper module called from each screen's existing handler.

**Tech Stack:** React (inline style objects + `S` shared constants from `src/styles/shared.js`), Vitest + React Testing Library, `better-sqlite3` via IPC (not touched here).

## Global Constraints

- **Zero schema change, zero data-model change** in all of W1. No migrations, no new persisted fields, no changed write shapes. (If any task appears to need one, stop — it belongs in the gated W1b or W2-field-retirement ticket per the spec.)
- **No new stylesheet.** The single scoped-CSS exception is bounded to `src/components/schedule/`. All new component styles are inline objects or `S` constants.
- **No explainers/help text as a fix.** Guidance is by affordance only.
- **Preserve verbatim (must survive every refactor):** the write-failure/delete-recovery messaging (`describeWriteFailure`, `deleteRefusalMessage`, the `ConfirmDangerDialog` recovery strings, delete-preview counts); the stale-load request-id guards inside each screen's load path; the atomic name-first create ordering and `UNIQUE_FIELD_ENTITIES`/`UNIQUE_FIRST_FIELD` parity.
- **Scope: non-Locations screens only** — `TiersScreen`, `GroupsScreen`, `DaysScreen`, `TimeBlocksScreen`, `ActivitiesScreen`, `AnchorsScreen`. Do not touch `LocationsScreen.jsx` or `src/screens/locations/*` (peer-owned).
- **Run tests with** `npm run test -- --no-file-parallelism <path>` (repo gotcha: vitest needs `--no-file-parallelism`). Do not run the full suite or Electron during tasks (machine-load mDNS flakes); run the focused file per task.
- Cohort-scoped screens are **Tiers, Time Blocks, Anchors** only (verified via `CohortPicker`/`cohort_id`); Groups, Days, Activities are not.

## File structure

- Create `src/screens/setup/setupHelpers.js` — shared pure helpers: `DOW`, `serializeFieldValue`, `parseIdList`, `BOOL_FIELDS`/`ARRAY_FIELDS` construction per screen.
- Create `src/components/setup/Field.jsx` — the label+control row currently duplicated in Activities/Anchors.
- Create `src/components/setup/ImportModal.jsx` — the import preview/done overlay with focus management.
- Create `src/components/setup/SetupScreenShell.jsx` — count eyebrow + toolbar (config-driven) + table frame + `Next:` footer.
- Create `src/lib/locationDedup.js` — shared `createLocation`/`updateLocationCapacity` bodies.
- Modify the six screens to consume the above.
- Tests colocated as `*.test.jsx` next to each new component; screen tests already exist and will be updated.

---

### Task 1: Extract shared setup helpers

**Files:**
- Create: `src/screens/setup/setupHelpers.js`
- Test: `src/screens/setup/setupHelpers.test.js`
- Modify (later steps): `src/screens/DaysScreen.jsx`, `ActivitiesScreen.jsx`, `AnchorsScreen.jsx` to import from it.

**Interfaces:**
- Produces: `DOW: string[]` (7 weekday names, Sunday-first); `parseIdList(raw: string|null|undefined): any[]`; `makeSerializeFieldValue(boolFields: Set<string>, arrayFields: Set<string>): (field, value) => string|number|null`.
- Rationale for `makeSerializeFieldValue` factory: Activities and Anchors have *different* `BOOL_FIELDS`/`ARRAY_FIELDS` sets, so the serializer is parameterized rather than shared as a bare constant.

- [ ] **Step 1: Write the failing test**

```javascript
// src/screens/setup/setupHelpers.test.js
import { describe, it, expect } from 'vitest'
import { DOW, parseIdList, makeSerializeFieldValue } from './setupHelpers'

describe('setupHelpers', () => {
  it('DOW is Sunday-first and 7 long', () => {
    expect(DOW).toHaveLength(7)
    expect(DOW[0]).toBe('Sunday')
    expect(DOW[6]).toBe('Saturday')
  })

  it('parseIdList returns [] for null/garbage and array for valid JSON', () => {
    expect(parseIdList(null)).toEqual([])
    expect(parseIdList('not json')).toEqual([])
    expect(parseIdList('{"a":1}')).toEqual([]) // object, not array
    expect(parseIdList('["x","y"]')).toEqual(['x', 'y'])
  })

  it('makeSerializeFieldValue coerces bools to 1/0 and arrays to JSON', () => {
    const serialize = makeSerializeFieldValue(new Set(['is_all_groups']), new Set(['group_ids']))
    expect(serialize('is_all_groups', true)).toBe(1)
    expect(serialize('is_all_groups', false)).toBe(0)
    expect(serialize('group_ids', ['a'])).toBe('["a"]')
    expect(serialize('group_ids', null)).toBe('[]')
    expect(serialize('name', 'Swim')).toBe('Swim')
    expect(serialize('notes', undefined)).toBe(null)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --no-file-parallelism src/screens/setup/setupHelpers.test.js`
Expected: FAIL — cannot resolve `./setupHelpers`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/screens/setup/setupHelpers.js

// Sunday-first weekday names. Previously duplicated in DaysScreen, ActivitiesScreen,
// and AnchorsScreen — day_of_week is an engine-facing 0..6 index (see buildSchedule.js).
export const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Defense-in-depth: malformed JSON in an id-list column (e.g. a corrupted/tampered
// op) must not crash a list render — default to [].
export function parseIdList(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// operations.value only accepts strings/null/number (better-sqlite3 throws on a raw
// boolean/array) — every write pre-serializes through this. Each screen supplies its
// own bool/array field sets, so the serializer is a factory, not a shared constant.
export function makeSerializeFieldValue(boolFields, arrayFields) {
  return function serializeFieldValue(field, value) {
    if (boolFields.has(field)) return value ? 1 : 0
    if (arrayFields.has(field)) return JSON.stringify(value ?? [])
    return value ?? null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --no-file-parallelism src/screens/setup/setupHelpers.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Adopt in the three screens, delete the local copies**

In `src/screens/DaysScreen.jsx`: remove the local `const DOW = [...]` (line ~15) and add `import { DOW } from './setup/setupHelpers'`.

In `src/screens/AnchorsScreen.jsx`: remove local `serializeFieldValue` (lines ~28-32) and `parseIdList` (lines ~54-62); add `import { parseIdList, makeSerializeFieldValue } from './setup/setupHelpers'`, then near the `BOOL_FIELDS`/`ARRAY_FIELDS` consts add `const serializeFieldValue = makeSerializeFieldValue(BOOL_FIELDS, ARRAY_FIELDS)`. Keep `BOOL_FIELDS`/`ARRAY_FIELDS`/`normalizeAnchor` where they are.

In `src/screens/ActivitiesScreen.jsx`: same treatment for its `serializeFieldValue`/`parseIdList`/`DOW` (verify each exists there first with grep before removing).

- [ ] **Step 6: Run the affected screen tests**

Run: `npm run test -- --no-file-parallelism src/screens/DaysScreen.test.jsx src/screens/AnchorsScreen.test.jsx src/screens/ActivitiesScreen.test.jsx`
Expected: PASS (no behavior change; imports relocated).

- [ ] **Step 7: Commit**

```bash
git add src/screens/setup/setupHelpers.js src/screens/setup/setupHelpers.test.js src/screens/DaysScreen.jsx src/screens/AnchorsScreen.jsx src/screens/ActivitiesScreen.jsx
git commit -m "refactor(setup): hoist DOW/parseIdList/serializeFieldValue into shared setupHelpers"
```

---

### Task 2: Shared `ImportModal` with focus management

**Files:**
- Create: `src/components/setup/ImportModal.jsx`
- Test: `src/components/setup/ImportModal.test.jsx`

**Interfaces:**
- Produces:
  ```
  <ImportModal
    step={'preview'|'done'|null}
    title={string}              // e.g. "Import Preview"
    columns={[{ key, label, mono? }]}   // preview table columns
    rows={[{ ...cellValues, warning?: string }]}
    readyCount={number}
    warnCount={number}
    result={{ added: number, skipped?: number } | null}
    importing={boolean}
    onConfirm={() => void}
    onCancel={() => void}
    renderCell={(row, col) => ReactNode}   // screen-specific cell formatting (e.g. DOW[value])
  />
  ```
- Owns: overlay chrome, the "N ready, M with warnings" line, the preview table, the Import-Complete panel, and **focus management** (focus-trap, Escape-to-cancel, initial focus on the primary button). Warning-row color comes from `S` tokens, not hardcoded hex.

- [ ] **Step 1: Add warning-row tokens to shared styles (if absent)**

Check `src/styles/shared.js` for an existing warning background token. If none, add to the `S` object:

```javascript
// Import-preview warning row — replaces the hardcoded #FFF8E7 / #F5A623 literals
// previously pasted into every screen's import table.
importWarnRow: { background: 'var(--warning-bg, #FFF8E7)' },
importWarnText: { color: 'var(--warning, #F5A623)', fontFamily: 'var(--font-mono)', fontSize: 12 },
```

- [ ] **Step 2: Write the failing test**

```jsx
// src/components/setup/ImportModal.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ImportModal from './ImportModal'

const cols = [{ key: 'label', label: 'Label' }, { key: 'status', label: 'Status' }]
const rows = [
  { label: 'Monday', warning: null },
  { label: '', warning: 'Missing label' },
]

describe('ImportModal', () => {
  it('renders ready/warn counts and the rows in preview', () => {
    render(<ImportModal step="preview" title="Import Preview" columns={cols} rows={rows}
      readyCount={1} warnCount={1} importing={false}
      onConfirm={() => {}} onCancel={() => {}} renderCell={(r, c) => r[c.key] || '—'} />)
    expect(screen.getByText(/1 ready/)).toBeInTheDocument()
    expect(screen.getByText(/1 with warnings/)).toBeInTheDocument()
  })

  it('Escape triggers onCancel', () => {
    const onCancel = vi.fn()
    render(<ImportModal step="preview" title="Import Preview" columns={cols} rows={rows}
      readyCount={1} warnCount={1} importing={false}
      onConfirm={() => {}} onCancel={onCancel} renderCell={(r, c) => r[c.key] || '—'} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('moves focus into the modal on open', () => {
    render(<ImportModal step="preview" title="Import Preview" columns={cols} rows={rows}
      readyCount={1} warnCount={1} importing={false}
      onConfirm={() => {}} onCancel={() => {}} renderCell={(r, c) => r[c.key] || '—'} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('renders the done panel with added/skipped', () => {
    render(<ImportModal step="done" title="Import Complete" columns={cols} rows={[]}
      readyCount={0} warnCount={0} result={{ added: 3, skipped: 1 }} importing={false}
      onConfirm={() => {}} onCancel={() => {}} renderCell={() => null} />)
    expect(screen.getByText(/3 added/)).toBeInTheDocument()
    expect(screen.getByText(/1 skipped/)).toBeInTheDocument()
  })

  it('renders nothing when step is null', () => {
    const { container } = render(<ImportModal step={null} title="" columns={cols} rows={[]}
      readyCount={0} warnCount={0} importing={false}
      onConfirm={() => {}} onCancel={() => {}} renderCell={() => null} />)
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- --no-file-parallelism src/components/setup/ImportModal.test.jsx`
Expected: FAIL — cannot resolve `./ImportModal`.

- [ ] **Step 4: Write minimal implementation**

```jsx
// src/components/setup/ImportModal.jsx
import { useEffect, useRef } from 'react'
import { S } from '../../styles/shared'

// Shared import overlay for the Roots setup screens. Previously each screen
// hand-rolled this ~50-line block; here it also gains focus management the
// per-screen copies lacked (focus-trap + Escape + initial focus).
export default function ImportModal({
  step, title, columns, rows, readyCount, warnCount, result,
  importing, onConfirm, onCancel, renderCell,
}) {
  const dialogRef = useRef(null)
  const primaryRef = useRef(null)

  useEffect(() => {
    if (!step) return
    // Initial focus lands on the primary action.
    primaryRef.current?.focus()
    function onKey(e) {
      if (e.key === 'Escape') { onCancel(); return }
      if (e.key !== 'Tab') return
      // Focus-trap: keep Tab within the dialog.
      const focusables = dialogRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [step, onCancel])

  if (!step) return null

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title}
        style={{ background: 'var(--surface)', borderRadius: 12, padding: 28, width: 520, maxHeight: '80vh', overflow: 'auto' }}>
        {step === 'preview' && (
          <>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>{title}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
              {readyCount} ready{warnCount > 0 && `, ${warnCount} with warnings`}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                {columns.map(c => <th key={c.key} style={S.th}>{c.label}</th>)}
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ ...(r.warning ? S.importWarnRow : null), borderBottom: '1px solid var(--border)' }}>
                    {columns.map(c => (
                      <td key={c.key} style={{ ...S.td, ...(c.mono ? { fontFamily: 'var(--font-mono)', fontSize: 12 } : null) }}>
                        {renderCell(r, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="press-97" onClick={onCancel} style={S.btnSecondary}>Cancel</button>
              <button ref={primaryRef} className="press-97" onClick={onConfirm} disabled={importing || readyCount === 0} style={S.btnPrimary}>
                {importing ? 'Importing…' : `Import ${readyCount}`}
              </button>
            </div>
          </>
        )}
        {step === 'done' && (
          <>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>{title}</div>
            <div style={{ fontSize: 14 }}>
              <span style={{ color: 'var(--success)', fontWeight: 600 }}>{result?.added ?? 0} added</span>
              {result?.skipped > 0 && <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{result.skipped} skipped</span>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button ref={primaryRef} className="press-97" onClick={onCancel} style={S.btnPrimary}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- --no-file-parallelism src/components/setup/ImportModal.test.jsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Adopt in DaysScreen (the reference), delete its inline overlay**

In `src/screens/DaysScreen.jsx`, replace the inline `{importStep && (...)}` block (lines ~266-303) with:

```jsx
<ImportModal
  step={importStep}
  title={importStep === 'done' ? 'Import Complete' : 'Import Preview'}
  columns={[{ key: 'label', label: 'Label' }, { key: 'day_of_week', label: 'Day' }, { key: 'sort_order', label: 'Order', mono: true }, { key: 'status', label: 'Status' }]}
  rows={importRows}
  readyCount={readyRows.length}
  warnCount={warnRows.length}
  result={importResult}
  importing={importing}
  onConfirm={confirmImport}
  onCancel={() => { setImportStep(null); setImportRows([]) }}
  renderCell={(r, c) => {
    if (c.key === 'label') return r.label || '—'
    if (c.key === 'day_of_week') return DOW[r.day_of_week] || '—'
    if (c.key === 'sort_order') return r.sort_order ?? '—'
    if (c.key === 'status') return <span style={r.warning ? S.importWarnText : { color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</span>
  }}
/>
```

Add `import ImportModal from '../components/setup/ImportModal'` at top. Leave `importStep`/`importRows`/`importResult`/`importing`/`confirmImport`/`readyRows`/`warnRows` exactly as-is.

- [ ] **Step 7: Run DaysScreen test**

Run: `npm run test -- --no-file-parallelism src/screens/DaysScreen.test.jsx`
Expected: PASS. If a test asserted the old hardcoded `#FFF8E7`, update it to assert presence of the warning row via role/text instead of the hex.

- [ ] **Step 8: Adopt in the other four import-bearing screens**

Repeat Step 6's pattern in `TiersScreen.jsx`, `GroupsScreen.jsx`, `TimeBlocksScreen.jsx`, `ActivitiesScreen.jsx`, `AnchorsScreen.jsx` — each supplies its own `columns`/`renderCell` matching its existing preview table. Do not change any screen's parse/confirm logic; only swap the overlay JSX for `<ImportModal>`. Run each screen's test file after its swap.

- [ ] **Step 9: Commit**

```bash
git add src/components/setup/ImportModal.jsx src/components/setup/ImportModal.test.jsx src/styles/shared.js src/screens/*.jsx
git commit -m "refactor(setup): shared ImportModal with focus management; tokenize warning rows"
```

---

### Task 3: `SetupScreenShell` with config-driven chrome

**Files:**
- Create: `src/components/setup/SetupScreenShell.jsx`
- Test: `src/components/setup/SetupScreenShell.test.jsx`

**Interfaces:**
- Produces:
  ```
  <SetupScreenShell
    countLabel={string}          // e.g. "5 days"
    role={string}
    actions={{                   // config-driven chrome — omit an action to hide it
      onDownloadTemplate?: () => void,
      onImport?: () => void,     // opens the file picker
      onDeleteAll?: () => void,
      deleteAllProminent?: boolean,  // false => tucked/receded for small screens
    }}
    fileInputRef={ref}
    onFileChange={(e) => void}
    nextLabel={string}           // e.g. "Next: Time Blocks →"
    onNext={() => void}
    error={string|null}
    cohortPicker={ReactNode}     // optional: rendered in the header for cohort-scoped screens (Task 6)
  >
    {children}                   // the table/card body
  </SetupScreenShell>
  ```
- Owns: the error banner, the count-eyebrow + toolbar row, the file `<input>`, and the `Next:` footer. Renders only the actions present in `actions` (config-driven — this is finding #4/#7: a small screen passes `deleteAllProminent: false` or omits `onImport`).

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/setup/SetupScreenShell.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import SetupScreenShell from './SetupScreenShell'

const base = {
  countLabel: '5 days', role: 'admin', fileInputRef: createRef(),
  onFileChange: () => {}, nextLabel: 'Next: X →', onNext: () => {}, error: null,
}

describe('SetupScreenShell', () => {
  it('renders count, children, and Next', () => {
    render(<SetupScreenShell {...base} actions={{}}><div>BODY</div></SetupScreenShell>)
    expect(screen.getByText('5 days')).toBeInTheDocument()
    expect(screen.getByText('BODY')).toBeInTheDocument()
    expect(screen.getByText('Next: X →')).toBeInTheDocument()
  })

  it('hides Delete All when no onDeleteAll is given', () => {
    render(<SetupScreenShell {...base} actions={{ onDownloadTemplate: () => {} }}><div /></SetupScreenShell>)
    expect(screen.queryByText('Delete All')).not.toBeInTheDocument()
    expect(screen.getByText('Download Template')).toBeInTheDocument()
  })

  it('shows Delete All when provided, disabled for non-admin', () => {
    render(<SetupScreenShell {...base} role="staff" actions={{ onDeleteAll: () => {} }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn).toBeDisabled()
  })

  it('renders the error banner when error is set', () => {
    render(<SetupScreenShell {...base} error="Nope" actions={{}}><div /></SetupScreenShell>)
    expect(screen.getByText('Nope')).toBeInTheDocument()
  })

  it('renders a cohortPicker node when supplied', () => {
    render(<SetupScreenShell {...base} actions={{}} cohortPicker={<div>PICKER</div>}><div /></SetupScreenShell>)
    expect(screen.getByText('PICKER')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --no-file-parallelism src/components/setup/SetupScreenShell.test.jsx`
Expected: FAIL — cannot resolve `./SetupScreenShell`.

- [ ] **Step 3: Write minimal implementation**

```jsx
// src/components/setup/SetupScreenShell.jsx
import { S } from '../../styles/shared'

const eyebrow = { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }

export default function SetupScreenShell({
  countLabel, role, actions = {}, fileInputRef, onFileChange,
  nextLabel, onNext, error, cohortPicker, children,
}) {
  const { onDownloadTemplate, onImport, onDeleteAll, deleteAllProminent = true } = actions
  const deleteStyle = role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger

  return (
    <div style={{ maxWidth: 680 }}>
      {error && <div style={S.errorBanner}>{error}</div>}
      {cohortPicker}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={eyebrow}>{countLabel}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {onDownloadTemplate && <button className="press-97" onClick={onDownloadTemplate} style={S.btnSecondary}>Download Template</button>}
          {onImport && <>
            <button className="press-97" onClick={onImport} style={S.btnSecondary}>Import from Excel</button>
            <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          </>}
          {onDeleteAll && (
            <button onClick={onDeleteAll} disabled={role !== 'admin'}
              title={role !== 'admin' ? 'Admin only' : undefined}
              style={deleteAllProminent ? deleteStyle : { ...deleteStyle, opacity: 0.6 }}>Delete All</button>
          )}
        </div>
      </div>
      {children}
      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button className="press-97" onClick={onNext} style={S.btnPrimary}>{nextLabel}</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --no-file-parallelism src/components/setup/SetupScreenShell.test.jsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Adopt in DaysScreen**

Wrap `DaysScreen`'s return body in `<SetupScreenShell>`: move the error banner, toolbar row (lines ~210-225), and the `Next:` footer (lines ~305-307) into the shell props; pass the table+add-card block as `children`. For Days (a small, fixed-content screen), pass `actions={{ onDownloadTemplate: downloadTemplate, onDeleteAll: deleteAll, deleteAllProminent: false }}` and **omit `onImport`** — a director does not bulk-import 5 weekday rows (finding #4/#7). Keep `pendingDelete`/`pendingDeleteAll` dialogs and the `<ImportModal>` (now unused for Days if import removed — if so, also remove the import parse handlers for Days only) outside/after the shell as siblings.

Note: removing Days' import is a UX call from the spec's config-driven-chrome item. If preferred to keep import on Days, pass `onImport` too — either is within W1. Default per plan: omit it.

- [ ] **Step 6: Run DaysScreen test**

Run: `npm run test -- --no-file-parallelism src/screens/DaysScreen.test.jsx`
Expected: PASS. Update any test asserting the old toolbar structure to assert via button text.

- [ ] **Step 7: Adopt in the remaining five screens**

Wrap each in `<SetupScreenShell>` with its own `actions` config. Guidance for `actions` per screen (chrome recede rule — bulk-entry screens keep the full bar, small/fixed ones recede):
- `TiersScreen`, `GroupsScreen`, `ActivitiesScreen`, `AnchorsScreen`: full bar — `onDownloadTemplate`, `onImport`, `onDeleteAll` with `deleteAllProminent: true`.
- `TimeBlocksScreen`: `deleteAllProminent: false` (typically few rows), keep import.
Run each screen's test after its wrap.

- [ ] **Step 8: Commit**

```bash
git add src/components/setup/SetupScreenShell.jsx src/components/setup/SetupScreenShell.test.jsx src/screens/*.jsx
git commit -m "refactor(setup): shared SetupScreenShell with config-driven chrome across six screens"
```

---

### Task 4: Location dedup helper (shared function, not state-ownership change)

**Files:**
- Create: `src/lib/locationDedup.js`
- Test: `src/lib/locationDedup.test.js`
- Modify: `src/screens/ActivitiesScreen.jsx`, `src/screens/AnchorsScreen.jsx`

**Interfaces:**
- Produces:
  - `createLocationRecord({ localClient, repository, campId, name, existing }): Promise<{ location, created: boolean } | { error }>` — the shared body of the two copy-pasted `createLocation` functions. Does the case-insensitive dedup against `existing`, name-first op ordering, returns the new/existing location. **Does not** touch React state — the caller still does `setLocations`.
  - `updateLocationCapacityRecord({ repository, campId, id, capacity }): Promise<...>` — shared body of `updateLocationCapacity`.
- Consumes: the exact current bodies at `ActivitiesScreen.jsx:619-635` and `AnchorsScreen.jsx:398-410`. Before writing, read both and confirm they are byte-identical modulo variable names (the Anchors comment at line ~395 states "mirrors ActivitiesScreen.createLocation exactly").

- [ ] **Step 1: Read both current implementations**

Run: `sed -n '595,640p' src/screens/ActivitiesScreen.jsx; echo ---; sed -n '392,412p' src/screens/AnchorsScreen.jsx`
Confirm the two bodies match. If they diverge in any way other than local names, STOP and report — the "pure code motion" premise fails and this task needs re-scoping (per the code-reviewer's must-fix note).

- [ ] **Step 2: Write the failing test** (fill the assertions from the real body read in Step 1 — case-insensitive dedup returns existing without a write; new name writes name-first). Example shape:

```javascript
// src/lib/locationDedup.test.js
import { describe, it, expect, vi } from 'vitest'
import { createLocationRecord } from './locationDedup'

describe('createLocationRecord', () => {
  it('returns the existing location (no write) on case-insensitive name match', async () => {
    const repository = { createRecord: vi.fn() }
    const existing = [{ id: 'l1', name: 'Pool' }]
    const res = await createLocationRecord({ localClient: {}, repository, campId: 'c1', name: 'pool', existing })
    expect(res.created).toBe(false)
    expect(res.location).toEqual({ id: 'l1', name: 'Pool' })
    expect(repository.createRecord).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run test to verify it fails** — `npm run test -- --no-file-parallelism src/lib/locationDedup.test.js` → FAIL (unresolved import).

- [ ] **Step 4: Implement** by moving the real body from `ActivitiesScreen.jsx` verbatim into the two exported functions, replacing screen-local `locations` reads with the `existing` param and returning the record instead of calling `setLocations`.

- [ ] **Step 5: Run test to verify it passes.**

- [ ] **Step 6: Rewire both screens** — each screen's `createLocation` becomes a thin wrapper: call `createLocationRecord({ ..., existing: locations })`, then on success do its own `setLocations(prev => ...)`. `LocationPicker` props (`onCreate`/`onUpdateCapacity`) are unchanged; inline capacity editing stays. Run both screen test files.

- [ ] **Step 7: Confirm parity gate untouched** — Run: `npm run test -- --no-file-parallelism electron/uniqueFirstFieldRegistryParity.test.js`. Expected: PASS (write order unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/lib/locationDedup.js src/lib/locationDedup.test.js src/screens/ActivitiesScreen.jsx src/screens/AnchorsScreen.jsx
git commit -m "refactor(setup): extract location create/capacity into shared locationDedup helper (LocationPicker stays prop-driven)"
```

---

### Task 5: Field component + cohort-scoping legibility

**Files:**
- Create: `src/components/setup/Field.jsx`, `src/components/setup/Field.test.jsx`
- Modify: `ActivitiesScreen.jsx`, `AnchorsScreen.jsx` (remove local `Field`); `TiersScreen.jsx`, `TimeBlocksScreen.jsx`, `AnchorsScreen.jsx` (cohort picker placement).

- [ ] **Step 1:** Read the two `Field` defs (`ActivitiesScreen.jsx:435`, `AnchorsScreen.jsx:220`); confirm identical. Write a render test for the extracted component (label renders, children render, `hint` renders when passed). Run → FAIL.

- [ ] **Step 2:** Implement `Field.jsx` from the verbatim body; adopt in both screens; delete local copies. Run both screen tests → PASS.

- [ ] **Step 3: Cohort-scoping legibility** — pass the existing `<CohortPicker>` on Tiers/TimeBlocks/Anchors through `SetupScreenShell`'s `cohortPicker` prop so its placement/affordance is identical across the three cohort-scoped screens. Do **not** add a picker to Groups/Days/Activities. This is presentation only — no scoping logic changes. Run the three screen tests.

- [ ] **Step 4: Commit**

```bash
git add src/components/setup/Field.jsx src/components/setup/Field.test.jsx src/screens/*.jsx
git commit -m "refactor(setup): shared Field component; consistent CohortPicker placement on cohort-scoped screens"
```

---

### Task 6: `max-height` collapse (P3, optional)

**Files:** Modify `src/screens/ActivitiesScreen.jsx:378`.

- [ ] **Step 1:** Migrate the "More options" collapse from `transition: max-height` to `grid-template-rows: 0fr → 1fr` (wrap the collapsible content in a `display: grid` container). Keep the `prefersReducedMotion()` guard. If the wrap is non-trivial given the surrounding layout, leave as-is (it is already reduced-motion-guarded) and note it done-or-skipped in the commit. Run `npm run test -- --no-file-parallelism src/screens/ActivitiesScreen.test.jsx`.

- [ ] **Step 2: Commit** (only if changed)

```bash
git add src/screens/ActivitiesScreen.jsx
git commit -m "refactor(activities): collapse via grid-template-rows instead of max-height"
```

---

### Task 7: W1 gate

- [ ] **Step 1:** Run the focused setup-screen test set:

```bash
npm run test -- --no-file-parallelism src/screens/TiersScreen.test.jsx src/screens/GroupsScreen.test.jsx src/screens/DaysScreen.test.jsx src/screens/TimeBlocksScreen.test.jsx src/screens/ActivitiesScreen.test.jsx src/screens/AnchorsScreen.test.jsx src/components/setup src/screens/setup/setupHelpers.test.js src/lib/locationDedup.test.js
```
Expected: all PASS.

- [ ] **Step 2:** Run lint: `npm run lint`. Expected: clean (watch for unused imports left after deletions).

- [ ] **Step 3:** Hand off to the full `npm run verify` at the Governor level (not inside a task) before opening the PR — the repo gotcha is to capture npm's real exit code, never `| tail`.

## Self-Review

- **Spec coverage:** reconciliation rows 1–9 map to Tasks 1–6 (helpers→T1/T5; ImportModal+focus→T2; chrome/config→T3; location dedup→T4; cohort legibility→T5; max-height→T6). Rows 10–14 (week-scoping, tier↔group, sort_order/day_of_week, renames) are explicitly out of W1 (gated tickets) — not in this plan by design. Row 14 renames are copy-only and can be a separate tiny task/PR; add if desired. Rows 15–17 parked/rejected/W3.
- **Placeholder scan:** Task 4/5 Steps 1 require reading the real body before writing final assertions — this is deliberate (the code must be copied verbatim, and I will not invent a body I haven't confirmed identical); every other step carries complete code.
- **Type consistency:** shared names used consistently — `DOW`, `parseIdList`, `makeSerializeFieldValue`, `<ImportModal>` prop set, `<SetupScreenShell>` `actions` shape, `createLocationRecord`/`updateLocationCapacityRecord`.
