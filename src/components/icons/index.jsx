// The app's icon vocabulary — every inline SVG glyph in one place.
//
// Before this module, icons were defined locally inside whichever component
// happened to need one: ~14 separate `function SomeIcon()` declarations across
// screens and components, three of which drew the same map pin with three
// different path data, and two of which were byte-identical plus signs. The
// same concept rendered differently depending on which screen a director was
// looking at. See docs/work/specs/2026-09-11-icon-vocabulary.md for the
// decision table this module implements.
//
// Conventions, so a new icon matches the ones already here:
//
//   - Hand-authored outline SVG. There is no icon dependency and should not
//     be one — the set is small and the house style (1.5 stroke, round caps)
//     is not what a general-purpose library ships.
//   - `stroke="currentColor"` by default, so the *call site's* colour rules
//     (a button's idle/hover CSS, a parent's inline colour) drive the glyph
//     with no extra inline style. Reach for a hard-coded `var(--danger)` only
//     when the mark's colour is part of its meaning and must not inherit —
//     UnfillableIcon is the one such case.
//   - Every icon takes `style` and spreads `...rest` onto the <svg>, so a
//     call site can pass `data-testid`, `aria-hidden`, or a one-off margin
//     without the icon needing to know about it.
//   - Two size families, reflecting where they are used: 10–12px glyphs for
//     the dense schedule grid, and 14–24px glyphs for ordinary chrome. Keep a
//     new icon in whichever family its neighbours use. Where one shape serves
//     both (PinIcon), the caller states stroke weight in PIXELS and the
//     component converts to viewBox units — see the note there for why.
//
// When a glyph becomes an icon and when it stays text — the rule that decided
// every borderline case in this program:
//
//   An ICON SLOT becomes an icon. That is a glyph occupying its own element
//   beside the text it marks — `<span>⚠</span><span>{message}</span>` inside a
//   flex row. The slot already exists; only the thing filling it changes.
//
//   An INLINE TEXT PREFIX stays text. That is a glyph inside a sentence or a
//   template literal — `` `✓ Kept ${side}'s version` ``. Replacing it means
//   restructuring a string into JSX and hanging an SVG off a text baseline,
//   which looks worse than the character it replaced and reads no better.
//
// The rule matters more than any individual case, because it is what stops the
// next person having to re-litigate this file glyph by glyph.
//
// Text glyphs that are deliberately NOT here, per the spec's open decisions:
// the sidebar's ✓/!/· state marks (D1 — a three-glyph vocabulary in a
// fixed-width column, `·` has no icon form), ScheduleDoor's → (D6 — an
// animation target found by querySelector), and the five literal
// multiplication signs (D3 — "3 groups × 4 blocks" is arithmetic, not a
// close button).

// ---------------------------------------------------------------------------
// Schedule-grid family — 10–12px, authored for the dense cell grid.
// ---------------------------------------------------------------------------

// The merge/split affordance's glyph. The split reading is the same chevron
// rotated 90°, not a second glyph — one icon vocabulary for "this control
// changes the cell's block span".
export function CellSpanChevron({ direction = 'merge', style, ...rest }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} fill="none"
      style={{ display: 'block', transform: direction === 'split' ? 'rotate(90deg)' : undefined, ...style }}
      {...rest}>
      <path d="M3 4.5 L6 7.2 L9 4.5" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Outline "alert" glyph — deliberately a shape (not a dot), per the design
// spec's "unambiguous even before color registers" instruction for the one
// per-cell flag mark that survives the decolorization pass. Colour is
// hard-coded rather than inherited because the danger reading IS the mark.
export function UnfillableIcon({ style, ...rest }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} fill="none" style={{ display: 'block', ...style }} {...rest}>
      <circle cx="6" cy="6" r="5.25" stroke="var(--danger)" strokeWidth="1.5" />
      <line x1="6" y1="3.25" x2="6" y2="6.5" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="6" cy="8.5" r="0.75" fill="var(--danger)" />
    </svg>
  )
}

// Outline "open in new" glyph for the elective drill-in button.
export function OpenElectiveIcon({ style, ...rest }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} fill="none" style={{ display: 'block', ...style }} {...rest}>
      <path d="M4.5 3H9v4.5M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Small outline "sun" glyph for outdoor activities — replaces the deleted
// WEATHER_RISK flag. Informational, not a caution state.
export function OutdoorIcon({ style, ...rest }) {
  return (
    <svg viewBox="0 0 10 10" width={10} height={10} fill="none" style={{ display: 'block', ...style }} {...rest}>
      <circle cx="5" cy="5" r="2.1" stroke="var(--text-secondary)" strokeWidth="1.5" />
      <g stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round">
        <line x1="5" y1="0.6" x2="5" y2="1.6" />
        <line x1="5" y1="8.4" x2="5" y2="9.4" />
        <line x1="0.6" y1="5" x2="1.6" y2="5" />
        <line x1="8.4" y1="5" x2="9.4" y2="5" />
      </g>
    </svg>
  )
}

// "Arrow-out" glyph for a PULL override — the group leaves the grid here.
export function PullIcon({ style, ...rest }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} fill="none" style={{ display: 'block', ...style }} {...rest}>
      <path d="M4.5 2 L2 2 L2 10 L4.5 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 6 L10 6 M10 6 L7.5 3.5 M10 6 L7.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// The "override this day" entry control's glyph.
