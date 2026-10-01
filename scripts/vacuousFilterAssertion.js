// Catches a test whose ONLY assertion is that a filtered/derived collection
// is empty — e.g. `expect(conflicts.filter(c => !c.resolved)).toHaveLength(0)`.
// That assertion is also trivially true if the mechanism under test never ran
// at all: a renamed field that silently breaks the filter predicate produces
// an empty result the same way a correctly-working system would. A companion
// assertion that proves the positive path was exercised (any other expect())
// is what distinguishes "nothing wrong" from "nothing happened".
//
// Only a plain `it(...)`/`test(...)` call (bare Identifier callee) counts —
// `.each`/`.skip`/`.only`/`.todo` are MemberExpression callees and are
// excluded by construction, not by name-matching them.
//
// STATED LIMITATION (round-1 review): the detector does NOT distinguish two
// different risk shapes that both match "sole assertion is an empty
// .filter() result", and this is why it ships ADVISORY rather than BLOCKING:
//   - a MATCH-finder filter (`filter(f => f.kind === 'X')`, the historical
//     ingest.t267 shape) is dangerously vacuous: it is empty BOTH when the
//     system is correct AND when the mechanism under test never ran at all
//     (e.g. a renamed field silently breaks the predicate, same empty result).
//   - a MISMATCH/parity-guard filter (`filter(x => !otherSet.has(x))`,
//     common in this corpus's entity-parity tests) tends to FAIL LOUD under
//     exactly the rename this ticket is about — a renamed/missing entity
//     shows up as a non-empty `missing`/`extra` array, not a silently-passing
//     empty one — so it is considerably less dangerous than the match-finder
//     shape, even though it has the identical AST shape this detector scans for.
// A finding here is a TRUE match of the narrow pattern, not a verified claim
// that the test is dangerously vacuous; a human (or a future, smarter
// detector) still has to tell the two shapes apart per finding.
//
// Cannot-see, stated rather than hidden:
//   - an empty check on something OTHER than a direct/traced `.filter()` call
//     (e.g. `.map()`, a manually-built array) — narrow on purpose
//   - a companion assertion inside a CALLED HELPER rather than inline in the
//     test body — this only sees expect() calls written directly in the test
//   - a throw-based emptiness check (`expect(() => {...}).not.toThrow()`)
//   - a `.filter()`-derived variable declared in an OUTER block than the
//     expect() that uses it (tracking is per-block, not inherited)

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'acorn'
import { walk } from './astWalk.js'

const finding = (code, message) => ({ code, message })

const TEST_CALL_NAMES = new Set(['it', 'test'])

function isFilterCall(node) {
  return !!node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'filter'
}

function isEmptyArrayLiteral(node) {
  return !!node && node.type === 'ArrayExpression' && node.elements.length === 0
}

/** `expect(x).method(args)` — direct chain only, no `.not` pass-through. */
function matchAssertionCall(node) {
  if (node.type !== 'CallExpression') return null
  const callee = node.callee
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return null
  if (callee.property.type !== 'Identifier') return null
  const inner = callee.object
  if (!inner || inner.type !== 'CallExpression') return null
  if (!inner.callee || inner.callee.type !== 'Identifier' || inner.callee.name !== 'expect') return null
  return { method: callee.property.name, outerArgs: node.arguments, expectArg: inner.arguments[0], node }
}

function isEmptyCheck(assertion) {
  const { method, outerArgs } = assertion
  if (method === 'toHaveLength') {
    return outerArgs[0]?.type === 'Literal' && outerArgs[0].value === 0
  }
  if (method === 'toEqual' || method === 'toStrictEqual') {
    return isEmptyArrayLiteral(outerArgs[0])
  }
  return false
}

function isAbsenceShaped(assertion, filterVars) {
  if (!isEmptyCheck(assertion)) return false
  const { expectArg } = assertion
  if (isFilterCall(expectArg)) return true
  if (expectArg && expectArg.type === 'Identifier' && filterVars.get(expectArg.name)) return true
  return false
}

