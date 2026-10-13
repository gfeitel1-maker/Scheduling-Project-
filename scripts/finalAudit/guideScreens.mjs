// Director-guide screens that no audit step stands on (guide mode only; called by step 18 in steps.mjs).
// Each screen is staged through the real UI and shot with guide(name, show). A screen that fails is
// recorded and the rest still run; guideShots.mjs then names every marker left without a fresh image.
//
// Two stand-ins, both outside the app's own logic:
// - Restore from backup picks its file with a native dialog, which CDP cannot drive. The main process's
//   dialog.showOpenDialog is replaced, for that one click, by a function returning a backup this run made.
// - A removed computer is shown through a real removal: B joins, A revokes B, B relaunches and learns it, and its
//   "This computer was removed from the camp" screen and the Start fresh confirm are shot. The confirm is cancelled;
//   the guide run never wipes anything.
import path from 'node:path'

export async function guideScreens(h, { importFile, done, openDevices, STATS }) {
  const { ev, waitFor, click, nav, setFile, sleep, guide } = h
  const failed = []
  const shot = async (name, fn) => { try { await fn() } catch (e) { failed.push(`${name}: ${e.message.slice(0, 200)}`); h.log(`  guide screen ${name} FAILED: ${e.message.slice(0, 300)}`); const t = await ev(`return document.body.innerText.replace(/\\s+/g,' ').slice(0,1500)`).catch(() => ''); h.log(`    screen: ${t}`) } }
  const CAMPB = h.CAMPB
  const mouse = (type, x, y) => h.app().send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  const centre = (sel) => ev(`const e=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(__vis)[0]; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}`)
  const toTop = () => ev(`document.querySelectorAll('*').forEach(e=>{ if(e.scrollTop) e.scrollTop=0 }); window.scrollTo(0,0); return true`)

  // GUIDE_ONLY_PEER=1 runs only the two-device section (a removal-propagation repro, without the rest).
  if (process.env.GUIDE_ONLY_PEER) { await importFile(CAMPB); await done(); return peerSection() }

  // --- Import: drop zone, preview, questions (a Replace import of campB, so Manual Build starts blank) ---
  await shot('import/drop-zone', async () => {
    await nav('Roots'); await click('Import last year', false, 20000)
    await waitFor(`return /Drop schedule here/.test(__main())`, 15000, 'drop zone')
    await guide('import/drop-zone', 'Drop schedule here')
  })
  await shot('import/preview', async () => {
    await setFile(CAMPB)
    await waitFor(`return !!__btn('Review ') || !!__btn('Replace with ')`, 60000, 'preview')
    if (await ev(`return !!__btn('○ Replace them', false)`)) { await click('○ Replace them', false, 10000); await sleep(500) }
    await toTop(); await guide('import/preview')
  })
  await shot('reconcile/questions', async () => {
    await waitFor(`const b=__btn('Replace with ')||__btn('Review '); if(!b||b.disabled) return false; b.click(); return true`, 15000, 'Review button')
    await waitFor(`return /questions? answered|Needs your attention/.test(__main())`, 60000, 'questions')
    await toTop(); await guide('reconcile/questions', 'Needs your attention')
  })
  // Finish the import: skip the open questions, commit.
  await ev(`let n=0; for(let i=0;i<200;i++){ const b=__btn('Skip this field',true)||[...document.querySelectorAll('button')].filter(__vis).find(b=>/^Skip .* for now/.test(b.innerText.trim())); if(!b) break; b.click(); n++; await new Promise(r=>setTimeout(r,60)) } return n`, 60000)
  await waitFor(`return __click('Use what Shoresh understood', true) || __click('Import the rest', false) || __click('Add to camp', false) || __click('Use this setup', true)`, 30000, 'commit')
  await waitFor(`return /Imported \\d+ records|Setup replaced and ready/.test(__main())`, 120000, 'import done'); await done()

  // --- Generated: first week ---
  await shot('generated/first-week', async () => {
    await nav('Generated Schedule')
    if (await ev(`return !!__btn('Generate a schedule', true)`)) await click('Generate a schedule', true)
    else { await click('Rebuild', true); if (await ev(`return !!__btn('Rebuild it', true)`)) await click('Rebuild it', true) }
    await waitFor(STATS, 120000, 'Generate stats')
    await click('Group View', true, 5000).catch(() => {}); await sleep(800); await toTop()
    await guide('generated/first-week')
  })

  // --- Electives: a set with offerings, the rail, the cell editor, the camper preview ---
  const SET = 'Afternoon Chugim'
  await shot('elective-set/offerings', async () => {
    await nav('Electives')
    if (!await ev(`return __main().includes(${JSON.stringify(SET)})`)) {
      await waitFor(`const i=__inp('input[placeholder$="Afternoon Chugim"]'); if(!i) return false; __set(i, ${JSON.stringify(SET)}); return true`, 10000, 'new set name')
      await sleep(200); await click('+ Add', true, 10000)
      await waitFor(`return __main().includes(${JSON.stringify(SET)})`, 10000, 'set added')
    }
    await ev(`const row=[...document.querySelectorAll('tr,div')].filter(__vis).find(r=>r.innerText.startsWith(${JSON.stringify(SET)})&&[...r.querySelectorAll('button')].some(b=>b.innerText.trim()==='Open')); [...row.querySelectorAll('button')].find(b=>b.innerText.trim()==='Open').click(); return true`)
    await waitFor(`return !!document.querySelector('input[aria-label="Search or add an activity"]')`, 15000, 'set detail')
    for (const n of ['Archery', 'Drama', 'Music']) {
      await ev(`const i=document.querySelector('input[aria-label="Search or add an activity"]'); i.focus(); __set(i, ${JSON.stringify(n)}); return true`)
      await sleep(400)
      await ev(`const i=document.querySelector('input[aria-label="Search or add an activity"]'); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true`)
      await sleep(800)
    }
    await toTop(); await guide('elective-set/offerings', 'Add Offering')
  })
  // --- Manual Build (blank after the Replace): mid-drag from the Activities panel onto an Open cell ---
  await shot('manual-build/dragging', async () => {
    await nav('Manual Build'); await sleep(800)
    if (await ev(`return !!__btn('Start a blank week', true)`)) { await click('Start a blank week', true, 10000); await sleep(1200) }
    await click('Group View', true, 5000).catch(() => {}); await sleep(600)
    await waitFor(`return document.querySelectorAll('[role=gridcell][data-empty]').length > 0`, 15000, 'empty cells')
    const a = await centre('[data-palette-activity]:not([disabled])')
    const b = await ev(`const e=[...document.querySelectorAll('[role=gridcell][data-empty]:not([data-collapsed])')].filter(__vis)[0]; if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}`)
    if (!a || !b) throw new Error(`palette item ${!!a}, Open cell ${!!b}; grid probe: ${await ev(`const m=document.querySelector('main')||document.body; const g=m.querySelector('[role=grid],table,.schedule-grid,[class*=grid]'); return JSON.stringify({grid:(g?.outerHTML||'none').slice(0,700), roles:[...new Set([...m.querySelectorAll('[role]')].map(e=>e.getAttribute('role')))], datas:[...new Set([...m.querySelectorAll('*')].flatMap(e=>[...e.attributes].map(a=>a.name).filter(n=>n.startsWith('data-'))))].slice(0,30)})`)}`)
    await mouse('mousePressed', a.x, a.y)
    for (let i = 1; i <= 14; i++) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / 14, a.y + (b.y - a.y) * i / 14); await sleep(30) }
    await waitFor(`return !!document.querySelector('[data-drag-over]')`, 5000, 'drag over a cell').catch(() => {})
    await guide('manual-build/dragging')
    await mouse('mouseReleased', b.x, b.y); await sleep(1000)
  })

  // --- Manual Build: an overlap dot (one activity, max 1 group at once, in two groups in one block) ---
  await shot('manual-build/overlap-dot', async () => {
    // Daily View shows every group in a block: drag one activity into two empty cells of the same block, then
    // let it take one group at a time, so the two overlap.
    await click('Daily View', true, 5000).catch(() => {}); await sleep(800)
    const pair = await ev(`const cs=[...document.querySelectorAll('[role=gridcell][data-empty]:not([data-collapsed])')].filter(__vis).map(c=>({key:c.dataset.cellKey})); const by={}; for(const c of cs){ const [g,d,b]=c.key.split('|'); (by[d+'|'+b]=by[d+'|'+b]||[]).push(c.key) } const k=Object.keys(by).find(k=>by[k].length>=2); return k?by[k].slice(0,2):null`)
    if (!pair) throw new Error('no block with two empty cells')
    const name = await ev(`const e=[...document.querySelectorAll('[data-palette-activity]:not([disabled])')].filter(__vis)[0]; return e.innerText.trim().split('\\n')[0]`)
    const at = (key) => ev(`const e=document.querySelector('[data-cell-key="'+${JSON.stringify(key)}+'"]'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}`)
    // Placed through the cell editor (double-click, type, Enter): steadier than two more drags.
    for (const key of pair) {
      const b = await at(key)
      await h.app().send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 2 })
      await h.app().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 2 })
      await waitFor(`return !!document.querySelector('.cell-inline-editor-input')`, 5000, 'cell editor')
      await ev(`const i=document.querySelector('.cell-inline-editor-input'); i.focus(); __set(i, ${JSON.stringify(name)}); return true`)
      await sleep(300)
      await ev(`document.querySelector('.cell-inline-editor-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true`)
      await sleep(1000)
    }
    await nav('Activities')
    await waitFor(`const b=document.querySelector('[aria-label=${JSON.stringify(`Edit ${name} details`)}]'); if(!b) return false; b.click(); return true`, 15000, `edit ${name}`)
    const labelFound = await ev(`const l=[...document.querySelectorAll('label')].find(l=>/Allow multiple groups/.test(l.innerText)); const i=l&&l.querySelector('input'); const was=i&&i.checked; if(i&&i.checked) i.click(); return l ? (was ? 'unticked' : 'already unticked') : 'NOT FOUND'`)
    await click('Save Changes', true, 10000)
    await nav('Manual Build'); await sleep(800)
    await click('Daily View', true, 5000).catch(() => {}); await sleep(1000)
    await waitFor(`return !!document.querySelector('.flag--overlap')`, 15000, 'overlap dot').catch(async (e) => { throw new Error(`no overlap dot; ${name} cells: ${await ev(`return ${JSON.stringify(pair)}.map(k=>(document.querySelector('[data-cell-key="'+k+'"]')?.innerText||'?').replace(/\\s+/g,' ')).join(' / ')`)}; stats: ${await ev(`return (__main().match(/\\d+ of \\d+[^]{0,120}/)||[''])[0].replace(/\\s+/g,' ')`)}; editor label found: ${labelFound}`) })
    await ev(`document.querySelector('.flag--overlap').scrollIntoView({block:'center'}); return true`)
    await guide('manual-build/overlap-dot')
  })

  await shot('schedule/elective-sets-in-rail', async () => {
    await nav('Manual Build'); await sleep(1000)
    await waitFor(`return /Elective sets/i.test(document.body.innerText)`, 10000, 'Elective sets in the rail')
    await guide('schedule/elective-sets-in-rail', 'Elective sets')
  })
  await shot('schedule/cell-editor-elective-sets', async () => {
    const p = await ev(`const e=[...document.querySelectorAll('[role=gridcell][data-empty]:not([data-collapsed])')].filter(__vis)[0]; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}`)
    if (!p) throw new Error('no Open cell')
    await h.app().send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 2 })
    await h.app().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 2 })
    await waitFor(`return !!document.querySelector('.cell-inline-editor-suggestions[role=listbox]')`, 10000, 'cell editor with suggestions')
    await guide('schedule/cell-editor-elective-sets')
    // Choosing the set places it on this schedule, which the camper import needs.
    await ev(`const o=[...document.querySelectorAll('.cell-inline-editor-suggestions [role=option]')].find(o=>o.innerText.includes(${JSON.stringify(SET)})); if(o){ o.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); o.click() } return !!o`)
    await sleep(1200)
  })
  await shot('electives/camper-import-preview', async () => {
    await nav('Electives'); await sleep(600)
    await ev(`const row=[...document.querySelectorAll('tr,div')].filter(__vis).find(r=>r.innerText.startsWith(${JSON.stringify(SET)})&&[...r.querySelectorAll('button')].some(b=>b.innerText.trim()==='Open')); [...row.querySelectorAll('button')].find(b=>b.innerText.trim()==='Open').click(); return true`)
    await waitFor(`return !!__btn('Import Camper Preferences', false)`, 10000, 'Import Camper Preferences').catch(async (e) => { throw new Error(`${e.message.slice(0, 80)}; camper text: ${await ev(`const t=document.body.innerText; const i=t.search(/camper|preference|assign/i); return i<0?'none':t.slice(i, i+700).replace(/\\s+/g,' ')`)}`) })
    const { root } = await h.app().send('DOM.getDocument', { depth: -1 })
    const ids = await h.app().send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' })
    const file = path.join(h.REPO, 'docs/work/specs/samples/fabricated-camper-preferences-100.csv')
    // The camper-preferences input is the last file input on the set screen (offerings Import comes first).
    await h.app().send('DOM.setFileInputFiles', { nodeId: ids.nodeIds[ids.nodeIds.length - 1], files: [file] })
    await waitFor(`return /Campers|Assign against|Solve Assignments|can't be assigned|Rank Column|CAMPER ID/i.test(__main())`, 30000, 'camper preview').catch(async (e) => { throw new Error(`no preview; inputs: ${await ev(`return [...document.querySelectorAll('input[type=file]')].map(i=>i.accept||'*').join(',')`)}; tail: ${await ev(`const t=__main().replace(/\\s+/g,' '); return t.slice(-700)`)}`) })
    await guide('electives/camper-import-preview', 'CAMPER ID')
  })

  // --- Generated: a day replaced by a special day ---
  await shot('generated/replaced-day', async () => {
    await nav('Special Events')
    if (!await ev(`return __main().includes('Audit Day')`)) {
      await waitFor(`const i=__inp('input[placeholder$="Color War"]'); if(!i) return false; __set(i,'Audit Day'); const s=__inp('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,[...s.options].find(o=>o.text==='Special Day').value); s.dispatchEvent(new Event('change',{bubbles:true})); return true`, 10000, 'special event form')
      await sleep(300); await click('+ Add', true)
      await click('Copy time blocks', true, 15000)
      await waitFor(`return /created — build it/.test(__main())`, 120000, 'copy finished')
    }
    // A placement made before step 6's Replace import can still show for a moment and then disappear, so the
    // result is checked on the schedule, and the day is placed again once if it is not there.
    const placeOnFriday = async () => {
      await nav('Special Schedules'); await click('Audit Day', false); await sleep(1500)
      if (await ev(`return /Week 1 · Fri/.test(__main())`)) return
      await click('+ Place on a day', true)
      // Read the cell before clicking: a cell that already holds this day reads "… is here. Remove." and a click
      // would UNPLACE it (SpecialDayPlacements.jsx toggles). Only a free cell is clicked.
      const cell = await waitFor(`const b=document.querySelector('button[aria-label^="Week 1, Friday"]'); return b && b.getAttribute('aria-label')`, 10000, 'Week 1 Friday')
      if (/is here\. Remove\./.test(cell)) return
      if (!/, free\./.test(cell)) throw new Error(`Week 1 Friday is taken by another special day: ${cell}`)
      await ev(`document.querySelector('button[aria-label^="Week 1, Friday"]').click(); return true`)
      // Bring the day's recurring events, so the replaced day shows a real grid rather than empty blocks.
      await sleep(600); await click('Bring', true, 5000).catch(() => {})
    }
    const replacedShows = async () => {
      await nav('Generated Schedule'); await sleep(800)
      await click('Daily View', true, 5000).catch(() => {}); await sleep(800)
      if (!await ev(`return [...document.querySelectorAll('.day-pill')].some(p=>p.hasAttribute('data-replaced'))`)) {
        await click('Rebuild', true, 10000); if (await ev(`return !!__btn('Rebuild it', true)`)) await click('Rebuild it', true)
        await waitFor(STATS, 120000, 'Generate stats after Rebuild')
      }
      return waitFor(`const p=[...document.querySelectorAll('.day-pill')].filter(__vis).find(p=>p.hasAttribute('data-replaced')); if(p) p.click(); return !!document.querySelector('.replaced-day-cell,[data-replaced].cell,.replaced-lane-row') || (p && p.getAttribute('aria-pressed')==='true') || !!p`, 15000, 'replaced day').then(() => true).catch(() => false)
    }
    await placeOnFriday()
    if (!await replacedShows()) { await placeOnFriday(); if (!await replacedShows()) throw new Error('the special day never showed as a replaced day on the Generated schedule') }
    await sleep(600)
    await ev(`const e=document.querySelector('.replaced-day-cell,[data-replaced]'); e && e.scrollIntoView({block:'center', inline:'center'}); return true`)
    await guide('generated/replaced-day')
  })

  // --- Generated: an Unfillable cell with its reason (most activities off for the week) ---
  await shot('generated/unfillable-hover', async () => {
    await nav('Activities')
    await waitFor(`return document.querySelectorAll('button[aria-label^="Runs in "]').length > 0`, 15000, 'week toggles')
    for (let i = 0; i < 40; i++) {
      const left = await ev(`return document.querySelectorAll('button[aria-label^="Runs in "]').length`)
      if (left <= 2) break
      await ev(`document.querySelectorAll('button[aria-label^="Runs in "]')[0].click(); return true`); await sleep(300)
      // Turning off an activity already placed asks first.
      await ev(`const b=[...document.querySelectorAll('[role=alertdialog] button,[role=dialog] button')].filter(__vis).find(b=>/^(Turn off|Off|Confirm|Yes)/.test(b.innerText.trim())); if(b) b.click(); return !!b`)
      await sleep(300)
    }
    await nav('Generated Schedule')
    await click('Rebuild', true, 10000); if (await ev(`return !!__btn('Rebuild it', true)`)) await click('Rebuild it', true)
    await waitFor(`const m=__main().match(/(\\d+)\\s*\\n?\\s*Unfillable/); return m && +m[1] > 0`, 120000, 'Unfillable cells')
    await waitFor(`const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>/Unfillable$/.test(b.innerText.trim())&&!b.disabled); if(!b) return false; b.click(); return true`, 10000, 'Unfillable count')
    await sleep(600)
    const p = await ev(`const e=[...document.querySelectorAll('[role=gridcell][data-cell-key]')].filter(__vis).find(c=>/Unfillable/.test(c.innerText)); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}`)
    if (!p) throw new Error('no Unfillable cell on screen')
    await h.app().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await sleep(800)
    await guide('generated/unfillable-hover')
    // Turn the activities back on and rebuild, so later screens (rainy day) show an ordinary camp.
    await nav('Activities')
    for (let i = 0; i < 60; i++) {
      if (!await ev(`return document.querySelectorAll('button[aria-label^="Off in "]').length`)) break
      await ev(`document.querySelectorAll('button[aria-label^="Off in "]')[0].click(); return true`); await sleep(250)
    }
    await nav('Generated Schedule')
    await click('Rebuild', true, 10000); if (await ev(`return !!__btn('Rebuild it', true)`)) await click('Rebuild it', true)
    await waitFor(STATS, 120000, 'Generate stats after turning activities back on')
  })

  // --- Devices: the router flag ---
  await shot('devices/router-flag', async () => {
    await openDevices()
    await waitFor(`return !!document.querySelector('[data-testid=port-mapping-flag-line]')`, 40000, 'router flag')
    await toTop(); await guide('devices/router-flag')
  })

  // --- Restore from backup: the confirmation (the native file dialog is stood in for) ---
  await shot('sidebar/restore-confirmation', async () => {
    await click('Backup now', true, 10000)
    await waitFor(`return /Backup saved|Last backup/.test(document.body.innerText)`, 30000, 'backup saved')
    const backup = await h.mainEval(`(()=>{const r=process.getBuiltinModule('module').createRequire('/x.js'); const fs=r('fs'), p=r('path'); const {app,dialog}=r('electron'); const dir=p.join(app.getPath('userData'),'backups'); let names; try{ names=fs.readdirSync(dir).filter(n=>/^shoresh-.*\\.db$/.test(n)) }catch(e){ return 'no dir '+dir }; const full=names.map(n=>p.join(dir,n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]; if(!full) return 'no top-level backup .db in '+dir+': '+fs.readdirSync(dir).join(','); if(!globalThis.__realOpen) globalThis.__realOpen=dialog.showOpenDialog; dialog.showOpenDialog=async()=>{ dialog.showOpenDialog=globalThis.__realOpen; return {canceled:false, filePaths:[full]} }; return full})()`)
    if (!backup || !backup.endsWith('.db')) throw new Error(`no backup to offer: ${backup}`)
    await click('Restore from backup…', true, 10000)
    await waitFor(`return !!document.querySelector('[role=alertdialog][aria-label="Confirm restore"]')`, 15000, 'restore confirmation').catch(async (e) => { throw new Error(`offered ${backup}; sidebar after click: ${await ev(`const t=document.body.innerText; const i=t.indexOf('Restore from backup'); return t.slice(i, i+200).replace(/\\s+/g,' ')`)}`) })
    await guide('sidebar/restore-confirmation')
    await click('Cancel', true, 5000)
  })

  // --- A second device: pair B, remove it on A; B's sidebar row and the Pair again screen ---
  // GUIDE_SKIP_PEER=1 skips the two-device screens (about 5 minutes) while iterating on the others.
  if (!process.env.GUIDE_SKIP_PEER) await peerSection()
  if (failed.length) throw new Error(`${failed.length} guide screen(s) failed: ${failed.join(' | ')}`)
  return 'all guide-only screens shot'

  async function peerSection() { await shot('devices/removed-start-fresh', async () => {
    let B = await h.launchPeer('G', h.PORT + 50)
    try {
      await openDevices()
      if (!await ev(`return /Stop adding devices/.test(__main())`)) await click('Add a device', true, 10000)
      const code = await waitFor(`const m=__main().match(/\\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\\b/); return m && m[1]`, 30000, 'camp code')
      await B.waitFor(`return document.body.innerText.includes('Join with a camp code')`, 120000, 'B: mode-select')
      await B.click('Join with a camp code', false)
      await B.waitFor(`const i=__inp('input[placeholder$="K4P7-2MRQ"]'); if(!i) return false; __set(i, ${JSON.stringify(code)}); return true`, 15000, 'B: code field')
      await sleep(300); await B.click('Continue', true, 10000)
      await waitFor(`const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>b.innerText.trim()==='Approve'&&!b.disabled); if(!b) return false; b.click(); return true`, 90000, "B's request on A")
      await B.waitFor(`return !!__inp('#join-name')`, 90000, 'B: sign-in')
      await B.ev(`__set(__inp('#join-name'), ${JSON.stringify(h.ADMIN)}); __set(__inp('#join-pin'), ${JSON.stringify(h.PIN)}); return true`)
      await sleep(300); await B.click('Sign in', true, 10000)
      await B.waitFor(`if (/nothing arrived/.test(document.body.innerText)) { __click('Try again', true); return false } return __click('Continue', true) || document.body.innerText.includes('Log out')`, 180000, 'B: camp arrived')
      await B.waitFor(`return document.body.innerText.includes('Log out')`, 60000, 'B: signed in')
      await click('Stop adding devices', true, 5000).catch(() => {})
      // A removes B.
      h.log(`  [peer] ${new Date().toISOString()} B signed in; B peer userData ${B.ud}`)
      await waitFor(`const b=[...document.querySelectorAll('button')].filter(__vis).find(b=>b.innerText.trim()==='Revoke'); if(!b) return false; b.click(); return true`, 30000, 'Revoke B')
      h.log(`  [peer] ${new Date().toISOString()} A: Revoke clicked for B`)
      await ev(`const b=[...document.querySelectorAll('[role=alertdialog] button,[role=dialog] button')].filter(__vis).find(b=>/Revoke|Remove/.test(b.innerText)); if(b) b.click(); return !!b`)
      await sleep(2000)
      h.log(`  after Revoke, A's devices: ${await ev(`const t=document.body.innerText; const i=t.indexOf('ALL DEVICES'); return t.slice(i, i+400).replace(/\\s+/g,' ')`)}`)
      h.log(`  dialogs open: ${await ev(`return [...document.querySelectorAll('[role=alertdialog],[role=dialog]')].filter(__vis).map(d=>d.innerText.replace(/\\s+/g,' ').slice(0,200)).join(' || ')`)}`)
      // B learns it was removed the next time it authenticates (the refusal carries the signed revoke), so it is
      // relaunched on its own data: the restart re-authenticates at once instead of whenever it next would.
      await sleep(3000)
      const ud = B.ud; await B.stop(); h.log(`  [peer] ${new Date().toISOString()} B stopped; relaunching on ${ud}`); B = await h.launchPeer('G2', h.PORT + 50, { reuse: ud })
      await B.waitFor(`return /Log out/.test(document.body.innerText) || !!__inp('#login-name')`, 120000, 'B: back up')
      if (await B.ev(`return !!__inp('#login-name')`)) { await B.ev(`__set(__inp('#login-name'), ${JSON.stringify(h.ADMIN)}); __set(__inp('#login-pin'), ${JSON.stringify(h.PIN)}); return true`); await B.click('Sign in', true, 10000) }
      h.log(`  [peer] ${new Date().toISOString()} B relaunched and signed in`)
      // A removed computer shows this on its sign-in screen, with Start fresh (#1022). The confirm step is shot and then
      // CANCELLED: the guide run never wipes anything.
      // Signed in when it learns, the device keeps its session and shows the sidebar row; signed out, it shows the
      // removed screen. Sign out first if needed, as the row says, to reach the screen the guide pictures.
      const state = await B.waitFor(`const t=document.body.innerText; if (/This computer was removed from the camp/.test(t) && [...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Start fresh on this computer')) return 'sign-in'; if (/removed from this camp/.test(t) && /Log out/.test(t)) return 'signed-in'; return false`, 240000, 'B: told it was removed')
      if (state === 'signed-in') {
        await B.click('Log out', true, 10000)
        await B.waitFor(`return /This computer was removed from the camp/.test(document.body.innerText) && [...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Start fresh on this computer')`, 30000, 'B: removed screen after signing out')
      }
      await guideFromPeer(B, 'devices/removed-start-fresh')
      await B.click('Start fresh on this computer', true, 10000)
      await B.waitFor(`return [...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Yes, start fresh')`, 15000, 'B: Start fresh confirm')
      await guideFromPeer(B, 'devices/start-fresh-confirm')
      await B.click('Cancel', true, 10000)
    } finally { await B.stop() }
  })
  if (failed.length) throw new Error(`${failed.length} guide screen(s) failed: ${failed.join(' | ')}`)
  return 'two-device screens shot'
  }

  async function guideFromPeer(peer, name) {
    // Same 1280x800 framing as guide(), through the peer's own CDP connection.
    await peer.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await sleep(700)
    await peer.shotTo(path.join(h.REPO, 'docs/guide/img', `${name}.png`))
    h.log(`  guide shot: docs/guide/img/${name}.png (device ${peer.label})`)
  }

  if (failed.length) throw new Error(`${failed.length} guide screen(s) failed: ${failed.join(' | ')}`)
  return 'all guide-only screens shot'
}
