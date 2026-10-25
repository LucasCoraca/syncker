// Joining a big drive in the web UI: the "sync everything?" banner, choosing
// folders, and removing a file from this device only.
// Run: node test/browser/join.test.js   (needs Chromium/Chrome; SHOTS=1 saves screenshots)
import test from 'brittle'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../../lib/app.js'
import { launch, chromeDir } from './cdp.js'

const exists = (f) => fs.stat(f).then(() => true, () => false)
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 100)) } throw new Error('timeout') }

test('big drive: asks before syncing; remove from this device keeps it elsewhere', { timeout: 180000 }, async (t) => {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-joinui-'))
  const a = new App({ home: path.join(root, 'a', 'h'), defaultFolder: path.join(root, 'a', 'f'), defaultName: 'laptop', port: 0, bootstrap: testnet.bootstrap })
  const b = new App({ home: path.join(root, 'b', 'h'), defaultFolder: path.join(root, 'b', 'f'), defaultName: 'Pixel 9', port: 0, bootstrap: testnet.bootstrap, askAbove: 1024 * 1024 })
  await a.start()
  await b.start()
  const page = await launch({ port: 9300 + Math.floor(Math.random() * 500) })
  t.teardown(async () => {
    await page.close()
    await a.close()
    await b.close()
    await testnet.destroy()
    await fs.rm(root, { recursive: true, force: true })
  })

  const ca = await a.setup({ mode: 'create', name: 'laptop', drive: 'Family' })
  await fs.mkdir(path.join(ca.folder, 'Videos'), { recursive: true })
  await fs.mkdir(path.join(ca.folder, 'Docs'), { recursive: true })
  await fs.writeFile(path.join(ca.folder, 'Videos', 'trip.mp4'), Buffer.alloc(3 * 1024 * 1024, 1))
  await fs.writeFile(path.join(ca.folder, 'Docs', 'letter.txt'), 'dear')
  await until(async () => { await a.engine.sync(); const e = await a.engine.drive.entry('/Videos/trip.mp4'); return Object.keys(a.engine.index).length === 2 && e && e.value.metadata.size === 3 * 1024 * 1024 })

  const cb = await b.setup({ mode: 'join', invite: a.invite, name: 'Pixel 9' })
  await page.goto(`http://127.0.0.1:${b.server.address().port}/`)
  await page.until("!document.getElementById('banner').hidden && /has 3.0 MB in 2 files/.test(document.getElementById('banner').textContent)", 30000)
  t.pass('banner: ' + await page.eval("document.getElementById('banner').textContent.replace(/\\s+/g, ' ').trim()"))
  t.ok(await page.eval("!!document.getElementById('holdAll') && !!document.getElementById('holdChoose') && !!document.getElementById('holdNone')"), 'three choices')
  if (process.env.SHOTS) {
    await page.screenshot(path.join(chromeDir(), 'join-banner.png'))
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.screenshot(path.join(chromeDir(), 'join-banner-phone.png'))
    await page.send('Emulation.clearDeviceMetricsOverride')
  }
  t.absent(await exists(path.join(cb.folder, 'Docs', 'letter.txt')), 'nothing downloaded yet')

  // Choose folders: a draft until "Start syncing".
  await page.eval("document.getElementById('holdChoose').click(); true")
  await page.until("document.getElementById('selDlg').open && document.querySelector('#selList input[data-p=\"/Videos\"]')", 10000)
  t.ok(await page.eval("!document.getElementById('selStart').hidden && !document.querySelector('#selList input[data-p=\"/\"]').checked && !document.querySelector('#selList input[data-p=\"/Docs\"]').checked"), 'starts with nothing ticked, Start syncing shown')
  await page.eval("const c = document.querySelector('#selList input[data-p=\"/Docs\"]'); c.checked = true; c.onchange(); true")
  await page.until("selDraft.includes('+/Docs') && document.querySelector('#selList input[data-p=\"/Docs\"]').checked && document.querySelector('#selList input[data-p=\"/\"]').indeterminate", 10000)
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.ok(b.info().spaces[0].hold, 'ticking applies nothing yet')
  if (process.env.SHOTS) await page.screenshot(path.join(chromeDir(), 'join-choose.png'))
  await page.eval("document.getElementById('selStart').click(); true")
  await until(() => exists(path.join(cb.folder, 'Docs', 'letter.txt')), 30000)
  t.pass('ticked folder downloaded')
  await page.until("document.getElementById('banner').hidden", 10000)
  t.pass('banner gone')
  t.absent(await exists(path.join(cb.folder, 'Videos', 'trip.mp4')), 'unticked folder stays online only')

  // Added later: a new folder stays online only, a new file in a ticked folder downloads.
  await fs.mkdir(path.join(ca.folder, 'New'), { recursive: true })
  await fs.writeFile(path.join(ca.folder, 'New', 'later.txt'), 'later')
  await fs.writeFile(path.join(ca.folder, 'Docs', 'more.txt'), 'more')
  await a.engine.sync()
  await until(() => exists(path.join(cb.folder, 'Docs', 'more.txt')), 30000)
  await until(() => b.engine.entries().some((x) => x.path === '/New/later.txt'), 30000)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  t.absent(await exists(path.join(cb.folder, 'New', 'later.txt')), 'a folder added later stays online only')

  // Remove from this device: gone here, still on the laptop, still listed.
  await page.eval("go('/Docs'); true")
  await page.until("document.querySelector('[data-path=\"/Docs/letter.txt\"]')", 10000)
  await page.eval("itemMenu(shown.find((x) => x.path === '/Docs/letter.txt'), 100, 100); true")
  t.ok(await page.eval("[...document.querySelectorAll('.menu button')].some((x) => x.textContent === 'Remove from this device') && [...document.querySelectorAll('.menu button')].some((x) => x.textContent === 'Delete from all devices')"), 'menu has both actions')
  await page.eval("[...document.querySelectorAll('.menu button')].find((x) => x.textContent === 'Remove from this device').click(); true")
  await page.until("document.getElementById('ask').open && /Other devices keep it/.test(document.getElementById('askText').textContent)", 5000)
  await page.eval("document.getElementById('askOk').click(); true")
  await until(async () => !(await exists(path.join(cb.folder, 'Docs', 'letter.txt'))), 20000)
  t.pass('removed here')
  await page.until("/Online only/.test((document.querySelector('[data-path=\"/Docs/letter.txt\"] .st') || {}).textContent)", 10000)
  t.pass('still listed as online only')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  t.is(await fs.readFile(path.join(ca.folder, 'Docs', 'letter.txt'), 'utf8'), 'dear', 'still on the other device')

  // Opening a file that is not here asks to download it first.
  await page.eval("window.open = (u) => { window.opened = u }; openItem(shown.find((x) => x.path === '/Docs/letter.txt')); true")
  await page.until("document.getElementById('ask').open && /Download/.test(document.getElementById('askTitle').textContent)", 5000)
  t.absent(await page.eval('window.opened || null'), 'not opened before downloading')
  await page.eval("document.getElementById('askOk').click(); true")
  await until(() => exists(path.join(cb.folder, 'Docs', 'letter.txt')), 20000)
  await page.until("/letter\\.txt/.test(window.opened || '')", 10000)
  t.pass('downloaded, then opened')
  t.alike(page.errors, [], 'no page errors')
})
