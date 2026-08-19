import { useState } from 'react'

// RosterList — Roots census roster, panel-only.
// docs/adr/2026-08-19-roots-census-and-persistent-inspector.md §(b).
//
// Presentational. Renders a per-child roster (buildRootMapModel's `roster`
// array) below the panel's "Open in {Screen} →" button. Reuses RootMap's
// four-state token colors — no fifth roster-row palette is invented here
// (not_set_up is a child-level state with an empty roster, never a roster
// row; see rootMapModel.js).

const STATE_DOT = {
  understood: 'var(--secondary)',
  attention: 'var(--accent)',
  changed: 'var(--primary)',
}

function groupEntries(entries, groupField, nullGroupLabel) {
  const map = new Map()
  for (const entry of entries) {
    const label = entry[groupField] ?? nullGroupLabel
    if (!map.has(label)) map.set(label, [])
    map.get(label).push(entry)
  }
  return map
}

// Entries have no globally-stable id: a live row's `entityId` is the natural
// key, but a proposed-new entry has entityId: null and only `decisionId` to
// distinguish it — and two RESOLVED proposed-new entries of the same type
// both have entityId: null, so entityId alone collides.
function rosterRowKey(entry) {
  return entry.entityId ?? entry.decisionId
}

function RosterRow({ entry }) {
  return (
    <div style={styles.row}>
      <span style={{ ...styles.dot, background: STATE_DOT[entry.state] ?? STATE_DOT.understood }} />
      <span style={styles.name}>{entry.name}</span>
      {entry.group && <span style={styles.groupLabel}>{` — ${entry.group}`}</span>}
    </div>
  )
}

export default function RosterList({ roster, threshold = 8, groupField = null, nullGroupLabel = '(no age division)' }) {
  const [query, setQuery] = useState('')
  const showSearch = roster.length > threshold

  // Entities that still need the director's attention are never subject to
  // the search filter or group collapse — they are the one thing a large
  // roster's "quiet at first glance" default must not let hide (ADR §(b)).
  const pinned = roster.filter((r) => r.state !== 'understood')
  const rest = roster.filter((r) => r.state === 'understood')

  const q = query.trim().toLowerCase()
  const filteredRest = q ? rest.filter((r) => r.name.toLowerCase().includes(q)) : rest
  const groups = groupField ? groupEntries(filteredRest, groupField, nullGroupLabel) : null

  return (
    <div style={styles.wrap}>
      {showSearch && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Find in ${roster.length}...`}
          style={styles.search}
        />
      )}
      {pinned.map((entry) => (
        <RosterRow key={rosterRowKey(entry)} entry={entry} />
      ))}
      {groups
        ? [...groups.entries()].map(([label, entries]) => (
          <details key={label} style={styles.group}>
            <summary style={styles.groupSummary}>{`${label} (${entries.length})`}</summary>
            {entries.map((entry) => <RosterRow key={rosterRowKey(entry)} entry={entry} />)}
          </details>
        ))
        : filteredRest.map((entry) => <RosterRow key={rosterRowKey(entry)} entry={entry} />)}
      {pinned.length === 0 && filteredRest.length === 0 && (
        <div style={styles.empty}>No matches.</div>
      )}
    </div>
  )
}

const styles = {
  wrap: {
    marginTop: 4,
  },
  search: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 10px',
    marginBottom: 8,
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 12,
    fontFamily: 'inherit',
    color: 'var(--text)',
    background: 'var(--bg)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 0',
    fontSize: 12,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  name: {
    color: 'var(--text)',
  },
  groupLabel: {
    color: 'var(--text-secondary)',
  },
  group: {
    marginBottom: 4,
  },
  groupSummary: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '4px 0',
  },
  empty: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    padding: '4px 0',
  },
}
