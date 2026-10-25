// Making a drive from a folder that already has files: a tree of its folders
// pops up first and only the ticked ones are shared.
// Run: node test/browser/folders.test.js   (needs Chromium/Chrome; SHOTS=1 saves screenshots)
import test from 'brittle'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../../lib/app.js'
import { launch, chromeDir } from './cdp.js'

const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 100)) } throw new Error('timeout') }

test('new drive from an existing folder: choose its folders in a tree', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-foldersui-'))
  const a = new App({ home: path.join(root, 'h'), defaultFolder: path.join(root, 'Syncker'), defaultName: 'laptop', port: 0, bootstrap: testnet.bootstrap })
  await a.start()
  const page = await launch({ port: 9300 + Math.floor(Math.random() * 500) })
  t.teardown(async () => {
    await page.close()
    await a.close()
    await testnet.destroy()
    await fs.rm(root, { recursive: true, force: true })
  })
  await a.setup({ mode: 'create', name: 'laptop', drive: 'Home' })

  const docs = path.join(root, 'Documents')
  const put = async (p, c) => { await fs.mkdir(path.dirname(path.join(docs, p)), { recursive: true }); await fs.writeFile(path.join(docs, p), c) }
  await put('Work/report.txt', 'report')
  await put('Work/Old/archive.txt', 'archive')
  await put('Photos/2024/beach.jpg', 'jpg')
  await put('app/node_modules/dep/index.js', 'dep')
  await put('app/src/main.js', 'main')
  await put('todo.txt', 'todo')

  await page.goto(`http://127.0.0.1:${a.server.address().port}/`)
  await page.until("!first && document.querySelector('#drives [data-drive]')", 15000)
  await page.eval(`addDrive('create'); document.getElementById('ddName').value = 'Documents'; document.getElementById('ddFolder').value = ${JSON.stringify(docs)}; document.getElementById('ddFolder').dataset.edited = '1'; document.getElementById('ddOk').click(); true`)
  await page.until("document.getElementById('selDlg').open && document.querySelector('#selList input[data-p=\"/Work\"]')", 10000)
  const rows = await page.eval("[...document.querySelectorAll('#selList .sel-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())")
  t.comment(JSON.stringify(rows))
  t.ok(await page.eval("!!document.querySelector('#selList input[data-p=\"/Photos\"]') && !!document.querySelector('#selList input[data-p=\"/app\"]')"), 'top folders listed')
  t.absent(await page.eval("!!document.querySelector('#selList input[data-p=\"/Work/Old\"]')"), 'subfolders only when opened')
  t.ok(await page.eval("[...document.querySelectorAll('#selList .sel-row.loose')].some((r) => /1 file directly in Documents/.test(r.textContent))"), 'files at the top are one row')
  t.absent(await page.eval("/report.txt|todo.txt/.test(document.getElementById('selList').textContent)"), 'no file names')

  // Open Work: its subfolder shows; untick Work, then tick only Work/Old back.
  await page.eval("document.querySelector('[data-open=\"/Work\"]').click(); true")
  await page.until("document.querySelector('#selList input[data-p=\"/Work/Old\"]')", 5000)
  await page.eval("document.querySelector('[data-open=\"/app\"]').click(); true")
  await page.until("document.querySelector('#selList input[data-p=\"/app/src\"]')", 5000)
  t.absent(await page.eval("!!document.querySelector('#selList input[data-p=\"/app/node_modules\"]')"), 'dependency folders left out')
  await page.until("/file/.test(document.querySelector('[data-size=\"/Work\"]').textContent)", 10000)
  t.pass('sizes counted: ' + await page.eval("document.querySelector('[data-size=\"/Work\"]').textContent"))
  const click = (p) => page.eval(`(() => { const c = document.querySelector('#selList input[data-p="${p}"]'); c.checked = !c.checked; c.onchange(); return true })()`)
  await click('/Work')
  await page.until("JSON.stringify(selDraft) === '[\"/Work\"]' && !document.querySelector('#selList input[data-p=\"/Work/Old\"]').checked", 5000) // applied and redrawn
  await click('/Work/Old')
  await page.until("document.querySelector('#selList input[data-p=\"/Work\"]').indeterminate && document.querySelector('#selList input[data-p=\"/Work/Old\"]').checked", 5000)
  await click('/Photos')
  await page.until("selDraft.includes('/Photos') && !document.querySelector('#selList input[data-p=\"/Photos\"]').checked && document.querySelector('#selList input[data-p=\"/\"]').indeterminate", 5000)
  t.pass('tri-state boxes')
  if (process.env.SHOTS) {
    await page.screenshot(path.join(chromeDir(), 'folders-create.png'))
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.screenshot(path.join(chromeDir(), 'folders-create-phone.png'))
    await page.send('Emulation.clearDeviceMetricsOverride')
  }
  await page.eval("document.getElementById('selStart').click(); true")
  await until(() => a.spaces.size === 2)
  const s = [...a.spaces.values()].find((x) => x.name === 'Documents')
  t.alike(s.skip.slice().sort(), ['/Photos', '/Work/report.txt'], 'skips what was unticked')
  t.ok(s.direct, 'no second copy')
  await until(() => s.engine.entries().length >= 3, 30000)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const shared = s.engine.entries().map((e) => e.path).sort()
  t.alike(shared, ['/Work/Old/archive.txt', '/app/src/main.js', '/todo.txt'], 'only the ticked folders are shared')

  // Cancel creates nothing.
  await page.eval(`addDrive('create'); document.getElementById('ddName').value = 'Again'; document.getElementById('ddFolder').value = ${JSON.stringify(path.join(docs, 'Work'))}; document.getElementById('ddFolder').dataset.edited = '1'; document.getElementById('ddOk').click(); true`)
  await page.until("document.getElementById('selDlg').open && document.querySelector('#selList input[data-p=\"/Old\"]')", 10000)
  await page.eval("document.getElementById('selDone').click(); true")
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(a.spaces.size, 2, 'cancel creates nothing')
  t.ok(await page.eval("document.getElementById('driveDlg').open"), 'back in the new drive dialog')

  // Picking the folder by browsing instead of typing it.
  await page.eval("document.getElementById('ddFolder').value = ''; document.getElementById('ddBrowse').click(); true")
  await page.until("document.getElementById('fsDlg').open && document.querySelector('#fsList [data-p$=\"/Documents\"]')", 5000)
  t.is(await page.eval("document.getElementById('fsPath').textContent"), root, 'starts where drives go by default')
  await page.eval("document.querySelector('#fsList [data-p$=\"/Documents\"]').click(); true")
  await page.until("document.querySelector('#fsList [data-p$=\"/Documents/Work\"]')", 5000)
  await page.eval("document.getElementById('fsNew').click(); true")
  await page.until("document.getElementById('ask').open", 5000)
  await page.eval("document.getElementById('askIn').value = 'Fresh'; document.getElementById('askOk').click(); true")
  await page.until("document.getElementById('fsPath').textContent.endsWith('/Documents/Fresh')", 5000)
  t.ok(await fs.stat(path.join(docs, 'Fresh')).then((st) => st.isDirectory()), 'new folder made')
  await page.eval("document.getElementById('fsUse').click(); true")
  t.is(await page.eval("document.getElementById('ddFolder').value"), path.join(docs, 'Fresh'), 'folder filled in')
  t.absent(await page.eval("document.getElementById('fsDlg').open"), 'picker closed')
})
