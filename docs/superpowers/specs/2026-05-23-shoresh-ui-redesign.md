# Shoresh UI Redesign — Design Spec

## Goal

Replace the current cold/neutral IBM Plex aesthetic with a warm, inviting visual system using Fredoka + Nunito fonts, sandy warm backgrounds, and a spacious schedule grid. The app should feel crafted and human — for camp people, not corporate vendors.

## Design Decisions

### Option B: Warm Redesign
Chosen scope: full font/color swap + spacious schedule cells + consistent warm styling across all screens. No structural or navigation changes. No new features.

---

## 1. Color System

Replace CSS variables in `src/index.css`:

| Variable | Old | New |
|---|---|---|
| `--bg` | `#F8F8F8` | `#FAF6F0` |
| `--surface` | `#FFFFFF` | `#FFFCF8` |
| `--surface-elevated` | (new) | `#FFF8F0` |
| `--border` | `#E5E5E5` | `#E8DDD0` |
| `--text` | `#111111` | `#2D1F12` |
| `--text-secondary` | `#777777` | `#7A6152` |

Keep unchanged: `--primary: #00ADBB`, `--warning: #F0585D`, `--success: #00AA59`, `--secondary: #2F7DE1`, `--purple: #A63595`, `--yellow-green: #7DC433`.

---

## 2. Typography

Replace font imports and CSS variables in `src/index.css`:

**Remove:** IBM Plex Sans, IBM Plex Sans Condensed  
**Add (Google Fonts):**
```css
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@300;400;500;600;700&display=swap');
```

**CSS variable changes:**
| Variable | Old | New |
|---|---|---|
| `--font-sans` | `'IBM Plex Sans'` | `'Nunito'` |
| `--font-condensed` | `'IBM Plex Sans Condensed'` | `'Fredoka'` |
| `--font-mono` | `'IBM Plex Mono'` | `'IBM Plex Mono'` (keep) |

**Usage rules:**
- `var(--font-condensed)` (Fredoka): Shoresh logo, screen/page titles, table column headers, stat labels, modal titles, nav item labels
- `var(--font-sans)` (Nunito): all body text, cell content, form inputs/labels, button text, secondary text
- `var(--font-mono)` (IBM Plex Mono): URLs, version tag, monospaced data only

---

## 3. Schedule Grid (Day View)

**Layout:** rows = days, columns = groups, time block selector pills at top.

**Time block selector:** pill buttons (border-radius: 20px) for each configured time block. Active pill uses `--primary` background + white text.

**Table headers (group names):** `font-family: var(--font-condensed)`, `font-size: 13px`, `font-weight: 600`, `color: var(--text)`. Background: `--surface-elevated`.

**Day label column (first column):**
- Day label: `font-family: var(--font-condensed)`, `font-size: 13px`, `font-weight: 600`

**Slot cells:**
- `min-height: 56px` (up from current ~28px)
- `padding: 10px 12px`
- `border-radius: 8px` on the inner fill div
- Background fill: `{color}1E` (30% opacity hex), border: `1.5px solid {color}55`
- Activity name: `font-size: 12px`, `font-weight: 700`, colored to match activity
- Empty cell: `background: var(--bg)`, `border: 1.5px dashed #D8C8B8`
- Anchor cell: `background: #F3E8FA`, `border: 1.5px solid #A6359588`

**Flag dots:** unchanged (6px circles below activity name)

**Group view** (rows = time blocks, cols = days for one selected group): apply same spacious cell treatment — same min-height, same border-radius, same fill style.

---

## 4. Setup Screens

Applies to: CampSetup, TiersScreen, GroupsScreen, TimeBlocksScreen, ActivitiesScreen, AnchorsScreen.

**Page structure:** Each screen keeps its existing layout. Visual updates only.

**Tables:**
- Header row: `font-family: var(--font-condensed)`, `font-size: 12px`, `text-transform: uppercase`, `letter-spacing: 0.5px`, `color: var(--text-secondary)`, background `var(--surface-elevated)`, `border-bottom: 1.5px solid var(--border)`
- Data rows: `min-height: 40px`, `border-bottom: 1px solid var(--border)`, Nunito body text
- Row hover: `background: var(--bg)`
- Table container: `border-radius: 12px`, `border: 1px solid var(--border)`, `overflow: hidden`, `background: var(--surface)`

**Buttons:**
- Primary: `border-radius: 7px`, `font-family: var(--font-sans)`, `font-weight: 700` — colors unchanged
- Secondary/Danger: same radius/font treatment

**Modals:**
- Container: `border-radius: 12px`, `background: var(--surface-elevated)`, `border: 1px solid var(--border)`
- Title: `font-family: var(--font-condensed)`, `font-size: 18px`, `font-weight: 600`
- Inputs: `border-radius: 7px`, `border: 1.5px solid var(--border)`, `background: var(--surface)`, Nunito font
- Input focus: `border-color: var(--primary)`, `outline: none`

**Empty states:** When a table has no rows, show a centered message: `font-family: var(--font-condensed)`, `font-size: 15px`, `color: var(--text-secondary)`, plus a description in Nunito below and the primary add button.

---

## 5. Sidebar & TopBar

**Sidebar:**
- Logo "Shoresh": `font-family: var(--font-condensed)`, `font-size: 24px` (already uses condensed — just becomes Fredoka)
- Camp name subtitle: keep `font-family: var(--font-mono)`
- Nav items: `font-family: var(--font-sans)`, `font-weight: 500`, active state `font-weight: 700`
- Active indicator: `border-left: 3px solid var(--primary)`, `background: #00ADBB0A`

**TopBar:**
- Screen title: `font-family: var(--font-condensed)`, `font-size: 18px`, `font-weight: 600`
- Stat badges: `border-radius: 6px`, `background: var(--bg)`, `border: 1px solid var(--border)`

---

## 6. Shared Styles (`src/styles/shared.js`)

Update `S` object values to match new design tokens:
- `S.th`: Fredoka, uppercase, warm secondary color
- `S.td`: Nunito, warm text, adequate row height
- `S.input`: rounded 7px, warm border, Nunito
- `S.btnPrimary`, `S.btnSecondary`, `S.btnDanger`: rounded 7px, Nunito 700
- `S.modalSm`, `S.modalLg`: rounded 12px, warm surface-elevated background
- `S.overlay`: unchanged
- `S.errorBanner`: unchanged (warning color stays)

---

## What Stays the Same

- All routing, navigation, data fetching, business logic
- Activity colors (`#00ADBB`, `#2F7DE1`, `#00AA59`, `#A63595`, `#F0585D`, `#7DC433`)
- Flag colors and flag dot rendering
- DnD behavior
- All screen structure and component hierarchy
- `--font-mono` (IBM Plex Mono)
