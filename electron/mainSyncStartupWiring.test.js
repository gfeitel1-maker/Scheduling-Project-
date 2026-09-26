// T273 — wiring guard for a seam no test can execute.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT.
//
// Proves: the `const initialHandlers = makeHandlers(...)` call site in main.js
// — and only that one — passes an `onCampBootstrapped` option that actually
// CALLS `startAutomergeSyncNodeIfEnabled`. It also pins the full set of
// `makeHandlers(...)` call sites and which of them are wired, so adding a
// fourth, or flipping one, goes red and forces a human decision.
//
// Does NOT prove:
//   - That sync starts after a db swap. `reinitialize()` (main.js:2677) and the
//     backup-restore path (main.js:2917) build handlers WITHOUT the sync
//     getters or `onCampBootstrapped`, deliberately and with the owner's
//     knowledge. A camp bootstrapped after a project switch or a restore still
//     will not sync until the app is restarted. Wiring those correctly also
//     requires stopping and nulling `automergeSyncNode` across the swap, which
//     is the sync-lifecycle redesign T273 explicitly rules out; it is a
//     separate ticket.
//   - That the starter works, or runs at all. `startAutomergeSyncNodeIfEnabled`
//     and this call site both live inside main.js's `isElectronEntryPoint()`
//     block (main.js:2385), which opens with `!process.env.VITEST` — under
//     Vitest it is dead code. Nothing here executes it. main.test.js's
//     behavioural T273 test can only prove bootstrapCamp calls whatever starter
//     it was GIVEN; this file is what proves the real one is given.
//
// Parsed, not string-matched, for the reason T228's authorize.js drift guard
// parses: a match on a literal snippet is satisfied by any text that happens to
// contain it (a comment, a renamed sibling) and broken by reformatting, so it
// both false-greens and false-reds. Precedent for acorn in a repo test:
// src/engine/fixtureSchemaParity.test.js.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js')

// The three names this guard is written against. If any of them is renamed the
// guard goes red and must be updated deliberately — which is the point: a
// rename is exactly the change that would otherwise silently unwire this.
const HANDLERS_VAR = 'initialHandlers'
const OPTION_NAME = 'onCampBootstrapped'
const STARTER_NAME = 'startAutomergeSyncNodeIfEnabled'

// Every `makeHandlers(...)` call site in main.js, and whether it is expected to
// hand the sync starter to bootstrapCamp. `newHandlers` (main.js:2677, the
// reinitialize db swap) and `restoreHandlers` (main.js:2917, backup restore)
// are DELIBERATELY unwired — see the header comment; that gap is owner-recorded
// and belongs to a follow-up ticket, not to T273.
const EXPECTED_CALL_SITES = {
  initialHandlers: true,
  newHandlers: false,
  restoreHandlers: false,
}

function parseMain() {
  return acorn.parse(fs.readFileSync(MAIN_JS, 'utf8'), {
    ecmaVersion: 2023,
    sourceType: 'module',
    locations: true,
  })
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) child.forEach((c) => walk(c, visit))
    else if (child && typeof child.type === 'string') walk(child, visit)
  }
}

function isMakeHandlersCall(node) {
  return (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'makeHandlers'
  )
}

/** Every `const <name> = makeHandlers(...)` in main.js, in source order. */
function findMakeHandlersCallSites(ast) {
  const sites = []
  walk(ast, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      isMakeHandlersCall(node.init)
    ) {
      sites.push({ name: node.id.name, call: node.init, line: node.loc.start.line })
    }
  })
  return sites
}

/** The `onCampBootstrapped` property of a makeHandlers call's options object. */
function onCampBootstrappedProp(call) {
  const options = call.arguments[2]
  if (options?.type !== 'ObjectExpression') return null
  return (
    options.properties.find(
      (p) => p.type === 'Property' && !p.computed && p.key?.name === OPTION_NAME
    ) ?? null
  )
}

/**
 * True when `value` actually INVOKES the starter, or is the starter itself
 * passed by reference as the callback. A mere mention — `const ref = starter`,
 * or the name in a comment-adjacent position — is not enough: that form would
 * satisfy an identifier-presence check while never starting sync.
 */
