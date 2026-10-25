// Joining a drive: a small one syncs right away, a big one asks first
// (nothing is downloaded until someone chooses what to sync).
import test from 'brittle'
import fs from '#fs/promises'
import os from '#os'
import path from '#path'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../lib/app.js'
import { until, read, exists, sleep } from './helpers.js'

async function env (t) {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-join-'))
  const apps = []
  const make = async (name, opts = {}) => {
    const app = new App({ home: path.join(root, name, 'home'), defaultFolder: path.join(root, name, 'Syncker'), defaultName: name, port: 0, bootstrap: testnet.bootstrap, ...opts })
    await app.start()
    apps.push(app)
    return app
  }
  t.teardown(async () => {
    for (const a of apps) await a.close()
    await testnet.destroy()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { make, root }
}

async function drive (laptop) {
  const d = await laptop.setup({ mode: 'create', drive: 'Home' })
  await fs.mkdir(path.join(d.folder, 'Videos'), { recursive: true })
  await fs.writeFile(path.join(d.folder, 'Videos', 'big.mp4'), Buffer.alloc(200 * 1024, 7))
  await fs.writeFile(path.join(d.folder, 'notes.txt'), 'notes')
  // The watcher may publish a half-written file first: wait for the final one.
  await until(async () => {
    await laptop.engine.sync()
    const e = await laptop.engine.drive.entry('/Videos/big.mp4')
    if (e && e.value.metadata.size === 200 * 1024) return true
    const st = await fs.stat(path.join(d.folder, 'Videos', 'big.mp4')).catch(() => null)
    throw new Error(`entry ${JSON.stringify(e && e.value.metadata)} index ${JSON.stringify(laptop.engine.index['/Videos/big.mp4'])} disk ${st && st.size}/${st && st.mtimeMs}/${st && st.ino} status ${JSON.stringify(laptop.engine.status)}`)
  }, 20000, 'added')
  return d
}

test('a small drive syncs everything after joining', async (t) => {
  const { make } = await env(t)
  const laptop = await make('laptop')
  const d = await drive(laptop)
  const phone = await make('phone')
  const j = await phone.setup({ mode: 'join', invite: d.invite, name: 'phone' })
  await until(async () => (await exists(path.join(j.folder, 'Videos', 'big.mp4'))) && exists(path.join(j.folder, 'notes.txt')), 30000, 'downloaded')
  t.is(phone.info().spaces[0].hold, null, 'no question asked')
  t.is(await read(path.join(j.folder, 'notes.txt')), 'notes')
})

test('a big drive waits for a choice; choosing folders starts the sync', async (t) => {
  const { make, root } = await env(t)
  const laptop = await make('laptop')
  const d = await drive(laptop)
  const phone = await make('phone', { askAbove: 100 * 1024 })
  const j = await phone.setup({ mode: 'join', invite: d.invite, name: 'phone' })
  t.ok(phone.info().spaces[0].hold, 'on hold right after joining')
  await until(() => phone.info().spaces[0].hold && phone.info().spaces[0].hold.ready, 30000, 'size known')
  const h = phone.info().spaces[0].hold
  t.is(h.files, 2)
  t.is(h.bytes, 200 * 1024 + 5)
  t.ok(h.free > 0, 'free space reported')
  await sleep(1500)
  await phone.engine.sync()
  t.absent(await exists(path.join(j.folder, 'notes.txt')), 'nothing downloaded while waiting')
  t.absent(phone.engine.pending.size, 'nothing pending either')
  t.is(phone.engine.details('/notes.txt').here.text, 'Not downloaded: choose what to sync from this drive first')
  t.ok(phone.info().spaces[0].selections, 'listed')

  // Restart: still waiting.
  await phone.close()
  const again = await make('phone', { askAbove: 100 * 1024 })
  t.ok(again.info().spaces[0].hold, 'still waiting after a restart')

  const sp = again.info().spaces[0].id
  if (typeof fetch === 'function') {
    // Draft edits through the web API apply nothing.
    const draft = await post(again, sp, { base: [], path: '/Videos', sync: false })
    t.alike(draft.excluded, ['/Videos'], 'draft computed')
    t.ok(again.info().spaces[0].hold, 'draft does not start the sync')
    await post(again, sp, { excluded: draft.excluded })
  } else await again.setExcluded(sp, ['/Videos'])
  await until(() => exists(path.join(j.folder, 'notes.txt')), 30000, 'chosen files downloaded')
  t.is(again.info().spaces[0].hold, null, 'no longer waiting')
  await sleep(1000)
  t.absent(await exists(path.join(j.folder, 'Videos', 'big.mp4')), 'unticked folder not downloaded')
  const cfg = JSON.parse(await fs.readFile(path.join(root, 'phone', 'home', 'config.json'), 'utf8'))
  t.is(cfg.spaces[0].hold, false, 'saved')
})

const post = async (app, sp, body) => (await fetch(`http://127.0.0.1:${app.server.address().port}/api/selective?space=${sp}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()

test('a single "keep on this device" while waiting keeps only that file', { skip: typeof fetch !== 'function' }, async (t) => {
  const { make } = await env(t)
  const laptop = await make('laptop')
  const d = await drive(laptop)
  const phone = await make('phone', { askAbove: 100 * 1024 })
  const j = await phone.setup({ mode: 'join', invite: d.invite, name: 'phone' })
  await until(() => phone.info().spaces[0].hold && phone.info().spaces[0].hold.ready, 30000, 'size known')
  await post(phone, phone.info().spaces[0].id, { path: '/notes.txt', sync: true })
  await until(() => exists(path.join(j.folder, 'notes.txt')), 30000, 'that file downloaded')
  await sleep(1000)
  t.absent(await exists(path.join(j.folder, 'Videos', 'big.mp4')), 'the rest stays online only')
})

test('joining from the command line syncs everything (no question)', async (t) => {
  const { make } = await env(t)
  const laptop = await make('laptop')
  const d = await drive(laptop)
  const phone = await make('phone', { askAbove: 10 })
  const j = await phone.setup({ mode: 'join', invite: d.invite, name: 'phone', ask: false })
  await until(() => exists(path.join(j.folder, 'Videos', 'big.mp4')), 30000, 'downloaded')
  t.pass('synced without asking')
})
