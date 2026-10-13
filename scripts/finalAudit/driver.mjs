// Final-audit driver for the PACKAGED Shoresh app over CDP: one instance on a throwaway userData
// ($TMPDIR/shoresh-pkg-smoke-*, the only userData a packaged build will take from the environment),
// a screenshot and one PASS/FAIL line per step. Steps are in steps.mjs.
//
//   node scripts/finalAudit/driver.mjs --app=release/mac/Shoresh.app/Contents/MacOS/Shoresh [--port=9336] [--only=1,5] [--keep]
//
// Run from the repo root (the sample files are read from it; --repo= overrides). The app gets a renderer
// debugging port (--port) and a main-process inspector on port+1, used only to route downloads to the
// run folder so an export never opens a native save dialog. Output: $TMPDIR/shoresh-final-audit/run-*
// (run.log, results.json, shots/, downloads/). --keep leaves the app running for inspection.
// Light by design: one app instance, no build, no test suite.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connect } from './cdp.mjs'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).slice(k.length + 3)
const PORT = Number(arg('port', 9444))
const APP = path.resolve(arg('app', 'release/mac/Shoresh.app/Contents/MacOS/Shoresh'))
const REPO = path.resolve(arg('repo', process.cwd()))
const CAMPB = path.join(REPO, 'docs/work/specs/samples/campB-by-day.txt')
const RUN = path.join(fs.realpathSync(os.tmpdir()), 'shoresh-final-audit', `run-${Date.now().toString(36)}`)
const SHOTS = path.join(RUN, 'shots'); const DL = path.join(RUN, 'downloads')
const UD = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shoresh-pkg-smoke-'))
const CAMP = 'Audit Camp', ADMIN = 'Audit Admin', PIN = '482913'
fs.mkdirSync(SHOTS, { recursive: true }); fs.mkdirSync(DL, { recursive: true })
const LOG = path.join(RUN, 'run.log')
const T0 = Date.now()
const log = (...a) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${a.join(' ')}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HELPERS = `
window.__vis=(e)=>e&&e.offsetParent!==null;
window.__btn=(t,exact)=>[...document.querySelectorAll('button,[role=button],[role=menuitem],[role=tab],a')].filter(__vis).filter(b=>{const s=b.innerText.trim();const last=s.split('\\n').pop().trim();return exact?(s===t||last===t):s.startsWith(t)}).sort((a,b)=>a.innerText.length-b.innerText.length)[0];
window.__click=(t,exact)=>{const b=__btn(t,exact);if(!b||b.disabled)return false;b.click();return true};
window.__set=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
window.__inp=(sel)=>[...document.querySelectorAll(sel)].filter(__vis)[0];
window.__main=()=>{const t=document.body.innerText;const i=t.indexOf('Log out');return i>=0?t.slice(i+7):t};
true`

let app = null, pid = null, BUILD_SHA = null
const results = []

