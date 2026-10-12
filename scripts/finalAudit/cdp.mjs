// Minimal CDP client for the final-audit driver: attach to the first page target on a
// --remote-debugging-port, evaluate in the page, capture a screenshot.
import fs from 'node:fs'
export async function connect(port, timeoutMs = 30000) {
  const t0 = Date.now(); let targets
  while (true) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools')); if (p) { targets = p; break } } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`CDP ${port}: no page target in ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 500))
  }
  const ws = new WebSocket(targets.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0; const pending = new Map()
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
  const send = (method, params = {}, to = 30000) => new Promise((res, rej) => { const i = ++id; const tm = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} timeout`)) }, to); pending.set(i, (d) => { clearTimeout(tm); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result) }); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expr, to, repl = true) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, replMode: repl }, to); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value }
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')) }
  return { send, evaluate, shot, close: () => ws.close() }
}
