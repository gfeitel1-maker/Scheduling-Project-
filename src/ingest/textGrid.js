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

export function countTimes(text) {
  return (String(text ?? '').match(/\d{1,2}[:.]\d{2}/g) ?? []).length
}

/**
 * Reduce a two-line time cell to the period it names.
 *
 * Camp A writes a period as "9:50- Block" over "10:25  1" — start and end on
 * separate lines with the block number mixed in. Left alone, each half became
 * its own time block and the camp came back with 53 of them instead of 8.
 */
export function normalizeTimeLabel(label) {
  const times = String(label ?? '').match(/\d{1,2}[:.]\d{2}/g) ?? []
  if (times.length >= 2) return `${times[0]}-${times[1]}`
  // Only one time survived, so the two halves of the cell were not matched up.
  // Keep the time and drop what was mixed in with it — "11:10-Block" and
  // "10:25  1" are not period names a camp would recognise.
  if (times.length === 1) return times[0]
  return String(label ?? '').trim()
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

  // The line above a header is that page's title. It must also END the previous
  // page, or the title is read as one more row of the page before it — which is
  // how 29 bunk names ("Adom 5's - Blintzes Schedule") arrived in Camp A's
  // activity list.
  const titleIndexes = headerIndexes.map((headerIndex, n) => {
    const prevHeader = n === 0 ? -1 : headerIndexes[n - 1]
    for (let i = headerIndex - 1; i > prevHeader; i--) {
      if (lines[i].trim()) return i
    }
    return headerIndex
  })

  return headerIndexes.map((headerIndex, n) => ({
    title: lines[titleIndexes[n]]?.trim() ?? '',
    headerIndex,
    endIndex: n === headerIndexes.length - 1 ? lines.length : titleIndexes[n + 1],
  }))
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

    // Rows are delimited by BLANK LINES, not by which line carries a time.
    //
    // This is the second attempt. Treating a timed line as the start of a row
    // looked natural and was wrong for Camp A, whose time cell is split over
    // two lines with the row's activities printed BETWEEN the halves:
    //
    //     9:50- Block
    //                    Drama          Dance          Music
    //      10:25   1
    //
    // Line-by-line reading produced periods that ran backwards ("12:25-12:10")
    // and activities welded together from adjacent rows ("Drama Avodom"). A
    // blank-line block handles both layouts without knowing either: whatever
    // sits left of the first data column is the period, everything else is a
    // cell, and text on several lines of one block is one wrapped value.
    const rows = []
    let block = []

    // Within a block, a line is either its own row of values or the wrapped
    // tail of one. Camp A nests a swim sub-schedule inside a period with no
    // blank line between, so a block can hold several rows; Camp B wraps one
    // row over three lines. Both are told apart by how much of the width a
    // line covers: a value row reaches most columns, a wrap reaches one or two.
    const isValueRow = (tokens) => {
      const filled = new Set()
      for (const t of tokens) {
        if (columns.length > 0 && t.end <= columns[0].start) continue
        const i = columnFor(t, columns)
        if (i >= 0) filled.add(i)
      }
      return filled.size >= Math.max(2, Math.ceil(columns.length * 0.5))
    }

    const closeBlock = () => {
      if (block.length === 0) return
      const label = []
      const valueRows = []

      // Wrapped text appears on BOTH sides of the line it belongs to, so a
      // sparse line before the first value row leads into it rather than
      // standing alone. Getting this backwards is what split "Little" from
      // "Playground" — the two halves sit either side of the row.
      let leading = []
      for (const tokens of block) {
        const dataTokens = []
        for (const token of tokens) {
          if (columns.length > 0 && token.end <= columns[0].start) label.push(token.text)
          else dataTokens.push(token)
        }
        if (dataTokens.length === 0) continue
        if (isValueRow(tokens)) {
          valueRows.push([...leading, dataTokens])
          leading = []
        } else if (valueRows.length === 0) {
          leading.push(dataTokens)
        } else {
          valueRows[valueRows.length - 1].push(dataTokens)
        }
      }
      // A block with no value row at all is still one row of content.
      if (leading.length > 0) valueRows.push(leading)

      block = []
      const periodLabel = label.join(' ')

      if (valueRows.length === 0) {
        if (periodLabel) rows.push({ label: periodLabel, cells: Array(columns.length).fill('') })
        return
      }

      for (const lineGroup of valueRows) {
        const cells = Array(columns.length).fill('')
        for (const tokens of lineGroup) {
          for (const token of tokens) {
            const index = columnFor(token, columns)
            if (index < 0) continue
            cells[index] = cells[index] ? `${cells[index]} ${token.text}` : token.text
          }
        }
        rows.push({ label: periodLabel, cells })
      }
    }

    for (let i = headerIndex + 1; i < endIndex; i++) {
      const line = lines[i]
      if (!line.trim()) { closeBlock(); continue }
      const tokens = tokenize(line)
      if (tokens.length > 0) block.push(tokens)
    }
    closeBlock()

    for (const row of rows) row.label = normalizeTimeLabel(row.label)
    pages.push({ title, columns: columnLabels, rows })
  }

  return { pages }
}
