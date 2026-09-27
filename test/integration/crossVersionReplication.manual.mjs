/**
 * Cross-version replication evidence (T215/T217, "the owner's product
 * requirement, his words: 'i would like for laptops to talk to one another
 * no matter what upgrades are happening'").
 *
 * WHY THIS EXISTS. Protocol IDs (/noise, /yamux/1.0.0, /multistream/1.0.0,
 * /ipfs/id/1.0.0) are byte-identical across the libp2p major and structurally
 * must be, being shared with go-/rust-libp2p — so two differently-versioned
 * nodes WILL connect and identify each other. That is not evidence that a
 * camp's document actually replicates, because Yamux's initial window size is
 * negotiated IN-BAND, after protocol selection, and sits underneath the
 * protocol-ID argument entirely. "Connects, then misbehaves once data moves"
 * is exactly what a connect-only test cannot see. This test therefore drives
 * REAL Automerge document writes across the wire — a small write (fits in any
 * window) and a 2 MiB write (forces at least one Yamux window-update round
 * trip past the 256 KiB default) — in BOTH directions, and asserts the data
 * actually lands in the receiving side's projected SQLite row. See
 * crossVersionRunner.js for the mechanics.
 *
 * WHY TWO PROCESSES. A camp's devices do not upgrade together, so the
 * scenario under test is genuinely two different `npm ci`'d installs of this
 * codebase talking to each other. Two different resolved libp2p majors cannot
 * both be `require`d into one Node process, so this spawns one `node` process
 * per side, each running crossVersionRunner.js from ITS OWN checkout's
 * node_modules, exchanging only a multiaddr string and a campId through two
 * small JSON handoff files on disk (loopback, one machine — see harnessAutomerge.js's
 * setupTwoJoinedDevices doc comment on what this technique will and will not
 * cover for a real two-machine LAN).
 *
 * WHY THIS IS NOT PART OF `npm run test` / `npm run verify`. It needs a
 * second checkout of this repo pinned to an older commit, with its own
 * `npm ci` already run (minutes, not seconds) — that is evidence-gathering
 * infrastructure, not a gate every commit should pay for, and CI has no such
 * second checkout lying around. Run it by hand when a libp2p major bump (or
 * this product requirement) needs re-checking:
 *
 *   git worktree add /tmp/shoresh-libp2p-210 08e971b   # pinned: libp2p 2.10.0
 *   (cd /tmp/shoresh-libp2p-210 && npm ci)
 *   SHORESH_XVER_OLD_TREE=/tmp/shoresh-libp2p-210 node test/integration/crossVersionReplication.manual.mjs
 *
 * Direction: the OLD tree (libp2p 2.10.0, commit 08e971b) plays the Host — an
 * already-running camp nobody has upgraded yet — and the CURRENT tree plays
 * the joining Client, modeling the real sequence (a camp is running on
 * whatever it's running, then one device updates and talks to it). The
 * transport is symmetric by protocol-ID design, so the reverse direction is
 * not expected to differ; that expectation itself is exactly what this test
 * exists to check rather than assume, and re-running with the roles swapped
 * is one line if that assumption is ever doubted.
 *
 * STATUS AS OF 2026-09-18 (T215/T217): INCONCLUSIVE, not because the test is
 * wrong but because this shared dev machine could not sustain the
 * measurement — recorded here so the next run doesn't have to rediscover it.
 *
 *   - A real bug WAS found and fixed in this test's OWN harness on the way
 *     here: approving the join the instant the `onPairingRequest` notification
 *     fires (zero human delay) can race authGate.js's own bookkeeping — the
 *     notification callback fires DURING request handling, before the
 *     `pairing_pending` reply is sent and `pendingPairingPeers` is populated,
 *     so an approval issued in that same tick finds no peer to dial back to.
 *     A real director reading a name off a screen is far slower than that
 *     window; the fix (crossVersionRunner.js's runHost) is a short pause
 *     standing in for that human, not a workaround for a product defect.
 *
 *   - With that fixed, pairing and PIN login DID complete successfully
 *     end-to-end across libp2p 2.10.0 <-> 3.3.11 on more than one run —
 *     `auth_ok`, the Host admitting the joining peer, and a signed camp
 *     token all worked across the version boundary.
 *
 *   - But `waitForCamp()` (the actual document arriving) then failed to
 *     complete, AND — this is the reason for "inconclusive" rather than
 *     "fails" — a control run with BOTH sides on the SAME version
 *     (SHORESH_XVER_OLD_TREE pointed at this same checkout) reproduced the
 *     identical hang at the identical step (the post-login `authenticate`
 *     round trip, or the document wait right after it). A same-version
 *     control failing the same way rules out "libp2p 2.10 and 3.3.11 can't
 *     talk" as the explanation for THAT failure — something about running
 *     two real libp2p nodes as two separate OS processes on this specific
 *     machine, under whatever else is running on it, does not reliably
 *     complete a stream round trip within DRAIN_TIMEOUT_MS (30s). Real mDNS
 *     noise from unrelated peers was visible on every run
 *     (`mutualAuth: peer ... rejected our authenticate`, a peer id matching
 *     neither side of this test), consistent with this repo's own documented
 *     "mDNS flake under load" (multiple concurrent agent sessions on one
 *     machine each running their own libp2p integration tests) rather than a
 *     protocol incompatibility.
 *
 *   - Net effect: the pairing/login/admission path has a positive
 *     cross-version result on this evidence; the document-replication path
 *     (the actual point of this test, and the reason a connect-only check
 *     was rejected — see the header above) has NOT been cleanly measured yet.
 *     Re-run this on a quiet machine (or one with real multicast confirmed
 *     working and no concurrent agent sessions) before treating either
 *     outcome as settled. Do not "fix" the hang by loosening
 *     DRAIN_TIMEOUT_MS or disabling mDNS as a reflex — first confirm on a
 *     quiet machine that the hang goes away; only then is it known to be
 *     environmental rather than product.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const CURRENT_TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OLD_TREE = process.env.SHORESH_XVER_OLD_TREE

if (!OLD_TREE) {
  console.log('SKIPPED (inconclusive): SHORESH_XVER_OLD_TREE is not set.')
  console.log('This test needs a second checkout pinned at 08e971b (libp2p 2.10.0) with npm ci already run.')
  console.log('See this file\'s header comment for the exact commands.')
  process.exit(0)
}
if (!fs.existsSync(OLD_TREE)) {
  console.error(`SHORESH_XVER_OLD_TREE does not exist: ${OLD_TREE}`)
  process.exit(1)
}

function resolvedVersion(treeDir, pkg) {
  return JSON.parse(fs.readFileSync(path.join(treeDir, 'node_modules', pkg, 'package.json'), 'utf8')).version
}

const currentLibp2pVersion = resolvedVersion(CURRENT_TREE, 'libp2p')
const oldLibp2pVersion = resolvedVersion(OLD_TREE, 'libp2p')
console.log(`Current tree libp2p: ${currentLibp2pVersion}`)
console.log(`Old tree (08e971b) libp2p: ${oldLibp2pVersion}`)
if (currentLibp2pVersion === oldLibp2pVersion) {
  console.error('Both trees resolved the SAME libp2p version — this proves nothing about cross-version replication. Aborting.')
  process.exit(1)
}

const runnerSrc = fs.readFileSync(path.join(CURRENT_TREE, 'test/integration/crossVersionRunner.js'), 'utf8')
const oldRunnerPath = path.join(OLD_TREE, 'test/integration/__crossVersionRunner.tmp.js')
fs.writeFileSync(oldRunnerPath, runnerSrc)

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-xver-'))
const handoffPath = path.join(workDir, 'handoff.json')
const hostResultPath = path.join(workDir, 'host-result.json')
const clientResultPath = path.join(workDir, 'client-result.json')

const liveChildren = new Set()

function spawnRole({ cwd, runnerPath, role, resultPath, label }) {
  const child = spawn(process.execPath, [runnerPath, role, handoffPath, resultPath], { cwd })
  liveChildren.add(child)
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`))
  return new Promise((resolve) => {
    child.on('exit', (code) => { liveChildren.delete(child); resolve(code) })
  })
}

// A timed-out promise here is a hung libp2p node, not a finished process — if
// we merely stop awaiting it, the child keeps running, keeps its sockets and
// mDNS registration open, and confuses the NEXT run (exactly what happened
// the first time this was written: a leaked host process from a killed run
// answered a later run's join request under the wrong identity). SIGKILL
// every live child before reporting the timeout.
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), ms)
  })
  return Promise.race([promise.then((v) => { clearTimeout(timer); return v }), timeout]).then((v) => {
    if (v === 'TIMEOUT') {
      console.error(`${label} timed out`)
      for (const child of liveChildren) child.kill('SIGKILL')
    }
    return v
  })
}

async function main() {
  console.log('Spawning Host on OLD tree (libp2p ' + oldLibp2pVersion + ')...')
  console.log('Spawning Client on CURRENT tree (libp2p ' + currentLibp2pVersion + ')...')

  const hostPromise = withTimeout(
    spawnRole({ cwd: OLD_TREE, runnerPath: oldRunnerPath, role: 'host', resultPath: hostResultPath, label: 'HOST(old)' }),
    90000, 'HOST'
  )
  const clientPromise = withTimeout(
    spawnRole({
      cwd: CURRENT_TREE,
      runnerPath: path.join(CURRENT_TREE, 'test/integration/crossVersionRunner.js'),
      role: 'client', resultPath: clientResultPath, label: 'CLIENT(new)',
    }),
    90000, 'CLIENT'
  )

  const [hostExit, clientExit] = await Promise.all([hostPromise, clientPromise])

  const hostResult = fs.existsSync(hostResultPath) ? JSON.parse(fs.readFileSync(hostResultPath, 'utf8')) : null
  const clientResult = fs.existsSync(clientResultPath) ? JSON.parse(fs.readFileSync(clientResultPath, 'utf8')) : null

  console.log('\n--- RESULTS ---')
  console.log('host exit code:', hostExit, JSON.stringify(hostResult))
  console.log('client exit code:', clientExit, JSON.stringify(clientResult))

  try { fs.unlinkSync(oldRunnerPath) } catch { /* ignore */ }
  fs.rmSync(workDir, { recursive: true, force: true })

  const ok = hostResult?.status === 'ok' && clientResult?.status === 'ok' &&
    hostResult.receivedSmallOk && hostResult.receivedLargeOk &&
    clientResult.receivedSmallOk && clientResult.receivedLargeOk

  if (ok) {
    console.log('\nPASS: document data replicated in both directions, including the >256KiB payload that forces a Yamux window update, across libp2p ' +
      oldLibp2pVersion + ' <-> ' + currentLibp2pVersion + '.')
    process.exit(0)
  } else {
    console.log('\nFAIL: cross-version replication did not complete as expected. See host/client results above for which side/payload failed.')
    process.exit(1)
  }
}

main()
