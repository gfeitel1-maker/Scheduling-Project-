// Measurement harness for the "Finalizing…" / "Committing…" freeze observed in
// electron:dev on 2026-09-30 (docs/work/runs/2026-09-30-t251-electron-dev-walk-
// director-flow.md). DIAGNOSIS ONLY — it changes nothing, it measures.
//
// RUN:
//   node --import ./scripts/fixtures/registerElectronStub.mjs \
//        scripts/electiveFreezePerf.mjs --sizes 40,80,160,312 --repeats 3
//
// Deliberately NOT a vitest file and NOT wired into `npm run verify`: it is an
// instrument quoted in a report, not a gate.
//
// WHY TWO ENGINES. `SHORESH_SYNC_ENGINE` is read ONCE at import
// (electron/sync/automerge/syncEngineFlag.js), so the Automerge dual-write can
// only be turned off in a SEPARATE PROCESS. That is the whole decomposition:
//   oplog arm      = SQLite INSERT + applyProjection, document path dead
//   automerge arm  = the same, PLUS the deferred document flush
//   difference     = commitDeferredDocWrites, with no probe inside production code
// The parent spawns the cells INTERLEAVED (oplog/automerge/oplog/… across sizes)
// because on this 4-core machine a block of same-arm runs measures the machine's
// mood, not the code (memory/T309, "op-log import write cost").
//
// WHY cpuUsage AND NOT WALL CLOCK: same memory. Wall ms is reported beside it,
// never instead of it.
//
// THE ONE THING THIS HARNESS MUST DO THAT THE T251 TEST FILES DO NOT:
// `setUserDataDirGetter`. Without it `applyLocalWriteNow` returns inert at
// liveDoc.js:379 and the document is never touched — which is exactly why the
// existing acceptance suite is green and fast while electron:dev hangs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

// ─── child: one (engine, size) cell ──────────────────────────────────────────