function launch() {
  const out = fs.openSync(path.join(RUN, 'app.log'), 'a')
  const p = spawn(APP, [`--remote-debugging-port=${PORT}`, `--inspect=${PORT + 1}`], { env: { ...process.env, SHORESH_SMOKE_USERDATA: UD }, detached: true, stdio: ['ignore', out, out] })
  p.unref(); pid = p.pid
  log(`launched pid=${pid} port=${PORT} userData=${UD}`)
}
// The main process (inspector on PORT+1): route every download to DL, so an export never opens a
// native save dialog (which CDP cannot see or close). Driver-side only; no product change.
async function mainEval(expr) {
  const t0 = Date.now(); let t
  while (!t && Date.now() - t0 < 30000) { try { [t] = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json() } catch { await sleep(500) } }
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  return new Promise((res, rej) => {
    const tm = setTimeout(() => rej(new Error('main eval timeout')), 20000)
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(tm); ws.close(); d.result?.exceptionDetails ? rej(new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 300))) : res(d.result?.result?.value) } }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, includeCommandLineAPI: true } }))
  })
}
async function routeDownloads() {
  return mainEval(`(()=>{const r=process.getBuiltinModule('module').createRequire('/x.js'); const {session}=r('electron'); const s=session.defaultSession; if(globalThis.__dlHooked) return 'already'; globalThis.__dlHooked=1; s.on('will-download',(e,item)=>{ item.setSavePath(r('path').join(${JSON.stringify(DL)}, Date.now()+'-'+item.getFilename())) }); return 'hooked'})()`)
}
async function attach() { app = await connect(PORT, 120000); await app.send('Page.enable').catch(() => {}); try { log('downloads: ' + await routeDownloads()) } catch (e) { log('downloads hook failed: ' + e.message) } return app }
// ev/text/waitFor/click for one CDP connection; the main app's are below, extra peers get their own (launchPeer).
function ctxFor(conn) {
  const cev = async (expr, to = 20000) => { await conn().evaluate(HELPERS, to, false); return conn().evaluate(`(async()=>{${expr}})()`, to, false) }
  const ctext = async () => { try { return await cev('return __main()', 10000) } catch (e) { return `<unreadable: ${e.message}>` } }
  const cwait = async (expr, timeout, what) => {
    const t = Date.now(); let last
    while (Date.now() - t < timeout) {
      try { const v = await cev(expr, 15000); if (v) return v } catch (e) { last = e.message }
      await sleep(700)
    }
    const seen = (await ctext()).replace(/\s+/g, ' ').slice(0, 700)
    throw new Error(`timed out after ${timeout / 1000}s waiting for ${what}${last ? ` (last error: ${last})` : ''}. Screen: "${seen}"`)
  }
  const cclick = (label, exact = true, timeout = 20000) => cwait(`return __click(${JSON.stringify(label)}, ${exact})`, timeout, `"${label}"`)
  return { ev: cev, text: ctext, waitFor: cwait, click: cclick, nav: async (label) => { await cclick(label, true, 20000); await sleep(800) } }
}
async function ev(expr, to = 20000) { await app.evaluate(HELPERS, to, false); return app.evaluate(`(async()=>{${expr}})()`, to, false) }
async function text() { try { return await ev('return __main()', 10000) } catch (e) { return `<unreadable: ${e.message}>` } }
async function waitFor(expr, timeout, what) {
  const t = Date.now(); let last
  while (Date.now() - t < timeout) {
    try { const v = await ev(expr, 15000); if (v) return v } catch (e) { last = e.message }
    await sleep(700)
  }
  const seen = (await text()).replace(/\s+/g, ' ').slice(0, 700)
  throw new Error(`timed out after ${timeout / 1000}s waiting for ${what}${last ? ` (last error: ${last})` : ''}. Screen: "${seen}"`)
}
const click = (label, exact = true, timeout = 20000) => waitFor(`return __click(${JSON.stringify(label)}, ${exact})`, timeout, `"${label}"`)
async function shot(label) {
  const f = path.join(SHOTS, `${String(results.length + 1).padStart(2, '0')}-${label}.png`)
  try { await app.shot(f) } catch (e) { log(`  screenshot failed: ${e.message}`) }
  return path.basename(f)
}
async function setFile(file) {
  await waitFor(`return !!document.querySelector('input[type=file]')`, 20000, 'file input')
  const { root } = await app.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await app.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
  await app.send('DOM.setFileInputFiles', { nodeId, files: [file] })
}
async function nav(label) { await click(label, true, 20000); await sleep(800) }

const ONLY = arg('only', '') ? new Set(arg('only', '').split(',')) : null
async function step(id, title, fn) {
  // Launch (0) and the fresh camp (1a) are prerequisites of every step, so --only always runs them.
  if (ONLY && !ONLY.has(String(id).replace(/[a-z]$/, '')) && !['0', '1a'].includes(String(id))) return true
  const t = Date.now(); let status = 'PASS', note = ''
  log(`STEP ${id} ${title}`)
  // A step throws { skip } when its feature is not in the build under test (featureIn).
  try { note = (await fn()) || '' } catch (e) { if (e?.skip) { status = 'SKIP'; note = e.skip } else { status = 'FAIL'; note = e.message } }
  const files = app ? [await shot(`s${id}`)] : []
  results.push({ id, title, status, ms: Date.now() - t, note: String(note), shots: files })
  log(`  -> ${status} (${((Date.now() - t) / 1000).toFixed(1)}s) ${String(note).slice(0, 600)}`)
  return status === 'PASS'
}


