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
    // "Replace them" is offered only when something is already set up; on an empty camp Review is the only path.
    if (replace && await ev(`return !!__btn('○ Replace them', false)`)) { await click('○ Replace them', false, 10000); await sleep(500) }
    await waitFor(`const b=__btn('Replace with ')||__btn('Review '); if(!b||b.disabled) return false; b.click(); return true`, 15000, 'Replace with / Review button')
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

  // Placed on Friday: a special day replaces the regular day in the grid, and step 11's double-period
  // file has its elective on Monday, which a Monday special day would hide.
  await step(4, 'Special day: Copy time blocks, place on Week 1 Fri, Also bring', async () => {
    await nav('Special Events')
    await waitFor(`const i=__inp('input[placeholder="Color War"]'); if(!i) return false; __set(i,'Audit Day'); const s=__inp('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,[...s.options].find(o=>o.text==='Special Day').value); s.dispatchEvent(new Event('change',{bubbles:true})); return true`, 10000, 'special event form')
    await sleep(300); await click('+ Add', true)
    await click('Copy time blocks', true, 15000)
    await waitFor(`return /created — build it/.test(__main())`, 120000, 'copy finished')
    await nav('Special Schedules'); await click('Audit Day', false)
    await click('+ Place on a day', true)
    await waitFor(`const b=document.querySelector('button[aria-label^="Week 1, Friday"]'); if(!b) return false; b.click(); return true`, 10000, 'Week 1 Friday cell')
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

  // ---- Steps 9-12: features landing for v1. Each skips when its PR is not in the build under test. ----
  const { execFileSync } = await import('node:child_process')
  const git = (...a) => execFileSync('git', ['-C', h.REPO, ...a], { encoding: 'utf8' }).trim()
  // In the build iff the PR is merged and its merge commit is an ancestor of the build's commit
  // (read off the footer in step 1a). Throws { skip } otherwise, which the driver records as SKIP.
  const featureIn = (pr, what) => {
    let info
    try { info = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--json', 'state,mergeCommit'], { cwd: h.REPO, encoding: 'utf8' })) } catch (e) { throw new Error(`could not read PR #${pr}: ${e.message}`) }
    const skip = (why) => { const e = new Error(why); e.skip = `${what}: feature not in this build (${why})`; throw e }
    if (info.state !== 'MERGED') skip(`PR #${pr} is ${info.state}`)
    const build = h.buildSha()
    if (!build) throw new Error('build commit unknown (step 1a reads it from the footer)')
    try { git('fetch', '-q', 'origin', 'main') } catch {}
    try { git('merge-base', '--is-ancestor', info.mergeCommit.oid, build) } catch { skip(`PR #${pr} merged as ${info.mergeCommit.oid.slice(0, 9)}, after build ${build}`) }
  }
  // The device screen: "Devices" since #976, "LAN & Devices" before it, so the driver runs on either build.
  // Matched on the start of the item (it also reads "only this computer"); under Settings when not in view.
  const openDevices = async () => {
    const js = `const b=[...document.querySelectorAll('button,[role=menuitem],a')].filter(__vis).find(b=>/^(LAN & )?Devices\\b/.test(b.innerText.replace(/\\s+/g,' ').trim())); if(!b) return false; b.click(); return true`
    if (!await ev(js)) { await click('Settings', true, 10000); await waitFor(js, 10000, '"Devices" (or "LAN & Devices")') }
  }
  const SYN = (f) => path.join(h.REPO, 'docs/work/specs/samples/synthetic', f)
  const S07 = SYN('s07-by-group-3-divisions.txt')
  const sorted = (rows) => rows.map((c) => `${c[0]} | ${c[1]} | ${c[3] ?? ''}`).sort()
  const snapshot = async () => {
    await nav('Roots')
    const roots = await ev(`return __main().match(/WHAT HAS TAKEN ROOT[^]*?Fixed Events\\n\\d+/)?.[0]`)
    return { roots, fixed: sorted(await listNames('Fixed Events')), recurring: sorted(await listNames('Recurring Events')) }
  }
  const diff = (a, b) => ['roots', 'fixed', 'recurring'].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  const done = async () => { await click('Continue', true, 10000).catch(() => {}) }
  // Restore the "Imported from <file>" version on Manual Build (step 3's path).
  const restoreImported = async (name) => {
    await nav('Manual Build')
    if (await ev(`return !!__btn('Start a blank week', true)`)) await click('Start a blank week', true)
    await waitFor(STATS, 30000, 'manual stats')
    await click('Versions', true)
    await waitFor(`return __main().includes(${JSON.stringify(name)})`, 10000, `"${name}" in Version History`)
    await ev(`const row=[...document.querySelectorAll('*')].filter(__vis).find(e=>(e.innerText||'').startsWith(${JSON.stringify(name)})&&e.innerText.length<160&&e.querySelector('button')); const b=row?[...row.querySelectorAll('button')].find(b=>b.innerText.trim()==='Restore'):null; if(!b) throw new Error('no Restore button on the version row'); b.click(); return true`)
    return waitFor(`const r=(()=>{${STATS}})(); return r && r.placed>0 && r`, 30000, 'restored stats')
  }
  // Visible grid cells naming `word`, with the number of rows each spans.
  // Only the schedule grid: anything left of the BLOCK column header (the activities palette, which
  // also names the elective) is not a cell. Innermost matches only, so a cell is counted once.
  const cellsNaming = (word) => ev(`const vis=[...document.querySelectorAll('*')].filter(__vis); const hdr=vis.find(e=>e.children.length===0&&(e.innerText||'').trim()==='BLOCK'); if(!hdr) return []; const x0=hdr.getBoundingClientRect().right; const labels=vis.filter(e=>{const r=e.getBoundingClientRect(); return r.right<=x0+2&&r.left>=hdr.getBoundingClientRect().left-2&&/^\\d{1,2}:\\d{2}/.test((e.innerText||'').trim())&&![...e.children].some(c=>/^\\d{1,2}:\\d{2}/.test((c.innerText||'').trim()))}).map(e=>e.getBoundingClientRect().top).sort((a,b)=>a-b); const pitch=labels.length>1?labels[1]-labels[0]:0; const hits=vis.filter(e=>{const r=e.getBoundingClientRect(); return r.left>=x0&&(e.innerText||'').trim()===${JSON.stringify(word)}}); const cells=hits.map(e=>{let c=e; while(c.parentElement&&c.parentElement.innerText.trim()===e.innerText.trim()) c=c.parentElement; return c}); return [...new Set(cells)].map(c=>pitch?Math.max(1,Math.round((c.getBoundingClientRect().height+pitch*0.25)/pitch)):0)`)

  await step(9, 'Locations round-trip: Download worksheet, edit a capacity in the xlsx, Import from Excel, the location updates', async () => {
    featureIn(959, 'Locations sheet round-trip')
    const XLSX = await import(`file://${h.REPO}/node_modules/xlsx/xlsx.mjs`)
    XLSX.set_fs(fs)
    // Make sure there is a location to edit.
    await nav('Locations')
    await waitFor(`return !!__inp('input[placeholder="Pool"]')`, 15000, 'Locations add row')
    if (await ev(`return /No locations yet/.test(__main())`)) {
      await ev(`__set(__inp('input[placeholder="Pool"]'), 'Audit Hall'); return true`); await sleep(200); await click('+ Add', true)
      await waitFor(`return !/No locations yet/.test(__main())`, 15000, 'added location')
    }
    await nav('Roots')
    const before = new Set(fs.readdirSync(DL))
    await click('Download worksheet', true)
    let file = null; const t0 = Date.now()
    while (!file && Date.now() - t0 < 60000) { file = fs.readdirSync(DL).find((f) => !before.has(f) && /\.xlsx$/.test(f) && fs.statSync(path.join(DL, f)).size > 0); await sleep(500) }
    if (!file) throw new Error('no worksheet .xlsx in 60s')
    const wb = XLSX.readFile(path.join(DL, file))
    const ws = wb.Sheets.Locations
    if (!ws) throw new Error(`worksheet has no Locations sheet (sheets: ${wb.SheetNames.join(', ')})`)
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
    const target = rows.find((r) => r.name)
    if (!target) throw new Error('Locations sheet has no rows')
    const from = Number(target.capacity) || 1, to = from + 3
    target.capacity = to
    const header = Object.keys(rows[0])
    wb.Sheets.Locations = XLSX.utils.json_to_sheet(rows, { header })
    const edited = path.join(DL, `edited-${file}`)
    XLSX.writeFile(wb, edited)
    // Straight onto the screen's hidden file input: clicking "Import from Excel" opens a native picker.
    await nav('Locations'); await setFile(edited)
    await waitFor(`return [...document.querySelectorAll('button')].filter(__vis).some(b=>/^Import \\d+$/.test(b.innerText.trim()))`, 30000, 'import preview')
    await ev(`[...document.querySelectorAll('button')].filter(__vis).find(b=>/^Import \\d+$/.test(b.innerText.trim())).click(); return true`)
    const result = await waitFor(`const m=__main().match(/[^\\n]*\\b(updated|unchanged)\\b[^\\n]*/i); return m && m[0]`, 30000, 'import result')
    await click('Done', true, 5000).catch(() => {}); await click('Close', true, 2000).catch(() => {})
    await nav('Locations')
    const cap = await ev(`const r=[...document.querySelectorAll('tr')].filter(__vis).find(r=>[...r.querySelectorAll('td')].some(td=>td.innerText.trim()===${JSON.stringify(String(target.name))})); return r ? [...r.querySelectorAll('td')].map(td=>td.innerText.trim()) : null`)
    const note = `"${target.name}" capacity ${from} -> ${to} in the xlsx; import said "${result}"; row now ${JSON.stringify(cap)}`
    // The capacity cell reads "<n> groups".
    if (!cap || !cap.some((c) => new RegExp(`^${to}( group|$)`).test(c))) throw new Error(note)
    return note
  })

  await step(10, 'Undo then re-import: the fixed and recurring events, and the elective bundles, come back exactly', async () => {
    // A Replace cannot be undone, so the undone import is a Keep import of campB on top of s07.
    // Reference run: Replace s07, Keep campB, snapshot. Test run: the same, Undo, re-import, snapshot.
    await importFile(S07, { replace: true }); await done()
    await importFile(CAMPB); await done()
    const ref = await snapshot()
    await importFile(S07, { replace: true }); await done()
    const base = await snapshot()
    await importFile(CAMPB)
    await click('Undo this import', true, 15000)
    const undone = await waitFor(`const m=__main().match(/Undo complete[^\\n]*/); return m && m[0]`, 60000, 'undo result')
    await done()
    const afterUndo = await snapshot()
    await importFile(CAMPB); await done()
    const again = await snapshot()
    const undoLeft = diff(base, afterUndo), reimport = diff(ref, again)
    const note = `undo "${undone}": ${undoLeft.length ? `NOT back to the pre-import state in ${undoLeft}` : 'back to the pre-import state'}; re-import ${reimport.length ? `DIFFERS from the reference in ${reimport}: ref=${JSON.stringify(reimport.map((k) => ref[k]))} got=${JSON.stringify(reimport.map((k) => again[k]))}` : `matches the reference (${ref.fixed.length} fixed, ${ref.recurring.length} recurring)`}`
    if (undoLeft.length || reimport.length || ref.fixed.length === 0) throw new Error(note)
    // The elective bundles (#961), on campB (which has no electives, so the file's bundle is new): undo a Keep import of the double-period file, re-import it, and
    // the Electives screen must read exactly as it did after the first import.
    const R9 = SYN('repro/r9-double-period-elective.txt')
    try { featureIn(961, 'Elective bundles relink') } catch (e) { if (e.skip) return `${note}; bundles: ${e.skip}`; throw e }
    if (!fs.existsSync(R9)) throw new Error(`${note}; ${R9} missing from this checkout (pull main)`)
    // What the double-period file links: an elective set, or (an unconfirmed import, #973) an activity
    // span. Both screens are read so either form is compared.
    const linked = async () => {
      await nav('Electives'); await sleep(800)
      const el = await ev(`const t=__main(); const m=t.match(/(\\d+) ELECTIVE SETS?/i); return { n: m ? +m[1] : 0, text: t.replace(/\\s+/g,' ').trim() }`)
      await nav('Activities'); await sleep(800)
      const act = await ev(`return __main().replace(/\\s+/g,' ').trim()`)
      return { n: el.n, text: `${el.text} || ${act}` }
    }
    // Start from campB with no elective sets: a Replace does not clear sets, and an earlier import (s07)
    // leaves a same-named "Indoor Elective" the r9 bundle would match rather than create.
    const clean = async () => {
      await importFile(CAMPB, { replace: true }); await done()
      await nav('Electives')
      for (let i = 0; i < 20 && await ev(`return [...document.querySelectorAll('tr')].filter(__vis).some(r=>[...r.querySelectorAll('button')].some(b=>b.innerText.trim()==='Delete'))`); i++) {
        await ev(`[...document.querySelectorAll('tr')].filter(__vis).flatMap(r=>[...r.querySelectorAll('button')]).find(b=>b.innerText.trim()==='Delete').click(); return true`)
        await click('Delete Elective Set', true, 10000); await sleep(800)
      }
    }
    // Reference: clean, then one r9 import with no undo.
    await clean()
    const eb = await linked()
    await importFile(R9); await done()
    const e0 = await linked()
    // Test: clean, r9 import, Undo, re-import. Undo must return to eb; the re-import must read as e0.
    await clean()
    await importFile(R9)
    await click('Undo this import', true, 15000)
    await waitFor(`return /Undo complete/.test(__main())`, 60000, 'undo result'); await done()
    const eu = await linked()
    await importFile(R9); await done()
    const e1 = await linked()
    const cut = (t) => `"${t.slice(0, 300)}"`
    const bnote = `${note}; bundles: elective sets ${eb.n} clean, ${e0.n} after the reference import, ${eu.n} after undo ${eu.text === eb.text ? '(as clean)' : `(DIFFERS from clean: ${cut(eu.text)} vs ${cut(eb.text)})`}, ${e1.n} after re-import ${e1.text === e0.text ? '(matches the reference)' : `(DIFFERS from the reference: ${cut(e1.text)} vs ${cut(e0.text)})`}`
    // Non-vacuity: the reference import must change what these screens show.
    if (e0.text === eb.text) throw new Error(`${bnote}; the r9 import changed neither the Electives nor the Activities screen, so nothing was compared`)
    if (eu.text !== eb.text || e1.text !== e0.text) throw new Error(bnote)
    return bnote
  })

  await step(11, 'Double-period elective: imports as one cell, and Generate keeps it', async () => {
    featureIn(961, 'Double-period elective')
    const R9 = SYN('repro/r9-double-period-elective.txt')
    if (!fs.existsSync(R9)) throw new Error(`${R9} missing from this checkout (pull main)`)
    await importFile(R9, { replace: true }); await done()
    const manual = await restoreImported('Imported from r9-double-period-elective.txt')
    const mCells = await cellsNaming('Pottery / Drama'); await h.shot('s11-manual')
    await nav('Generated Schedule')
    if (await ev(`return !!__btn('Generate a schedule', true)`)) await click('Generate a schedule', true)
    else await click('Rebuild', true)
    const gen = await waitFor(STATS, 120000, 'Generate stats')
    const gCells = await cellsNaming('Pottery / Drama')
    const ok = (c) => c.length > 0 && c.every((n) => n >= 2)
    const note = `Manual (restored ${manual.placed}/${manual.total}): Pottery cells spans=${JSON.stringify(mCells)}; Generated (${gen.placed}/${gen.total}, ${gen.still} still needed): spans=${JSON.stringify(gCells)}`
    if (!ok(mCells) || !ok(gCells)) throw new Error(note)
    return note
  })

  await step(12, 'Encryption disable through the UI: the app restarts by itself and signs everyone out, the database is plain SQLite, data intact', async () => {
    featureIn(960, 'At-rest encryption disable')
    const dbFiles = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/Cache|GPU|blob_storage|backups?/i.test(e.name)) walk(p) } else if (/\.(db|sqlite3?)$/.test(e.name) && fs.statSync(p).size > 0) out.push(p) } }; try { walk(UD) } catch {} ; return out }
    const plain = (f) => { const b = Buffer.alloc(16); const fd = fs.openSync(f, 'r'); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); return b.toString('latin1') === 'SQLite format 3\0' }
    const header = () => Object.fromEntries(dbFiles().map((f) => [path.relative(UD, f), plain(f) ? 'plain' : 'encrypted']))
    const snap0 = await snapshot()
    const h0 = header()
    await openDevices()
    await click('Turn off encryption…', true, 15000)
    await waitFor(`const i=[...document.querySelectorAll('label input')].filter(__vis)[0]; if(!i) return false; __set(i,'DISABLE ENCRYPTION'); return true`, 10000, 'confirmation input')
    await sleep(300); await click('Turn off encryption', true, 10000)
    const said = await waitFor(`const m=__main().match(/Encryption is off[^\\n]*|Encryption is still on[^\\n]*/); return m && m[0]`, 120000, 'disable outcome')
    if (/still on/.test(said)) throw new Error(`refused: "${said}"`)
    const ms = await h.adopt()
    await waitFor(`return document.body.innerText.includes('Log out') || !!__inp('#login-name')`, 120000, 'app back up')
    const signedIn = await ev(`return document.body.innerText.includes('Log out')`)
    if (!signedIn) { await h.signInIfAsked(); await waitFor(`return document.body.innerText.includes('Log out')`, 30000, 'signed in') }
    const snap1 = await snapshot()
    const h1 = header()
    const changed = diff(snap0, snap1)
    const anyPlain = Object.values(h1).includes('plain')
    // The panel copy is the spec: it restarts AND signs everyone out.
    const note = `"${said}"; relaunched in ${(ms / 1000).toFixed(1)}s, ${signedIn ? 'came back STILL SIGNED IN (the panel says it signs everyone out)' : 'signed out as the panel says'}; db before ${JSON.stringify(h0)} after ${JSON.stringify(h1)}; data after signing back in ${changed.length ? `CHANGED in ${changed}` : 'intact'}`
    if (signedIn || changed.length || !anyPlain || Object.values(h0).includes('plain')) throw new Error(note)
    return note
  })

  // Like featureIn, for work that has a branch but no PR number yet: in the build iff a MERGED PR from
  // that branch has its merge commit in the build. --force=<step> runs the step anyway (to check the
  // harness against a build without the feature, where the step is expected to FAIL).
  const featureInBranch = (branch, what, stepId) => {
    if (h.FORCE.has(String(stepId))) return
    const prs = JSON.parse(execFileSync('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,mergeCommit'], { cwd: h.REPO, encoding: 'utf8' }))
    const e = new Error('skip')
    if (!prs.length) { e.skip = `${what}: feature not in this build (no merged PR from ${branch})`; throw e }
    featureIn(prs[0].number, what)
  }

  await step(13, 'Host off: two paired non-admin devices still sync (B edits, C sees it within 60s)', async () => {
    featureInBranch('claude/shared-device-roster', 'Shared device roster (host-off sync)', 13)
    // A (this instance) is the host. B and C join by camp code and are approved on A; a normally
    // approved device is a plain member (admin standing comes only from the signed authority log).
    const devicesScreen = async () => {
      await openDevices()
      await waitFor(`return /Add a device|Stop adding devices/.test(__main())`, 20000, 'Device Manager')
    }
    const pair = async (peer) => {
      await devicesScreen()
      if (!await ev(`return /Stop adding devices/.test(__main())`)) await click('Add a device', true, 10000)
      const code = await waitFor(`const m=__main().match(/\\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\\b/); return m && m[1]`, 30000, 'camp code')
      await peer.waitFor(`return document.body.innerText.includes('Join with a camp code')`, 120000, `${peer.label}: mode-select`)
      await peer.click('Join with a camp code', false)
      await peer.waitFor(`const i=__inp('input[placeholder="K4P7-2MRQ"]'); if(!i) return false; __set(i, ${JSON.stringify(code)}); return true`, 15000, `${peer.label}: code field`)
      await sleep(300); await peer.click('Continue', true, 10000)
      await waitFor(`return [...document.querySelectorAll('button')].filter(__vis).some(b=>b.innerText.trim()==='Approve'&&!b.disabled)`, 90000, `${peer.label}'s pairing request on A`)
      await ev(`[...document.querySelectorAll('button')].filter(__vis).find(b=>b.innerText.trim()==='Approve'&&!b.disabled).click(); return true`)
      await peer.waitFor(`return !!__inp('#join-name')`, 90000, `${peer.label}: sign-in after approval`)
      await peer.ev(`__set(__inp('#join-name'), ${JSON.stringify(h.ADMIN)}); __set(__inp('#join-pin'), ${JSON.stringify(h.PIN)}); return true`)
      await sleep(300); await peer.click('Sign in', true, 10000)
      // The join completes only once the camp document has arrived from A (the host must stay on until then).
      await peer.waitFor(`return __click('Continue', true) || document.body.innerText.includes('Log out')`, 120000, `${peer.label}: camp arrived`)
      await peer.waitFor(`return document.body.innerText.includes('Log out')`, 60000, `${peer.label}: signed in`)
      return code
    }
    const B = await h.launchPeer('B', h.PORT + 10), C = await h.launchPeer('C', h.PORT + 20)
    try {
      const codeB = await pair(B), codeC = await pair(C)
      await click('Stop adding devices', true, 5000).catch(() => {})
      // B adds a location; seconds until C shows it (null if not within 60s). C re-opens the screen to re-read.
      const editReaches = async (tag) => {
        const name = `${tag} ${Date.now().toString(36)}`
        await B.nav('Locations')
        await B.waitFor(`const i=__inp('input[placeholder="Pool"]'); if(!i) return false; __set(i, ${JSON.stringify(name)}); return true`, 15000, 'B: Locations add row')
        await sleep(200); await B.click('+ Add', true, 10000)
        await B.waitFor(`return __main().includes(${JSON.stringify(name)})`, 15000, 'B: location added')
        const t0 = Date.now()
        await C.nav('Locations')
        while (Date.now() - t0 < 60000) {
          if (await C.ev(`return __main().includes(${JSON.stringify(name)})`).catch(() => false)) return { name, s: (Date.now() - t0) / 1000 }
          await sleep(2000); await C.nav('Activities').catch(() => {}); await C.nav('Locations').catch(() => {})
        }
        return { name, s: null }
      }
      // Control, host ON: proves the detection path (B edits, C reads) before the host-off claim.
      const on = await editReaches('Host On')
      if (on.s == null) throw new Error(`control failed: with A on, C did not see B's "${on.name}" within 60s, so a host-off result would mean nothing`)
      const quitMs = await h.quitMain()
      const off = await editReaches('Host Off')
      await B.shot('s13'); await C.shot('s13')
      const note = `paired B (${codeB}) and C (${codeC}) on A; control with A on: C saw "${on.name}" after ${on.s.toFixed(1)}s; A quit in ${(quitMs / 1000).toFixed(1)}s; host off: C ${off.s != null ? `saw "${off.name}" after ${off.s.toFixed(1)}s` : `did NOT see "${off.name}" within 60s`} (24h token expiry: covered by the integration test, not here)`
      if (off.s == null) throw new Error(note)
      return note
    } finally {
      await B.stop(); await C.stop()
    }
  })
}

function listBackups(ud) {
  const out = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/node_modules|Cache|GPU/.test(e.name)) walk(p) } else if (/backup/i.test(p)) out.push(path.relative(ud, p)) } }
  try { walk(ud) } catch {}
  return out
}
