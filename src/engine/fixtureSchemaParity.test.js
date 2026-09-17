// @vitest-environment node
//
// T187 — engine fixture / schema parity guard.
//
// THE BUG CLASS. T62 (#443) fixed a defect where the engine read
// `anchor.activity_id` — a column `anchor_activities` has NEVER had. It stayed
// green for a month because the test fixture hand-built the column, so the
// engine's tests agreed with the engine's imagination rather than with the
// database. Lunch and Rest Hour were double-booked in production the whole time.
//
// WHY THIS FILE IS HERE AND NOT UNDER electron/. All the existing parity guards
// (electron/ops/projectionsCoverage.test.js, electron/ops/undoReferences.schemaParity.test.js,
// the migration scanners) sit on the electron/ SQL boundary. `src/engine/` is a
// PURE function whose anchor and slot fixtures are JS object literals that never
// touch SQLite — which is exactly where T62 lived, and exactly where nothing was
// checking. This test is deliberately the one place under src/engine/ that
// reaches into electron/: the ENGINE stays pure (T69 — buildSchedule.js must
// never import from electron/), only the TEST reads the schema.
//
// WHAT IT ASSERTS. Every key an anchor fixture or a slot fixture in
// src/engine/*.test.js carries must correspond to a real column on
// `anchor_activities` / `template_slots` — per PRAGMA table_info on a fully
// migrated db, because schema.sql self-documents as base-only and is not ground
// truth — or be listed below as an explicit, reasoned exemption.
//
// ANTI-VACUITY — read before touching any of it.
// A static scanner's worst failure mode is not missing a bug; it is silently
// matching nothing while still passing green, because then it LOOKS like a
// guard. Five layers exist to make that loud:
//   1. total fixture-count floors (catches total scanner breakage);
//   2. a PER-PATTERN floor — every extraction pattern still finds a real
//      fixture in the tree (catches PARTIAL breakage, which aggregate counts
//      cannot see; T184's lesson);
//   3. a hardcoded CANARY key set, human-verified against the files today;
//   4. an OPAQUE-SITE floor — the scanner's own "I found a fixture site and
//      could not read it" list must stay empty. Without it, a new authoring
//      idiom silently takes fixtures out of coverage and nothing anywhere
//      changes colour. This is the layer the first draft was missing.
//   5. a PLANTED-DEFECT self-test: the real collector is run against synthetic
//      sources carrying defects of each shape and must report each one. Unlike
//      the floors, this survives the tree changing — if every helper-built
//      fixture were deleted tomorrow, layer 2 would have to be relaxed but
//      layer 5 would still prove the capability is intact.
// Do not weaken these to make a refactor pass. Fix the scanner instead.
//
// KNOWN RESIDUAL BLIND SPOTS (stated, not hidden):
//   - classification is by NAME (`anchors:` / `preplacedSlots:` / a variable
//     matching /anchor/i or /slots?$/). A fixture named nothing like an anchor
//     or a slot is not classified as one and goes unchecked. This is the one
//     genuinely SILENT hole left: the guard never learns such a site exists.
//   - computed keys (`{ [k]: v }`) cannot be resolved statically. They are not
//     checked — but they are counted, and the count is pinned at zero, so
//     introducing one is a failing test rather than a quiet hole.
//   - a fixture built by a helper in another module is unreadable (the scan
//     root is src/engine/*.test.js). It is not silently skipped: the site is
//     recorded as opaque, and layer 4 fails.
//   - a fixture whose keys come from imported data is likewise recorded as
//     opaque rather than skipped.
//   - the declaration map is file-flat, so two same-named `const`s in
//     different scopes are BOTH checked. That over-reports rather than
//     under-reports: worst case the guard names a key a sibling carries, which
//     a human can see and disambiguate. It does not hide anything.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'
import { openLocalDb } from '../../electron/db/localDb.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_DIR = __dirname
const SELF = path.basename(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Exemptions and aliases. Every entry carries its reason.
// ---------------------------------------------------------------------------

// Anchor fixture keys that are legitimately not columns on anchor_activities.
const ANCHOR_EXEMPT = {
  activity_id:
    'T62 legacy. `anchor_activities` has no activity_id; anchorActivityLink.js still honors an ' +
    'explicit link ahead of a name match, buildSchedule.test.js keeps the original T62 fixture ' +
    '(commented in place as unreal) beside name-linked regression tests, and removing the ' +
    'short-circuit is an explicit non-goal of T187.',
  _isSpanHead:
    'Engine-internal marker buildSchedule.js writes onto an expanded anchor. Never persisted.',
}

// Slot fixtures are in ENGINE shape (camelCase); template_slots is in DB shape
// (snake_case). The two are NOT a pure case transform — the engine calls the
// time block `blockId` where the column is `time_block_id`. The mapping is
// therefore explicit rather than inferred, so that a typo cannot be normalised
// into a real column by accident.
const SLOT_KEY_TO_COLUMN = {
  groupId: 'group_id',
  dayId: 'day_id',
  blockId: 'time_block_id',
  activityId: 'activity_id',
  anchorId: 'anchor_id',
  electiveSetId: 'elective_set_id',
  eventId: 'event_id',
  templateId: 'template_id',
  isReleased: 'is_released',
  isAnchor: 'is_anchor',
  isSpanHead: 'is_span_head',
}

const SLOT_EXEMPT = {
  type:
    'Engine-derived discriminator on the in-memory slot ("activity" | "anchor" | "elective" | ' +
    '"event" | "open"). Not persisted — the DB reconstructs it from is_anchor / elective_set_id / event_id.',
  cohort_id:
    'Cohort provenance carried on the in-memory slot so a multi-cohort run can be reassembled. ' +
    'template_slots is per-template and has no cohort column.',
}

// ---------------------------------------------------------------------------
// Anti-vacuity floors. Measured against the tree, then pinned with headroom.
// ---------------------------------------------------------------------------
const FLOORS = {
  filesScanned: 9, // 11 today
  anchorFixtures: 70, // 90 today
  slotFixtures: 30, // 40 today
}

// Hardcoded, human-verified keys the scanner must keep finding.
const CANARY_ANCHOR_KEYS = [
  'time_block_id', // plain inline literal (buildSchedule.test.js)
  'span_blocks',
  'group_ids',
  'is_all_groups',
  'unit_ids', // only reachable via the call-argument pattern (anchorScope.test.js)
  'name',
]
const CANARY_SLOT_KEYS = ['groupId', 'dayId', 'blockId', 'electiveSetId', 'eventId']

// Extraction patterns that must still be finding real fixtures in the tree.
// `helper` is deliberately NOT here: no engine test builds a fixture through a
// helper today, so requiring one would be a lie. The planted-defect self-test
// is what proves the helper path works.
const LIVE_PATTERNS = ['property', 'variable', 'call-arg', 'spread']

// Fixture sites the scanner found but could not read. Empty today; see the
// assertion that uses it for the rule about changing it.
const OPAQUE_SITES_ALLOWED = []

// ---------------------------------------------------------------------------
// AST plumbing
// ---------------------------------------------------------------------------

function parse(src) {
  return acorn.parse(src, { ecmaVersion: 2023, sourceType: 'module', locations: true })
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') walk(c, visit)
    } else if (child && typeof child.type === 'string') {
      walk(child, visit)
    }
  }
}