export function PencilIcon({ style, ...rest }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} fill="none" style={{ display: 'block', ...style }} {...rest}>
      <path d="M8 2 L10 4 L4 10 L2 10 L2 8 Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Chrome family — 14–24px, for ordinary screen furniture.
// ---------------------------------------------------------------------------

// The location pin — one shape, used at two sizes.
//
// Both call sites previously drew their own pin with different path data: a
// 24-viewBox one in the pickers and a squashed 10x12 one in the grid cells.
// Merging them is not just a matter of picking a path, because stroke width is
// expressed in viewBox units: the same `strokeWidth` renders thinner the
// smaller the icon is drawn. A naive merge would have made the grid pin render
// a 0.67px stroke against the picker's 1.0px, which reads as faded rather than
// small.
//
// So the caller states the stroke weight it wants in PIXELS and the component
// converts. That keeps a 10px pin and a 15px pin looking like the same object
// at two distances, which is the whole point of sharing the glyph.
export function PinIcon({ color = 'var(--text-secondary)', size = 15, strokePx = 1, style, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={strokePx * 24 / size} strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }} {...rest}>
      <path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10Z" />
      <circle cx="12" cy="11" r="2.2" />
    </svg>
  )
}

// The grid-cell preset: smaller, and a touch heavier in stroke so it holds up
// against the dense cell background. `display: block` matches the other
// grid-family glyphs so it sits on the text baseline the same way.
// Colour is inherited (`currentColor`) rather than named, because the cell's
// own CSS owns it — .cell-location-icon sets it today and any future hover
// state on the cell should carry the pin with it.
export function CellPinIcon({ style, ...rest }) {
  return <PinIcon size={10} strokePx={1.2} color="currentColor" style={{ display: 'block', ...style }} {...rest} />
}

// "Add a new one" inside the pickers.
export function PlusIcon({ style, ...rest }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      style={{ flexShrink: 0, ...style }} {...rest}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

// Disclosure chevron. Points down when collapsed, flips up when expanded —
// the rotation is the state, so callers pass `expanded` rather than picking a
// different glyph.
//
// A caller whose disclosure reads as a tree rather than a show-more toggle
// (the sidebar's section folds) overrides `transform` via `style`, which wins
// because it is spread last. That deliberately keeps the sidebar's
// right-then-down idiom while still sharing this one shape: the glyph is
// consolidated, the interaction language is not overwritten.
export function ChevronIcon({ expanded = false, size = 10, style, ...rest }) {
  return (
    <svg
      aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      style={{
        flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform var(--motion-base) var(--ease-standard)',
        ...style,
      }}
      {...rest}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

// Reorder arrow. Deliberately NOT the chevron, per decision D4: a chevron says
// "this reveals more", an arrow says "this moves the thing". Both were `▲`/`▼`
// before, which is exactly the collision worth spending a second glyph on.
const ARROW_ROTATION = { up: 0, right: 90, down: 180, left: 270 }

export function ArrowIcon({ direction = 'up', size = 10, style, ...rest }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', transform: `rotate(${ARROW_ROTATION[direction]}deg)`, ...style }} {...rest}>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  )
}

// Caution triangle. Stroke is a prop because the same shape carries both the
// warning and the danger reading depending on severity.
export function WarningTriangleIcon({ color = 'currentColor', size = 14, style, ...rest }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }} {...rest}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

// Info — the notice box's mark. Sibling to WarningTriangleIcon: the two fill
// the same slot in the same flex box, so they share a size and a stroke
// weight, and both inherit colour from the box rather than naming one.
export function InfoIcon({ size = 14, style, ...rest }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }} {...rest}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v5" />
      <path d="M12 7.75v.5" />
    </svg>
  )
}

// Padlock — the conflict screen's "a PIN was changed" marker, where the
// changed value itself must never be rendered.
export function LockIcon({ size = 18, style, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={style} {...rest}>
      <rect x="5" y="11" width="14" height="10" rx="2" stroke="var(--text-secondary)" strokeWidth="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// The larger celebratory check — an empty attention queue, not an inline
// confirmation. Deliberately distinct in weight from the small inline check
// (spec decision D2).
export function CircleCheckIcon({ size = 24, style, ...rest }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      style={style} {...rest}
    >
      <circle cx="12" cy="12" r="9.5" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  )
}

// Calendar — the shared empty state's glyph.
export function CalendarIcon({ size = 24, style, ...rest }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      style={style} {...rest}
    >
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 9.5h16" />
      <path d="M8 3v3M16 3v3" />
    </svg>
  )
}

// Static identity glyph — a simple root/tree mark. Not animated: it is
// identity, not choreography. Used once, and should stay that way; it is the
// product's mark, not a general-purpose decoration.
export function RootGlyph({ size = 22, style, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={style} {...rest}>
      <path
        d="M12 3v8M12 11c-2 0-3 1.5-4 4M12 11c2 0 3 1.5 4 4M12 11c-1 2-1 5-2.5 7M12 11c1 2 1 5 2.5 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="3" r="1.6" fill="currentColor" />
    </svg>
  )
}
