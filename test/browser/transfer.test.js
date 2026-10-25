// A large file moving between two devices: transfer progress in the engine
// (both directions) and in the receiver's web UI, at desktop and phone width.
// Run: node test/browser/transfer.test.js   (needs Chromium/Chrome; SHOTS=1 saves screenshots)
import test from 'brittle'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../../lib/app.js'
import { launch, chromeDir } from './cdp.js'

const SIZE = 768 * 1024 * 1024
const xf = (app) => app.info().spaces[0].transfers

async function writeBig (file) {
  const chunk = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 2654435761) >>> 24
  const fh = await fs.open(file, 'w')
  for (let i = 0; i < SIZE / chunk.length; i++) {
    chunk[0] = i & 255 // not that hyperblobs dedups, but keep blocks distinct
    await fh.write(chunk)
  }
  await fh.close()
}

test('large file: progress on both devices and in the UI', { timeout: 300000 }, async (t) => {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-xfer-'))
  const a = new App({ home: path.join(root, 'a', 'h'), defaultFolder: path.join(root, 'a', 'f'), defaultName: 'laptop', port: 0, bootstrap: testnet.bootstrap })
  const b = new App({ home: path.join(root, 'b', 'h'), defaultFolder: path.join(root, 'b', 'f'), defaultName: 'Pixel 9', port: 0, bootstrap: testnet.bootstrap })
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

  const ca = await a.setup({ mode: 'create', name: 'laptop' })
  await fs.mkdir(path.join(ca.folder, 'Videos'), { recursive: true })
  await fs.writeFile(path.join(ca.folder, 'notes.txt'), 'hello')
  await writeBig(path.join(ca.folder, 'Videos', 'holiday.mp4'))

  // The sender shows "adding" progress while it hashes and stores the file.
  const adds = []
  a.on('change', () => { for (const x of xf(a)) if (x.dir === 'add' && x.path === '/Videos/holiday.mp4') adds.push(x.percent) })
  await a.engine.sync()
  t.ok(adds.some((p) => p > 0 && p < 100), 'sender reported adding progress: ' + [...new Set(adds)].slice(0, 6).join(','))
  t.is(xf(a).find((x) => x.path === '/Videos/holiday.mp4').state, 'done', 'adding finished')

  await b.setup({ mode: 'join', invite: a.invite, name: 'Pixel 9' })
  const url = `http://127.0.0.1:${b.server.address().port}/`
  await page.goto(url + '#' + encodeURIComponent('/Videos'))

  // Receiver: download progress with speed and ETA, sender: upload progress.
  const seen = { down: new Set(), up: new Set() }
  let mid = null
  const end = Date.now() + 120000
  while (Date.now() < end) {
    const d = xf(b).find((x) => x.dir === 'down' && x.path === '/Videos/holiday.mp4')
    const u = xf(a).find((x) => x.dir === 'up' && x.path === '/Videos/holiday.mp4')
    if (d) seen.down.add(d.percent)
    if (u) seen.up.add(u.percent)
    if (d && d.percent >= 20 && d.percent <= 80 && !mid) {
      mid = d
      await page.until("/Syncing 1 file · \\d+%/.test(document.getElementById('statetext').textContent)", 5000).catch(async (err) => { console.log(await page.eval("document.getElementById('statetext').textContent + JSON.stringify(status.transfers.map(x => x.path + x.state))"), JSON.stringify(xf(b).map(x => x.path + x.state)), JSON.stringify(b.info().pending), !!b.engine.index["/notes.txt"], b.engine.status); throw err })
      t.pass('status chip: ' + await page.eval("document.getElementById('statetext').textContent"))
      t.ok(await page.eval("!document.getElementById('panel').hidden && /Downloading 1 file/.test(document.getElementById('panelTitle').textContent)"), 'transfer panel open')
      t.ok(await page.eval("/MB of .*MB/.test(document.getElementById('panelList').textContent)"), 'panel shows bytes: ' + await page.eval("document.querySelector('#panelList .d').textContent"))
      t.ok(await page.eval("/\\d+%/.test(document.querySelector('[data-path=\"/Videos/holiday.mp4\"] .st').textContent)"), 'file row shows percent')
      const det = await (await fetch(url + 'api/details?path=' + encodeURIComponent('/Videos/holiday.mp4'))).json()
      t.ok(['downloading', 'waiting', 'saving'].includes(det.here.state) && det.devices[0].name === 'laptop' && det.devices[0].state === 'synced', 'details mid-download: ' + det.here.text + ' / laptop: ' + det.devices[0].text)
      if (process.env.SHOTS) {
        await page.screenshot(path.join(chromeDir(), 'xfer-desktop.png'))
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
        await new Promise((resolve) => setTimeout(resolve, 400))
        await page.screenshot(path.join(chromeDir(), 'xfer-phone.png'))
        await page.send('Emulation.clearDeviceMetricsOverride')
      }
    }
    if (await fs.stat(path.join(b.engine.folder, 'Videos', 'holiday.mp4')).then((s) => s.size === SIZE, () => false)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  t.ok(mid, 'saw a mid-transfer state: ' + JSON.stringify(mid && { percent: mid.percent, speed: mid.speed, eta: mid.eta, device: mid.device }))
  t.ok(mid && mid.speed > 0 && mid.device === 'laptop', 'speed and source device reported')
  t.ok([...seen.down].length >= 3, 'download percent advanced: ' + [...seen.down].sort((x, y) => x - y).slice(0, 8).join(','))
  t.ok([...seen.up].some((p) => p > 0), 'sender saw upload progress to the receiver')
  t.ok(xf(a).some((x) => x.dir === 'up' && x.device === 'Pixel 9'), 'upload names the receiving device')

  await page.until("document.querySelector('[data-path=\"/Videos/holiday.mp4\"]') && !document.querySelector('[data-path=\"/Videos/holiday.mp4\"] .bar')", 30000)
  const done = xf(b).find((x) => x.dir === 'down' && x.path === '/Videos/holiday.mp4')
  t.is(done && done.state, 'done', 'download marked done')
  t.is(done && done.percent, 100, '100%')
  await page.until("/Up to date/.test(document.getElementById('statetext').textContent)", 15000)
  await page.until("/1 file synced|files synced/.test(document.getElementById('panelTitle').textContent)", 5000)
  t.pass('UI settles: ' + await page.eval("document.getElementById('statetext').textContent + ' / ' + document.getElementById('panelTitle').textContent"))
  if (process.env.SHOTS) {
    await page.eval("setLayout('grid'); go('/'); true")
    await page.until("document.getElementById('files').textContent.includes('notes.txt')")
    await page.screenshot(path.join(chromeDir(), 'done-grid.png'))
    await page.eval("showView('devices'); true")
    await new Promise((resolve) => setTimeout(resolve, 500))
    await page.screenshot(path.join(chromeDir(), 'devices.png'))
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.screenshot(path.join(chromeDir(), 'devices-phone.png'))
    await page.eval("setLayout('list'); go('/Videos'); true")
    await new Promise((resolve) => setTimeout(resolve, 500))
    await page.screenshot(path.join(chromeDir(), 'done-phone.png'))
  }

  // Sync details dialog: where the file is on every device.
  await page.eval("go('/Videos'); true")
  await page.until("document.querySelector('[data-path=\"/Videos/holiday.mp4\"] .st .state')", 10000)
  await page.eval("document.querySelector('[data-path=\"/Videos/holiday.mp4\"] .st .state').click(); true")
  await page.until("document.getElementById('details').open && /2 of 2 devices have the latest version/.test(document.getElementById('detBody').textContent)", 20000)
  const detText = await page.eval("document.getElementById('detBody').textContent")
  t.ok(/Downloaded from laptop/.test(detText) && /laptop/.test(detText) && /connected via local network/.test(detText), 'details dialog: ' + detText.slice(0, 200))
  if (process.env.SHOTS) await page.screenshot(path.join(chromeDir(), 'details.png'))
  await page.eval("document.getElementById('details').close(); true")
  await page.until("document.querySelector('[data-path=\"/Videos/holiday.mp4\"] .st .state')", 10000)
  const seenA = await (await fetch(`http://127.0.0.1:${a.server.address().port}/api/details?path=` + encodeURIComponent('/Videos/holiday.mp4'))).json()
  t.is(seenA.devices[0].state, 'synced', 'sender knows the receiver has it: ' + seenA.devices[0].text)

  // A big file the sender is still adding: listed as "being prepared" here.
  const add = a.engine.transfers.start('add:/ubuntu.iso', { dir: 'add', path: '/ubuntu.iso', device: 'laptop', size: 2 * SIZE })
  a.engine.transfers.progress(add, SIZE * 0.8)
  await a.engine._announce()
  await page.eval("go('/'); true")
  await page.until("/laptop is preparing 1 file · 40%/.test(document.getElementById('statetext').textContent)", 20000)
  t.pass('status chip: ' + await page.eval("document.getElementById('statetext').textContent"))
  await page.until("/Preparing 40%/.test((document.querySelector('[data-path=\"/ubuntu.iso\"] .st') || {}).textContent)", 10000)
  t.pass('file listed with preparing state')
  t.ok(await page.eval("/Waiting for laptop to prepare 1 file/.test(document.getElementById('panelTitle').textContent) && /Being prepared on laptop · 40%/.test(document.getElementById('panelList').textContent)"), 'panel: ' + await page.eval("document.getElementById('panelTitle').textContent"))
  a.engine.transfers.drop(add.id)
  await a.engine._announce()
  await page.until("/Up to date/.test(document.getElementById('statetext').textContent) && !document.querySelector('[data-path=\"/ubuntu.iso\"]')", 20000)
  t.pass('cleared when the sender stops adding')
  t.alike(page.errors, [], 'no page errors')
})
