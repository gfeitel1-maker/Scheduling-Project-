// Turn the text of a schedule PDF into pages of grids.
//
// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §6, §7.
//
// A digital PDF's text extraction keeps horizontal position as whitespace and
// nothing else — there are no cell boundaries to read. So columns have to be
// reconstructed from where the header row's labels sit, and every later line's
// text assigned to whichever column it overlaps.
//
// This is the only format-specific stage. Excel and CSV arrive as a grid
// already; everything downstream of `parseTextGrid` is shared.
//
// It does not need to be perfect. Nothing here writes to the database — the
// output is a *proposal* the director reviews and corrects (ADR §1), so
// over-inclusion is recoverable and silent omission is the failure to avoid.
// Where the two trade off, this errs toward including too much.

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

// A run of two or more spaces separates columns; a single space is inside a
// label ("Back Playground", "Yeladim 1").
const TOKEN = /\S+(?: \S+)*/g

/**
 * Every run of text on a line, with the column span it occupies.
 * `{ text, start, end }` in character positions.
 */
export function tokenize(line) {
  const out = []
  let match
  TOKEN.lastIndex = 0
  while ((match = TOKEN.exec(line)) !== null) {
    // A single space inside the match is only part of a label if the gap is
    // narrow; TOKEN already enforces that by refusing runs of 2+.
    out.push({ text: match[0].trim(), start: match.index, end: match.index + match[0].length })
  }
  return out.filter((t) => t.text.length > 0)
}

/**
 * The header row is the line that names the columns. Both real samples label
 * their first column "Time", which is the only anchor available that does not
 * assume a layout — the column labels themselves differ completely between the
 * two camps (days in one, group names in the other).
 */
export function findHeaderLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const tokens = tokenize(lines[i])
    if (tokens.length >= 3 && /^time$/i.test(tokens[0].text)) return i
  }
  return -1
}

/**
 * Which header column a piece of text belongs to, by horizontal overlap.
 *
 * Overlap rather than nearest-centre because wrapped text is often wider than
 * its header ("Back Playground" under "Monday") and a centre comparison puts
 * long labels in the neighbouring column.
 */
function columnFor(token, columns) {
  let best = -1
  let bestOverlap = 0
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i]
    const overlap = Math.min(token.end, c.end) - Math.max(token.start, c.start)
    if (overlap > bestOverlap) { bestOverlap = overlap; best = i }
  }
  if (best !== -1) return best
  // No overlap at all — fall back to the nearest column by centre, so text
  // that sits between two columns still lands somewhere rather than vanishing.
  const centre = (token.start + token.end) / 2
  let nearest = 0
  let nearestDist = Infinity
  for (let i = 0; i < columns.length; i++) {
    const dist = Math.abs((columns[i].start + columns[i].end) / 2 - centre)
    if (dist < nearestDist) { nearestDist = dist; nearest = i }
  }
  return nearest
}

// Columns are widened to meet their neighbours, because a header label is
// narrower than the column it heads ("Music" heads a column that also holds
// "Instructional Swim").
function columnSpans(headerTokens) {
  return headerTokens.map((t, i) => {
    const prev = headerTokens[i - 1]
    const next = headerTokens[i + 1]
    return {
      label: t.text,
      start: prev ? Math.floor((prev.end + t.start) / 2) : 0,
      end: next ? Math.ceil((t.end + next.start) / 2) : Number.MAX_SAFE_INTEGER,
    }
  })
}

const TIME_RANGE = /^\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}$/
const TIME_PART = /^\d{1,2}[:.]\d{2}\s*[-–—]?$/
// A time need not be followed by a dash to start a row: Camp A's time cells
// read "10:30 Block" and "9:50- Block". Requiring the dash missed the first,
// which merged two rows' activities into one cell and would have proposed
// "Drama Back Playground" as an activity name.
const LEADING_TIME = /^\d{1,2}[:.]\d{2}(?![\d:.])/