// Every named binding in the file — `const X = <init>` and `function X() {}` —
// flattened across scopes, name → ALL initializers seen under that name.
//
// It is a LIST, not a single entry, on purpose. A flat last-one-wins map is
// worse than imprecise, it is silently wrong: two same-named fixtures in
// different scopes collapse, and `anchors: [x]` then resolves to whichever
// declaration came last in the file — which may be a clean sibling while the
// one actually reaching the engine carries a phantom column. That fails
// silently, with nothing even counted as unresolved. Keeping every candidate
// and checking all of them turns that into a loud over-report instead: worst
// case the guard complains about a key a sibling carries, which a human can
// see and disambiguate. (Red Hat EXP3b.)
function buildDeclarationMap(ast) {
  const map = new Map()
  const add = (name, node) => {
    const list = map.get(name)
    if (list) list.push(node)
    else map.set(name, [node])
  }
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init) add(n.id.name, n.init)
    if (n.type === 'FunctionDeclaration' && n.id?.type === 'Identifier') add(n.id.name, n)
  })
  return map
}

// Functions in src/engine/*.js whose FIRST parameter is literally named
// `anchor`. Derived rather than hardcoded, so a new anchor-consuming resolver
// is covered the day it is written without anyone remembering to list it here.
function anchorConsumingFunctionNames() {
  const names = new Set()
  for (const file of fs.readdirSync(ENGINE_DIR)) {
    if (!file.endsWith('.js') || file.endsWith('.test.js')) continue
    const ast = parse(fs.readFileSync(path.join(ENGINE_DIR, file), 'utf8'))
    walk(ast, (n) => {
      const isFn =
        n.type === 'FunctionDeclaration' ||
        (n.type === 'VariableDeclarator' &&
          (n.init?.type === 'ArrowFunctionExpression' || n.init?.type === 'FunctionExpression'))
      if (!isFn) return
      const fn = n.type === 'FunctionDeclaration' ? n : n.init
      const first = fn.params?.[0]
      if (first?.type === 'Identifier' && first.name === 'anchor' && n.id?.name) names.add(n.id.name)
    })
  }
  return names
}

