// Final-audit steps 1-8 (board keeper brief). Each step returns a note or throws; the driver
// records PASS/FAIL and a screenshot. Labels are the ones the packaged UI shows.
import fs from 'node:fs'
import path from 'node:path'

const STATS = `const t=__main().replace(/\\n+/g,' ¦ '); const m=t.match(/(\\d+) of (\\d+) ¦ Placed ¦ (\\d+) ¦ (Unfillable|Overlapping) ¦ (\\d+) ¦ Still needed/); return m && {placed:+m[1], total:+m[2], second:m[4], secondN:+m[3], still:+m[5]}`

export async function run(h) {
  const { parseTextGrid } = await import(`file://${h.REPO}/src/ingest/textGrid.js`)
  const { step, ev, waitFor, click, nav, setFile, sleep, CAMPB, DL, relaunch, UD } = h
  const listNames = async (screen) => {
    await nav(screen)
    await waitFor(`return /\\d+ (FIXED|RECURRING) EVENTS?/.test(__main())`, 20000, `${screen} list`)
    return ev(`return [...document.querySelectorAll('tr')].filter(__vis).map(r=>[...r.querySelectorAll('td')].map(td=>td.innerText.trim())).filter(c=>c.length>=3)`)
  }
  // Which groups the FILE gives a lunch, per day (CIT has none in campB).
  const fileLunch = () => {
    const out = {}
    for (const pg of parseTextGrid(fs.readFileSync(CAMPB, 'utf8')).pages) {
      const day = pg.title.split(/\s+—/)[0].trim()
      pg.columns.forEach((g, i) => { if (pg.rows.some((r) => /^lunch\b/i.test(String(r.cells[i] ?? '')))) (out[g] ??= new Set()).add(day) })
    }
    return out
  }
  const importFile = async (file, { replace = false } = {}) => {
    await nav('Roots'); await click('Import last year', false, 20000)
    await setFile(file)
    await waitFor(`return !!__btn('Review ') || !!__btn('Replace with ')`, 60000, 'Review N records')
    if (replace) { await click('○ Replace them', false, 10000); await sleep(500) }
    await ev(`(__btn('Replace with ')||__btn('Review ')).click(); return true`)
    const q = await waitFor(`const m=__main().match(/(\\d+) of (\\d+) questions? answered/); return m ? m[2] : ((__btn('Use what Shoresh understood',true)||__btn('Use this setup',true))? '0':false)`, 60000, 'reconciliation')
    // Zero answers: a card that blocks the commit ("Skip this field" / "Skip … for now") is skipped.
    const skipped = await ev(`let n=0; for(let i=0;i<200;i++){ const b=__btn('Skip this field',true)||[...document.querySelectorAll('button')].filter(__vis).find(b=>/^Skip .* for now/.test(b.innerText.trim())); if(!b) break; b.click(); n++; await new Promise(r=>setTimeout(r,60)) } return n`, 60000)
    const t0 = Date.now()
    await waitFor(`return __click('Use what Shoresh understood', true) || __click('Use this setup', true)`, 30000, 'commit button')
    const done = await waitFor(`const t=__main(); const m=t.match(/Imported (\\d+) records[^\\n]*/)||t.match(/Setup replaced and ready[^\\n]*/); return m && m[0]`, 120000, 'import result')
    return { questions: +q, skipped, ms: Date.now() - t0, done }
  }

  await step(1, 'Import campB with zero answers: questions, Roots, no name both Fixed and Recurring, lunch on every group the file feeds', async () => {
    const r = await importFile(CAMPB)
    await click('Continue', true, 10000).catch(() => {})
    await nav('Roots')
    const roots = await ev(`const t=__main(); const g=(k)=>{const m=t.match(new RegExp(k+'\\\\n(\\\\d+)'));return m&&+m[1]}; return {activities:g('Activities'), groups:g('Groups'), divisions:g('Age Divisions'), timeBlocks:g('Time Blocks'), fixed:g('Fixed Events')}`)
    const fixed = await listNames('Fixed Events'); const rec = await listNames('Recurring Events')
    const fixedNames = new Set(fixed.map((c) => c[0])); const recNames = new Set(rec.map((c) => c[0]))
    const both = [...fixedNames].filter((n) => recNames.has(n))
    // Lunch: every group the file gives a lunch must have a Lunch row (fixed or recurring) for its division on that day.
    const divOf = (g) => g.split(' ')[0]
    const rows = [...fixed, ...rec].filter((c) => /^lunch\b/i.test(c[0]))
    const has = (g, day) => rows.some((c) => c[1] === day && (/All age divisions/.test(c[3]) || c[3].split(/,\s*/).includes(divOf(g))))
    const missing = []
    for (const [g, days] of Object.entries(fileLunch())) for (const d of days) if (!has(g, d)) missing.push(`${g} ${d}`)
    const note = `questions=${r.questions}; roots=${JSON.stringify(roots)}; fixed names=${fixedNames.size} recurring names=${recNames.size}; in both=${JSON.stringify(both)}; lunch missing=${JSON.stringify(missing)}`
    if (both.length || missing.length) throw new Error(note)
    return note
  })

  await step(2, 'Generate: placed all / still needed 0 / unfillable 0', async () => {
    await nav('Generated Schedule')
    if (await ev(`return !!__btn('Generate a schedule', true)`)) await click('Generate a schedule', true)
    else await click('Rebuild', true)
    const s = await waitFor(STATS, 120000, 'Generate stats')
    const note = `${s.placed} of ${s.total} placed, ${s.secondN} ${s.second}, ${s.still} still needed`
    if (s.placed !== s.total || s.secondN !== 0 || s.still !== 0) throw new Error(note)
    return note
  })

  await step(3, 'Manual: blank week, then restore "Imported from campB": no unresolved cell, nothing short', async () => {
    await nav('Manual Build')
    if (await ev(`return !!__btn('Start a blank week', true)`)) await click('Start a blank week', true)
    const blank = await waitFor(STATS, 30000, 'blank week stats')
    await click('Versions', true)
    await waitFor(`return /Imported from campB/.test(__main())`, 10000, 'Imported version in Version History')
    await ev(`const row=[...document.querySelectorAll('*')].filter(__vis).find(e=>/^Imported from campB/.test(e.innerText||'')&&e.innerText.length<120&&e.querySelector('button')); const b=row?[...row.querySelectorAll('button')].find(b=>b.innerText.trim()==='Restore'):__btn('Restore',true); b.click(); return true`)
    const s = await waitFor(`const r=(()=>{${STATS}})(); return r && r.placed>0 && r`, 30000, 'restored stats')
    const unresolved = await ev(`return (__main().match(/(\\d+) unresolved[^\\n]*/i)||[null])[0]`)
    const note = `blank ${blank.placed}/${blank.total}; restored ${s.placed} of ${s.total} placed, ${s.secondN} ${s.second}, ${s.still} still needed; unresolved=${unresolved}`
    if (s.placed !== s.total || unresolved || s.still !== 0) throw new Error(note)
    return note
  })

  await step(4, 'Special day: Copy time blocks, place on Week 1 Mon, Also bring', async () => {
    await nav('Special Events')
    await waitFor(`const i=__inp('input[placeholder="Color War"]'); if(!i) return false; __set(i,'Audit Day'); const s=__inp('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,[...s.options].find(o=>o.text==='Special Day').value); s.dispatchEvent(new Event('change',{bubbles:true})); return true`, 10000, 'special event form')
    await sleep(300); await click('+ Add', true)
    await click('Copy time blocks', true, 15000)
    await waitFor(`return /created — build it/.test(__main())`, 120000, 'copy finished')
    await nav('Special Schedules'); await click('Audit Day', false)
    await click('+ Place on a day', true)
    await waitFor(`const b=document.querySelector('button[aria-label^="Week 1, Monday"]'); if(!b) return false; b.click(); return true`, 10000, 'Week 1 Monday cell')
    const before = await waitFor(`const m=__main().match(/(\\d+) \\/ (\\d+) filled/); return m && +m[1]`, 10000, 'filled count')
    const offer = await waitFor(`const m=__main().match(/Also bring[^\\n]*/); return m && m[0]`, 15000, 'Also bring offer')
    await click('Bring', true)
    const after = await waitFor(`const m=__main().match(/(\\d+) \\/ (\\d+) filled/); return m && +m[1] > ${before} && +m[1]`, 15000, 'filled count to rise')
    return `"${offer}"; filled ${before} -> ${after}`
  })

  await step(5, 'Re-import: Keep writes 0; Replace under 15s with a "Before replace" version; Undo import', async () => {
    const keep = await importFile(CAMPB)
    const kept = keep.done.match(/Imported (\d+) records/)
    await click('Continue', true, 10000).catch(() => {})
    const rep = await importFile(CAMPB, { replace: true })
    await click('Continue', true, 10000).catch(() => {})
    await nav('Manual Build'); await click('Versions', true)
    const before = await waitFor(`return /Before replace/.test(__main())`, 10000, '"Before replace" version').catch((e) => false)
    await ev(`document.body.click(); return true`)
    // Undo: a Keep import that ADDS records (a renamed variant brings 14 new groups), then
    // "Undo this import" must put Roots back exactly as it was.
    const rootsNow = async () => { await nav('Roots'); return ev(`return __main().match(/WHAT HAS TAKEN ROOT[^]*?Fixed Events\\n\\d+/)?.[0]`) }
    const r0 = await rootsNow()
    const added = await importFile(path.join(h.REPO, 'docs/work/specs/samples/synthetic/campb-variants/b1-renamed.txt'))
    await click('Undo this import', true, 15000)
    const undone = await waitFor(`const m=__main().match(/Undo complete[^\\n]*/); return m && m[0]`, 60000, 'undo result')
    await click('Continue', true, 5000).catch(() => {})
    const r1 = await rootsNow()
    const note = `Keep: ${keep.done} (questions ${keep.questions}); Replace: ${(rep.ms / 1000).toFixed(1)}s (questions ${rep.questions}); "Before replace" version ${before ? 'present' : 'MISSING'}; Undo of "${added.done}": "${undone}", Roots ${r0 === r1 ? 'restored' : `NOT restored: before=${JSON.stringify(r0)} after=${JSON.stringify(r1)}`}`
    if (!kept || +kept[1] !== 0 || rep.ms > 15000 || !before || r0 !== r1 || /Nothing to undo/.test(undone)) throw new Error(note)
    return note
  })

  await step(6, '"What Shoresh has learned" opens; an answered question is remembered on re-import', async () => {
    await nav('Roots')
    // Shown in the sidebar footer, or under Settings on a short window.
    const found = await waitFor(`if (__click('What Shoresh has learned', true)) return 'sidebar'; if (!window.__settingsTried) { window.__settingsTried = 1; __click('Settings', true) } return false`, 10000, '"What Shoresh has learned"').catch(() => null)
    if (!found) throw new Error('"What Shoresh has learned" not found in the sidebar or under Settings')
    await waitFor(`return /learned/i.test(__main())`, 10000, 'learned screen')
    // Answer one question, then import the same file again: that question must not be asked again.
    // A synthetic camp raises questions on top of campB (a campB re-import asks none).
    const QFILE = path.join(h.REPO, 'docs/work/specs/samples/synthetic/s07-by-group-3-divisions.txt')
    // The first s07 import REPLACES the camp's setup, so s07 asks the questions a fresh camp would
    // (after steps 1-5 a Keep import of it raises only skip-only cards, which answer memory does not record).
    const openReview = async ({ replace = false } = {}) => {
      await nav('Roots'); await click('Import last year', false, 20000); await setFile(QFILE)
      await waitFor(`return !!__btn('Review ') || !!__btn('Replace with ')`, 60000, 'Review')
      if (replace) { await click('○ Replace them', false, 10000); await sleep(500) }
      await ev(`(__btn('Replace with ')||__btn('Review ')).click(); return true`)
      // As text: a count of 0 must not read as "not ready yet".
      return Number(await waitFor(`const m=__main().match(/(\\d+) of (\\d+) questions? answered/); return m ? String(m[2]) : ((__btn('Use what Shoresh understood',true)||__btn('Use this setup',true))?'0':false)`, 60000, 'questions'))
    }
    const q1 = await openReview({ replace: true })
    if (q1 < 1) throw new Error(`the question file raised ${q1} questions`)
    // Answer the first open question with its first choice. Choices are the card's buttons other than
    // the explain/skip/navigation ones, whatever the question kind labels them.
    const answered = await ev(`const NOT=/^(Why\\?|Show |Skip |Low is fine|Set them in|Cancel|Use |Leave as is|Dismiss|Review all|\\d+ )/; const head=[...document.querySelectorAll('h1,h2,h3,h4,div,span')].filter(__vis).find(e=>e.children.length===0&&e.innerText.trim()==='Needs your attention'); if(!head) return null; const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>{const t=b.innerText.trim(); return t && t.length<40 && !NOT.test(t) && (head.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)}); if(!b) return null; b.click(); return b.innerText.trim()`)
    if (!answered) throw new Error(`no answer button; buttons: ${await ev(`return [...new Set([...document.querySelectorAll('button')].filter(__vis).map(b=>b.innerText.trim()).filter(t=>t&&t.length<40))].join(' | ')`)}`)
    await ev(`let n=0; for(let i=0;i<300;i++){ const b=__btn('Skip this field',true)||[...document.querySelectorAll('button')].filter(__vis).find(b=>/^Skip .* for now/.test(b.innerText.trim())); if(!b) break; b.click(); n++; await new Promise(r=>setTimeout(r,60)) } return n`, 60000)
    await waitFor(`return __click('Use what Shoresh understood', true) || __click('Use this setup', true)`, 30000, 'commit')
    await waitFor(`return /Imported \\d+ records|Setup replaced/.test(__main())`, 120000, 'import done'); await click('Continue', true, 5000).catch(() => {})
    const q2 = await openReview()
    await click('Cancel', true, 5000).catch(() => {})
    const note = `questions ${q1} -> ${q2} after answering one ("${answered}")`
    if (!(q2 < q1)) throw new Error(note)
    return note
  })

  await step(7, 'Export to Excel and Backup now each produce a file', async () => {
    await nav('Generated Schedule')
    if (await ev(`return !!__btn('Generate a schedule', true)`)) { await click('Generate a schedule', true); await waitFor(STATS, 120000, 'Generate stats') }
    const before = new Set(fs.readdirSync(DL))
    await ev(`setTimeout(()=>__click('Export to Excel', true), 0); return true`)
    await sleep(1500)
    await ev(`const b=__btn('Generated',true)||__btn('Generated schedule',false); if(b) b.click(); return true`).catch(() => {})
    let file = null; const t0 = Date.now()
    while (!file && Date.now() - t0 < 60000) { file = fs.readdirSync(DL).find((f) => !before.has(f) && /\.xlsx$/.test(f) && fs.statSync(path.join(DL, f)).size > 0); await sleep(500) }
    const backupsBefore = listBackups(UD)
    await click('Backup now', true, 10000)
    const status = await waitFor(`const m=document.body.innerText.match(/Backup (saved|failed)[^\\n]*/); return m && m[0]`, 30000, 'backup status')
    const backupsAfter = listBackups(UD).filter((f) => !backupsBefore.includes(f))
    const note = `excel=${file ? `${file} (${fs.statSync(path.join(DL, file)).size} bytes)` : 'NONE in 60s'}; backup: "${status}", new files=${JSON.stringify(backupsAfter)}`
    if (!file || !/saved/.test(status) || backupsAfter.length === 0) throw new Error(note)
    return note
  })

  await step(8, 'Quit (SIGTERM, under 10s) and relaunch: still signed in, data intact', async () => {
    await nav('Roots')
    const snap = await ev(`return __main().match(/WHAT HAS TAKEN ROOT[^]*?Fixed Events\\n\\d+/)?.[0]`)
    const exitMs = await relaunch()
    await waitFor(`return document.body.innerText.includes('Log out') || !!__inp('#login-name')`, 120000, 'app back up')
    const signedIn = await ev(`return document.body.innerText.includes('Log out')`)
    if (!signedIn) { await h.signInIfAsked(); await waitFor(`return document.body.innerText.includes('Log out')`, 30000, 'signed in') }
    await nav('Roots')
    const snap2 = await ev(`return __main().match(/WHAT HAS TAKEN ROOT[^]*?Fixed Events\\n\\d+/)?.[0]`)
    const note = `exited ${(exitMs / 1000).toFixed(1)}s after SIGTERM; ${signedIn ? 'came back signed in' : 'asked to sign in again'}; Roots ${snap === snap2 ? 'unchanged' : 'CHANGED'}`
    if (exitMs > 10000 || !signedIn || snap !== snap2) throw new Error(note)
    return note
  })
}

function listBackups(ud) {
  const out = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/node_modules|Cache|GPU/.test(e.name)) walk(p) } else if (/backup/i.test(p)) out.push(path.relative(ud, p)) } }
  try { walk(ud) } catch {}
  return out
}
