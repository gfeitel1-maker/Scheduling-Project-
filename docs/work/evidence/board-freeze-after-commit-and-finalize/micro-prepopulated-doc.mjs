import process from 'node:process'
import { createEmptyDoc, applyWrites } from '/Users/gregfeitel/dev/shoresh/.claude/worktrees/elegant-hugle-bd9d3d/electron/automerge/campDocument.js'

const mk = (n, prefix) => Array.from({ length: n }, (_, i) => ({
  entity: 'campers', entity_id: `${prefix}-${i}`, field: 'display_name', value: `Camper ${i}`,
  source: null, author_user_id: 'u1',
}))
const chunked = (k) => (doc, ws) => { let d = doc; for (let i = 0; i < ws.length; i += k) d = applyWrites(d, ws.slice(i, i + k)); return d }
const arms = { one: (d, ws) => applyWrites(d, ws), c50: chunked(50), c100: chunked(100), c250: chunked(250), c500: chunked(500), c1000: chunked(1000) }
const names = Object.keys(arms)

// PRE-POPULATED doc: P existing keys, built once per cell with the fastest arm.
const PRE = Number(process.argv[2] ?? 6000)
const sizes = [500, 1000, 2000, 4000]
const out = new Map()
for (let r = 0; r < 2; r += 1) {
  for (const n of sizes) {
    const order = r % 2 ? [...names].reverse() : names
    for (const name of order) {
      let doc = createEmptyDoc()
      if (PRE > 0) doc = chunked(250)(doc, mk(PRE, 'pre'))
      const ws = mk(n, 'new')
      const c0 = process.cpuUsage()
      arms[name](doc, ws)
      const c = process.cpuUsage(c0)
      const key = `${name}|${n}`
      if (!out.has(key)) out.set(key, [])
      out.get(key).push(c.user + c.system)
    }
  }
}
console.log(`PRE-POPULATED with ${PRE} keys`)
console.log('arm      n       cpu(ms) min  [samples]      µs/write')
for (const n of sizes) {
  for (const name of names) {
    const xs = out.get(`${name}|${n}`); const min = Math.min(...xs)
    console.log(`${name.padEnd(8)} ${String(n).padStart(5)} ${(min/1000).toFixed(1).padStart(10)}  [${xs.map(x=>(x/1000).toFixed(0)).join(', ')}]  ${(min/n).toFixed(1).padStart(8)}`)
  }
  console.log('')
}