// ---------------------------------------------------------------------------
// Fixture collection
// ---------------------------------------------------------------------------

const ANCHOR_VAR_RE = /anchor/i
const ANCHOR_PROP_NAMES = new Set(['anchors'])
const SLOT_VAR_RE = /^(preplaced|.*[Ss]lots?)$/
const SLOT_PROP_NAMES = new Set(['preplacedSlots'])

// Resolves an expression to the concrete object literals it stands for.
// Returns { objects: [{ node, helper }], opaque } where `opaque` names each
// sub-expression that could be holding a fixture but could not be read.
// `helper: true` marks a literal reached THROUGH a function call rather than
// read straight off the call site — T184's exact blind spot: a scanner that
// only reads inline literals is blind to every fixture a helper builds.
function resolveObjects(node, decls, seen = new Set(), depth = 0) {
  const out = { objects: [], opaque: [] }
  if (!node || depth > 10) return out
  const absorb = (inner, markHelper = false) => {
    for (const o of inner.objects) out.objects.push(markHelper ? { node: o.node, helper: true } : o)
    out.opaque.push(...inner.opaque)
  }
  switch (node.type) {
    case 'ObjectExpression':
      out.objects.push({ node, helper: false })
      return out
    case 'ArrayExpression':
      for (const el of node.elements) {
        if (!el) continue
        absorb(resolveObjects(el.type === 'SpreadElement' ? el.argument : el, decls, seen, depth + 1))
      }
      return out
    case 'Identifier': {
      if (seen.has(node.name)) return out
      const inits = decls.get(node.name)
      if (!inits) {
        // Declared nowhere in this file: an import, or a function parameter.
        // Either way it could be carrying a fixture this guard cannot see.
        out.opaque.push(`${node.name} (no declaration in file)`)
        return out
      }
      const next = new Set(seen)
      next.add(node.name)
      for (const init of inits) absorb(resolveObjects(init, decls, next, depth + 1))
      return out
    }
    case 'ConditionalExpression':
      absorb(resolveObjects(node.consequent, decls, seen, depth + 1))
      absorb(resolveObjects(node.alternate, decls, seen, depth + 1))
      return out
    case 'CallExpression': {
      // A fixture built by a helper: `anchors: [makeAnchor({ day_id: 'd2' })]`.
      // Both halves are fixture surface — the helper's own literal (where a
      // phantom column would sit unnoticed) and the override handed in at the
      // call site.
      let found = false
      const callee = node.callee
      // `Object.assign({}, base, { ... })` — every argument is fixture surface,
      // including the identifier ones a plain "inline literals only" scan
      // would drop on the floor. (Red Hat EXP2.)
      if (
        callee?.type === 'MemberExpression' &&
        callee.object?.type === 'Identifier' &&
        callee.object.name === 'Object' &&
        callee.property?.name === 'assign'
      ) {
        for (const arg of node.arguments) {
          const inner = resolveObjects(arg, decls, seen, depth + 1)
          if (inner.objects.length) found = true
          absorb(inner)
        }
        if (!found) out.opaque.push('Object.assign(...) resolved to nothing')
        return out
      }
      // `raw.map((x) => ({ ... }))` — an ordinary way to build a fixture array,
      // and invisible to a scanner that only understands named callees.
      // (Red Hat EXP1.)
      if (callee?.type === 'MemberExpression' && callee.property?.name === 'map') {
        const fn = node.arguments[0]
        if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
          for (const expr of returnedExpressions(fn)) {
            const inner = resolveObjects(expr, decls, seen, depth + 1)
            if (inner.objects.length) found = true
            absorb(inner, true)
          }
        }
        if (!found) out.opaque.push('.map(...) with a callback this scan cannot read')
        return out
      }
      // Any other method call — `slots.filter(...)`, `ALL_CATEGORIES.find(...)`,
      // a library call. These are queries over engine OUTPUT or over unrelated
      // data, not fixture construction, so they are deliberately NOT treated as
      // unseen fixture sites. Engine output is checked by the engine's own
      // tests; this guard is about INPUT fixtures.
      if (callee?.type === 'MemberExpression') return out
      if (callee?.type === 'Identifier') {
        const key = `fn:${callee.name}`
        if (!seen.has(key)) {
          const next = new Set(seen)
          next.add(key)
          for (const fn of decls.get(callee.name) ?? []) {
            const isFn =
              fn.type === 'FunctionDeclaration' ||
              fn.type === 'ArrowFunctionExpression' ||
              fn.type === 'FunctionExpression'
            if (!isFn) continue
            for (const expr of returnedExpressions(fn)) {
              const inner = resolveObjects(expr, decls, next, depth + 1)
              if (inner.objects.length) found = true
              absorb(inner, true)
            }
          }
        }
      }
      for (const arg of node.arguments) {
        if (arg?.type === 'ObjectExpression') {
          out.objects.push({ node: arg, helper: false })
          found = true
        }
      }
      if (!found) {
        // A named call that resolves to no local function: almost certainly a
        // helper imported from another module. That is real fixture surface
        // this scan cannot follow (its scan root is src/engine/*.test.js), so
        // it is reported rather than swallowed.
        out.opaque.push(`${callee?.name ?? '<expr>'}(...) — no local function of that name`)
      }
      return out
    }
    default:
      // Literals (including `null`), logical/binary expressions, parameter
      // defaults, member reads. None of these is a shape a fixture object
      // literal can hide inside, so they are not counted as blind spots.
      // A fixture reached through a function PARAMETER (`over.anchors || []`)
      // is covered from the other side: the call site passing it has its own
      // `anchors:` property site.
      return out
  }
}

