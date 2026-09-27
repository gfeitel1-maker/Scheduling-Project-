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
//   - That the starter works, or runs at all — from THIS file. The
//     `startAutomergeSyncNodeIfEnabled` name in main.js is now a one-line
//     wrapper (`() => syncStarter.start()`) still declared inside
//     `isElectronEntryPoint()`'s `!process.env.VITEST`-gated block, so main.js
//     itself is never imported under Vitest and this file's own AST parsing
//     still cannot execute it. T276 discharged the actual behavioural gap:
//     the wrapper's real logic was extracted to
//     electron/sync/automerge/syncStarter.js's `createAutomergeSyncStarter`,
//     which IS executed under Vitest — see syncStarter.test.js for the
//     concurrency (TOCTOU latch) and funnel-guard proofs that used to be
//     AST-only, further down in this file. main.test.js's behavioural T273
//     test can only prove bootstrapCamp calls whatever starter it was GIVEN;
//     this file is what proves the real one is given.
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
// T274 — the join-path mirror of onCampBootstrapped. Same starter, same
// call site, a different hook because a joined camp materializes through
// joinAwaitData rather than bootstrapCamp.
const OPTION_NAME_JOINED = 'onCampJoined'

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
// T274 — the same set of call sites, for the join-path hook. Identical
// expectations to EXPECTED_CALL_SITES: only the one true startup site wires
// it, and the two db-swap sites stay unwired for the same reason (T274 is
// explicitly out of scope for the db-swap lifecycle redesign).
const EXPECTED_CALL_SITES_JOINED = {
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

/** The named property (e.g. `onCampBootstrapped`/`onCampJoined`) of a makeHandlers call's options object. */
function optionProp(call, optionName) {
  const options = call.arguments[2]
  if (options?.type !== 'ObjectExpression') return null
  return (
    options.properties.find(
      (p) => p.type === 'Property' && !p.computed && p.key?.name === optionName
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

    const prop = optionProp(site.call, OPTION_NAME)
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
        const prop = optionProp(s.call, OPTION_NAME)
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
    expect(makeHandlersDeclaresOption(OPTION_NAME), `makeHandlers does not accept \`${OPTION_NAME}\``).toBe(true)
  })
})

/** Whether makeHandlers' own (third parameter) options destructuring declares `optionName`. */
function makeHandlersDeclaresOption(optionName) {
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

  return pattern.properties.some(
    (p) => p.type === 'Property' && !p.computed && p.key?.name === optionName
  )
}

// T274 — the join-path mirror of the T273 block above. Same three
// invariants (exactly one call site wired, the wired set pinned, the option
// declared on makeHandlers), against `onCampJoined` instead of
// `onCampBootstrapped`. A joined camp materializes through joinAwaitData, not
// bootstrapCamp, so it needs its own hook — but the same starter, the same
// one true call site, and the same db-swap exclusion.
describe('T274 wiring: the real sync starter reaches joinAwaitData', () => {
  it(`passes an ${OPTION_NAME_JOINED} that CALLS ${STARTER_NAME}`, () => {
    const site = findMakeHandlersCallSites(parseMain()).find((s) => s.name === HANDLERS_VAR)
    expect(site, `no \`const ${HANDLERS_VAR} = makeHandlers(...)\` found in main.js`).toBeTruthy()

    expect(site.call.arguments[2]?.type, 'makeHandlers third argument is not an object literal').toBe(
      'ObjectExpression'
    )

    const prop = optionProp(site.call, OPTION_NAME_JOINED)
    expect(
      prop,
      `makeHandlers(${HANDLERS_VAR}) does not pass \`${OPTION_NAME_JOINED}\` — a device that joins a camp in this session will not start syncing until restart (T274)`
    ).toBeTruthy()

    expect(
      invokesStarter(prop.value),
      `\`${OPTION_NAME_JOINED}\` never CALLS \`${STARTER_NAME}\` — merely naming it leaves sync stopped until restart (T274)`
    ).toBe(true)
  })

  it('pins the known set of makeHandlers call sites and which are wired for the join hook', () => {
    const ast = parseMain()
    const sites = findMakeHandlersCallSites(ast)

    const actual = Object.fromEntries(
      sites.map((s) => {
        const prop = optionProp(s.call, OPTION_NAME_JOINED)
        return [s.name, Boolean(prop && invokesStarter(prop.value))]
      })
    )

    expect(
      actual,
      [
        'The set of makeHandlers(...) call sites in main.js, or which of them start sync on join, has changed.',
        'Decide deliberately, do not just update this expectation:',
        `  - A NEW call site: does a camp joined through it need to start syncing? If yes it needs \`${OPTION_NAME_JOINED}\`; if no, say why here.`,
        `  - \`newHandlers\` (main.js:2677) or \`restoreHandlers\` (main.js:2917) now WIRED: those are db-swap paths, deliberately excluded by T274 too — see the header comment.`,
        `  - \`${HANDLERS_VAR}\` now UNWIRED: that is the T274 regression this file exists to catch.`,
      ].join('\n')
    ).toEqual(EXPECTED_CALL_SITES_JOINED)
  })

  it('declares onCampJoined in makeHandlers own options destructuring', () => {
    expect(makeHandlersDeclaresOption(OPTION_NAME_JOINED), `makeHandlers does not accept \`${OPTION_NAME_JOINED}\``).toBe(true)
  })
})

// T276 — the synchronous in-flight latch and the funnel-guard EXECUTION
// ORDER (both formerly asserted here on AST shape, because
// startAutomergeSyncNodeIfEnabled lived inside main.js's
// `!process.env.VITEST`-gated block and could not be executed under Vitest
// at all) are now proven as EXECUTED behaviour in
// electron/sync/automerge/syncStarter.test.js, against the extracted
// `createAutomergeSyncStarter`'s real `start()` — a real concurrent-call
// test for the latch, and a real "guard refuses / non-vacuity guard admits"
// pair for the funnel guard. Those two AST-only describe blocks are retired
// here rather than kept redundant. `makeHandlers` itself, and its
// `hasRetainedJoinSession` predicate, still live in main.js (never imported
// under Vitest — see this file's header comment), so the structural check
// that makeHandlers exposes that predicate remains below.
const RETAINED_JOIN_PREDICATE = 'hasRetainedJoinSession'

describe('T274 final: makeHandlers still exposes the funnel guard predicate', () => {
  it(`makeHandlers exposes ${RETAINED_JOIN_PREDICATE} on its returned handlers object`, () => {
    let returnObj = null
    walk(parseMain(), (node) => {
      if (
        (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') &&
        node.id?.name === 'makeHandlers'
      ) {
        walk(node.body, (n) => {
          if (n.type === 'ReturnStatement' && n.argument?.type === 'ObjectExpression') {
            returnObj = n.argument
          }
        })
      }
    })
    expect(returnObj, 'makeHandlers return object not found').toBeTruthy()
    const declared = returnObj.properties.some(
      (p) => p.type === 'Property' && !p.computed && p.key?.name === RETAINED_JOIN_PREDICATE
    )
    expect(declared, `makeHandlers' return object does not expose \`${RETAINED_JOIN_PREDICATE}\``).toBe(true)
  })
})
