// Final-audit steps 1-8 (board keeper brief). Each step returns a note or throws; the driver
// records PASS/FAIL and a screenshot. Labels are the ones the packaged UI shows.
import fs from 'node:fs'
import path from 'node:path'

const STATS = `const t=__main().replace(/\\n+/g,' ¦ '); const m=t.match(/(\\d+) of (\\d+) ¦ Placed ¦ (\\d+) ¦ (Unfillable|Overlapping) ¦ (\\d+) ¦ Still needed/); return m && {placed:+m[1], total:+m[2], second:m[4], secondN:+m[3], still:+m[5]}`

export async function run(h) {
  const { parseTextGrid } = await import(`file://${h.REPO}/src/ingest/textGrid.js`)
  const { step, ev, waitFor, click, nav, setFile, sleep, CAMPB, DL, relaunch, UD } = h
  // Director-guide screenshots (scripts/finalAudit/guideShots.mjs): a no-op outside --guide.
  const guide = h.guide ?? (async () => {})
  const listNamesOn = async (c, screen) => {
    await c.nav(screen)
    await c.waitFor(`return /\\d+ (FIXED|RECURRING) EVENTS?/.test(__main())`, 20000, `${screen} list`)
    // One entry per event per DAY, [name, day, block, divisions], whether the screen groups an event's
    // days into one row (T377) or not. Every grouped row is expanded; its header row is skipped, and a
    // day row's name comes from its "Edit NAME on DAY" label (its first cell shows the day).
    await c.ev(`for (const b of [...document.querySelectorAll('button[aria-label^="Show each day of"]')].filter(__vis)) b.click(); return true`)
    await sleep(400)
    return c.ev(`return [...document.querySelectorAll('tr')].filter(__vis).flatMap(r=>{
      if (r.querySelector('button[aria-label^="Hide each day of"],button[aria-label^="Show each day of"]')) return []
      const c=[...r.querySelectorAll('td')].map(td=>td.innerText.trim()); if (c.length<3) return []
      const m=(r.querySelector('[role=button][aria-label^="Edit "]')?.getAttribute('aria-label')||'').match(/^Edit (.+) on (.+)$/)
      return [m ? [m[1], c[1], c[2], c[3]] : c]
    })`)
  }
  const listNames = (screen) => listNamesOn({ nav, waitFor, ev }, screen)
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
    if (await ev(`return !!__btn('○ Replace them', false)`)) await guide('import/keep-or-replace', 'Replace them')
    // "Replace them" is offered only when something is already set up; on an empty camp Review is the only path.
    if (replace && await ev(`return !!__btn('○ Replace them', false)`)) { await click('○ Replace them', false, 10000); await sleep(500) }
    await waitFor(`const b=__btn('Replace with ')||__btn('Review '); if(!b||b.disabled) return false; b.click(); return true`, 15000, 'Replace with / Review button')
    const q = await waitFor(`const m=__main().match(/(\\d+) of (\\d+) questions? answered/); return m ? m[2] : ((__btn('Use what Shoresh understood',true)||__btn('Import the rest')||__btn('Add to camp')||__btn('Use this setup',true))? '0':false)`, 60000, 'reconciliation')
    // Zero answers: a card that blocks the commit ("Skip this field" / "Skip … for now") is skipped.
    const skipped = await ev(`let n=0; for(let i=0;i<200;i++){ const b=__btn('Skip this field',true)||[...document.querySelectorAll('button')].filter(__vis).find(b=>/^Skip .* for now/.test(b.innerText.trim())); if(!b) break; b.click(); n++; await new Promise(r=>setTimeout(r,60)) } return n`, 60000)
    const t0 = Date.now()
    await waitFor(`return __click('Use what Shoresh understood', true) || __click('Import the rest', false) || __click('Add to camp', false) || __click('Use this setup', true)`, 30000, 'commit button')
    const done = await waitFor(`const t=__main(); const m=t.match(/Imported (\\d+) records[^\\n]*/)||t.match(/Setup replaced and ready[^\\n]*/); return m && m[0]`, 120000, 'import result')
    return { questions: +q, skipped, ms: Date.now() - t0, done }
  }

  await step(1, 'Import campB with zero answers: questions, Roots, no name both Fixed and Recurring, lunch on every group the file feeds', async () => {
    const r = await importFile(CAMPB)
    await click('Continue', true, 10000).catch(() => {})
    if (h.guide) {
      // A one-day file is recognised and not imported as the week; shot, then Cancel.
      await nav('Roots'); await click('Import last year', false, 20000)
      await setFile(path.join(h.REPO, 'docs/work/specs/samples/synthetic/special-days/s02-color-war-day.txt'))
      await waitFor(`return /This looks like a single-day schedule/.test(__main())`, 60000, 'one-day file card')
      await guide('import/one-day-file-card')
      await click('Cancel', true, 10000).catch(() => {})
    }
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
    await waitFor(`const i=__inp('input[placeholder$="Color War"]'); if(!i) return false; __set(i,'Audit Day'); const s=__inp('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,[...s.options].find(o=>o.text==='Special Day').value); s.dispatchEvent(new Event('change',{bubbles:true})); return true`, 10000, 'special event form')
    await sleep(300); await click('+ Add', true)
    await click('Copy time blocks', true, 15000)
    await waitFor(`return /created — build it/.test(__main())`, 120000, 'copy finished')
    await nav('Special Schedules'); await click('Audit Day', false)
    await click('+ Place on a day', true)
    await waitFor(`const b=document.querySelector('button[aria-label^="Week 1, Friday"]'); if(!b) return false; b.click(); return true`, 10000, 'Week 1 Friday cell')
    const before = await waitFor(`const m=__main().match(/(\\d+) \\/ (\\d+) filled/); return m && +m[1]`, 10000, 'filled count')
    const offer = await waitFor(`const m=__main().match(/Also bring[^\\n]*/); return m && m[0]`, 15000, 'Also bring offer')
    await guide('special-day/bring-recurring-events')
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
    await guide('reconcile/undo-receipt')
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
      return Number(await waitFor(`const m=__main().match(/(\\d+) of (\\d+) questions? answered/); return m ? String(m[2]) : ((__btn('Use what Shoresh understood',true)||__btn('Import the rest')||__btn('Add to camp')||__btn('Use this setup',true))?'0':false)`, 60000, 'questions'))
    }
    const q1 = await openReview({ replace: true })
    if (q1 < 1) throw new Error(`the question file raised ${q1} questions`)
    // Answer the first open question with its first choice. Choices are the card's buttons other than
    // the explain/skip/navigation ones, whatever the question kind labels them.
    const answered = await ev(`const NOT=/^(Why\\?|Show |Skip |Low is fine|Set them in|Cancel|Use |Leave as is|Dismiss|Review all|\\d+ )/; const head=[...document.querySelectorAll('h1,h2,h3,h4,div,span')].filter(__vis).find(e=>e.children.length===0&&e.innerText.trim()==='Needs your attention'); if(!head) return null; const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>{const t=b.innerText.trim(); return t && t.length<40 && !NOT.test(t) && (head.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)}); if(!b) return null; b.click(); return b.innerText.trim()`)
    if (!answered) throw new Error(`no answer button; buttons: ${await ev(`return [...new Set([...document.querySelectorAll('button')].filter(__vis).map(b=>b.innerText.trim()).filter(t=>t&&t.length<40))].join(' | ')`)}`)
    await ev(`let n=0; for(let i=0;i<300;i++){ const b=__btn('Skip this field',true)||[...document.querySelectorAll('button')].filter(__vis).find(b=>/^Skip .* for now/.test(b.innerText.trim())); if(!b) break; b.click(); n++; await new Promise(r=>setTimeout(r,60)) } return n`, 60000)
    await waitFor(`return __click('Use what Shoresh understood', true) || __click('Import the rest', false) || __click('Add to camp', false) || __click('Use this setup', true)`, 30000, 'commit')
    await waitFor(`return /Imported \\d+ records|Setup replaced/.test(__main())`, 120000, 'import done'); await click('Continue', true, 5000).catch(() => {})
    const q2 = await openReview()
    await click('Cancel', true, 5000).catch(() => {})
    if (h.guide) {
      // The guide shows the screen with a remembered answer on it, so shoot it after answering.
      await nav('Roots')
      await waitFor(`if (__click('What Shoresh has learned', true)) return true; if (!window.__settingsTried2) { window.__settingsTried2 = 1; __click('Settings', true) } return false`, 10000, '"What Shoresh has learned"')
      await waitFor(`return /Forget answer/.test(__main())`, 10000, 'a remembered answer on the learned screen')
      await guide('learned/what-shoresh-has-learned')
    }
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
  // Row pitch comes from the grid's row-header cells (one per block). Block times now wrap onto two
  // lines, so the gap between two time-text lines is not a row; the text fallback ignores gaps under 40px.
  // Only the schedule grid: anything left of the BLOCK column header (the activities palette, which
  // also names the elective) is not a cell. Innermost matches only, so a cell is counted once.
  const cellsNaming = (word) => ev(`const vis=[...document.querySelectorAll('*')].filter(__vis); const hdr=vis.find(e=>e.children.length===0&&(e.innerText||'').trim()==='BLOCK'); if(!hdr) return []; const x0=hdr.getBoundingClientRect().right; const labels=vis.filter(e=>{const r=e.getBoundingClientRect(); return r.right<=x0+2&&r.left>=hdr.getBoundingClientRect().left-2&&/^\\d{1,2}:\\d{2}/.test((e.innerText||'').trim())&&![...e.children].some(c=>/^\\d{1,2}:\\d{2}/.test((c.innerText||'').trim()))}).map(e=>e.getBoundingClientRect().top).sort((a,b)=>a-b); const heads=[...document.querySelectorAll('[role=rowheader]')].filter(__vis).map(e=>e.getBoundingClientRect().top).sort((a,b)=>a-b); const gaps=labels.slice(1).map((t,i)=>t-labels[i]).filter(g=>g>40); const pitch=heads.length>1?heads[1]-heads[0]:(gaps.length?Math.min(...gaps):0); const hits=vis.filter(e=>{const r=e.getBoundingClientRect(); return r.left>=x0&&(e.innerText||'').trim()===${JSON.stringify(word)}}); const cells=hits.map(e=>{let c=e; while(c.parentElement&&c.parentElement.innerText.trim()===e.innerText.trim()) c=c.parentElement; return c}); return [...new Set(cells)].map(c=>pitch?Math.max(1,Math.round((c.getBoundingClientRect().height+pitch*0.25)/pitch)):0)`)
  // Every day, not just the one on screen: since T378 a double period can land on any day (#1004).
  const dayPills = () => ev(`return [...document.querySelectorAll('.day-pill')].filter(__vis).length`)
  const onEachDay = async (read) => {
    const n = await dayPills(); if (!n) return [await read()]
    const out = []
    for (let k = 0; k < n; k++) { await ev(`[...document.querySelectorAll('.day-pill')].filter(__vis)[${k}].click(); return true`); await sleep(600); out.push(await read()) }
    await ev(`[...document.querySelectorAll('.day-pill')].filter(__vis)[0].click(); return true`); await sleep(400)
    return out
  }
  const cellsNamingAllDays = async (word) => (await onEachDay(() => cellsNaming(word))).flat()

  await step(9, 'Locations round-trip: Download worksheet, edit a capacity in the xlsx, Import from Excel, the location updates', async () => {
    featureIn(959, 'Locations sheet round-trip')
    const XLSX = await import(`file://${h.REPO}/node_modules/xlsx/xlsx.mjs`)
    XLSX.set_fs(fs)
    // Make sure there is a location to edit.
    await nav('Locations')
    await waitFor(`return !!__inp('input[placeholder$="Pool"]')`, 15000, 'Locations add row')
    if (await ev(`return /No locations yet/.test(__main())`)) {
      await ev(`__set(__inp('input[placeholder$="Pool"]'), 'Audit Hall'); return true`); await sleep(200); await click('+ Add', true)
      await waitFor(`return !/No locations yet/.test(__main())`, 15000, 'added location')
    }
    await guide('worksheet/locations-sheet')
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
    const mCells = await cellsNamingAllDays('Pottery / Drama'); await h.shot('s11-manual')
    await nav('Generated Schedule')
    if (await ev(`return !!__btn('Generate a schedule', true)`)) await click('Generate a schedule', true)
    else await click('Rebuild', true)
    const gen = await waitFor(STATS, 120000, 'Generate stats')
    const gCells = await cellsNamingAllDays('Pottery / Drama')
    const ok = (c) => c.length > 0 && c.every((n) => n >= 2)
    const note = `Manual (restored ${manual.placed}/${manual.total}): Pottery cells spans=${JSON.stringify(mCells)}; Generated (${gen.placed}/${gen.total}, ${gen.still} still needed): spans=${JSON.stringify(gCells)}`
    if (!ok(mCells) || !ok(gCells)) throw new Error(note)
    return note
  })

  // Guide mode only (step 18): the director-guide screens no audit step stands on (scripts/finalAudit/guideScreens.mjs).
  if (h.guide) await step(18, 'Guide screens: import, schedules, electives, special day, devices, restore, pair again', async () => {
    const { guideScreens } = await import('./guideScreens.mjs')
    return guideScreens(h, { importFile, done, openDevices, STATS })
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
    await sleep(300); await guide('devices/turn-off-encryption', 'DISABLE ENCRYPTION'); await click('Turn off encryption', true, 10000)
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

  await step(14, 'Drag swap + undo count: two filled cells swap, Placed unchanged, Undo restores both; a span refuses with a note', async () => {
    // Needs a generated schedule. Standalone (--only=14) on a fresh camp, import campB and generate first.
    await nav('Generated Schedule')
    if (await ev(`return /still needed before you can build|Seed your camp/.test(__main())`)) {
      await importFile(CAMPB); await done(); await nav('Generated Schedule')
    }
    if (await ev(`return !!__btn('Generate a schedule', true)`)) await click('Generate a schedule', true)
    await waitFor(STATS, 120000, 'Generate stats')
    await click('Daily View', true, 10000).catch(() => {})
    await sleep(800)
    const cellInfo = `const cells=[...document.querySelectorAll('[role=gridcell][data-cell-key]')].filter(__vis).map(c=>{const r=c.getBoundingClientRect(); const [g,d,b]=c.dataset.cellKey.split('|'); return {key:c.dataset.cellKey, g, d, b, x:r.left+r.width/2, y:r.top+r.height/2, text:c.innerText.trim(), span:Number(c.getAttribute('aria-rowspan')||1), plain:!c.hasAttribute('data-elective')&&!c.hasAttribute('data-event')&&!c.hasAttribute('data-drop-disabled')&&!!c.querySelector('.cell-inner')&&!c.querySelector('.cell-inner--anchor')}}).filter(c=>c.text);`
    const textAt = (key) => ev(`return document.querySelector('[data-cell-key="'+${JSON.stringify(key)}+'"]')?.innerText.trim() ?? null`)
    const placed = async () => (await waitFor(STATS, 15000, 'stats')).placed
    // A real pointer drag (dnd-kit needs > 5px of movement before it starts).
    const drag = async (a, b) => {
      const send = (type, x, y) => h.app().send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
      await send('mousePressed', a.x, a.y)
      for (let i = 1; i <= 12; i++) { await send('mouseMoved', a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12); await sleep(25) }
      await sleep(150); await send('mouseReleased', b.x, b.y); await sleep(1200)
    }
    const cells = await ev(cellInfo + 'return cells')
    // Two plain single-block cells in the same block, holding different activities.
    const plain = cells.filter(c => c.plain && c.span === 1)
    let pair = null
    for (const a of plain) { const b = plain.find(o => o.b === a.b && o.d === a.d && o.key !== a.key && o.text !== a.text); if (b) { pair = [a, b]; break } }
    if (!pair) throw new Error(`no two plain single-block cells with different activities in one block (${plain.length} plain cells)`)
    const [A, B] = pair
    const p0 = await placed()
    await drag(A, B)
    const [a1, b1, p1] = [await textAt(A.key), await textAt(B.key), await placed()]
    await click('Undo', true, 10000).catch(async () => ev(`document.querySelector('[aria-label=Undo]')?.click(); return true`))
    await sleep(1200)
    const [a2, b2, p2] = [await textAt(A.key), await textAt(B.key), await placed()]
    const swapped = a1 === B.text && b1 === A.text
    const restored = a2 === A.text && b2 === B.text
    let note = `swap "${A.text}" (${A.key}) onto "${B.text}" (${B.key}): ${swapped ? 'swapped' : `NOT swapped (now "${a1}" / "${b1}")`}, Placed ${p0} -> ${p1}; Undo: ${restored ? 'both restored' : `NOT restored ("${a2}" / "${b2}")`}, Placed ${p2}`
    let ok = swapped && restored && p1 === p0 && p2 === p0
    // Refused case: a plain cell dropped on a multi-block cell.
    const findSpan = async () => {
      const n = await dayPills()
      for (let k = 0; k < Math.max(n, 1); k++) {
        if (n) { await ev(`[...document.querySelectorAll('.day-pill')].filter(__vis)[${k}].click(); return true`); await sleep(600) }
        const cells = await ev(cellInfo + 'return cells'); const sp = cells.find(c => c.span > 1)
        if (sp) return [cells, sp]
      }
      return [await ev(cellInfo + 'return cells'), null]
    }
    let [after, span] = await findSpan()
    if (!span) {
      // campB's week has no multi-block cell: load the double-period elective sample (r9), whose Monday
      // holds a two-block elective, so the refused case is always exercised.
      const R9 = SYN('repro/r9-double-period-elective.txt')
      if (!fs.existsSync(R9)) throw new Error(`${note}; refused case needs ${R9} (pull main)`)
      await importFile(R9, { replace: true }); await done()
      await nav('Generated Schedule')
      if (await ev(`return !!__btn('Generate a schedule', true)`)) await click('Generate a schedule', true)
      else await click('Rebuild', true)
      if (await ev(`return !!__btn('Rebuild it', true)`)) await click('Rebuild it', true)
      await waitFor(STATS, 120000, 'Generate stats (r9)')
      ;[after, span] = await findSpan()
    }
    const src = span && after.find(c => c.plain && c.span === 1 && c.d === span.d && c.text !== span.text)
    if (!span || !src) throw new Error(`${note}; refused case: no multi-block cell even after loading r9`)
    {
      const [s0, t0, p3] = [await textAt(src.key), await textAt(span.key), await placed()]
      await drag(src, span)
      const said = await ev(`return (__main().match(/Can.t swap[^\\n]*/)||[null])[0]`)
      const [s1, t1, p4] = [await textAt(src.key), await textAt(span.key), await placed()]
      const unchanged = s1 === s0 && t1 === t0 && p4 === p3
      note += `; refused case "${src.text}" onto 2-block "${span.text}": note ${said ? `"${said}"` : 'MISSING'}, ${unchanged ? 'nothing changed' : `CHANGED ("${s1}" / "${t1}", Placed ${p3} -> ${p4})`}`
      ok = ok && Boolean(said) && unchanged
    }
    if (!ok) throw new Error(note)
    return note
  })

  await step(16, 'Rainy day…: a version is saved first, the day\'s outdoor cells take their rain plan, other days stay, Undo restores it', async () => {
    // Needs a generated schedule. Standalone (--only=16) on a fresh camp, import campB and generate first.
    await nav('Generated Schedule')
    if (await ev(`return /still needed before you can build|Seed your camp/.test(__main())`)) {
      await importFile(CAMPB); await done(); await nav('Generated Schedule')
    }
    if (await ev(`return !!__btn('Generate a schedule', true)`)) await click('Generate a schedule', true)
    await waitFor(STATS, 120000, 'Generate stats')
    await click('Daily View', true, 10000).catch(() => {})
    await sleep(800)
    const cellMap = () => ev(`const m={}; for (const c of document.querySelectorAll('[role=gridcell][data-cell-key]')) { if (__vis(c)) m[c.dataset.cellKey]=c.innerText.trim().split('\\n')[0] } return m`)
    const before = await cellMap()
    const names = Object.values(before).filter(Boolean)
    const counts = names.reduce((m, n) => ({ ...m, [n]: (m[n] || 0) + 1 }), {})
    const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
    // The outdoor one is the most-placed grid label that is an ACTIVITY (a cell can also show a fixed event or
    // an elective bundle, which have no row on Activities).
    await nav('Activities')
    await waitFor(`return document.querySelectorAll('[aria-label^="Edit "][aria-label$=" details"]').length > 0`, 20000, 'activity rows')
    const activityNames = await ev(`return [...document.querySelectorAll('[aria-label^="Edit "][aria-label$=" details"]')].map(b=>b.getAttribute('aria-label').slice(5, -8))`)
    const outdoor = ranked.find((n) => activityNames.includes(n))
    if (!outdoor) throw new Error(`no activity among the first day's grid labels ${JSON.stringify(ranked)} (activities: ${JSON.stringify(activityNames)})`)

    // The rain plan is a fresh indoor activity, absent from every block, so at least one cell has room to
    // switch (an existing activity may already be at its groups-at-once limit in every block: "N full").
    // In guide mode the picture shows a name a director would use; the audit keeps a unique one.
    const rain = h.guide ? 'Indoor Games' : `Rain Room ${Date.now().toString(36)}`
    await nav('Activities')
    await waitFor(`const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>/^\\+?\\s*Add activity$/i.test(b.innerText.trim())); if(!b) return false; b.click(); return true`, 15000, 'Add activity')
    await waitFor(`const i=__inp('input[placeholder$="Swim"]'); if(!i) return false; __set(i, ${JSON.stringify(rain)}); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true`, 10000, 'new activity name')
    await waitFor(`return !!document.querySelector('[aria-label=${JSON.stringify(`Edit ${rain} details`)}]')`, 15000, 'rain plan activity added')
    await waitFor(`return !!document.querySelector('[aria-label=${JSON.stringify(`Edit ${outdoor} details`)}]')`, 20000, 'activity row')
    await ev(`document.querySelector('[aria-label=${JSON.stringify(`Edit ${outdoor} details`)}]').click(); return true`)
    await waitFor(`return !!document.querySelector('select[aria-label="Rain plan"]')`, 10000, 'Rain plan field')
    await ev(`const cb=[...document.querySelectorAll('label')].find(l=>/Outdoor activity/.test(l.innerText))?.querySelector('input'); if (cb && !cb.checked) cb.click(); return true`)
    await ev(`const sel=document.querySelector('select[aria-label="Rain plan"]'); const o=[...sel.options].find(o=>o.text===${JSON.stringify(rain)}); if(!o) throw new Error('rain plan option missing: '+${JSON.stringify(rain)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(sel,o.value); sel.dispatchEvent(new Event('change',{bubbles:true})); return true`)
    await click('Save Changes', true, 10000)
    await waitFor(`return !document.querySelector('select[aria-label="Rain plan"]')`, 15000, 'editor closed')

    await nav('Generated Schedule')
    await click('Daily View', true, 10000).catch(() => {})
    await sleep(800)
    const sunny = await cellMap()
    const pills = await ev(`return [...document.querySelectorAll('.day-pill')].filter(__vis).map(b=>b.innerText.trim())`)
    if (pills.length < 2) throw new Error(`need two days to compare (saw ${pills})`)
    await ev(`[...document.querySelectorAll('.day-pill')].filter(__vis)[1].click(); return true`)
    await sleep(600)
    const otherSunny = await cellMap()
    await ev(`[...document.querySelectorAll('.day-pill')].filter(__vis)[0].click(); return true`)
    await sleep(600)

    await click('Rainy day…', true, 10000)
    const dayLabel = await ev(`const b=document.querySelector('[aria-label="Pick a rainy day"] button'); const t=b.innerText.trim(); b.click(); return t`)
    await waitFor(`return /Rainy [^:]+: \\d+ switched/.test(__main())`, 20000, 'rainy day receipt')
    const receipt = await ev(`return (__main().match(/Rainy [A-Z][a-z]+day: [^\\n]*/)||[null])[0]`)
    const rainy = await cellMap()
    if (h.guide) {
      // The guide's picture: the picker open over the note a rainy day leaves. Closed again before the checks go on.
      await click('Rainy day…', true, 10000)
      await waitFor(`return !!document.querySelector('[aria-label="Pick a rainy day"]')`, 5000, 'rainy day picker')
      await guide('rainy-day', 'Rainy day…')
      await click('Rainy day…', true, 5000).catch(() => {})
      await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true`)
      await sleep(400)
    }
    const switched = Object.keys(sunny).filter(k => sunny[k] === outdoor && rainy[k] === rain)
    await ev(`[...document.querySelectorAll('.day-pill')].filter(__vis)[1].click(); return true`)
    await sleep(600)
    const otherRainy = await cellMap()
    await ev(`[...document.querySelectorAll('.day-pill')].filter(__vis)[0].click(); return true`)
    await sleep(600)
    const otherSame = JSON.stringify(otherSunny) === JSON.stringify(otherRainy)

    await click('Versions', true, 10000)
    const saved = await waitFor(`return new RegExp('Before rainy '+${JSON.stringify(dayLabel)}).test(__main())`, 10000, 'version "Before rainy ..."').then(() => true).catch(() => false)
    await ev(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true`)
    await sleep(300)

    await ev(`document.querySelector('[aria-label=Undo]')?.click(); return true`)
    await sleep(1500)
    const undone = await cellMap()
    const restored = JSON.stringify(undone) === JSON.stringify(sunny)

    const note = `${receipt}; version "Before rainy ${dayLabel}" ${saved ? 'saved' : 'MISSING'}; ${outdoor} -> ${rain} on ${switched.length} cell(s); other day ${otherSame ? 'unchanged' : 'CHANGED'}; Undo ${restored ? 'restored every cell' : 'did NOT restore'}`
    if (!saved || switched.length === 0 || !otherSame || !restored) throw new Error(note)
    return note
  })

  await step(17, 'Backup now, change something, Restore from backup…: the change is gone and the rest of the camp is intact (same device, encryption on)', async () => {
    // Restore from backup rejected every encrypted backup as "not a Shoresh backup". The native open dialog
    // is invisible to CDP, so the main process answers it with the backup this step just made. Runs before 13 (quits A).
    await nav('Activities')
    await waitFor(`return document.querySelectorAll('[aria-label^="Edit "][aria-label$=" details"]').length > 0`, 20000, 'activity rows')
    const activityNames = () => ev(`return [...document.querySelectorAll('[aria-label^="Edit "][aria-label$=" details"]')].map(b=>b.getAttribute('aria-label').slice(5, -8)).sort()`)
    const original = await activityNames()
    const dbBackups = () => listBackups(UD).filter((f) => /\.db$/.test(f))
    const backupsBefore = dbBackups()
    await click('Backup now', true, 10000)
    await waitFor(`return /Backup saved/.test(document.body.innerText)`, 30000, 'backup saved')
    const fresh = dbBackups().filter((f) => !backupsBefore.includes(f))
    if (fresh.length !== 1) throw new Error(`expected one new backup .db, saw ${JSON.stringify(fresh)}`)
    const backupFile = path.join(UD, fresh[0])

    const probe = `Restore Probe ${Date.now().toString(36)}`
    await waitFor(`const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>/^\\+?\\s*Add activity$/i.test(b.innerText.trim())); if(!b) return false; b.click(); return true`, 15000, 'Add activity')
    await waitFor(`const i=__inp('input[placeholder$="Swim"]'); if(!i) return false; __set(i, ${JSON.stringify(probe)}); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true`, 10000, 'new activity name')
    await waitFor(`return !!document.querySelector('[aria-label=${JSON.stringify(`Edit ${probe} details`)}]')`, 15000, 'probe activity added')

    await h.mainEval(`(()=>{const r=process.getBuiltinModule('module').createRequire('/x.js'); const {dialog}=r('electron'); dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(backupFile)}]}); return 'hooked'})()`)
    await click('Restore from backup…', true, 10000)
    const picked = await waitFor(`const a=document.querySelector('[role=alertdialog][aria-label="Confirm restore"]'); if(a) return 'confirm'; const m=document.querySelector('[role=alert]'); return m ? 'REFUSED: '+m.innerText : false`, 20000, 'confirm restore or a refusal')
    if (picked !== 'confirm') throw new Error(`the encrypted backup was not accepted: ${picked}`)
    await click('Restore', true, 10000)
    await sleep(3000)
    await waitFor(`return document.body.innerText.includes('Log out') || !!__inp('#login-name')`, 120000, 'app back after restore')
    if (!(await ev(`return document.body.innerText.includes('Log out')`))) { await h.signInIfAsked(); await waitFor(`return document.body.innerText.includes('Log out')`, 30000, 'signed in') }

    await nav('Activities')
    await waitFor(`return document.querySelectorAll('[aria-label^="Edit "][aria-label$=" details"]').length > 0`, 20000, 'activity rows')
    const after = await activityNames()
    const gone = !after.includes(probe)
    const intact = JSON.stringify(after) === JSON.stringify(original)
    const note = `restored from ${fresh[0]}; "${probe}" ${gone ? 'gone' : 'STILL THERE'}; ${after.length} of ${original.length} original activities ${intact ? 'back unchanged' : 'DIFFER'}`
    if (!gone || !intact) throw new Error(note)
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

  const devicesScreen = async () => {
    await openDevices()
    await waitFor(`return /Add a device|Stop adding devices/.test(__main())`, 20000, 'Devices')
  }
  // Pair peer B onto A exactly as step 13 does: camp code on A, join on B, Approve on A, sign in on B.
  const pairPeer = async (B) => {
      await devicesScreen()
      if (!await ev(`return /Stop adding devices/.test(__main())`)) await click('Add a device', true, 10000)
      const code = await waitFor(`const m=__main().match(/\\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\\b/); return m && m[1]`, 30000, 'camp code')
      await B.waitFor(`return document.body.innerText.includes('Join with a camp code')`, 120000, 'R: mode-select')
      await B.click('Join with a camp code', false)
      await B.waitFor(`const i=__inp('input[placeholder$="K4P7-2MRQ"]'); if(!i) return false; __set(i, ${JSON.stringify(code)}); return true`, 15000, 'R: code field')
      await sleep(300); await B.click('Continue', true, 10000)
      await waitFor(`return [...document.querySelectorAll('button')].filter(__vis).some(b=>b.innerText.trim()==='Approve'&&!b.disabled)`, 90000, "R's pairing request on A")
      await ev(`[...document.querySelectorAll('button')].filter(__vis).find(b=>b.innerText.trim()==='Approve'&&!b.disabled).click(); return true`)
      await B.waitFor(`return !!__inp('#join-name')`, 90000, 'R: sign-in after approval')
      await B.ev(`__set(__inp('#join-name'), ${JSON.stringify(h.ADMIN)}); __set(__inp('#join-pin'), ${JSON.stringify(h.PIN)}); return true`)
      await sleep(300); await B.click('Sign in', true, 10000)
      await B.waitFor(`return __click('Continue', true) || document.body.innerText.includes('Log out')`, 120000, 'R: camp arrived')
      await B.waitFor(`return document.body.innerText.includes('Log out')`, 60000, 'R: signed in')
  }

  await step(19, 'A removed device learns it: pair B, Revoke B on A, relaunch B on its own data; B shows it was removed within 90s, A stays signed in', async () => {
    featureIn(1013, 'A removed device learns its removal (#1013)')
    const B = await h.launchPeer('R', h.PORT + 70)
    try {
      await pairPeer(B)
      // Revoke B on A. The only Revoke button is B's row: the host's own row never has one.
      await devicesScreen()
      await waitFor(`const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>b.innerText.trim()==='Revoke'&&!b.disabled); if(!b) return false; b.click(); return true`, 30000, 'Revoke for R on A')
      await waitFor(`return /Revoked|No longer allowed/.test(__main())`, 30000, 'A lists R as revoked')
      // Relaunch B on its OWN data so it authenticates afresh, then wait for it to learn.
      const ud = B.ud
      await B.stop()
      const B2 = await h.launchPeer('R2', h.PORT + 70, { reuse: ud })
      try {
        await B2.waitFor(`return /Log out|Sign in/.test(document.body.innerText)`, 120000, 'R2: up')
        if (await B2.ev(`return !!__inp('#login-pin') || !!__inp('input[type=password]')`)) {
          await B2.ev(`const n=__inp('#login-name')||__inp('input[type=text]'); if(n) __set(n, ${JSON.stringify(h.ADMIN)}); __set(__inp('#login-pin')||__inp('input[type=password]'), ${JSON.stringify(h.PIN)}); return true`)
          await sleep(300); await B2.click('Sign in', true, 10000).catch(() => {})
        }
        const t0 = Date.now()
        const seen = await B2.waitFor(`const t=document.body.innerText; return (t.includes('removed from this camp') && 'sidebar flag "removed from this camp"') || (t.includes('This computer was removed from the camp.') && 'sign-in screen "This computer was removed from the camp."')`, 90000, 'R2 shows it was removed')
        const learnedS = ((Date.now() - t0) / 1000).toFixed(1)
        await B2.shot('removed')
        // A is unaffected: still signed in, not shown the removed state.
        const aOk = await ev(`const t=document.body.innerText; return t.includes('Log out') && !t.includes('This computer was removed from the camp.') && !t.includes('removed from this camp')`)
        if (!aOk) throw new Error(`R learned its removal (${seen}, ${learnedS}s) but A is no longer fine`)
        return `R removed on A; after relaunch R showed the ${seen} within ${learnedS}s; A stayed signed in`
      } finally { await B2.stop() }
    } finally { await B.stop().catch(() => {}) }
  })

  await step('19b', 'Start fresh on a removed computer: R learns it was removed, Start fresh clears it, R relaunches empty, joins again by code, A approves, R sees a change made on A', async () => {
    featureInBranch('claude/start-fresh', 'Start fresh on this computer', '19b')
    const B = await h.launchPeer('S', h.PORT + 80)
    try {
      await pairPeer(B)
      await devicesScreen()
      await waitFor(`const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>b.innerText.trim()==='Revoke'&&!b.disabled); if(!b) return false; b.click(); return true`, 30000, 'Revoke for S on A')
      await waitFor(`return /Revoked|No longer allowed/.test(__main())`, 30000, 'A lists S as revoked')
      const ud = B.ud
      await B.stop()
      const B2 = await h.launchPeer('S2', h.PORT + 80, { reuse: ud })
      try {
        await B2.waitFor(`return /Log out|Sign in/.test(document.body.innerText)`, 120000, 'S2: up')
        await B2.waitFor(`return [...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Start fresh on this computer')`, 90000, 'S2 offers Start fresh')
        await B2.shot('start-fresh-offered')
        await B2.click('Start fresh on this computer', true, 10000)
        await B2.waitFor(`return /clears Shoresh on this computer only/.test(document.body.innerText)`, 10000, 'S2 confirm text')
        if (await B2.ev(`return document.body.innerText.includes('Join with a camp code')`)) throw new Error('Start fresh acted on the first click')
        await B2.click('Yes, start fresh', true, 10000)
        const ms = await B2.adopt()
        await B2.waitFor(`return document.body.innerText.includes('Join with a camp code')`, 120000, 'S2: empty, back on mode-select')
        const leftover = fs.readdirSync(ud).filter((n) => /^(\.reset-|local-reset\.journal)/.test(n))
        if (leftover.length) throw new Error(`the wipe left ${JSON.stringify(leftover)} in S's userData`)
        await B2.shot('after-start-fresh')
        // Join again by code as a brand-new device.
        await devicesScreen()
        if (!await ev(`return /Stop adding devices/.test(__main())`)) await click('Add a device', true, 10000)
        const code = await waitFor(`const m=__main().match(/\\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\\b/); return m && m[1]`, 30000, 'camp code')
        await B2.click('Join with a camp code', false)
        await B2.waitFor(`const i=__inp('input[placeholder$="K4P7-2MRQ"]'); if(!i) return false; __set(i, ${JSON.stringify(code)}); return true`, 15000, 'S2: code field')
        await sleep(300); await B2.click('Continue', true, 10000)
        await waitFor(`return [...document.querySelectorAll('button')].filter(__vis).some(b=>b.innerText.trim()==='Approve'&&!b.disabled)`, 90000, "S2's new pairing request on A")
        await ev(`[...document.querySelectorAll('button')].filter(__vis).find(b=>b.innerText.trim()==='Approve'&&!b.disabled).click(); return true`)
        await B2.waitFor(`return !!__inp('#join-name')`, 90000, 'S2: sign-in after approval')
        await B2.ev(`__set(__inp('#join-name'), ${JSON.stringify(h.ADMIN)}); __set(__inp('#join-pin'), ${JSON.stringify(h.PIN)}); return true`)
        await sleep(300); await B2.click('Sign in', true, 10000)
        await B2.waitFor(`return __click('Continue', true) || document.body.innerText.includes('Log out')`, 120000, 'S2: camp arrived')
        await B2.waitFor(`return document.body.innerText.includes('Log out')`, 60000, 'S2: signed in')
        // A change made on A reaches the fresh S2.
        const probe = `Fresh Start ${Date.now().toString(36)}`
        await nav('Locations')
        await waitFor(`const i=__inp('input[placeholder$="Pool"]'); if(!i) return false; __set(i, ${JSON.stringify(probe)}); return true`, 15000, 'Locations add row')
        await sleep(200); await click('+ Add', true, 10000)
        await waitFor(`return __main().includes(${JSON.stringify(probe)})`, 15000, 'probe added on A')
        await B2.nav('Locations')
        await B2.waitFor(`return __main().includes(${JSON.stringify(probe)})`, 90000, 'S2 sees the change made on A')
        return `S removed on A; Start fresh needed two clicks; relaunched empty in ${(ms / 1000).toFixed(1)}s; rejoined by code as a new device and saw "${probe}" made on A`
      } finally { await B2.stop() }
    } finally { await B.stop().catch(() => {}) }
  })

  await step(20, 'Save whole camp, then Open a saved camp on a new device: both schedules, events and locations carry over; no sign-in or device does', async () => {
    // T381 / docs/adr/2026-10-13-whole-camp-file-save-and-open.md section 7. The native dialogs are invisible to CDP,
    // so each app's main process answers them with this run's file. Needs A running (runs before 13, which quits A),
    // and a build with the feature (the PR from claude/whole-camp-file-adr).
    featureInBranch('claude/whole-camp-file-adr', 'Whole-camp file', 20)
    const saved = path.join(h.RUN, 'whole-camp.shoresh-camp')
    fs.rmSync(saved, { force: true })
    const hook = (kind) => `(()=>{const r=process.getBuiltinModule('module').createRequire('/x.js'); const {dialog}=r('electron'); ${kind === 'save'
      ? `dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(saved)}})`
      : `dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(saved)}]})`}; return 'hooked'})()`
    const lines = (c) => c.ev(`return __main().split('\\n').map(l=>l.trim()).filter(Boolean)`)
    const read = async (c) => {
      await c.nav('Generated Schedule')
      const gen = await c.waitFor(STATS, 120000, 'Generated stats')
      await c.nav('Manual Build')
      const man = await c.waitFor(STATS, 60000, 'Manual stats')
      const events = [...(await listNamesOn(c, 'Fixed Events')), ...(await listNamesOn(c, 'Recurring Events'))].map((r) => JSON.stringify(r)).sort()
      await c.nav('Locations')
      await c.waitFor(`return !/No locations yet/.test(__main())`, 15000, 'locations list')
      return { gen, man, events, locations: await lines(c) }
    }
    const before = await read({ nav, waitFor, ev })

    await h.mainEval(hook('save'))
    await click('Save whole camp', true, 10000)
    const warning = await waitFor(`const a=document.querySelector('[role=alertdialog][aria-label="Confirm save whole camp"]'); return a ? a.innerText : false`, 10000, 'save confirmation')
    for (const sentence of ["This file isn't protected — keep it somewhere private.", "Camper lists and elective choices aren't included; import them again after opening."]) {
      if (!warning.includes(sentence)) throw new Error(`the save confirmation lacks "${sentence}": ${warning}`)
    }
    await h.shot('s20-save-warning')
    await click('Choose where to save', true, 10000)
    // The confirmation is in the sidebar footer (SaveCampControl), not the main area.
    const savedLine = await waitFor(`const m=document.body.innerText.match(/Saved [^\\n]*\\.shoresh-camp[^\\n]*/); return m && m[0]`, 60000, 'saved confirmation')
    await h.shot('s20-saved')
    if (!fs.existsSync(saved) || fs.statSync(saved).size < 1000) throw new Error('the camp file was not written')
    if (fs.readdirSync(h.RUN).some((f) => f.includes('.tmp-'))) throw new Error('a temp file was left beside the camp file')
    const file = JSON.parse(fs.readFileSync(saved, 'utf8'))
    for (const gone of ['users', 'device_roster', 'camp_authority_log', 'campers']) if (file.entities?.[gone]) throw new Error(`the file carries ${gone}`)
    if (JSON.stringify(file).includes(h.PIN) || /signing_secret|pin_hash/.test(JSON.stringify(file))) throw new Error('the file carries a secret')

    const W = await h.launchPeer('W', h.PORT + 60)
    try {
      await W.mainEval(hook('open'))
      await W.waitFor(`return document.body.innerText.includes('Open a saved camp')`, 120000, 'W: start screen')
      await W.shot('s20-start-screen')
      await W.click('Open a saved camp', false)
      await W.click('Choose a camp file', true, 15000)
      const SECOND_PIN = '715204'
      await W.waitFor(`const n=document.getElementById('bootstrap-camp-name'); if(!n || !n.value) return false; __set(document.getElementById('bootstrap-admin-name'), 'Second Director'); __set(document.getElementById('bootstrap-admin-pin'), ${JSON.stringify(SECOND_PIN)}); return true`, 15000, 'W: form prefilled from the file')
      await sleep(300); await W.click('Open camp', true, 10000)
      await W.waitFor(`return document.body.innerText.includes('Log out')`, 240000, 'W: signed in to the opened camp')
      if (await W.ev(`return /didn.t finish opening|Couldn.t open that camp/.test(document.body.innerText)`)) throw new Error('W shows a load-incomplete or failure screen')
      const after = await read(W)
      await W.shot('s20-opened')
      const problems = []
      for (const k of ['gen', 'man']) if (before[k].placed !== after[k].placed || before[k].total !== after[k].total) problems.push(`${k} placed ${before[k].placed}/${before[k].total} -> ${after[k].placed}/${after[k].total}`)
      if (JSON.stringify(before.events) !== JSON.stringify(after.events)) problems.push(`events differ: ${before.events.length} -> ${after.events.length}`)
      const gone = before.locations.filter((l) => !after.locations.includes(l)), added = after.locations.filter((l) => !before.locations.includes(l))
      if (gone.length || added.length) problems.push(`locations differ: missing ${JSON.stringify(gone.slice(0, 3))}, extra ${JSON.stringify(added.slice(0, 3))}`)
      // Derived ids resolve: a regenerated Generated schedule still places.
      await W.nav('Generated Schedule')
      const regen = await W.ev(`const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>/^(Rebuild|Re-?generate|Generate again)$/i.test(b.innerText.trim())); if(!b) return 'NO REGENERATE BUTTON: '+[...document.querySelectorAll('button')].filter(__vis).map(b=>b.innerText.trim()).filter(Boolean).slice(0,25).join(' | '); b.click(); return 'clicked'`)
      if (regen !== 'clicked') problems.push(regen)
      else {
        // The app's button is "Rebuild", and it asks before replacing the schedule ("Rebuild it").
        await sleep(600); await W.click('Rebuild it', true, 5000).catch(() => {})
        await sleep(1500)
        const again = await W.waitFor(STATS, 120000, 'W: regenerated stats')
        if (!(again.placed > 0)) problems.push('regenerating on the opened camp placed nothing')
      }
      // No sign-in carries over: the first camp's director and PIN do not work on the opened camp.
      await W.click('Log out', true, 10000)
      await W.waitFor(`return !!__inp('#login-name')`, 20000, 'W: sign-in screen')
      await W.ev(`__set(__inp('#login-name'), ${JSON.stringify(h.ADMIN)}); __set(__inp('#login-pin'), ${JSON.stringify(h.PIN)}); setTimeout(()=>__click('Sign in', true),300); return true`)
      await sleep(4000)
      if (await W.ev(`return document.body.innerText.includes('Log out')`)) problems.push("the first camp's director and PIN signed in to the opened camp")
      await W.shot('s20-no-identity')
      if (problems.length) throw new Error(problems.join('; '))
      return `${savedLine}; opened in a new device as a new camp: Generated ${after.gen.placed}/${after.gen.total} and Manual ${after.man.placed}/${after.man.total} placed (as before), ${after.events.length} events and ${after.locations.length} location lines match, a regeneration places, the first camp's sign-in is refused`
    } finally {
      await W.stop()
    }
  })

  await step(15, 'Two camps on one network: both hosts stay signed in, neither admits the other, no data crosses', async () => {
    // Security batch / keeper 2026-10-13, after #991 (a peer's refusal read as this device's removal). A second,
    // unrelated camp on the same LAN is the everyday case at a shared site: both hosts advertise, discover each
    // other, and must refuse each other quietly. Runs before 13, which quits A.
    const X = await h.launchPeer('X', h.PORT + 30)
    const lost = `return document.body.innerText.includes('This computer was removed from the camp.') || !document.body.innerText.includes('Log out')`
    try {
      await X.waitFor(`return document.body.innerText.includes('Start a new camp')`, 120000, 'X: mode-select')
      await X.click('Start a new camp', false)
      await X.waitFor(`const n=document.getElementById('bootstrap-camp-name'); if(!n) return false; __set(n, 'Other Camp'); __set(document.getElementById('bootstrap-admin-name'), 'Other Dir'); __set(document.getElementById('bootstrap-admin-pin'), ${JSON.stringify(h.PIN)}); return true`, 10000, 'X: bootstrap form')
      await sleep(300); await X.click('Create camp', true, 10000)
      await X.waitFor(`return document.body.innerText.includes('Log out') && document.body.innerText.includes('Other Camp')`, 60000, 'X: signed in to Other Camp')
      // Both hosts advertise for joiners (the most exposed state), each with a location only it has.
      const tag = Date.now().toString(36)
      const addLoc = async (c, name) => {
        await c.nav('Locations')
        await c.waitFor(`const i=__inp('input[placeholder$="Pool"]'); if(!i) return false; __set(i, ${JSON.stringify(name)}); return true`, 15000, 'Locations add row')
        await sleep(200); await c.click('+ Add', true, 10000)
        await c.waitFor(`return __main().includes(${JSON.stringify(name)})`, 15000, `${name} added`)
      }
      const A = { nav, waitFor, click, ev }
      await addLoc(A, `OnlyA ${tag}`); await addLoc(X, `OnlyX ${tag}`)
      await openDevices(); if (!await ev(`return /Stop adding devices/.test(__main())`)) await click('Add a device', true, 10000)
      await X.nav('Settings').catch(() => {}); await X.click('Devices', true, 10000).catch(() => {})
      if (!await X.ev(`return /Stop adding devices/.test(__main())`).catch(() => false)) await X.click('Add a device', true, 10000).catch(() => {})
      // 90s together on one LAN, sampled every 3s.
      const t0 = Date.now(); const problems = []
      while (Date.now() - t0 < 90000 && !problems.length) {
        if (await ev(lost).catch(() => false)) problems.push('A lost its sign-in')
        if (await X.ev(lost).catch(() => false)) problems.push('X lost its sign-in')
        if (await ev(`return [...document.querySelectorAll('button')].filter(__vis).some(b=>b.innerText.trim()==='Approve')`).catch(() => false)) problems.push('A was offered a pairing request (from X?)')
        if (await X.ev(`return [...document.querySelectorAll('button')].filter(__vis).some(b=>b.innerText.trim()==='Approve')`).catch(() => false)) problems.push('X was offered a pairing request (from A?)')
        await sleep(3000)
      }
      // Silence from the logs, not only the screens: neither host may have discovered, dialed or authenticated
      // the other in the window. Different camps use different camp-scoped mDNS tags (sync/automerge/discovery.js),
      // so ANY such event naming the other is a failure.
      const netEvents = (file, from) => { try { return fs.readFileSync(path.join(h.RUN, file), 'utf8').split('\n').filter((l) => /"event":"(PEER_DISCOVERED|DIAL_[A-Z_]+|AUTH_[A-Z_]+|TRUST_CHECK_[A-Z_]+)"/.test(l)).filter((l) => (JSON.parse(l.slice(l.indexOf('{'))).ts ?? 0) >= from) } catch { return [] } }
      const aSaw = netEvents('app.log', t0), xSaw = netEvents('app-X.log', 0)
      if (aSaw.length) problems.push(`A logged ${aSaw.length} discovery/auth event(s) with no same-camp peer present: ${aSaw[0].slice(0, 160)}`)
      if (xSaw.length) problems.push(`X logged ${xSaw.length} discovery/auth event(s): ${xSaw[0].slice(0, 160)}`)
      // Control: discovery works on this machine and network. Y asks to join A by code while A is still
      // advertising; A must be offered Y's request. Without it, silence above proves nothing ("not exercised").
      const Y = await h.launchPeer('Y', h.PORT + 40)
      try {
        const code = await waitFor(`const m=__main().match(/\\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\\b/); return m && m[1]`, 30000, 'camp code on A')
        await Y.waitFor(`return document.body.innerText.includes('Join with a camp code')`, 120000, 'Y: mode-select')
        await Y.click('Join with a camp code', false)
        await Y.waitFor(`const i=__inp('input[placeholder$="K4P7-2MRQ"]'); if(!i) return false; __set(i, ${JSON.stringify(code)}); return true`, 15000, 'Y: code field')
        await sleep(300); await Y.click('Continue', true, 10000)
        const seen = await waitFor(`return [...document.querySelectorAll('button')].filter(__vis).some(b=>b.innerText.trim()==='Approve')`, 90000, 'control').catch(() => false)
        if (!seen) throw new Error('not exercised: a same-camp join request never reached A within 90s, so discovery does not work on this machine/network (VPN?) and the silence between the two camps proves nothing')
        // Deny the control's request: left pending, a later step would approve Y instead of its own peer.
        await ev(`const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>b.innerText.trim()==='Deny'); if(b) b.click(); return !!b`)
        await waitFor(`return ![...document.querySelectorAll('button')].filter(__vis).some(b=>b.innerText.trim()==='Approve')`, 15000, "control's request denied")
      } finally { await Y.stop() }
      await click('Stop adding devices', true, 5000).catch(() => {})
      await nav('Locations'); await X.nav('Locations')
      if (await ev(`return __main().includes(${JSON.stringify(`OnlyX ${tag}`)})`)) problems.push("X's location reached A")
      if (await X.ev(`return __main().includes(${JSON.stringify(`OnlyA ${tag}`)})`)) problems.push("A's location reached X")
      if (!await ev(`return __main().includes(${JSON.stringify(`OnlyA ${tag}`)})`)) problems.push("A's own location is missing (detection path broken)")
      await h.shot('s15'); await X.shot('s15')
      if (problems.length) throw new Error(problems.join('; '))
      return `A ("Audit Camp") and X ("Other Camp") both hosting and advertising on one LAN for ${((Date.now() - t0) / 1000).toFixed(0)}s: both stayed signed in, no pairing request on either, neither location crossed, neither host logged discovering or dialing the other; control: a same-camp join request reached A`
    } finally {
      await X.stop()
    }
  })

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
      await peer.waitFor(`const i=__inp('input[placeholder$="K4P7-2MRQ"]'); if(!i) return false; __set(i, ${JSON.stringify(code)}); return true`, 15000, `${peer.label}: code field`)
      await sleep(300); await peer.click('Continue', true, 10000)
      h.log(`[t13] ${new Date().toISOString()} ${peer.label}: pairing request sent (code ${code})`)
      await waitFor(`return [...document.querySelectorAll('button')].filter(__vis).some(b=>b.innerText.trim()==='Approve'&&!b.disabled)`, 90000, `${peer.label}'s pairing request on A`)
      await ev(`[...document.querySelectorAll('button')].filter(__vis).find(b=>b.innerText.trim()==='Approve'&&!b.disabled).click(); return true`)
      h.log(`[t13] ${new Date().toISOString()} A: Approve clicked for ${peer.label}`)
      await peer.waitFor(`return !!__inp('#join-name')`, 90000, `${peer.label}: sign-in after approval`)
      await peer.ev(`__set(__inp('#join-name'), ${JSON.stringify(h.ADMIN)}); __set(__inp('#join-pin'), ${JSON.stringify(h.PIN)}); return true`)
      await sleep(300); await peer.click('Sign in', true, 10000)
      // The join completes only once the camp document has arrived from A (the host must stay on until then).
      await peer.waitFor(`return __click('Continue', true) || document.body.innerText.includes('Log out')`, 120000, `${peer.label}: camp arrived`)
      await peer.waitFor(`return document.body.innerText.includes('Log out')`, 60000, `${peer.label}: signed in`)
      h.log(`[t13] ${new Date().toISOString()} ${peer.label}: first sign-in complete`)
      return code
    }
    // Timeline for diagnosis (T376 host self-sign-out): the instant A shows it lost access is logged.
    let signedOutAt = null
    const watch = setInterval(() => { if (!signedOutAt) ev(`return document.body.innerText.includes('This computer was removed from the camp.')`).then((v) => { if (v && !signedOutAt) { signedOutAt = new Date().toISOString(); h.log(`[t13] ${signedOutAt} A: shows "removed from the camp"`) } }).catch(() => {}) }, 500)
    h.log(`[t13] ${new Date().toISOString()} launching peers B and C`)
    const B = await h.launchPeer('B', h.PORT + 10), C = await h.launchPeer('C', h.PORT + 20)
    h.log(`[t13] ${new Date().toISOString()} peers B and C up`)
    try {
      const codeB = await pair(B), codeC = await pair(C)
      await click('Stop adding devices', true, 5000).catch(() => {})
      // B adds a location; seconds until C shows it (null if not within 60s). C re-opens the screen to re-read.
      const editReaches = async (tag) => {
        const name = `${tag} ${Date.now().toString(36)}`
        await B.nav('Locations')
        await B.waitFor(`const i=__inp('input[placeholder$="Pool"]'); if(!i) return false; __set(i, ${JSON.stringify(name)}); return true`, 15000, 'B: Locations add row')
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
      clearInterval(watch)
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