// Every expression a function can hand back: a concise arrow body, or the
// argument of any `return` in its block.
function returnedExpressions(fn) {
  if (fn.body && fn.body.type !== 'BlockStatement') return [fn.body]
  const out = []
  walk(fn.body, (n) => {
    if (n.type === 'ReturnStatement' && n.argument) out.push(n.argument)
  })
  return out
}

// Keys carried by an object literal, following `...spread` into whatever the
// spread source resolves to — `{ ...baseAnchor, day_id: 'd2' }` carries
// baseAnchor's keys too.
function keysOf(objectNode, decls, depth = 0) {
  const keys = new Set()
  let computed = 0
  if (depth > 8) return { keys, computed }
  for (const prop of objectNode.properties) {
    if (prop.type === 'SpreadElement') {
      const inner = resolveObjects(prop.argument, decls)
      for (const o of inner.objects) {
        const r = keysOf(o.node, decls, depth + 1)
        for (const k of r.keys) keys.add(k)
        computed += r.computed
      }
      continue
    }
    if (prop.computed) {
      computed += 1
      continue
    }
    const k = prop.key
    if (k.type === 'Identifier') keys.add(k.name)
    else if (k.type === 'Literal') keys.add(String(k.value))
    else computed += 1
  }
  return { keys, computed }
}

