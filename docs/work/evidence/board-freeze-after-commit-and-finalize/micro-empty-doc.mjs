import process from 'node:process'
import { createEmptyDoc, applyWrite, applyWrites } from '../../../../electron/automerge/campDocument.js'
import { randomUUID } from 'node:crypto'

const mk = (n) => Array.from({ length: n }, (_, i) => ({
  entity: 'campers', entity_id: `c-${i}`, field: 'display_name', value: `Camper ${i}`,
  source: null, author_user_id: 'u1',
}))

function cpu(fn) {
  const c0 = process.cpuUsage(); const w0 = process.hrtime.bigint()
  fn()
  const c = process.cpuUsage(c0)
  return { cpu: c.user + c.system, wall: Number(process.hrtime.bigint() - w0) / 1e6 }
}

const arms = {
  per: (doc, ws) => { let d = doc; for (const w of ws) d = applyWrite(d, w); return d },
  one: (doc, ws) => applyWrites(doc, ws),
  chunk100: (doc, ws) => { let d = doc; for (let i = 0; i < ws.length; i += 100) d = applyWrites(d, ws.slice(i, i + 100)); return d },
  chunk250: (doc, ws) => { let d = doc; for (let i = 0; i < ws.length; i += 250) d = applyWrites(d, ws.slice(i, i + 250)); return d },
  chunk500: (doc, ws) => { let d = doc; for (let i = 0; i < ws.length; i += 500) d = applyWrites(d, ws.slice(i, i + 500)); return d },
  chunk1000: (doc, ws) => { let d = doc; for (let i = 0; i < ws.length; i += 1000) d = applyWrites(d, ws.slice(i, i + 1000)); return d },
}

const sizes = [500, 1000, 2000, 4000]
const names = Object.keys(arms)
const out = new Map()
// interleave: for each repeat, for each size, run every arm in rotating order
for (let r = 0; r < 2; r += 1) {
  for (const n of sizes) {
    const order = [...names]
    if (r % 2) order.reverse()
    for (const name of order) {
      const ws = mk(n)
      const doc = createEmptyDoc()
      const m = cpu(() => arms[name](doc, ws))
      const key = `${name}|${n}`
      if (!out.has(key)) out.set(key, [])
      out.get(key).push(m.cpu)
    }
  }
}
console.log('arm         n      cpu(ms) [samples]        µs/write')
for (const n of sizes) {
  for (const name of names) {
    const xs = out.get(`${name}|${n}`)
    const min = Math.min(...xs)
    console.log(`${name.padEnd(10)} ${String(n).padStart(5)} ${(min/1000).toFixed(1).padStart(9)}  [${xs.map(x=>(x/1000).toFixed(0)).join(', ')}]  ${(min/n).toFixed(1).padStart(8)}`)
  }
  console.log('')
}
