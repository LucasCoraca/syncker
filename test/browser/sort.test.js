// Sorting and filtering the file list, folder totals, and the details dialog.
// Run: node test/browser/sort.test.js   (needs Chromium/Chrome; SHOTS=1 saves screenshots)
import test from 'brittle'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../../lib/app.js'
import { launch, chromeDir } from './cdp.js'

const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 100)) } throw new Error('timeout') }
const names = "shown.map((x) => x.name).join(',')"
const pickMenu = (label) => `(() => { const b = [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b })()`
const chip = (sel) => `(() => { const b = document.querySelector(${JSON.stringify(sel)}); b.click(); return !!document.querySelector('.menu') })()`

test('sort, filter, folder totals and details', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-sortui-'))
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
  const day = 24 * 3600 * 1000
  const put = async (name, bytes, age) => {
    const f = path.join(c.folder, name)
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, 'x'.repeat(bytes))
    const when = new Date(Date.now() - age)
    await fs.utimes(f, when, when)
  }
  await put('Trip/beach.jpg', 2000, 400 * day)
  await put('Trip/notes.txt', 500, 400 * day)
  await put('small.txt', 10, 40 * day)
  await put('big.mp4', 9000, 0)
  await put('report.pdf', 300, 3 * day)
  await put('report (conflict laptop 2026-10-01).pdf', 200, 20 * day)
  await until(async () => { await a.engine.sync(); return Object.keys(a.engine.index).length === 6 })

  await page.goto(`http://127.0.0.1:${a.server.address().port}/`)
  await page.until("!first && document.querySelector('[data-path=\"/big.mp4\"]')", 15000)
  t.ok(await page.eval("!document.getElementById('tools').hidden"), 'sort and filters are shown')
  t.is(await page.eval(names), 'Trip,big.mp4,report (conflict laptop 2026-10-01).pdf,report.pdf,small.txt', 'name order, folders first')

  // Folder totals: every file inside, in the list.
  const trip = "shown.find((x) => x.name === 'Trip')"
  t.is(await page.eval(`${trip}.files`), 2, 'folder counts its files')
  t.is(await page.eval(`${trip}.size`), 2500, 'and their size')
  t.ok(await page.eval("/2 files/.test(document.querySelector('[data-path=\"/Trip\"]').textContent)"), 'shown on the row')

  // The sort menu.
  t.ok(await page.eval(chip('#sortBtn')), 'sort menu opens')
  t.ok(await page.eval(pickMenu('Largest first')))
  t.is(await page.eval(names), 'Trip,big.mp4,report.pdf,report (conflict laptop 2026-10-01).pdf,small.txt', 'largest first')
  t.ok(await page.eval("/Largest first/.test(document.getElementById('sortBtn').textContent)"), 'the button says the order')
  await page.eval(chip('#sortBtn'))
  await page.eval(pickMenu('Folders first'))
  t.is(await page.eval(names), 'big.mp4,Trip,report.pdf,report (conflict laptop 2026-10-01).pdf,small.txt', 'folders sorted with the files')
  await page.eval(chip('#sortBtn'))
  await page.eval(pickMenu('Newest first'))
  t.is(await page.eval(names), 'big.mp4,report.pdf,report (conflict laptop 2026-10-01).pdf,small.txt,Trip', 'newest first: a folder is as new as its newest file')
  await page.eval(chip('#sortBtn'))
  await page.eval(pickMenu('Type'))
  t.is(await page.eval(names), 'Trip,small.txt,report (conflict laptop 2026-10-01).pdf,report.pdf,big.mp4', 'by type')
  t.alike(await page.eval("JSON.parse(localStorage.getItem('sort'))"), { key: 'type', asc: true, folders: false }, 'remembered')
  await page.eval(chip('#sortBtn'))
  await page.eval(pickMenu('Folders first'))
  await page.eval(chip('#sortBtn'))
  await page.eval(pickMenu('Name (A to Z)'))

  // Filters.
  await page.eval(chip('[data-f="type"]'))
  await page.eval(pickMenu('Documents'))
  t.is(await page.eval(names), 'Trip,report (conflict laptop 2026-10-01).pdf,report.pdf,small.txt', 'documents, and folders to go into')
  t.ok(await page.eval("document.querySelector('[data-f=\"type\"]').classList.contains('on') && /Documents/.test(document.querySelector('[data-f=\"type\"]').textContent)"), 'the chip shows the filter')
  await page.eval(chip('[data-f="when"]'))
  await page.eval(pickMenu('Last 7 days'))
  t.is(await page.eval(names), 'report.pdf', 'and modified this week')
  await page.eval(chip('[data-f="when"]'))
  await page.eval(pickMenu('Clear'))
  await page.eval(chip('[data-f="avail"]'))
  await page.eval(pickMenu('Conflicts'))
  t.is(await page.eval(names), 'report (conflict laptop 2026-10-01).pdf', 'conflicts')
  await page.eval(chip('[data-f="type"]'))
  await page.eval(pickMenu('Videos'))
  t.ok(await page.eval("/Nothing matches these filters/.test(document.getElementById('files').textContent)"), 'nothing matches: says so')
  if (process.env.SHOTS) await page.screenshot(path.join(chromeDir(), 'sort-empty.png'))
  await page.eval("[...document.querySelectorAll('#files button')].find((b) => b.textContent === 'Clear filters').click(); true")
  t.is(await page.eval("shown.length"), 5, 'cleared')
  t.ok(await page.eval("!document.querySelector('.chip.on')"), 'no filter chip left on')
  await page.eval(chip('[data-f="avail"]'))
  await page.eval(pickMenu('On this device'))
  t.is(await page.eval("shown.length"), 5, 'everything is on this device')
  await page.eval('clearFilters(); true')

  // Details: a folder.
  await page.eval(`showDetails(${trip}); true`)
  await page.until("/Contains/.test(document.getElementById('detBody').textContent)")
  const fd = await page.eval("document.getElementById('detBody').textContent")
  t.ok(/Folder/.test(fd) && /2 files/.test(fd) && /2\.4 KB/.test(fd), 'folder: type, files and size')
  t.ok(/All files/.test(fd), 'all of it on this device')
  t.ok(fd.includes(path.join(c.folder, 'Trip')), 'where it is')
  if (process.env.SHOTS) await page.screenshot(path.join(chromeDir(), 'details-folder.png'))
  await page.eval("document.getElementById('details').close(); true")

  // Details: a file.
  await page.eval("showDetails(shown.find((x) => x.name === 'big.mp4')); true")
  await page.until("/latest version/.test(document.getElementById('detBody').textContent)")
  const d = await page.eval("document.getElementById('detBody').textContent")
  t.ok(/MP4 video/.test(d), 'type')
  t.ok(/9,000 bytes/.test(d), 'exact size')
  t.ok(/on laptop/.test(d), 'changed on which device')
  t.ok(d.includes(path.join(c.folder, 'big.mp4')), 'where it is')
  if (process.env.SHOTS) await page.screenshot(path.join(chromeDir(), 'details-file.png'))
  await page.eval("document.getElementById('details').close(); true")

  // A phone: the sort button is there too, and folders say what is in them.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await page.eval('renderFiles(); true')
  t.ok(await page.eval("document.getElementById('sortBtn').getBoundingClientRect().width > 0"), 'sort button on a phone')
  t.ok(await page.eval("/2 files · 2\\.4 KB/.test(document.querySelector('[data-path=\"/Trip\"] .sub').textContent)"), 'folder line on a phone')
  if (process.env.SHOTS) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    await page.screenshot(path.join(chromeDir(), 'list-phone.png'))
    await page.eval(chip('#sortBtn'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.screenshot(path.join(chromeDir(), 'sort-phone.png'))
  }
})