export function looksLikeTime(text) {
  const t = text.trim()
  return TIME_RANGE.test(t) || TIME_PART.test(t) || LEADING_TIME.test(t)
}

export function isDayName(text) {
  return DAY_NAMES.includes(String(text).trim().toLowerCase())
}

/**
 * Split the document into pages.
 *
 * A page starts at each header line. Anything before the first header is a
 * title; the title of a later page is whatever sits between the previous
 * page's last row and this header.
 */
function splitPages(lines) {
  const headerIndexes = []
  for (let i = 0; i < lines.length; i++) {
    const tokens = tokenize(lines[i])
    if (tokens.length >= 3 && /^time$/i.test(tokens[0].text)) headerIndexes.push(i)
  }
  return headerIndexes.map((headerIndex, n) => {
    const prevHeader = n === 0 ? -1 : headerIndexes[n - 1]
    const endIndex = n === headerIndexes.length - 1 ? lines.length : headerIndexes[n + 1]
    // The title is the last non-empty line above the header that is not itself
    // part of the previous page's grid — in practice the line immediately
    // above, which is how both samples are laid out.
    let title = ''
    for (let i = headerIndex - 1; i > prevHeader; i--) {
      const text = lines[i].trim()
      if (text) { title = text; break }
    }
    return { title, headerIndex, endIndex }
  })
}

/**
 * Parse extracted PDF text into pages of grids.
 *
 * Returns `{ pages: [{ title, columns, rows }] }` where each row is
 * `{ label, cells }` — `label` is the row's first-column text (the time), and
 * `cells[i]` is the text under `columns[i]`.
 *
 * Wrapped text is joined to the row it belongs to: a line with no time in its
 * first column is a continuation of the row above.
 */
export function parseTextGrid(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const pages = []

  for (const { title, headerIndex, endIndex } of splitPages(lines)) {
    const headerTokens = tokenize(lines[headerIndex])
    // The first header cell is the time column and is not a data column.
    const columns = columnSpans(headerTokens).slice(1)
    const columnLabels = columns.map((c) => c.label)

    const rows = []
    // Wrapped text appears both ABOVE and BELOW the timed line it belongs to:
    //
    //                                    Little
    //   09:45–10:25   Slingshots                    Woodworking
    //                                 Playground
    //
    // So untimed lines are buffered rather than applied immediately. A blank
    // line means the buffer belonged to the row above; a timed line means it
    // belonged to the row about to start. Applying them eagerly is what splits
    // "Little Playground" into two entities that are neither.
    let pending = []

    const applyTo = (row, tokens) => {
      for (const token of tokens) {
        // Text left of the first data column is part of the time column, not
        // data. Camp A's time cell is two lines — "9:50- Block" over
        // "10:25  1" — so without this the block number lands in Monday and
        // every activity there reads "Drama 1".
        if (columns.length > 0 && token.end <= columns[0].start) continue
        const index = columnFor(token, columns)
        if (index < 0) continue
        row.cells[index] = row.cells[index] ? `${row.cells[index]} ${token.text}` : token.text
      }
    }
    const flushPending = (row) => {
      if (!row) { pending = []; return }
      for (const tokens of pending) applyTo(row, tokens)
      pending = []
    }

    for (let i = headerIndex + 1; i < endIndex; i++) {
      const line = lines[i]
      if (!line.trim()) {
        // Blank line: whatever is buffered trailed the row above.
        flushPending(rows[rows.length - 1])
        continue
      }
      const tokens = tokenize(line)
      if (tokens.length === 0) continue

      const first = tokens[0]
      if (looksLikeTime(first.text)) {
        const row = { label: first.text, cells: Array(columns.length).fill('') }
        rows.push(row)
        // Buffered text immediately above a timed line leads into it.
        flushPending(row)
        applyTo(row, tokens.slice(1))
      } else {
        pending.push(tokens)
      }
    }
    // Anything still buffered at the end of the page trailed the last row.
    flushPending(rows[rows.length - 1])

    pages.push({ title, columns: columnLabels, rows })
  }

  return { pages }
}
