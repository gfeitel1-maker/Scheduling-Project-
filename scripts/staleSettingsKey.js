// Catches the "wide rename, lookup silently returns nothing" class (#696): a
// curated engine function reads its settings object by key, a rename changes
// what it reads, and a call site that still passes the OLD key is not a
// syntax error — the function simply never sees that value. This shipped
// five times in one rename (T293 anchors -> fixed/recurring events).
//
// The registry below is HAND-MAINTAINED and must be re-verified against the
// real source whenever either callee's contract changes — this check cannot
// derive the key set itself (that would mean re-implementing each callee's
// own destructuring/normalization logic, which is the blind spot
// test-helper-reimplements-the-code-under-test already names for test
// fixtures and applies equally here).
//
//   - findRouteConflicts: destructured directly in its signature —
//     src/engine/routeConflicts.js, `export function findRouteConflicts({ slots,
//     activities, fixedEvents, electiveSetActivities, events, locations })`.
//   - buildSchedule: takes one opaque `input` then calls `normalizeInput(input)`
//     (src/engine/buildSchedule.js). The real contract is every `input.<key>`
//     read across BOTH branches of normalizeInput — the UNION, since a caller
//     may take either branch depending on whether it passes `cohorts`.
//
// SOUNDNESS OVER COVERAGE. A call site this cannot reason about safely must
// ABSTAIN (push nothing) rather than guess:
//   - a spread property (`...inputs`) — the real keys may come from the spread,
//     invisible to a syntactic scan — abstains the ENTIRE call site.
//   - a computed key (`[dynamicKey]: 1`) — same reason, whole call abstains.
//   - the argument is not an object literal at the call site (a variable, a
//     function call result) — this check only sees literals written AT the
//     call, not what a variable holds.
//
// Cannot-see, stated rather than hidden:
//   - any callee not in SETTINGS_CALLEE_REGISTRY (narrow by design — a false
//     positive on an uncurated callee is worse than missing it)
//   - an indirect call target (`const fn = buildSchedule; fn(...)`, a method
//     access like `obj.buildSchedule(...)`)
//   - a stale registry — if either source changes and this file is not
//     updated, every call site is silently checked against the WRONG keys

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'acorn'
import { walk } from './astWalk.js'

export const SETTINGS_CALLEE_REGISTRY = {
  findRouteConflicts: {
    source: 'src/engine/routeConflicts.js',
    keys: new Set(['slots', 'activities', 'fixedEvents', 'electiveSetActivities', 'events', 'locations']),
  },
  buildSchedule: {
    source: 'src/engine/buildSchedule.js',
    // Union of both normalizeInput branches (confirmed 2026-10-01 against the
    // current source — re-confirm this set whenever normalizeInput changes).
    keys: new Set([
      'cohorts', 'days', 'activities', 'campId', 'locations', 'electiveSetActivities',
      'events', 'fixedEventsOnly', 'weekId',
      'timeBlocks', 'tiers', 'groups', 'preplacedSlots', 'fixedEvents',
    ]),
  },
}

const finding = (code, message) => ({ code, message })

function propertyKeyName(prop) {
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return undefined // an unusual key shape (e.g. numeric literal) — treat as unresolved below
}

/**
 * Pure core: scan one file's already-read text for calls to a curated callee
 * with an inline object-literal argument whose keys do not match the
 * registry. Never throws on a file acorn cannot parse — an unparseable file
 * (not valid ES module JS) abstains silently, same reasoning as every other
 * per-file abstention here.
 */
export function scanStaleSettingsKeysInText(path, text) {
  let ast
  try {
    ast = parse(text, { sourceType: 'module', ecmaVersion: 'latest', locations: true })
  } catch {
    return []
  }

  const findings = []

  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return
    if (node.callee.type !== 'Identifier') return
    const entry = SETTINGS_CALLEE_REGISTRY[node.callee.name]
    if (!entry) return
    if (node.arguments.length !== 1) return
    const arg = node.arguments[0]
    if (arg.type !== 'ObjectExpression') return

    // First pass: any property this cannot reason about safely abstains the
    // WHOLE call site — never a partial report built from the props we could
    // resolve plus silence on the ones we could not.
    const names = []
    for (const prop of arg.properties) {
      if (prop.type === 'SpreadElement') return
      if (prop.computed) return
      const name = propertyKeyName(prop)
      if (name === undefined) return
      names.push(name)
    }

    for (const name of names) {
      if (!entry.keys.has(name)) {
        findings.push(finding('stale-settings-key',
          `${path}:${node.loc.start.line} passes key '${name}' to ${node.callee.name}() but ` +
          `${node.callee.name}'s settings object does not read that key (see ${entry.source}) — ` +
          'check for a rename'))
      }
    }
  })

  return findings
}

/** Wrapper over the real filesystem/git — scans every tracked *.js file. */
export function checkStaleSettingsKey(root, {
  execFn = (cmd) => execSync(cmd, { encoding: 'utf8' }),
  readFn = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const files = execFn(`git -C '${root}' ls-files '*.js'`).split('\n').filter(Boolean)
  const findings = []
  for (const f of files) {
    let text
    try {
      text = readFn(join(root, f))
    } catch {
      continue
    }
    findings.push(...scanStaleSettingsKeysInText(f, text))
  }
  return findings
}