async function signInIfAsked() {
  return ev(`if(__inp('#login-name')&&!window.__relogin){ window.__relogin=1; __set(__inp('#login-name'), ${JSON.stringify(ADMIN)}); __set(__inp('#login-pin'), ${JSON.stringify(PIN)}); setTimeout(()=>__click('Sign in', true),300) } return true`)
}

// Two drivers on one port drive the SAME app and read each other's state, so a port that is
// already answering is refused rather than shared.
async function portBusy(p) {
  const net = await import('node:net')
  return new Promise((res) => { const c = net.connect(p, '127.0.0.1'); c.once('connect', () => { c.destroy(); res(true) }); c.once('error', () => res(false)) })
}

async function main() {
  fs.writeFileSync(LOG, `run ${new Date().toISOString()} app=${APP}\n`)
  for (const p of [PORT, PORT + 1]) if (await portBusy(p)) { log(`port ${p} is already in use (another driver or app?); refusing to start. Pass a free --port=.`); process.exit(2) }
  launch(); await attach()
  await step(0, 'Launch: reaches mode-select on an empty userData', async () => {
    await waitFor(`return document.body.innerText.includes('Start a new camp')`, 120000, 'mode-select')
  })
  await step('1a', `Fresh camp "${CAMP}"`, async () => {
    await click('Start a new camp', false)
    await waitFor(`const n=document.getElementById('bootstrap-camp-name'); if(!n) return false; __set(n, ${JSON.stringify(CAMP)}); __set(document.getElementById('bootstrap-admin-name'), ${JSON.stringify(ADMIN)}); __set(document.getElementById('bootstrap-admin-pin'), ${JSON.stringify(PIN)}); return true`, 10000, 'bootstrap form')
    await sleep(300); await click('Create camp')
    await waitFor(`return document.body.innerText.includes('Log out') && document.body.innerText.includes(${JSON.stringify(CAMP)})`, 60000, 'shell with camp name')
    const build = await ev(`return (document.body.innerText.match(/v\\d+\\.\\d+\\.\\d+ · [0-9a-f]{7,} · [0-9-]+/)||['?'])[0]`)
    BUILD_SHA = (build.match(/· ([0-9a-f]{7,}) ·/) || [])[1] || null
    return 'build ' + build
  })
  await (await import('./steps.mjs')).run({ step, ev, waitFor, click, nav, text, shot, setFile, sleep, log, app: () => app, CAMPB, DL, RUN, relaunch, adopt, launchPeer, quitMain, FORCE: new Set(arg('force', '').split(',').filter(Boolean)), ADMIN, PIN, signInIfAsked, UD, REPO, PORT, buildSha: () => BUILD_SHA })
  finish()
}

async function relaunch() {
  const t = Date.now(); process.kill(pid, 'SIGTERM'); try { app.close() } catch {}
  let alive = true
  while (Date.now() - t < 30000) { try { process.kill(pid, 0) } catch { alive = false; break } await sleep(250) }
  const exitMs = Date.now() - t
  if (alive) throw new Error(`pid ${pid} still alive 30s after SIGTERM`)
  launch(); await attach()
  return exitMs
}

// The app restarted ITSELF (app.relaunch keeps argv, so the new process has the same debugging
// port): wait for the old pid to exit, find the new one by that port argument, and re-attach.
// The pattern goes after `--`: one starting with "--remote…" is read by pgrep as an option and never matches, and
// the binary name keeps it off the renderer helpers, whose arguments carry the same port.
async function adopt(timeoutMs = 120000) {
  const t = Date.now(); try { app.close() } catch {}
  while (Date.now() - t < timeoutMs) { try { process.kill(pid, 0) } catch { break } await sleep(250) }
  const { execFileSync } = await import('node:child_process')
  let next = null
  while (!next && Date.now() - t < timeoutMs) {
    try { next = execFileSync('pgrep', ['-n', '-f', '--', `${path.basename(APP)} --remote-debugging-port=${PORT}`], { encoding: 'utf8' }).trim().split('\n').map(Number).find((n) => n && n !== pid) } catch {}
    if (!next) await sleep(500)
  }
  if (!next) throw new Error(`no relaunched process with --remote-debugging-port=${PORT} within ${timeoutMs / 1000}s`)
  log(`adopted relaunched pid=${next} (was ${pid})`); pid = next
  await attach()
  return Date.now() - t
}

