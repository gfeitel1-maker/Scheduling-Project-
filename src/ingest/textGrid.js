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


import { splitPeriodBlocks } from './splitPeriodBlocks.js'

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

// The first two camps label their time column "Time"; the third leaves it
// blank. `hasTimeLabel` is the single signal that tells the two families apart,
// and every new-family behaviour below is gated on it being false — so a camp
// that labels its time column runs none of the new-family branches, which is
// the regression guarantee for the three shipped camps (ADR §7 addendum,
// spec §3). Proven byte-identical for Camp A/B; not a general-case proof —
// see the isHeaderLine note and [T36] for the widened-match residual.
//
// The label is matched against a SET of spellings, not the single word "Time":
// a Camp-A-shaped camp that heads its time column "Times", "Time Block", or
// "Period" must take the labelled path too, or it silently loses unit inference
// (tiers=[]). One constant, reused by hasTimeLabel and isHeaderLine, so the two
// never drift.
// T36 F2 (2026-08-03, re-verified still reproducing 2026-09-13): this was a
// PREFIX match, so any first token merely STARTING with a time word passed —
// including "Period 2" (a period named in the body) and "Times Up" (an
// activity). Such a row read as a header, starting a spurious page mid-body:
// the grid is cut at that row and whatever sat above it can be lost.
//
// Now an EXACT match on the LABEL. The distinction is what the text is doing:
// a header labels the column ("Time", "Period"), while "Period 2" names one
// particular period and is therefore data. Measured against the four-camp
// corpus before tightening — every time-labelled header in it is the single
// word "Time" — so the exact set refuses nothing real while closing both
// proven over-matches.
//
// WHAT IS ALLOWED AFTER THE WORD is the part that matters, and the first cut
// got it too narrow (Red Hat): "Time (approx)", "Period #" and "Time/Period"
// all passed the old prefix and would have been REFUSED, silently routing a
// labelled camp into the unlabeled family and costing it unit inference. So the
// tail is an allowlist of things that QUALIFY a label — a parenthetical, a #
// placeholder, a slash alternative, "Block"/"of day", a colon — and not the two
// shapes that turn a label into data: a bare following word ("Times Up") or an
// index ("Period 2"). Being generous here is the safe direction, since the cost
// of a false reject is a camp that cannot import correctly and the cost of a
// false accept is the narrow mid-body split this closes.
const TIME_HEADER_LABEL =
  /^(time|times|period|periods)(\s*[/|]\s*(time|times|period|periods))?(\s+(blocks?|of\s+day))?(\s*[#*]|\s*\([^)]*\))?\s*:?$/i

export function hasTimeLabel(tokens) {
  return tokens.length > 0 && TIME_HEADER_LABEL.test(tokens[0]?.text ?? '')
}

function dayCount(tokens) {
  return tokens.filter((t) => isDayName(t.text)).length
}

// A header with no "Time" label is recognised by being predominantly day names
// — the cross-camp signal for the days-across-the-top family. The 0.6 majority
// mirrors detectOrientation's day-column test; requiring >= 3 day names keeps a
// stray one- or two-word line from being read as a header.
export function isDayHeader(tokens) {
  const days = dayCount(tokens)
  return days >= 3 && days >= Math.ceil(tokens.length * 0.6)
}

/**
 * The header row is the line that names the columns. Two families label their
 * first column with a time word (Time/Times/Time Block/Period — the
 * layout-independent anchor); a third leaves the time column blank and is
 * recognised instead by a day-name-majority row.
 *
 * The time-word test covers a SET of spellings, wider than the original
 * `/^time$/` so a "Times"/"Period"/"Time Block" time column is caught (spec §3
 * FIX 2) — but an EXACT match against that set rather than a prefix of it.
 *
 * It was a prefix until 2026-09-13, and the cost was T36 F2: a BODY row whose
 * first cell merely BEGAN with a time word (a period named "Period 2", an
 * activity "Times Up") read as a header and split the page mid-body, losing
 * what sat above it. Closed — see TIME_HEADER_LABEL's own note, and
 * textGrid.f2.test.js.
 */
export function isHeaderLine(tokens) {
  return (tokens.length >= 3 && TIME_HEADER_LABEL.test(tokens[0].text)) || isDayHeader(tokens)
}

export function findHeaderLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (isHeaderLine(tokenize(lines[i]))) return i
  }
  return -1
}

