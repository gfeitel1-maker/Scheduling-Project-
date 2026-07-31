// Frontmatter parsing for the work-record graph.
//
// This covers only the YAML subset this repository's frontmatter uses: scalars,
// inline lists, block lists, and block lists of flat maps. It is not a YAML
// implementation and must not become one. A document this cannot parse should
// be rewritten to fit the subset — that is cheaper than owning a YAML parser,
// and it keeps the frontmatter simple enough to read without one.
//
// Adding `yaml` as a dependency was the alternative. Rejected: 43 files of
// `key: value` do not justify a dependency in an app that ships to camps on a
// laptop, and every dependency here is one more thing electron-builder packages.

const OPEN = '---'

/**
 * @returns {{data: object|null, body: string, error: string|null}}
 *   `data` is null when there is no frontmatter *or* when it is malformed —
 *   `error` distinguishes the two. Callers must check `error` rather than
 *   treating a null `data` as "no frontmatter".
 */
export function parseFrontmatter(source) {
  const lines = source.split('\n')
  if (lines[0]?.trim() !== OPEN) {
    return { data: null, body: source, error: null }
  }

  const close = lines.indexOf(OPEN, 1)
  if (close === -1) {
    return { data: null, body: source, error: 'unterminated frontmatter block' }
  }

  try {
    return {
      data: parseBlock(lines.slice(1, close)),
      body: lines.slice(close + 1).join('\n'),
      error: null,
    }
  } catch (e) {
    return { data: null, body: source, error: e.message }
  }
}

function parseBlock(lines) {
  const data = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue }

    const match = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line)
    if (!match) throw new Error(`cannot parse frontmatter line: ${line.trim()}`)

    const [, key, rest] = match
    const inline = rest.trim()
    i++

    if (inline !== '') {
      data[key] = parseScalarOrInlineList(inline)
      continue
    }

    // An indented run following a bare `key:` is a block list; anything else
    // means the key's value is genuinely empty.
    const items = []
    while (i < lines.length && /^\s+-\s/.test(lines[i])) {
      const entry = lines[i].replace(/^\s+-\s/, '')
      i++

      // A map entry is `- key: value` followed by more-indented `key: value`
      // lines. A scalar entry is anything else.
      const first = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(entry)
      if (!first) { items.push(unquote(entry.trim())); continue }

      const obj = { [first[1]]: unquote(first[2].trim()) }
      while (i < lines.length && /^\s+[A-Za-z_]/.test(lines[i]) && !/^\s+-\s/.test(lines[i])) {
        const pair = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[i])
        if (!pair) break
        obj[pair[1]] = unquote(pair[2].trim())
        i++
      }
      items.push(obj)
    }

    data[key] = items.length ? items : ''
  }

  return data
}

function parseScalarOrInlineList(raw) {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((v) => unquote(v.trim())).filter((v) => v !== '')
  }
  if (raw === 'null' || raw === '~') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  return unquote(raw)
}

function unquote(value) {
  if (value.length >= 2 && (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Normalise a reference field to an array.
 *
 * A bare string where the standard requires a list is a real defect and the
 * checker reports it — but the index builder must still see the edge. Dropping
 * a reference because of a formatting mistake would hide a true relationship,
 * which is the failure this whole system exists to prevent.
 */
export function asList(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return [value]
}