// Another packaged instance on its own userData and port (multi-device steps). Refuses a busy port
// like the main one; stopped and its userData removed by stop() or at finish.
const peers = []
const peerData = [] // every peer's userData; removed at finish only when no step failed
async function launchPeer(label, port) {
  for (const p of [port, port + 1]) if (await portBusy(p)) throw new Error(`peer ${label}: port ${p} is already in use`)
  const ud = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shoresh-pkg-smoke-'))
  const out = fs.openSync(path.join(RUN, `app-${label}.log`), 'a')
  const child = spawn(APP, [`--remote-debugging-port=${port}`], { env: { ...process.env, SHORESH_SMOKE_USERDATA: ud }, detached: true, stdio: ['ignore', out, out] })
  child.unref()
  log(`peer ${label} launched pid=${child.pid} port=${port} userData=${ud}`)
  let conn = null
  const stop = async () => {
    try { conn?.close() } catch {}
    try { process.kill(child.pid, 'SIGTERM') } catch {}
    const t = Date.now(); while (Date.now() - t < 15000) { try { process.kill(child.pid, 0) } catch { break } await sleep(250) }
    try { process.kill(child.pid, 'SIGKILL') } catch {}
    // userData is NOT removed here: finish() removes it only when every step passed, so a failure's
    // databases can be inspected.
  }
  peers.push(stop)
  peerData.push({ label, ud })
  conn = await connect(port, 120000)
  const shotPeer = async (name) => { const f = path.join(SHOTS, `${String(results.length + 1).padStart(2, '0')}-${label}-${name}.png`); try { await conn.shot(f) } catch (e) { log(`  peer screenshot failed: ${e.message}`) } }
  return { label, pid: child.pid, ud, stop, shot: shotPeer, ...ctxFor(() => conn) }
}

// Quit the main instance (SIGTERM) and wait for it to exit; later steps then have no main app.
async function quitMain() {
  const t = Date.now(); process.kill(pid, 'SIGTERM'); try { app.close() } catch {}
  while (Date.now() - t < 30000) { try { process.kill(pid, 0) } catch { return Date.now() - t } await sleep(250) }
  throw new Error(`pid ${pid} still alive 30s after SIGTERM`)
}

function finish() {
  for (const stop of peers) stop().catch(() => {})
  log('\nRESULTS')
  for (const r of results) log(`${String(r.id).padEnd(4)} ${r.status.padEnd(4)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.title}${r.note ? ' — ' + r.note.slice(0, 500) : ''}  [${r.shots.join(', ')}]`)
  fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(results, null, 1))
  try { app?.close() } catch {}
  if (process.argv.includes('--keep')) { log(`--keep: app left running pid=${pid} port=${PORT} userData=${UD}`); fs.writeFileSync(path.join(RUN, 'kept.json'), JSON.stringify({ pid, UD })); process.exit(0) }
  try { process.kill(pid, 'SIGTERM') } catch {}
  log(`run dir ${RUN}`)
  // Remove userData only once the app has exited (it writes on the way out, which re-created the
  // folder when this ran on a fixed 3s timer), SIGKILLing after 20s.
  const t = Date.now()
  const tick = () => {
    let alive = true; try { process.kill(pid, 0) } catch { alive = false }
    if (alive && Date.now() - t < 20000) return setTimeout(tick, 250)
    if (alive) try { process.kill(pid, 'SIGKILL') } catch {}
    setTimeout(() => {
      // On any failure every app's userData is kept (host, and each peer) so its database can be
      // inspected; on a clean run all of it is removed.
      const failed = results.some((r) => r.status === 'FAIL')
      const all = [{ label: 'host', ud: UD }, ...peerData]
      if (failed) for (const { label, ud } of all) log(`kept userData (${label}): ${ud}`)
      else for (const { ud } of all) { try { fs.rmSync(ud, { recursive: true, force: true }) } catch {} }
      process.exit(failed ? 1 : 0)
    }, 500)
  }
  tick()
}

main().catch((e) => { log('FATAL ' + e.stack); finish() })