// Where the body's time column ends, for a header that does not label it.
//
// The time column is invisible in the header, so its extent is read from the
// body: lines whose first token sits at the left margin and looks like a time.
// The maximum such end is the time column's right edge — a synthesized leading
// token ending there reproduces a "Time" label's exact column geometry (spec
// §3a). Capped below the first header token so it can never overlap a day.
export function leadingTimeExtent(lines, headerIndex, endIndex, firstDataStart) {
  let end = 0
  for (let i = headerIndex + 1; i < endIndex; i++) {
    const first = tokenize(lines[i])[0]
    if (!first || first.start !== 0 || !looksLikeTime(first.text)) continue
    if (first.end < firstDataStart) end = Math.max(end, first.end)
  }
  return end
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

// A location printed as bare room numbers — a single "217" tail, or "102 104
// 105" spread across the days — rather than a room name. Used by the fail-safe
// strip alongside the full-width value-row test to tell a location line from a
// wrapped activity continuation (spec §3b, R3).
function isBareNumbers(tokens) {
  return tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t.text))
}

// A page banner is the line that repeats above every page's title (e.g. a camp
// name printed on each page). It physically falls inside the PREVIOUS page's
// body span, so left alone it becomes a phantom activity. A camp whose titles
// have no shared line above them yields `null` and the skip below is a no-op
// (spec §3d).
//
// A banner CANDIDATE must be a single centred label, not schedule content: a
// real full-width content row (e.g. a daily "Dismissal"/"Pick Up" printed under
// every day) tokenizes to many columns, while a camp-name banner is one token.
// Requiring one token stops a repeated fixed-event row from being mistaken for a
// banner and silently stripped (ADR §1 forbids the omission; spec §3d).
// T36 F3 — does this text also appear INSIDE a real row?
//
// A line with two or more tokens is schedule content, not a centred label. If
// the banner candidate turns up as a whole cell in one of those, it is a thing
// the camp does — a "Dismissal" both printed above each page break and
// scheduled in the grid — and stripping it would delete a real event from every
// page.
//
// This is the deciding evidence precisely BECAUSE typography cannot decide: a
// camp name and a one-word event are the same shape above a page break. The
// document settles what the layout cannot (owner, 2026-09-13: "I'd rather us
// almost not infer but just flag that this isn't knowable from the way it is
// written").
// Red Hat (T36 review): scoped to the lines INSIDE a page's body, not the whole
// document. A PDF footer sets the camp name and a page number in two columns
// ("Shemesh        Page 1"), which tokenizes to two tokens — so scanning every
// line let a footer vouch for the camp name as "content" and made the real
// banner un-strippable, reintroducing it as a phantom activity on every page.
// That is the very bug the strip exists to close, arrived at through the guard
// meant to protect it.
function appearsInAValueRow(bodyLines, text) {
  const wanted = text.trim().toLowerCase()
  for (const line of bodyLines) {
    const tokens = tokenize(line)
    // Three or more columns, and the match is NOT the first one. A schedule row
    // leads with its time or period label and carries content after it; a PDF
    // footer leads with the camp name ("Shemesh        Page 1") and is two
    // columns wide. Scoping to page bodies alone does not separate them —
    // a footer falls physically INSIDE the previous page's span, the same
    // property that makes a banner need stripping in the first place.
    if (tokens.length < 3) continue
    if (tokens.slice(1).some((t) => t.text.trim().toLowerCase() === wanted)) return true
  }
  return false
}

function detectBanner(lines, titleIndexes, bodyLines) {
  const counts = new Map()
  for (const ti of titleIndexes) {
    for (let i = ti - 1; i >= 0; i--) {
      const text = lines[i].trim()
      if (!text) continue
      if (tokenize(lines[i]).length === 1) counts.set(text, (counts.get(text) ?? 0) + 1)
      break
    }
  }
  const threshold = Math.ceil(titleIndexes.length / 2)
  // Ordered by how often the candidate repeats, so the strongest is considered
  // first — but a candidate the grid vouches for as content is SKIPPED rather
  // than ending the search, or a camp whose name repeats less often than a real
  // event would keep its name as a phantom activity.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  for (const [text, n] of ranked) {
    if (n < threshold) break
    if (appearsInAValueRow(bodyLines, text)) continue
    return text
  }
  return null
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
    if (isHeaderLine(tokenize(lines[i]))) headerIndexes.push(i)
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

  const pages = headerIndexes.map((headerIndex, n) => ({
    title: lines[titleIndexes[n]]?.trim() ?? '',
    headerIndex,
    endIndex: n === headerIndexes.length - 1 ? lines.length : titleIndexes[n + 1],
  }))

  // Only the rows of a page count as schedule content for the banner check: a
  // title, a footer and the gap between pages are not rows, however many
  // columns they happen to occupy.
  const bodyLines = []
  for (const page of pages) {
    for (let i = page.headerIndex + 1; i < page.endIndex; i++) bodyLines.push(lines[i])
  }
  return { pages, banner: detectBanner(lines, titleIndexes, bodyLines) }
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