function invokesStarter(value) {
  if (value?.type === 'Identifier' && value.name === STARTER_NAME) return true
  let called = false
  walk(value, (n) => {
    if (
      n.type === 'CallExpression' &&
      n.callee?.type === 'Identifier' &&
      n.callee.name === STARTER_NAME
    ) {
      called = true
    }
  })
  return called
}

describe('T273 wiring: the real sync starter reaches bootstrapCamp', () => {
  it(`declares exactly one \`const ${HANDLERS_VAR} = makeHandlers(...)\``, () => {
    const matches = findMakeHandlersCallSites(parseMain()).filter((s) => s.name === HANDLERS_VAR)
    expect(
      matches.map((m) => m.line),
      `expected exactly one \`const ${HANDLERS_VAR} = makeHandlers(...)\` in main.js; with more than one, the assertions below silently check whichever came last`
    ).toHaveLength(1)
  })

  it(`passes an ${OPTION_NAME} that CALLS ${STARTER_NAME}`, () => {
    const site = findMakeHandlersCallSites(parseMain()).find((s) => s.name === HANDLERS_VAR)
    expect(site, `no \`const ${HANDLERS_VAR} = makeHandlers(...)\` found in main.js`).toBeTruthy()

    expect(site.call.arguments[2]?.type, 'makeHandlers third argument is not an object literal').toBe(
      'ObjectExpression'
    )

    const prop = onCampBootstrappedProp(site.call)
    expect(
      prop,
      `makeHandlers(${HANDLERS_VAR}) does not pass \`${OPTION_NAME}\` — a camp bootstrapped in this session will not start syncing until restart (T273)`
    ).toBeTruthy()

    expect(
      invokesStarter(prop.value),
      `\`${OPTION_NAME}\` never CALLS \`${STARTER_NAME}\` — merely naming it (e.g. assigning it to a local and returning it) leaves sync stopped until restart (T273)`
    ).toBe(true)
  })

  it('pins the known set of makeHandlers call sites and which are wired for sync', () => {
    const ast = parseMain()
    const sites = findMakeHandlersCallSites(ast)

    // A makeHandlers(...) not assigned to a plain identifier would escape the
    // map below entirely, so count the raw calls too.
    let rawCalls = 0
    walk(ast, (n) => {
      if (isMakeHandlersCall(n)) rawCalls += 1
    })
    expect(
      rawCalls,
      'a makeHandlers(...) call is not a `const <name> = makeHandlers(...)`, so this guard cannot classify it — give it a name or extend this guard deliberately'
    ).toBe(sites.length)

    const actual = Object.fromEntries(
      sites.map((s) => {
        const prop = onCampBootstrappedProp(s.call)
        return [s.name, Boolean(prop && invokesStarter(prop.value))]
      })
    )

    expect(
      actual,
      [
        'The set of makeHandlers(...) call sites in main.js, or which of them start sync, has changed.',
        'Decide deliberately, do not just update this expectation:',
        `  - A NEW call site: does a camp bootstrapped through it need to start syncing? If yes it needs \`${OPTION_NAME}\`; if no, say why here.`,
        `  - \`newHandlers\` (main.js:2677) or \`restoreHandlers\` (main.js:2917) now WIRED: those are db-swap paths. Wiring them is only correct alongside stopping and nulling \`automergeSyncNode\` across the swap — otherwise the old camp's node keeps running. That is the follow-up ticket, not T273.`,
        `  - \`${HANDLERS_VAR}\` now UNWIRED: that is the T273 regression this file exists to catch.`,
      ].join('\n')
    ).toEqual(EXPECTED_CALL_SITES)
  })

  it('declares onCampBootstrapped in makeHandlers own options destructuring', () => {
    let params = null
    walk(parseMain(), (node) => {
      if (
        (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') &&
        node.id?.name === 'makeHandlers'
      ) {
        params = node.params
      }
    })
    expect(params, 'makeHandlers declaration not found').toBeTruthy()

    const optionsParam = params[2]
    const pattern = optionsParam?.type === 'AssignmentPattern' ? optionsParam.left : optionsParam
    expect(pattern?.type, 'makeHandlers third parameter is not destructured').toBe('ObjectPattern')

    const declared = pattern.properties.some(
      (p) => p.type === 'Property' && !p.computed && p.key?.name === OPTION_NAME
    )
    expect(declared, `makeHandlers does not accept \`${OPTION_NAME}\``).toBe(true)
  })
})