function recordFilterDeclarations(stmt, map) {
  if (stmt.type !== 'VariableDeclaration') return
  for (const decl of stmt.declarations) {
    if (decl.id.type === 'Identifier' && isFilterCall(decl.init)) {
      map.set(decl.id.name, true)
    }
  }
}

/**
 * Walk a test's body, collecting every assertion found (not descending into
 * nested function/arrow bodies — a `.filter()` predicate's own internals must
 * never be mistaken for the test's own assertions). `.filter()`-declared
 * variables are tracked per BlockStatement, not inherited from an outer one —
 * `filterVars` is the map for the nearest enclosing block, rebuilt fresh every
 * time this function re-enters a BlockStatement.
 */
function collectAssertions(node, assertions, filterVars) {
  if (!node || typeof node.type !== 'string') return
  if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') {
    return // do not descend into a nested function/arrow's own body
  }

  if (node.type === 'BlockStatement') {
    const scoped = new Map()
    for (const stmt of node.body) {
      recordFilterDeclarations(stmt, scoped)
      collectAssertions(stmt, assertions, scoped)
    }
    return
  }

  const assertion = matchAssertionCall(node)
  if (assertion) assertions.push({ assertion, filterVars })

  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) collectAssertions(item, assertions, filterVars)
    } else if (value && typeof value.type === 'string') {
      collectAssertions(value, assertions, filterVars)
    }
  }
}

/** Pure core: scan one already-read test file's text. Abstains on unparseable JS. */
export function scanVacuousFilterAssertionInText(path, text) {
  let ast
  try {
    ast = parse(text, { sourceType: 'module', ecmaVersion: 'latest', locations: true })
  } catch {
    return []
  }

  const findings = []

  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return
    if (node.callee.type !== 'Identifier' || !TEST_CALL_NAMES.has(node.callee.name)) return
    const last = node.arguments[node.arguments.length - 1]
    if (!last || (last.type !== 'FunctionExpression' && last.type !== 'ArrowFunctionExpression')) return
    if (last.body.type !== 'BlockStatement') return

    const assertions = []
    collectAssertions(last.body, assertions, new Map())
    if (!assertions.length) return

    const absenceShaped = assertions.filter(({ assertion, filterVars }) => isAbsenceShaped(assertion, filterVars))
    if (!absenceShaped.length) return
    if (absenceShaped.length !== assertions.length) return // a companion assertion of another shape exists

    const { assertion } = absenceShaped[0]
    const base = assertion.expectArg.type === 'Identifier' ? assertion.expectArg.name : '<filtered>'
    const chainArgs = assertion.method === 'toHaveLength' ? '0' : '[]'
    const chain = `${base}.${assertion.method}(${chainArgs})`
    findings.push(finding('vacuous-filter-assertion',
      `${path}:${node.loc.start.line} — the only assertion in this test is that a filtered/derived ` +
      `collection is empty ('${chain}'); this is also trivially true if the mechanism under test never ` +
      'ran. Add a companion assertion that proves the positive path was exercised.'))
  })

  return findings
}

/** Wrapper over the real filesystem/git — scans the test-file corpus. */
export function checkVacuousFilterAssertion(root, {
  execFn = (cmd) => execSync(cmd, { encoding: 'utf8' }),
  readFn = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const patterns = ["'*.test.js'", "':(glob)test/integration/**/*.js'", "'*.automerge.js'"]
  // Skip silently if git is unavailable, matching every other git-backed check.
  const files = new Set()
  try {
    for (const pattern of patterns) {
      for (const f of execFn(`git -C '${root}' ls-files ${pattern}`).split('\n').filter(Boolean)) {
        files.add(f)
      }
    }
  } catch {
    return []
  }

  const findings = []
  for (const f of files) {
    let text
    try {
      text = readFn(join(root, f))
    } catch {
      continue
    }
    findings.push(...scanVacuousFilterAssertionInText(f, text))
  }
  return findings
}