// Scans ONE module's source text. Split out from collectFixtures so the
// planted-defect self-test can run the REAL collector over synthetic sources,
// rather than only over whatever the tree happens to contain today.
function scanSource(file, src, consumers) {
  const out = { anchors: [], slots: [], opaqueSites: [], computedKeys: 0 }
  const ast = parse(src)
  const decls = buildDeclarationMap(ast)
  const sites = [] // { node, kind: 'anchor' | 'slot', pattern }

  walk(ast, (n) => {
    // Pattern: `anchors: [...]` / `preplacedSlots: [...]` object properties.
    if (n.type === 'Property' && !n.computed && n.key?.type === 'Identifier') {
      if (ANCHOR_PROP_NAMES.has(n.key.name)) sites.push({ node: n.value, kind: 'anchor', pattern: 'property' })
      else if (SLOT_PROP_NAMES.has(n.key.name)) sites.push({ node: n.value, kind: 'slot', pattern: 'property' })
    }
    // Pattern: `const anchor = {...}` / `const preplaced = [...]`.
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init) {
      if (ANCHOR_VAR_RE.test(n.id.name)) sites.push({ node: n.init, kind: 'anchor', pattern: 'variable' })
      else if (SLOT_VAR_RE.test(n.id.name)) sites.push({ node: n.init, kind: 'slot', pattern: 'variable' })
    }
    // Pattern: first argument of an anchor-consuming engine function.
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && consumers.has(n.callee.name)) {
      if (n.arguments[0]) sites.push({ node: n.arguments[0], kind: 'anchor', pattern: 'call-arg' })
    }
  })

  for (const site of sites) {
    const { objects, opaque } = resolveObjects(site.node, decls)
    for (const reason of opaque) {
      out.opaqueSites.push(`${file}:${site.node.loc.start.line} (${site.kind}/${site.pattern}) — ${reason}`)
    }
    for (const o of objects) {
      const { keys, computed } = keysOf(o.node, decls)
      out.computedKeys += computed
      const hasSpread = o.node.properties.some((p) => p.type === 'SpreadElement')
      const pattern = o.helper ? 'helper' : hasSpread ? 'spread' : site.pattern
      const bucket = site.kind === 'anchor' ? out.anchors : out.slots
      bucket.push({ file, line: o.node.loc.start.line, keys: [...keys], pattern })
    }
  }
  return out
}

function collectFixtures() {
  const consumers = anchorConsumingFunctionNames()
  const result = {
    filesScanned: 0,
    consumers: [...consumers],
    anchors: [], // { file, line, keys, pattern }
    slots: [],
    opaqueSites: [],
    computedKeys: 0,
  }

  for (const file of fs.readdirSync(ENGINE_DIR).sort()) {
    if (!file.endsWith('.test.js')) continue
    // Never scan this guard itself. Its own ANCHOR_EXEMPT / SLOT_KEY_TO_COLUMN
    // tables are objects whose names match the anchor/slot patterns, so a
    // self-scan would feed the guard its own exemption list as evidence.
    if (file === SELF) continue
    const src = fs.readFileSync(path.join(ENGINE_DIR, file), 'utf8')
    result.filesScanned += 1
    const one = scanSource(file, src, consumers)
    result.anchors.push(...one.anchors)
    result.slots.push(...one.slots)
    result.opaqueSites.push(...one.opaqueSites)
    result.computedKeys += one.computedKeys
  }
  return result
}

// Fixtures are deduplicated by file:line, because one literal can legitimately
// be reached by more than one pattern (a `const anchor = {...}` later passed as
// `anchors: [anchor]`). Counting it twice would inflate the vacuity floors.
function dedupe(list) {
  const byLoc = new Map()
  for (const f of list) if (!byLoc.has(`${f.file}:${f.line}`)) byLoc.set(`${f.file}:${f.line}`, f)
  return [...byLoc.values()]
}

// --- the parity predicate itself, used by both the tree assertions and the
// --- planted-defect self-test, so the self-test cannot pass against a
// --- different rule from the one that guards the repo.

function anchorOffenders(fixtures, columns) {
  const out = []
  for (const f of fixtures) {
    for (const key of f.keys) {
      if (columns.has(key) || key in ANCHOR_EXEMPT) continue
      out.push(`${f.file}:${f.line} carries "${key}", which anchor_activities does not have`)
    }
  }
  return out
}

