// Selecting several files in the web UI: click, Ctrl/Shift click, Ctrl+A,
// long press on a phone, and the bulk actions of the selection bar.
// Run: node test/browser/select.test.js   (needs Chromium/Chrome; SHOTS=1 saves screenshots)
import test from 'brittle'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../../lib/app.js'
import { launch, chromeDir } from './cdp.js'

const exists = (f) => fs.stat(f).then(() => true, () => false)
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 100)) } throw new Error('timeout') }
const row = (p) => `document.querySelector('[data-path="${p}"]')`
const click = (p, mods = {}) => `${row(p)}.dispatchEvent(new MouseEvent('click', { bubbles: true, ...${JSON.stringify(mods)} })); true`
const count = "document.querySelector('#selbar .count b') && document.querySelector('.head').classList.contains('picking') ? parseInt(document.querySelector('#selbar .count b').textContent) : 0"
const button = (label) => `[...document.querySelectorAll('#selbar [data-act]')].find((x) => x.title.startsWith(${JSON.stringify(label)}))`

test('multiple selection and bulk actions', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-selui-'))
  const a = new App({ home: path.join(root, 'h'), defaultFolder: path.join(root, 'f'), defaultName: 'laptop', port: 0, bootstrap: testnet.bootstrap })
  await a.start()
  const page = await launch({ port: 9300 + Math.floor(Math.random() * 500) })
  t.teardown(async () => {
    await page.close()
    await a.close()
    await testnet.destroy()
    await fs.rm(root, { recursive: true, force: true })
  })

  const c = await a.setup({ mode: 'create', name: 'laptop', drive: 'Family' })
  await fs.mkdir(path.join(c.folder, 'Folder'))
  for (const n of ['a', 'b', 'c', 'd']) await fs.writeFile(path.join(c.folder, n + '.txt'), n.repeat(1000))
  await fs.writeFile(path.join(c.folder, 'Folder', 'x.txt'), 'x')
  await until(async () => { await a.engine.sync(); return Object.keys(a.engine.index).length === 5 })

  await page.goto(`http://127.0.0.1:${a.server.address().port}/`)
  await page.until(`!first && ${row('/d.txt')}`, 15000)
  // A desktop with a mouse (headless Chrome reports no hover, like a phone).
  await page.eval("window.realMatchMedia = matchMedia; window.matchMedia = (m) => m === '(hover: none)' ? { matches: false } : realMatchMedia(m); true")

  await page.eval(click('/a.txt'))
  t.is(await page.eval(count), 1, 'click selects one')
  await page.eval(click('/c.txt', { ctrlKey: true }))
  t.is(await page.eval(count), 2, 'ctrl click adds')
  t.ok(await page.eval(`${row('/a.txt')}.classList.contains('sel') && !${row('/b.txt')}.classList.contains('sel') && ${row('/c.txt')}.classList.contains('sel')`), 'rows highlighted')
  await page.eval(click('/a.txt', { ctrlKey: true }))
  t.is(await page.eval(count), 1, 'ctrl click again removes')
  await page.eval(click('/a.txt'))
  await page.eval(click('/c.txt', { shiftKey: true }))
  t.is(await page.eval(count), 3, 'shift click selects the range')
  t.ok(await page.eval("/3 selected · 2.9 KB/.test(document.getElementById('selbar').textContent)"), 'shows count and size')
  await page.eval("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })); true")
  t.is(await page.eval(count), 5, 'ctrl+a selects all')
  await page.eval("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true")
  t.is(await page.eval(count), 0, 'escape clears')

  // The tick box selects without opening (also for folders).
  await page.eval(`${row('/Folder')}.querySelector('[data-pick]').click(); true`)
  t.is(await page.eval(count), 1, 'tick box selects a folder')
  t.ok(await page.eval("view === 'files' && dir === '/'"), 'and does not open it')
  await page.eval("document.getElementById('selClear').click(); true")
  t.is(await page.eval(count), 0, 'clear button')

  // Remove two files from this device in one go, then keep them again.
  await page.eval(click('/b.txt'))
  await page.eval(click('/c.txt', { ctrlKey: true }))
  if (process.env.SHOTS) await page.screenshot(path.join(chromeDir(), 'select-bar.png'))
  t.ok(await page.eval(`!!${button('Download 2 files')} && !!${button('Remove from this device')} && !!${button('Delete from all devices')} && !${button('Keep on this device')}`), 'bulk actions for local files')
  await page.eval(`${button('Remove from this device')}.click(); true`)
  await page.until("document.getElementById('ask').open && /Remove 2 items/.test(document.getElementById('askTitle').textContent)", 5000)
  await page.eval("document.getElementById('askOk').click(); true")
  await until(async () => !(await exists(path.join(c.folder, 'b.txt'))) && !(await exists(path.join(c.folder, 'c.txt'))), 20000)
  t.alike(a.engine.excluded.slice().sort(), ['/b.txt', '/c.txt'], 'one change excludes both')
  await page.until(`/Online only/.test(${row('/b.txt')}.textContent) && /Online only/.test(${row('/c.txt')}.textContent)`, 10000)
  t.is(await page.eval(count), 0, 'selection cleared after the action')
  await page.eval(click('/b.txt'))
  await page.eval(click('/c.txt', { ctrlKey: true }))
  await page.until(`!!${button('Keep on this device')}`, 5000)
  await page.eval(`${button('Keep on this device')}.click(); true`)
  await until(async () => (await exists(path.join(c.folder, 'b.txt'))) && (await exists(path.join(c.folder, 'c.txt'))), 20000)
  t.alike(a.engine.excluded, [], 'kept on this device again')

  // Right click on a selection: the bulk menu.
  await page.until(`!/Online only/.test(${row('/c.txt')}.textContent)`, 10000)
  await page.eval(click('/a.txt'))
  await page.eval(click('/d.txt', { ctrlKey: true }))
  await page.eval(`${row('/d.txt')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 })); true`)
  t.ok(await page.eval("[...document.querySelectorAll('.menu button')].some((x) => x.textContent === 'Download 2 files')"), 'right click shows the bulk menu')
  await page.eval("[...document.querySelectorAll('.menu button')].find((x) => x.textContent === 'Delete from all devices').click(); true")
  await page.until("document.getElementById('ask').open && /Delete 2 items/.test(document.getElementById('askTitle').textContent)", 5000)
  await page.eval("document.getElementById('askOk').click(); true")
  await until(async () => !(await exists(path.join(c.folder, 'a.txt'))) && !(await exists(path.join(c.folder, 'd.txt'))), 20000)
  t.pass('both deleted')
  await page.until(`!${row('/a.txt')} && !${row('/d.txt')} && ${row('/b.txt')}`, 10000)
  t.ok(await exists(path.join(c.folder, 'b.txt')), 'others untouched')

  // Phone: long press starts selecting, then taps toggle instead of opening.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await page.eval('window.matchMedia = realMatchMedia; true')
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await page.until("matchMedia('(hover: none)').matches && matchMedia('(max-width: 800px)').matches", 5000)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const at = await page.eval(`(() => { const r = ${row('/b.txt')}.getBoundingClientRect(); return [r.left + r.width / 3, r.top + r.height / 2] })()`)
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at[0], y: at[1] }] })
  await new Promise((resolve) => setTimeout(resolve, 700))
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.until(`(${count}) === 1`, 5000)
  t.pass('long press selects')
  await page.eval(click('/Folder'))
  t.is(await page.eval(count), 2, 'tap adds to the selection')
  t.ok(await page.eval("dir === '/' && document.getElementById('files').classList.contains('picking')"), 'folder not opened, tick boxes shown')
  if (process.env.SHOTS) await page.screenshot(path.join(chromeDir(), 'select-phone.png'))
  await page.eval(click('/Folder'))
  await page.eval(click('/b.txt'))
  t.is(await page.eval(count), 0, 'tapping again unselects')
  await page.eval(click('/Folder'))
  await page.until("dir === '/Folder'", 5000)
  t.pass('without a selection a tap opens')

  // Android back: up one folder, then (at the top) it is not handled here.
  t.ok(await page.eval("onBack() && dir === '/' && view === 'files'"), 'back goes up a folder')
  t.absent(await page.eval('onBack()'), 'at the top, back is left to the app')
  await page.eval("showView('devices'); true")
  t.ok(await page.eval("onBack() && view === 'files'"), 'back leaves the manage page')
})
