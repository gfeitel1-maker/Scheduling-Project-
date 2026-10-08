// End-to-end over the REAL stdio MCP transport (T226).
//
// Every other test in this directory calls the handler functions directly,
// which is the fast seam and covers the logic. It cannot cover the wiring:
// argv parsing, tool registration, the JSON content envelope, and the fact that
// the server process can actually open this db and write to it. A tool that is
// implemented and never registered passes every handler test and does not
// exist for a caller.
//
// So this spawns `node scripts/mcp/server.js` as a subprocess, drives it with
// the MCP SDK client, and then — the part that matters — opens the SQLite file
// itself and asserts the ROWS. Asserting the call returned ok would prove only
// that nothing threw; this repo has been bitten by exactly that.
//
// Expectations are computed from the FIXTURE below, never read back out of the
// code under test.

import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

import { openLocalDb } from '../../electron/db/localDb.js'

const REPO = process.cwd()
const SHEET = path.join(REPO, 'docs/work/specs/samples/fabricated-camper-preferences-100.csv')
const SERVER = path.join(REPO, 'scripts/mcp/server.js')

// Independent reading of the fixture — plain CSV splitting, nothing imported
// from src/ingest — so the numbers below describe the SHEET.
function fixtureExpectations() {
  const lines = fs.readFileSync(SHEET, 'utf8').trim().split('\n')
  const header = lines[0].split(',')
  const rankCols = header.map((h, i) => [h, i]).filter(([h]) => /^#\d+$/.test(h)).map(([, i]) => i)
  const body = lines.slice(1).map((l) => l.split(','))
  const labels = new Set()
  let preferences = 0
  for (const row of body) {
    for (const i of rankCols) {
      const v = (row[i] ?? '').trim()
      if (!v) continue
      preferences += 1
      labels.add(v.toLowerCase().replace(/\s+/g, ''))
    }
  }
  return {
    campers: body.length,
    choices: labels.size,
    preferences,
    rankCols,
    // A named camper and the elective they put first — the spot check.
    sample: { name: body[0][1], externalId: body[0][0], rank1: body[0][rankCols[0]] },
  }
}

// The MCP content envelope is {content: [{type: 'text', text: '<json>'}]}.
function unwrap(response) {
  const text = response.content?.find((c) => c.type === 'text')?.text
  expect(text, 'tool returned no text content').toBeTruthy()
  return JSON.parse(text)
}

describe('preference sheet over the stdio MCP transport', () => {
  const expected = fixtureExpectations()
  let dir, dbPath, campId, client, transport

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-mcp-e2e-'))
    dbPath = path.join(dir, 'shoresh.sqlite')
    const db = openLocalDb(dbPath)
    campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(randomUUID(), 'Host')
    // The author must be a real users row: operations.author_user_id is a
    // foreign key (electron/db/schema.sql:340), so an unknown --author-user-id
    // makes every commit fail with a bare 'FOREIGN KEY constraint failed'.
    const userId = randomUUID()
    db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')")
      .run(userId, campId)
    db.close()

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, '--db', dbPath, '--allow-write', '--author-user-id', userId],
      cwd: REPO,
      // The transport does not inherit the parent env, and encryption defaults ON: this test's db is a
      // disposable plaintext fixture, so pin the server's process off rather than authorize a tool.
      env: { ...getDefaultEnvironment(), SHORESH_AT_REST_ENCRYPTION: 'off' },
    })
    client = new Client({ name: 'shoresh-e2e-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
  }, 60_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('registers both preference-sheet tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('preference_sheet_preview')
    expect(names).toContain('preference_sheet_commit')
  })

  it('previews, commits, and lands the rows the fixture describes', async () => {
    const preview = unwrap(
      await client.callTool({ name: 'preference_sheet_preview', arguments: { file_path: SHEET } })
    )
    expect(preview.error).toBe(null)
    expect(preview.ok).toBe(true)
    expect(preview.blocked).toBe(null)
    expect(preview.counts).toEqual({
      campers: expected.campers,
      choices: expected.choices,
      preferences: expected.preferences,
    })
    expect(preview.mapping.rankColumns).toHaveLength(expected.rankCols.length)

    // The preview really was read-only — checked on disk, not taken on trust.
    const dry = openLocalDb(dbPath)
    expect(dry.prepare('SELECT COUNT(*) c FROM campers').get().c).toBe(0)
    dry.close()

    const commit = unwrap(
      await client.callTool({
        name: 'preference_sheet_commit',
        arguments: { file_path: SHEET, run_name: 'Session 1 preferences' },
      })
    )
    expect(commit.error).toBe(null)
    expect(commit.ok).toBe(true)
    expect(commit.runId).toBeTruthy()

    // THE ASSERTION THAT MATTERS: open the db the server wrote and read it.
    const db = openLocalDb(dbPath)
    try {
      const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
      expect(count('campers')).toBe(expected.campers)
      expect(count('elective_choices')).toBe(expected.choices)
      expect(count('elective_preferences')).toBe(expected.preferences)
      expect(count('elective_assignment_runs')).toBe(1)

      const run = db.prepare('SELECT * FROM elective_assignment_runs').get()
      expect(run.id).toBe(commit.runId)
      expect(run.camp_id).toBe(campId)
      expect(run.name).toBe('Session 1 preferences')

      const camper = db.prepare('SELECT * FROM campers WHERE display_name = ?').get(expected.sample.name)
      expect(camper.camp_id).toBe(campId)
      expect(camper.external_id).toBe(expected.sample.externalId)

      const rank1 = db
        .prepare(
          'SELECT c.label FROM elective_preferences p JOIN elective_choices c ON c.id = p.choice_id ' +
            'WHERE p.camper_id = ? AND p.rank = 1'
        )
        .get(camper.id)
      expect(rank1.label).toBe(expected.sample.rank1)

      // Every choice and preference belongs to the run just committed.
      expect(db.prepare('SELECT COUNT(*) c FROM elective_choices WHERE run_id = ?').get(commit.runId).c)
        .toBe(expected.choices)
      expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences WHERE run_id = ?').get(commit.runId).c)
        .toBe(expected.preferences)
    } finally {
      db.close()
    }
  }, 60_000)

  it('refuses a same-name sheet over the wire and writes no new campers', async () => {
    const before = (() => {
      const db = openLocalDb(dbPath)
      try {
        return db.prepare('SELECT COUNT(*) c FROM campers').get().c
      } finally {
        db.close()
      }
    })()

    const sameName = path.join(REPO, 'docs/work/specs/samples/fabricated-camper-preferences-same-name.csv')
    const result = unwrap(
      await client.callTool({ name: 'preference_sheet_commit', arguments: { file_path: sameName } })
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/more than one row/)

    const db = openLocalDb(dbPath)
    try {
      expect(db.prepare('SELECT COUNT(*) c FROM campers').get().c).toBe(before)
      expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c).toBe(1)
    } finally {
      db.close()
    }
  }, 60_000)

  // Board item 9b — THE MCP DOOR SEES BUNDLE NAMES. It rides the CLI core, so
  // this is the same fact scripts/preferenceSheetCli.test.js pins, asserted
  // across the stdio transport where an agent actually meets it. Written as its
  // own test so it can seed a bundle into the db this suite's server already has
  // open — the server reads the camp fresh on each call, so a row inserted now is
  // visible to the next preview.
  it('resolves a label only a bundle carries', async () => {
    const BUNDLE_NAME = 'Ropes Intensive'
    const db = openLocalDb(dbPath)
    const activityId = randomUUID()
    const setId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, 'Ropes')
    db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'Session 1')
    db.prepare('INSERT INTO elective_bundles (id, elective_set_id, activity_id, name) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), setId, activityId, BUNDLE_NAME)
    db.close()

    const file = path.join(dir, 'bundle-by-name.csv')
    fs.writeFileSync(file, `Camper,Division,#1\nAvi Cohen,Older,${BUNDLE_NAME}\n`)

    const preview = unwrap(
      await client.callTool({ name: 'preference_sheet_preview', arguments: { file_path: file } })
    )
    expect(preview.error).toBe(null)
    expect(preview.residue.filter((r) => r.kind === 'UNRESOLVED_CHOICE_LABEL' && r.label === BUNDLE_NAME))
      .toEqual([])
    expect(preview.counts.preferences).toBe(1)
  }, 60_000)
})