function slotOffenders(fixtures, columns) {
  const out = []
  for (const f of fixtures) {
    for (const key of f.keys) {
      if (key in SLOT_EXEMPT) continue
      const column = SLOT_KEY_TO_COLUMN[key] ?? key
      if (columns.has(column)) continue
      out.push(`${f.file}:${f.line} carries "${key}" (→ column "${column}"), which template_slots does not have`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------

describe('engine fixtures stay in parity with the real schema (T187)', () => {
  let columns
  let scan
  let anchorFixtures
  let slotFixtures
  let consumers
  const tmpFiles = []

  beforeAll(() => {
    const file = path.join(os.tmpdir(), `shoresh-t187-${Date.now()}-${Math.random()}.sqlite`)
    tmpFiles.push(file)
    const db = openLocalDb(file)
    columns = {
      anchor_activities: new Set(db.prepare('PRAGMA table_info(anchor_activities)').all().map((c) => c.name)),
      template_slots: new Set(db.prepare('PRAGMA table_info(template_slots)').all().map((c) => c.name)),
    }
    db.close()
    consumers = anchorConsumingFunctionNames()
    scan = collectFixtures()
    anchorFixtures = dedupe(scan.anchors)
    slotFixtures = dedupe(scan.slots)
  })

  afterAll(() => {
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
      }
    }
  })

  // The floors run first: a broken scanner must fail here, before the (then
  // vacuously green) parity assertions get a chance to look fine.
  describe('anti-vacuity floors', () => {
    it('read a real schema, not an empty one', () => {
      expect(columns.anchor_activities.size).toBeGreaterThan(10)
      expect(columns.template_slots.size).toBeGreaterThan(10)
    })

    it('scanned a plausible number of engine test files', () => {
      expect(scan.filesScanned).toBeGreaterThanOrEqual(FLOORS.filesScanned)
    })

    it('found anchor and slot fixtures at all', () => {
      expect(anchorFixtures.length).toBeGreaterThanOrEqual(FLOORS.anchorFixtures)
      expect(slotFixtures.length).toBeGreaterThanOrEqual(FLOORS.slotFixtures)
    })

    it('derived the anchor-consuming function list from engine source, non-empty', () => {
      // If this empties out, the call-argument pattern silently stops finding
      // anything and anchorScope.test.js's fixtures go unchecked.
      expect(scan.consumers.length).toBeGreaterThanOrEqual(3)
      expect(scan.consumers).toContain('resolveAnchorGroupIds')
    })

    it('every live extraction pattern is still finding a real fixture', () => {
      // PARTIAL-breakage floor. The aggregate counts above cannot see a scanner
      // that has regressed to only its simplest pattern; this can.
      const seen = new Set([...anchorFixtures, ...slotFixtures].map((f) => f.pattern))
      for (const pattern of LIVE_PATTERNS) {
        expect(seen, `extraction pattern "${pattern}" found nothing`).toContain(pattern)
      }
    })

    it('no engine fixture carries a computed key', () => {
      // A computed key (`{ [k]: v }`) cannot be resolved statically, so it is a
      // hole this guard cannot see through. Rather than let that hole open
      // silently, the count is pinned at zero: introducing one is a deliberate
      // act that turns this red and forces the conversation.
      expect(scan.computedKeys).toBe(0)
    })

    it('is not quietly giving up on any fixture site it can see', () => {
      // `opaqueSites` is the guard's own "I found a fixture site and could not
      // read it" list. Left unasserted it is telemetry wired to nothing, and a
      // new authoring idiom — Object.assign, .map(), a helper imported from
      // another module — takes fixtures out of coverage with no signal at all.
      // That is the exact silence T62 shipped inside.
      //
      // If this goes red: a fixture site stopped being readable. Teach
      // resolveObjects the new shape. Adding the site to OPAQUE_SITES_ALLOWED
      // is only correct when it genuinely is not a fixture, and then the entry
      // must say why.
      expect(scan.opaqueSites).toEqual(OPAQUE_SITES_ALLOWED)
    })

    it('still sees the canary keys, which are present in the tree today', () => {
      const anchorKeys = new Set(anchorFixtures.flatMap((f) => f.keys))
      for (const k of CANARY_ANCHOR_KEYS) {
        expect(anchorKeys, `anchor canary key "${k}" no longer seen`).toContain(k)
      }
      const slotKeys = new Set(slotFixtures.flatMap((f) => f.keys))
      for (const k of CANARY_SLOT_KEYS) {
        expect(slotKeys, `slot canary key "${k}" no longer seen`).toContain(k)
      }
    })
  })

  // Proof of capability, independent of what the tree contains. Each case is a
  // defect shape the guard must catch — including shapes it was NOT originally
  // written for. Every source below is deliberately minimal and self-contained.
  describe('planted defects — the guard is proven to catch, not merely to pass', () => {
    const scanSynthetic = (src) => scanSource('synthetic.js', src, consumers)

    it('catches a phantom column on template_slots (the table nobody was thinking about)', () => {
      const s = scanSynthetic(`const preplacedSlots = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', roomId: 'r1' }]`)
      expect(slotOffenders(s.slots, columns.template_slots)).toHaveLength(1)
      expect(slotOffenders(s.slots, columns.template_slots)[0]).toContain('roomId')
    })

    it('catches a phantom key on a fixture built by a HELPER FUNCTION, not an inline literal', () => {
      // T184's blind spot: helper-routed construction invisible to a scanner
      // that only reads the call site.
      const s = scanSynthetic(`
        function makeAnchor(over = {}) {
          return { id: 'a1', name: 'Lunch', time_block_id: 'b1', activity_kind: 'meal', ...over }
        }
        buildSchedule({ anchors: [makeAnchor()] })
      `)
      expect(s.anchors.some((f) => f.pattern === 'helper')).toBe(true)
      expect(anchorOffenders(s.anchors, columns.anchor_activities).join(' ')).toContain('activity_kind')
    })

    it('catches a phantom key in the OVERRIDE object handed to a helper', () => {
      const s = scanSynthetic(`
        const makeAnchor = (over) => ({ id: 'a1', name: 'Lunch', ...over })
        buildSchedule({ anchors: [makeAnchor({ activity_kind: 'meal' })] })
      `)
      expect(anchorOffenders(s.anchors, columns.anchor_activities).join(' ')).toContain('activity_kind')
    })

    it('catches a key that is real on a DIFFERENT table (plausible-looking, wrong table)', () => {
      // `tier_id` is a real column — on `groups`. anchor_activities scopes by
      // unit_id / unit_ids, never tier_id.
      expect(columns.anchor_activities.has('tier_id')).toBe(false)
      const s = scanSynthetic(`const anchor = { id: 'a1', name: 'Lunch', tier_id: 't1' }`)
      expect(anchorOffenders(s.anchors, columns.anchor_activities).join(' ')).toContain('tier_id')
    })

    it('catches a slot key that is real on a different table', () => {
      // `part_of_day` is real on time_blocks, not on template_slots.
      expect(columns.template_slots.has('part_of_day')).toBe(false)
      const s = scanSynthetic(`const preplacedSlots = [{ groupId: 'g1', part_of_day: 'morning' }]`)
      expect(slotOffenders(s.slots, columns.template_slots).join(' ')).toContain('part_of_day')
    })

    it('catches a phantom key introduced through a spread base', () => {
      const s = scanSynthetic(`
        const baseAnchor = { id: 'a1', name: 'Lunch', bogus_col: 1 }
        const anchor = { ...baseAnchor, day_id: 'd2' }
      `)
      expect(anchorOffenders(s.anchors, columns.anchor_activities).join(' ')).toContain('bogus_col')
    })

    it('catches a phantom key at a bare call-argument site', () => {
      const s = scanSynthetic(`resolveAnchorGroupIds({ unit_ids: ['t1'], bogus_col: 1 }, groups)`)
      expect(anchorOffenders(s.anchors, columns.anchor_activities).join(' ')).toContain('bogus_col')
    })

    it('catches a phantom key in a fixture array built by .map()', () => {
      // Red Hat EXP1: an ordinary idiom, and invisible to a scanner that only
      // understands named callees.
      const s = scanSynthetic(`
        const anchors = RAW.map((x) => ({ ...x, name: 'Lunch', time_block_id: 'b1', phantom_map_col: 1 }))
      `)
      expect(anchorOffenders(s.anchors, columns.anchor_activities).join(' ')).toContain('phantom_map_col')
    })

    it('catches a phantom key composed in through Object.assign', () => {
      // Red Hat EXP2: the identifier arguments, not just the inline ones.
      const s = scanSynthetic(`
        const base = { extra_phantom_via_base: 1 }
        const anchor = Object.assign({}, base, { name: 'Lunch', time_block_id: 'b1' })
      `)
      expect(anchorOffenders(s.anchors, columns.anchor_activities).join(' ')).toContain('extra_phantom_via_base')
    })

    it('catches a phantom key on a SHADOWED sibling rather than resolving past it', () => {
      // Red Hat EXP3b: with a last-one-wins declaration map, `anchors: [x]`
      // resolved to the clean, unused second `x` and the phantom on the one
      // actually reaching the engine vanished without a trace.
      const s = scanSynthetic(`
        function a() {
          const x = { name: 'Lunch', phantom_shadow_col: 1 }
          return buildSchedule({ anchors: [x] })
        }
        function b() {
          const x = { name: 'Lunch', time_block_id: 'b1' }
          return x
        }
      `)
      expect(anchorOffenders(s.anchors, columns.anchor_activities).join(' ')).toContain('phantom_shadow_col')
    })

    it('reports — rather than silently skips — a fixture built by an IMPORTED helper', () => {
      // Red Hat EXP5. The scan root is src/engine/*.test.js, so this guard
      // genuinely cannot read a helper defined in another module. What it must
      // not do is stay quiet about it: the site lands in opaqueSites, and the
      // floor assertion above turns that into a failing test rather than a
      // silent hole.
      const s = scanSynthetic(`
        import { makeAnchor } from './testHelpers.js'
        buildSchedule({ anchors: [makeAnchor()] })
      `)
      expect(s.opaqueSites.join(' ')).toContain('makeAnchor')
      expect(s.anchors).toEqual([])
    })

    it('reports a fixture reached through an identifier declared outside the file', () => {
      const s = scanSynthetic(`import { FIXTURE } from './fixtures.js'\nbuildSchedule({ anchors: FIXTURE })`)
      expect(s.opaqueSites.join(' ')).toContain('FIXTURE')
    })

    it('counts a computed key rather than pretending the fixture was fully read', () => {
      const s = scanSynthetic(`const k = 'phantom'\nconst anchor = { name: 'Lunch', [k]: 1 }`)
      expect(s.computedKeys).toBe(1)
    })

    it('does NOT count an array query over engine output as an unread fixture', () => {
      // `const anchorSlots = slots.filter(...)` matches the slot NAME pattern
      // but holds engine OUTPUT, not an input fixture. Treating it as a blind
      // spot would make the opaque-site floor a nuisance red — the kind a
      // future engineer "fixes" by deleting it.
      const s = scanSynthetic(`const anchorSlots = slots.filter((x) => x.type === 'anchor')`)
      expect(s.opaqueSites).toEqual([])
    })

    it('does NOT fire on a correct fixture — the guard discriminates', () => {
      const s = scanSynthetic(`
        const anchor = { id: 'a1', name: 'Lunch', unit_ids: ['t1'], is_all_groups: 1, time_block_id: 'b1', span_blocks: 1 }
        const preplacedSlots = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'x' }]
      `)
      expect(anchorOffenders(s.anchors, columns.anchor_activities)).toEqual([])
      expect(slotOffenders(s.slots, columns.template_slots)).toEqual([])
      expect(s.anchors.length).toBeGreaterThan(0)
      expect(s.slots.length).toBeGreaterThan(0)
    })
  })

  describe('parity', () => {
    it('every anchor fixture key is a real anchor_activities column (or a listed exemption)', () => {
      expect(anchorOffenders(anchorFixtures, columns.anchor_activities)).toEqual([])
    })

    it('every slot fixture key maps to a real template_slots column (or a listed exemption)', () => {
      expect(slotOffenders(slotFixtures, columns.template_slots)).toEqual([])
    })

    it('every exemption and alias is still accurate — a stale one is a lie about the schema', () => {
      for (const key of Object.keys(ANCHOR_EXEMPT)) {
        expect(columns.anchor_activities.has(key), `anchor exemption "${key}" is now a real column`).toBe(false)
      }
      for (const key of Object.keys(SLOT_EXEMPT)) {
        expect(columns.template_slots.has(key), `slot exemption "${key}" is now a real column`).toBe(false)
      }
      for (const [key, column] of Object.entries(SLOT_KEY_TO_COLUMN)) {
        expect(columns.template_slots.has(column), `slot alias ${key} → "${column}" is not a real column`).toBe(true)
      }
    })
  })
})
