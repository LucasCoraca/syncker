// Drives the real web UI in headless Chromium against a real engine:
// setup, list, upload, new folder, navigate, rename, versions, delete, QR.
// Run: node test/browser/ui.test.js   (needs Chromium/Chrome; not part of npm test)
import test from 'brittle'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../../lib/app.js'
import { launch } from './cdp.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function start (t) {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-ui-'))
  const app = new App({ home: path.join(root, 'home'), defaultFolder: path.join(root, 'files'), defaultName: 'ui-test', port: 0, bootstrap: testnet.bootstrap })
  await app.start()
  const url = `http://127.0.0.1:${app.server.address().port}/`
  const page = await launch({ port: 9300 + Math.floor(Math.random() * 500) })
  t.teardown(async () => {
    await page.close()
    await app.close()
    await testnet.destroy()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { app, page, url, root }
}

test('first run setup, then file operations through the UI', async (t) => {
  const { app, page, url } = await start(t)
  await page.goto(url)

  await page.until("!document.getElementById('setupView').hidden")
  t.ok(await page.eval("document.getElementById('folderIn').value.endsWith('/files')"), 'default folder prefilled')
  await page.eval("document.getElementById('nameIn').value = 'my laptop'; doSetup(); true")
  await page.until("!document.getElementById('mainView').hidden")
  t.is(app.engine.deviceName, 'my laptop', 'set up with the typed name')
  await page.until("document.getElementById('crumbs').textContent.includes('My drive')")
  t.ok(await page.eval("document.getElementById('files').textContent.includes('Nothing here yet')"), 'empty state shown')

  // Upload (same request the file picker / drag and drop makes)
  await page.eval("uploadFiles([new File(['hello world'], 'hello.txt')]).then(() => true)")
  await page.until("document.getElementById('files').textContent.includes('hello.txt')")
  t.is(await fs.readFile(path.join(app.engine.folder, 'hello.txt'), 'utf8'), 'hello world', 'uploaded to the folder')

  // New folder + navigate + upload inside
  const answer = async (value) => {
    await page.until("document.getElementById('ask').open")
    await page.eval(`${value === null ? '' : `document.getElementById('askIn').value = ${JSON.stringify(value)};`} document.getElementById('askOk').click(); true`)
  }
  await page.eval("newFolder(); true")
  await answer('Photos')
  await page.until("dir === '/Photos'")
  await page.eval("uploadFiles([new File(['img'], 'a.jpg')]).then(() => true)")
  await page.until("document.getElementById('files').textContent.includes('a.jpg')")
  t.ok(await page.eval("document.getElementById('crumbs').textContent.includes('Photos')"), 'breadcrumb shows folder')
  await page.eval("go('/'); true")
  await page.until("document.getElementById('files').textContent.includes('Photos')")

  // Rename
  const item = (name) => `shown.find((i) => i.name === ${JSON.stringify(name)})`
  await page.eval(`act('rename', ${item('hello.txt')}); true`)
  t.is(await page.eval("document.getElementById('askIn').value"), 'hello.txt', 'rename prefilled with the current name')
  await answer('renamed.txt')
  await page.until("document.getElementById('files').textContent.includes('renamed.txt')")
  t.is(await fs.readFile(path.join(app.engine.folder, 'renamed.txt'), 'utf8'), 'hello world', 'renamed on disk')

  // Versions dialog
  await app.engine.sync()
  await page.eval(`act('history', ${item('renamed.txt')}); true`)
  await page.until("document.getElementById('hist').open && document.getElementById('histBody').textContent.includes('my laptop')")
  await page.eval("document.getElementById('hist').close(); true")
  t.pass('versions dialog lists this device')

  // Delete
  await page.eval(`act('delete', ${item('renamed.txt')}); true`)
  await answer(null)
  await page.until("!document.getElementById('files').textContent.includes('renamed.txt')")
  t.absent(await fs.stat(path.join(app.engine.folder, 'renamed.txt')).then(() => true, () => false), 'deleted on disk')

  // Status line
  await sleep(500)
  t.ok(await page.eval("/Up to date|Syncing/.test(document.getElementById('statetext').textContent)"), 'status line rendered')

  // Item menu, search, recent, devices
  await page.eval(`itemMenu(${item('Photos')}, 100, 100); true`)
  t.ok(await page.eval("/Rename/.test(document.querySelector('.menu').textContent)"), 'item menu opens')
  await page.eval('closeMenu(); true')
  await page.eval("const s = document.getElementById('searchIn'); s.value = 'a.jp'; s.oninput(); true")
  await page.until("view === 'search' && document.getElementById('files').textContent.includes('a.jpg')")
  t.pass('search finds files in subfolders')
  await page.eval("showView('recent'); true")
  await page.until("document.getElementById('files').textContent.includes('a.jpg')")
  t.pass('recent lists files')
  await page.eval("showView('devices'); true")
  await page.until("document.getElementById('peers').textContent.includes('my laptop')")
  t.pass('manage page lists this device')
  await page.until("document.getElementById('qr').naturalWidth > 0")
  t.pass('invite QR image loaded')

  // Choose what to sync: make Photos online only, then bring it back.
  const first = app.engine
  await page.eval("chooseSync(); true")
  await page.until("document.querySelector('#selList input[data-p=\"/Photos\"]')")
  await page.eval("const cb = document.querySelector('#selList input[data-p=\"/Photos\"]'); cb.checked = false; cb.onchange(); true")
  await page.until("document.querySelector('#selList input[data-p=\"/Photos\"]') && !document.querySelector('#selList input[data-p=\"/Photos\"]').checked && document.querySelector('#selList input[data-p=\"/\"]').indeterminate", 10000)
  t.alike(first.excluded, ['/Photos'], 'excluded saved')
  await page.eval("document.getElementById('selDlg').close(); true")
  const photo = path.join(first.folder, 'Photos', 'a.jpg')
  for (let i = 0; i < 50 && await fs.stat(photo).then(() => true, () => false); i++) await sleep(100)
  t.absent(await fs.stat(photo).then(() => true, () => false), 'online-only file removed from this device')
  await page.eval("go('/Photos'); true")
  await page.until("document.getElementById('files').textContent.includes('a.jpg') && document.getElementById('files').textContent.includes('Online only')")
  t.pass('online-only file still listed')
  const streamed = await page.eval("fetch('/api/file?' + q({ space, path: '/Photos/a.jpg' })).then((r) => r.text())")
  t.is(streamed, 'img', 'online-only file opens (streamed from the drive)')
  await page.eval(`setSync(${item('a.jpg')}, true); true`)
  for (let i = 0; i < 50 && !(await fs.stat(photo).then(() => true, () => false)); i++) await sleep(100)
  t.is(await fs.readFile(photo, 'utf8'), 'img', 'back on this device after "Keep on this device"')
  t.alike(first.excluded, ['/Photos', '+/Photos/a.jpg'], 'only that file is kept: the folder stays online only for files added later')

  // A second shared drive, with its own folder and invite.
  await page.eval("addDrive('create'); true")
  await page.until("document.getElementById('driveDlg').open && document.getElementById('ddFolder').value.length > 0")
  await page.eval("const n = document.getElementById('ddName'); n.value = 'Family'; n.oninput(); true")
  await page.until("/ - Family$/.test(document.getElementById('ddFolder').value)")
  await page.eval("document.getElementById('ddOk').click(); true")
  await page.until("cur() && cur().name === 'Family' && view === 'devices'")
  t.is(app.spaces.size, 2, 'second drive created')
  const fam = [...app.spaces.values()].find((s) => s.name === 'Family')
  t.not(fam.invite, app.invite, 'own invite')
  t.ok(fam.invite.includes('?name=Family'), 'invite carries the drive name')
  t.ok(await page.eval("document.getElementById('invite').textContent.includes('name=Family')"), 'manage page shows this drive\'s invite')
  await page.eval("go('/'); true")
  await page.eval("uploadFiles([new File(['fam'], 'family.txt')]).then(() => true)")
  await page.until("document.getElementById('files').textContent.includes('family.txt')")
  t.is(await fs.readFile(path.join(fam.folder, 'family.txt'), 'utf8'), 'fam', 'uploaded into the second drive folder')
  t.absent(await fs.stat(path.join(first.folder, 'family.txt')).then(() => true, () => false), 'not in the first drive')
  t.ok(await page.eval("document.getElementById('drives').textContent.includes('My drive') && document.getElementById('drives').textContent.includes('Family')"), 'sidebar lists both drives')
  await page.eval("showView('recent'); true")
  await page.until("document.getElementById('files').textContent.includes('family.txt') && document.getElementById('files').textContent.includes('a.jpg')")
  t.pass('recent spans drives')

  // Config survives a restart; leave the drive.
  const saved = JSON.parse(await fs.readFile(path.join(app.home, 'config.json'), 'utf8'))
  t.is(saved.spaces.length, 2, 'both drives saved')
  await page.eval(`space = ${JSON.stringify(fam.id)}; showView('devices'); leaveDrive(); true`)
  await answer(null)
  await page.until("drives().length === 1")
  t.is(app.spaces.size, 1, 'left the drive')
  t.ok(await fs.stat(path.join(fam.folder, 'family.txt')).then(() => true, () => false), 'its files stay on disk')
  t.alike(page.errors, [], 'no page errors')
})

test('API rejects path traversal and cross-site requests', async (t) => {
  const { app, url } = await start(t)
  await app.setup({ mode: 'create', name: 'x' })
  const r1 = await fetch(url + 'api/file?path=' + encodeURIComponent('/../../etc/passwd'))
  t.not(r1.status, 200, 'traversal not served')
  const r2 = await fetch(url + 'api/file?path=/x.txt', { method: 'PUT', body: 'x', headers: { origin: 'http://evil.example' } })
  t.is(r2.status, 403, 'cross-origin write blocked')
  // fetch() cannot set Host; use http.request
  const status3 = await new Promise((resolve, reject) => {
    http.get(url + 'api/status', { headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', reject)
  })
  t.is(status3, 403, 'foreign Host blocked (DNS rebinding)')
  const r4 = await fetch(url + 'api/file?path=/.syncker', { method: 'DELETE' })
  t.is(r4.status, 400, 'marker file cannot be deleted through the API')
})