// T36 F1 — a trailing row filed as a LOCATION that the document itself says is
// an activity.
//
// `closeOnePeriod` reads a full-width row following another data row as the
// room printed under its activity. That is right almost always, and this does
// NOT change it: the reading stands, so every current camp parses identically.
// What it adds is a report, because the one case it gets wrong is a block that
// stacks two activities with no blank line between them, and the cost there is
// a real thing the camp does filed as a place.
//
// The evidence is whole-document rather than typographic, because typography
// cannot settle it (owner, 2026-09-13): "Art / Art Studio" and "Swim / Swim
// Return" are the same shape and mean opposite things. A text filed as a place
// on one row, which ALSO appears as an activity CELL somewhere else in the
// document, is a thing happening.
function findAmbiguousLocations(pages) {
  const activityCells = new Set()
  for (const page of pages) {
    for (const row of page.rows ?? []) {
      for (const cell of row.cells ?? []) {
        const text = String(cell ?? '').trim().toLowerCase()
        if (text) activityCells.add(text)
      }
    }
  }
  const counts = new Map()
  for (const page of pages) {
    for (const row of page.rows ?? []) {
      for (const loc of row.locations ?? []) {
        const text = String(loc ?? '').trim()
        if (!text) continue
        if (!activityCells.has(text.toLowerCase())) continue
        counts.set(text, (counts.get(text) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
}

export function parseTextGrid(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const pages = []

  const { pages: pageSpans, banner } = splitPages(lines)

  for (const { title, headerIndex, endIndex } of pageSpans) {
    const headerTokens = tokenize(lines[headerIndex])
    const labeled = hasTimeLabel(headerTokens)

    // A labelled time column is the original path, unchanged. An unlabeled one
    // is reconstructed from where the body's times sit: a synthesized leading
    // token ending at that extent makes the SAME columnSpans + slice(1) place
    // the first day column's boundary exactly where a "Time" label would (spec
    // §3a). Without it, slicing the header alone gives the first day a start of
    // 0 and pulls the body's times into it.
    let columns
    if (labeled) {
      // The first header cell is the time column and is not a data column.
      columns = columnSpans(headerTokens).slice(1)
    } else {
      const timeEnd = leadingTimeExtent(lines, headerIndex, endIndex, headerTokens[0]?.start ?? 0)
      const synthetic = [{ text: '', start: 0, end: timeEnd }, ...headerTokens]
      columns = columnSpans(synthetic).slice(1)
    }
    const columnLabels = columns.map((c) => c.label)
    // The new family prints a location line under each activity; strip it (spec
    // §3b). Gated on the missing time label so the two labelled camps never do.
    const stripLocations = !labeled

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

    // One blank-line block can hold more than one period (T140) — campA does it
    // twice. Each is handed to the existing per-block logic unchanged, which
    // simply runs once per period instead of once per block.
    const closeBlock = () => {
      if (block.length === 0) return
      const pending = block
      block = []
      for (const piece of splitPeriodBlocks(pending, columns[0]?.start ?? 0)) closeOnePeriod(piece)
    }

    const closeOnePeriod = (block) => {
      if (block.length === 0) return
      const label = []
      const valueRows = []

      // Wrapped text appears on BOTH sides of the line it belongs to, so a
      // sparse line before the first value row leads into it rather than
      // standing alone. Getting this backwards is what split "Little" from
      // "Playground" — the two halves sit either side of the row.
      let leading = []
      // A data line whose immediately-preceding non-blank line was also data MAY
      // be a location printed under its activity — but only a location-SHAPED one
      // is dropped (R3, the coupling: strip runs on `!labeled` pages). A trailing
      // line is treated as a location when it is a full-width value row (a room
      // under every day) OR bare numbers (a room number); a NARROW trailing line
      // fills far fewer columns than the activity above, so it is a wrapped
      // continuation ("Instructional" over "Swim") — kept, not dropped. A time
      // line (no data) resets the adjacency, so a recurring event that follows its
      // own time line ("Sof Hayom" under the 03:20 line) is kept too. When
      // ambiguous, KEEP: ADR §1 makes a dropped activity the one unrecoverable
      // failure. Gated to unlabeled pages (spec §3b).
      //
      // RESIDUAL: this reads any full-width trailing row as a location, so a
      // block that stacks TWO activity rows with no blank line between (as Camp
      // A nests its swim sub-schedule — but Camp A is labelled and spared) would
      // drop the second on a future unlabeled camp. Every current-corpus period
      // is one activity + one location per blank-delimited block, so it does not
      // fire today. Tracked, not pre-solved — see [T36].
      // Q8 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D5): a
      // line that WOULD be stripped as a location is captured instead of
      // discarded, parallel to `valueRows` by index (the row it sits under —
      // the value row most recently pushed when the location line is seen).
      // `locationLineGroups[i]` may be sparse/absent; a row with no captured
      // location line simply carries no `locations` field downstream.
      const locationLineGroups = []
      let prevHadData = false
      for (const tokens of block) {
        const dataTokens = []
        for (const token of tokens) {
          if (columns.length > 0 && token.end <= columns[0].start) label.push(token.text)
          else dataTokens.push(token)
        }
        if (dataTokens.length === 0) {
          if (stripLocations) prevHadData = false
          continue
        }
        if (stripLocations) {
          if (prevHadData && (isValueRow(tokens) || isBareNumbers(dataTokens))) {
            if (valueRows.length > 0) {
              const idx = valueRows.length - 1
              if (!locationLineGroups[idx]) locationLineGroups[idx] = []
              locationLineGroups[idx].push(dataTokens)
            }
            continue
          }
          prevHadData = true
        }
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

      const periodLabel = label.join(' ')

      if (valueRows.length === 0) {
        if (!periodLabel) return
        // A blank line can land INSIDE a wrapped label, which splits one period
        // in half: Camp A's backcountry pages print "11:10-Block" over its data,
        // then a blank, then " 11:45  3". The tail arrives here as a label with
        // no data, and left alone both halves become bare one-ended periods
        // ("11:10" and "11:45") instead of one "11:10-11:45".
        //
        // It is a tail, not an empty period, when it carries a single time AND
        // the row before it is still missing its end — a period that genuinely
        // has no activities follows a COMPLETE label and is pushed as before.
        const previous = rows[rows.length - 1]
        const timesIn = (text) => (String(text ?? '').match(/\d{1,2}[:.]\d{2}/g) ?? []).length
        if (previous && timesIn(periodLabel) === 1 && timesIn(previous.label) % 2 === 1) {
          previous.label = `${previous.label} ${periodLabel}`
          return
        }
        rows.push({ label: periodLabel, cells: Array(columns.length).fill('') })
        return
      }

      valueRows.forEach((lineGroup, rowIndex) => {
        const cells = Array(columns.length).fill('')
        for (const tokens of lineGroup) {
          for (const token of tokens) {
            const index = columnFor(token, columns)
            if (index < 0) continue
            cells[index] = cells[index] ? `${cells[index]} ${token.text}` : token.text
          }
        }
        const capturedTokens = locationLineGroups[rowIndex]
        let locations
        if (capturedTokens && capturedTokens.length > 0) {
          locations = Array(columns.length).fill('')
          for (const tokens of capturedTokens) {
            for (const token of tokens) {
              const index = columnFor(token, columns)
              if (index < 0) continue
              locations[index] = locations[index] ? `${locations[index]} ${token.text}` : token.text
            }
          }
        }
        rows.push(locations ? { label: periodLabel, cells, locations } : { label: periodLabel, cells })
      })
    }

    for (let i = headerIndex + 1; i < endIndex; i++) {
      const line = lines[i]
      if (!line.trim()) { closeBlock(); continue }
      // The repeating page banner sits in this page's body span; treat it like a
      // blank line so it never becomes a phantom activity (spec §3d). Gated on
      // `!labeled` (R3, the coupling) so a labelled camp's body is never skipped.
      if (!labeled && banner && line.trim() === banner) { closeBlock(); continue }
      const tokens = tokenize(line)
      if (tokens.length > 0) block.push(tokens)
    }
    closeBlock()

    for (const row of rows) row.label = normalizeTimeLabel(row.label)
    pages.push({ title, columns: columnLabels, rows, timeColumnLabeled: labeled })
  }

  // T36 F3 — returned so a caller can SHOW what was removed. The parser has
  // always computed this and thrown it away, which is what made a stripped line
  // invisible to the director.
  return { pages, banner, ambiguousLocations: findAmbiguousLocations(pages) }
}