async function runCell({ size, engine }) {
  const { getOrCreateDeviceId } = await import('../electron/db/localDb.js')
  const { openTemplatedDb } = await import('../electron/db/testDbTemplate.js')
  const { createUser, ensureHostSigningKey } = await import('../electron/auth/localAuth.js')
  const { appendOp } = await import('../electron/ops/operations.js')
  const { makeHandlers } = await import('../electron/main.js')
  const { deriveElectiveOccurrenceId } = await import('../electron/ops/electiveDerivedIds.js')
  const { deriveElectiveRunOuterRows } = await import('../electron/ops/electiveRunOuterSchedule.js')
  const { computeExpectedSnapshotDigestByCamper } = await import('../electron/ops/electiveRunSnapshotCompleteness.js')
  const { deriveElectiveRunOuterSnapshotId } = await import('../electron/ops/deriveElectiveRunOuterSnapshotId.js')
  const liveDoc = await import('../electron/sync/automerge/liveDoc.js')
  const { SYNC_ENGINE } = await import('../electron/sync/automerge/syncEngineFlag.js')

  if (SYNC_ENGINE !== engine) throw new Error(`engine flag is ${SYNC_ENGINE}, wanted ${engine}`)

  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-perf-doc-'))
  liveDoc.resetForTests()
  // THE LINE THAT MAKES THIS PRODUCTION-FAITHFUL. See the header.
  liveDoc.setUserDataDirGetter(() => docDir)

  const templated = openTemplatedDb()
  const db = templated.db
  const deviceId = getOrCreateDeviceId(db)
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, os.hostname())
  db.prepare(
    "UPDATE devices SET authorized_at = ?, device_secret_identifier = ?, pairing_status = 'authorized' WHERE id = ?"
  ).run(new Date().toISOString(), randomBytes(32).toString('hex'), deviceId)

  const hostKey = ensureHostSigningKey(db)
  // INTERPOLATED, AND IT HAS TO BE: a trigger BODY cannot be parameterized in
  // SQLite (a bound parameter in a stored statement has no value at fire time),
  // so there is no `?` form of this. The value is locally generated hex from
  // ensureHostSigningKey, never anything a caller supplies — this is not a
  // counterexample to the repo's bound-parameter rule, it is the one shape the
  // rule cannot cover.
  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS trg_perf_set_signing_public_key
    AFTER INSERT ON camps WHEN NEW.signing_public_key IS NULL
    BEGIN UPDATE camps SET signing_public_key = '${hostKey.public_key}' WHERE id = NEW.id; END;
  `)

  // ── camp + fixture, copied in shape from electron/electiveRunFinalize
  // .integration.test.js's seedAdmin/seedFixture. One group/tier, one elective
  // set, one offering, one template_slots cell, and `size` campers in it — so
  // snapshot rows == campers, the axis being scaled.
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Perf', 'a'.repeat(64))
  await createUser(
    db,
    { camp_id: campId, name: 'Director', pin: '123400', role: 'admin' },
    async ({ entity, entity_id, field, value }) => ({
      status: 'applied',
      op: appendOp(db, { entity, entity_id, field, value, author_user_id: null, device_id: deviceId, parent_op_id: null }),
    })
  )
  const handlers = makeHandlers(db, deviceId, {})
  const { token } = await handlers.login({ name: 'Director', pin: '123400' })

  const fx = {
    groupId: randomUUID(), tierId: randomUUID(), setId: randomUUID(),
    activityId: randomUUID(), locationId: randomUUID(),
    dayId: 'day-1', timeBlockId: 'tb-1', templateId: 'tpl-1',
  }
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(fx.tierId, campId, 'Bogrim')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(fx.groupId, campId, 'Bogrim A', fx.tierId)
  db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, ?)').run(fx.locationId, campId, 'Field', 10000)
  db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)').run(fx.activityId, campId, 'Archery', fx.locationId)
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(fx.setId, campId, 'AM Electives')
  db.prepare('INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, capacity_limit) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), fx.setId, fx.activityId, 'unlimited', null)
  db.prepare('INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), fx.templateId, fx.groupId, fx.setId, fx.dayId, fx.timeBlockId)

  const runId = randomUUID()
  const occurrenceId = deriveElectiveOccurrenceId(runId, fx.setId, fx.dayId, fx.timeBlockId, fx.tierId)
  const campers = Array.from({ length: size }, (_, i) => ({ id: randomUUID(), name: `Camper ${i}` }))
  const parsed = {
    campers: campers.map((c) => ({ id: c.id, display_name: c.name, external_id: null })),
    choices: [{ label: 'Archery', labelKey: 'archery' }],
    preferences: campers.map((c) => ({ camper_id: c.id, occurrence_id: occurrenceId, label: 'Archery', labelKey: 'archery', rank: 1 })),
    sameNameCampers: [], skippedRows: [],
  }
  const assignments = campers.map((c) => ({
    camper_id: c.id, occurrence_id: occurrenceId, labelKey: 'archery',
    activity_id: fx.activityId, preference_rank: 1, flags: [],
  }))
  const occurrences = [{ id: occurrenceId, elective_set_id: fx.setId, day_id: fx.dayId, time_block_id: fx.timeBlockId, tier_id: fx.tierId }]

  const opCount = () => db.prepare('SELECT COUNT(*) c FROM operations').get().c
  // user+system together AND apart: the brief wants them kept separate, and the
  // split is diagnostic on its own (a system-heavy phase is I/O, a user-heavy
  // one is JS).
  const measure = async (fn) => {
    const ops0 = opCount()
    const cpu0 = process.cpuUsage()
    const wall0 = process.hrtime.bigint()
    const value = await fn()
    const cpu = process.cpuUsage(cpu0)
    const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6
    return { value, user: cpu.user, system: cpu.system, wallMs, ops: opCount() - ops0 }
  }

  const commit = await measure(() => handlers.commitElectiveRun({
    token, name: 'Week 1 electives', parsed, assignments, occurrences,
    scheduleTemplateId: fx.templateId, runId,
  }))
  if (!commit.value?.ok) throw new Error(`commit failed: ${JSON.stringify(commit.value)}`)

  // The two PURE phases finalize runs before it opens its transaction, timed on
  // their own. Read-only, so running them here changes nothing about the
  // finalize below except warming SQLite's page cache — which biases the
  // finalize number DOWN, i.e. against the hypothesis being tested.
  const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
  const derive = await measure(() => deriveElectiveRunOuterRows(db, run))
  const snapshots = derive.value.rows.map((row) => ({
    id: deriveElectiveRunOuterSnapshotId(runId, row.camper_id, row.day_id, row.time_block_id), ...row,
  }))
  const digest = await measure(() => computeExpectedSnapshotDigestByCamper(snapshots, runId))

  const finalize = await measure(() => handlers.finalizeElectiveRun({ token, runId }))
  if (!finalize.value?.ok) throw new Error(`finalize failed: ${JSON.stringify(finalize.value)}`)

  // DEFECT B PROBE — a TINY second commit (2 campers) into the camp the big run
  // has just been finalized into. Same handler, ~1/150th the rows. If this is
  // slow too, the cost is a function of how big the DOCUMENT already is, not of
  // how much this write touches — which is what a director experiences as "a
  // 2-camper commit hung".
  const smallRunId = randomUUID()
  const smallOccId = deriveElectiveOccurrenceId(smallRunId, fx.setId, fx.dayId, fx.timeBlockId, fx.tierId)
  const smallCampers = campers.slice(0, 2)
  const smallCommit = await measure(() => handlers.commitElectiveRun({
    token, name: 'Tiny follow-up', runId: smallRunId, scheduleTemplateId: fx.templateId,
    parsed: {
      campers: smallCampers.map((c) => ({ id: c.id, display_name: c.name, external_id: null })),
      choices: [{ label: 'Archery', labelKey: 'archery' }],
      preferences: smallCampers.map((c) => ({ camper_id: c.id, occurrence_id: smallOccId, label: 'Archery', labelKey: 'archery', rank: 1 })),
      sameNameCampers: [], skippedRows: [],
    },
    assignments: smallCampers.map((c) => ({
      camper_id: c.id, occurrence_id: smallOccId, labelKey: 'archery',
      activity_id: fx.activityId, preference_rank: 1, flags: [],
    })),
    occurrences: [{ id: smallOccId, elective_set_id: fx.setId, day_id: fx.dayId, time_block_id: fx.timeBlockId, tier_id: fx.tierId }],
  }))
  if (!smallCommit.value?.ok) throw new Error(`small commit failed: ${JSON.stringify(smallCommit.value)}`)

  const out = {
    engine, size,
    snapshotRows: finalize.value.snapshotRows,
    commit: strip(commit), derive: strip(derive), digest: strip(digest),
    finalize: strip(finalize), smallCommit: strip(smallCommit),
  }

  db.close()
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(templated.file + suffix)) fs.unlinkSync(templated.file + suffix)
  }
  fs.rmSync(docDir, { recursive: true, force: true })
  return out
}

const strip = ({ user, system, wallMs, ops }) => ({ user, system, wallMs, ops })

// ─── parent: interleave the cells, print the table ───────────────────────────

function parseArgs(argv) {
  const out = { sizes: [40, 120, 312], repeats: 2, cell: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sizes') out.sizes = argv[++i].split(',').map(Number)
    else if (argv[i] === '--repeats') out.repeats = Number(argv[++i])
    else if (argv[i] === '--cell') out.cell = argv[++i]
    else throw new Error(`unrecognised argument: ${argv[i]}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.cell) {
  const [sizeRaw, engine] = args.cell.split(':')
  const result = await runCell({ size: Number(sizeRaw), engine })
  process.stdout.write(`__CELL__${JSON.stringify(result)}\n`)
} else {
  const cells = []
  for (let r = 0; r < args.repeats; r += 1) {
    for (const size of args.sizes) {
      // oplog first on even repeats, automerge first on odd: neither arm always
      // runs on the colder machine.
      const order = r % 2 === 0 ? ['oplog', 'automerge'] : ['automerge', 'oplog']
      for (const engine of order) cells.push({ size, engine, repeat: r })
    }
  }

  const results = []
  for (const cell of cells) {
    const child = spawnSync(
      process.execPath,
      ['--import', './scripts/fixtures/registerElectronStub.mjs', 'scripts/electiveFreezePerf.mjs', '--cell', `${cell.size}:${cell.engine}`],
      { cwd: REPO, env: { ...process.env, SHORESH_SYNC_ENGINE: cell.engine }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
    const line = (child.stdout || '').split('\n').find((l) => l.startsWith('__CELL__'))
    if (!line) {
      process.stderr.write(`cell ${cell.size}:${cell.engine} produced no result\n${child.stdout}\n${child.stderr}\n`)
      process.exit(1)
    }
    const parsed = JSON.parse(line.slice('__CELL__'.length))
    parsed.repeat = cell.repeat
    results.push(parsed)
    process.stderr.write(`. ${cell.engine} n=${cell.size} r=${cell.repeat}\n`)
  }

  report(results)
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

// WITH --repeats 2 THE "MEDIAN" IS THE MEAN OF TWO SAMPLES and rejects no
// outlier, so every median printed below carries its own min/max. A reader who
// cannot see the dispersion cannot tell a real difference from this machine's
// mood, and that is exactly the mistake this harness exists to avoid.
function spread(xs) {
  if (xs.length < 2) return `n=1`
  return `${Math.round(Math.min(...xs))}..${Math.round(Math.max(...xs))} n=${xs.length}`
}

function report(results) {
  const sizes = [...new Set(results.map((r) => r.size))].sort((a, b) => a - b)
  const pick = (size, engine) => results.filter((r) => r.size === size && r.engine === engine)
  const med = (rows, phase, key) => Math.round(median(rows.map((r) => r[phase][key])))

  const lines = []
  lines.push('')
  lines.push('RAW CELLS (cpu µs; user+sys; wall ms; ops appended)')
  lines.push('engine     n    phase      user        sys       cpu       wall     ops   cpu/op')
  for (const r of results) {
    for (const phase of ['commit', 'derive', 'digest', 'finalize', 'smallCommit']) {
      const p = r[phase]
      const cpu = p.user + p.system
      lines.push(
        `${r.engine.padEnd(10)} ${String(r.size).padStart(4)}  ${phase.padEnd(9)} ` +
        `${String(p.user).padStart(9)} ${String(p.system).padStart(9)} ${String(cpu).padStart(9)} ` +
        `${p.wallMs.toFixed(1).padStart(9)} ${String(p.ops).padStart(7)} ` +
        `${(p.ops ? (cpu / p.ops).toFixed(1) : '-').padStart(8)}`
      )
    }
  }

  lines.push('')
  lines.push('MEDIANS BY SIZE (cpu µs = user+sys), each with its own min..max')
  lines.push('phase                        n     cpu      ops    cpu/op   spread')
  for (const size of sizes) {
    const am = pick(size, 'automerge')
    const ol = pick(size, 'oplog')
    // Per-SAMPLE cpu, so the spread describes the thing being reported rather
    // than one of its two components.
    const cpus = (rows, phase) => rows.map((r) => r[phase].user + r[phase].system)
    const row = (label, cpu, ops, note) =>
      lines.push(
        `${label.padEnd(27)} ${String(size).padStart(4)} ${String(Math.round(cpu)).padStart(8)} ${String(ops).padStart(8)} ` +
        `${(ops ? (cpu / ops).toFixed(1) : '-').padStart(9)}   ${note}`
      )

    const dRows = [...am, ...ol]
    row('derive rows (pure)', median(cpus(dRows, 'derive')), size, spread(cpus(dRows, 'derive')))
    row('digest (pure)', median(cpus(dRows, 'digest')), size, spread(cpus(dRows, 'digest')))

    const olFin = median(cpus(ol, 'finalize'))
    const amFin = median(cpus(am, 'finalize'))
    const fops = med(am, 'finalize', 'ops')
    row('finalize: oplog+projection', olFin, fops, spread(cpus(ol, 'finalize')))
    row('finalize: TOTAL automerge', amFin, fops, spread(cpus(am, 'finalize')))
    // A DIFFERENCE OF MEDIANS HAS NO SPREAD OF ITS OWN. Both arms' spreads are
    // printed instead, which is what tells a reader whether the difference
    // clears the noise.
    row('finalize: DOC FLUSH (diff)', amFin - olFin, fops, `am ${spread(cpus(am, 'finalize'))} | ol ${spread(cpus(ol, 'finalize'))}`)

    const olCom = median(cpus(ol, 'commit'))
    const amCom = median(cpus(am, 'commit'))
    const cops = med(am, 'commit', 'ops')
    row('commit: oplog+projection', olCom, cops, spread(cpus(ol, 'commit')))
    row('commit: TOTAL automerge', amCom, cops, spread(cpus(am, 'commit')))
    row('commit: DOC FLUSH (diff)', amCom - olCom, cops, `am ${spread(cpus(am, 'commit'))} | ol ${spread(cpus(ol, 'commit'))}`)

    const olSm = median(cpus(ol, 'smallCommit'))
    const amSm = median(cpus(am, 'smallCommit'))
    const sops = med(am, 'smallCommit', 'ops')
    row('small commit: DOC FLUSH', amSm - olSm, sops, `am ${spread(cpus(am, 'smallCommit'))} | ol ${spread(cpus(ol, 'smallCommit'))}`)
    lines.push('')
  }

  for (const phase of ['finalize', 'commit']) {
    lines.push(`SUPERLINEARITY — ${phase} document flush, cpu per op by size`)
    let prev = null
    for (const size of sizes) {
      const am = pick(size, 'automerge'), ol = pick(size, 'oplog')
      const cpus = (rows) => rows.map((r) => r[phase].user + r[phase].system)
      const diff = median(cpus(am)) - median(cpus(ol))
      const ops = med(am, phase, 'ops')
      const perOp = diff / ops
      lines.push(`  n=${String(size).padStart(4)}  ops=${String(ops).padStart(6)}  flushCpu=${String(Math.round(diff)).padStart(10)}µs  cpu/op=${perOp.toFixed(1).padStart(8)}µs` +
        (prev ? `   (x${(perOp / prev).toFixed(2)} vs previous size)` : '') +
        `   [am ${spread(cpus(am))} | ol ${spread(cpus(ol))}]`)
      prev = perOp
    }
    lines.push('')
  }
  lines.push('A RISING cpu/op IS THE QUADRATIC. A FLAT ONE IS A SLOW CONSTANT.')
  lines.push('READ THE SPREADS BEFORE READING A RATIO: with few repeats, a growth factor is')
  lines.push('only distinguishable from its neighbours when the arms do not overlap.')
  process.stdout.write(lines.join('\n') + '\n')
}
