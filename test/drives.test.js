// Shared drives: each invite is its own drive (own folder, data and peers),
// a device can be in several, and old single-drive setups keep working.
import test from 'brittle'
import fs from '#fs/promises'
import os from '#os'
import path from '#path'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../lib/app.js'
import { Engine } from '../lib/engine.js'
import { newSecret, toInvite, fromInvite } from '../lib/config.js'
import { until, read, exists } from './helpers.js'

const httpTest = typeof fetch === 'function' ? test : test.skip

async function env (t) {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-drives-'))
  const apps = []
  const make = async (name) => {
    const app = new App({ home: path.join(root, name, 'home'), defaultFolder: path.join(root, name, 'Syncker'), defaultName: name, port: 0, bootstrap: testnet.bootstrap })
    await app.start()
    apps.push(app)
    return app
  }
  t.teardown(async () => {
    for (const a of apps) await a.close()
    await testnet.destroy()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { make, root, testnet }
}

test('invite format carries the drive name and still accepts old invites', (t) => {
  const secret = newSecret()
  t.alike(fromInvite(toInvite(secret, 'Família & Co')), { secret, name: 'Família & Co' })
  t.alike(fromInvite(toInvite(secret)), { secret, name: null })
  t.exception(() => fromInvite('syncker:nope'), /Invalid invite/)
})

test('two drives, a device joins only one: files never cross drives', async (t) => {
  const { make } = await env(t)
  const laptop = await make('laptop')
  const phone = await make('phone')
  const work = await laptop.setup({ mode: 'create', drive: 'Work' })
  const family = await laptop.addSpace({ mode: 'create', name: 'Family' })
  t.ok(family.folder.endsWith('Syncker - Family'), 'second drive folder next to the first: ' + family.folder)
  await t.exception(() => laptop.addSpace({ mode: 'create', name: 'X', folder: path.join(work.folder, 'inside') }), /overlaps/, 'nested folders refused')
  await t.exception(() => laptop.addSpace({ mode: 'join', invite: work.invite }), /Already in/, 'joining twice refused')

  await fs.writeFile(path.join(work.folder, 'report.txt'), 'work')
  await fs.writeFile(path.join(family.folder, 'photo.jpg'), 'family')

  const joined = await phone.setup({ mode: 'join', invite: family.invite, name: 'phone' })
  t.is(joined.name, 'Family', 'drive name taken from the invite')
  await until(() => exists(path.join(joined.folder, 'photo.jpg')), 30000, 'family file on phone')
  t.is(await read(path.join(joined.folder, 'photo.jpg')), 'family')
  t.absent(await exists(path.join(joined.folder, 'report.txt')), 'work file not in the family drive')
  t.is(phone.spaces.size, 1)
  const fam = phone.info().spaces[0]
  t.is(fam.peers.length, 1, 'phone knows only the laptop (in this drive)')

  // Phone joins Work later: second drive on the phone.
  const w = await phone.addSpace({ mode: 'join', invite: work.invite })
  await until(() => exists(path.join(w.folder, 'report.txt')), 30000, 'work file on phone')
  t.not(w.folder, joined.folder, 'separate folders')

  // Leaving Family on the phone keeps its files there and stops syncing it.
  await phone.removeSpace(phone.info().spaces.find((s) => s.name === 'Family').id)
  await fs.writeFile(path.join(family.folder, 'later.jpg'), 'later')
  await fs.writeFile(path.join(work.folder, 'later.txt'), 'later')
  await until(() => exists(path.join(w.folder, 'later.txt')), 30000, 'work still syncs')
  t.absent(await exists(path.join(joined.folder, 'later.jpg')), 'left drive no longer syncs')
  t.ok(await exists(path.join(joined.folder, 'photo.jpg')), 'left drive files kept')
  t.ok(await exists(path.join(family.folder, 'photo.jpg')), 'nothing deleted on the laptop')
})

httpTest('a drive just joined shows no files until its whole file list is here', { timeout: 120000 }, async (t) => {
  const { make, root } = await env(t)
  const laptop = await make('laptop')
  const drive = await laptop.setup({ mode: 'create', drive: 'Big' })
  t.ok(laptop.info().spaces[0].listed, 'a drive made here is listed from the start')
  for (let i = 0; i < 300; i++) await fs.writeFile(path.join(drive.folder, `f${i}.txt`), 'x' + i)
  await until(() => laptop.spaces.get(drive.id).engine.entries().length === 300, 30000, 'laptop published')

  const phone = await make('phone')
  const joined = await phone.setup({ mode: 'join', invite: drive.invite, name: 'phone' })
  const s = phone.spaces.get(joined.id)
  t.is(s.engine.listed, false, 'not listed right after joining')
  const port = phone.server.address().port
  const list = async () => (await fetch(`http://127.0.0.1:${port}/api/list?space=${joined.id}&dir=/`)).json()
  let partial = 0
  let hidden = 0
  await until(async () => {
    const r = await list()
    if (r.listing) { hidden++; t.is(r.items.length, 0); return false }
    if (r.items.length !== 300) partial++
    return r.items.length === 300
  }, 60000, 'whole list shown')
  t.ok(hidden > 0, 'hidden while the list was coming in')
  t.is(partial, 0, 'never a partial list')
  t.is(phone.info().spaces[0].listed, true)

  await phone.close()
  const again = new App({ home: path.join(root, 'phone', 'home'), defaultFolder: path.join(root, 'phone', 'Syncker'), defaultName: 'phone', port: 0 })
  await again.start()
  t.is(again.spaces.get(joined.id).engine.listed, true, 'still listed after a restart, with no device online')
  await again.close()
})

test('photo backup: asked once, the camera folder syncs as its own drive, half-written photos stay put', async (t) => {
  const { root, testnet } = await env(t)
  const camera = path.join(root, 'phone', 'DCIM', 'Camera')
  await fs.mkdir(camera, { recursive: true })
  await fs.writeFile(path.join(camera, 'IMG_1.jpg'), 'old photo')
  // The first folder with photos in it is offered: DCIM/Camera here, not the empty Pictures.
  await fs.mkdir(path.join(root, 'phone', 'Pictures'), { recursive: true })
  const opts = { home: path.join(root, 'phone', 'home'), defaultFolder: path.join(root, 'phone', 'Syncker'), defaultName: 'Pixel', port: 0, bootstrap: testnet.bootstrap, cameraFolder: [path.join(root, 'phone', 'Pictures'), camera] }
  const phone = new App(opts)
  await phone.start()
  await phone.setup({ mode: 'create', drive: 'Files' })
  t.alike(phone.info().camera, { folder: camera, asked: false, space: null }, 'not asked yet, nothing synced')
  t.is(phone.spaces.size, 1)

  const cam = await phone.setCamera(true)
  t.is(cam.name, 'Pixel photos')
  t.is(cam.folder, camera)
  t.alike(phone.info().camera, { folder: camera, asked: true, space: cam.id })
  t.is(phone.spaces.get(cam.id).engine.direct, true, 'sent from the folder: no copy on the phone')

  const laptop = new App({ home: path.join(root, 'laptop', 'home'), defaultFolder: path.join(root, 'laptop', 'Syncker'), defaultName: 'laptop', port: 0, bootstrap: testnet.bootstrap })
  await laptop.start()
  const got = await laptop.setup({ mode: 'join', invite: cam.invite, name: 'laptop', ask: false })
  t.teardown(() => laptop.close())
  await until(() => exists(path.join(got.folder, 'IMG_1.jpg')), 30000, 'camera roll on the laptop')
  await fs.writeFile(path.join(camera, '.pending-1700000000-IMG_2.jpg'), 'half')
  await fs.writeFile(path.join(camera, 'IMG_3.jpg'), 'new photo')
  phone.spaces.get(cam.id).engine.sync()
  await until(() => exists(path.join(got.folder, 'IMG_3.jpg')), 30000, 'new photo on the laptop')
  t.is(await read(path.join(got.folder, 'IMG_3.jpg')), 'new photo')
  t.absent(await exists(path.join(got.folder, '.pending-1700000000-IMG_2.jpg')), 'photo still being written is not synced')

  await phone.close()
  const again = new App(opts)
  await again.start()
  t.alike(again.info().camera, { folder: camera, asked: true, space: cam.id }, 'kept after a restart')
  await again.removeSpace(cam.id)
  t.alike(again.info().camera, { folder: camera, asked: true, space: null }, 'left: offered from the menu, not asked again')
  await again.setCamera(false)
  t.is(again.spaces.size, 1, '"not now" adds nothing')
  const other = path.join(root, 'phone', 'Elsewhere')
  const moved = await again.setCamera(true, other)
  t.is(moved.folder, other, 'a folder picked by the user')
  await again.removeSpace(moved.id)
  t.ok(await exists(path.join(camera, 'IMG_1.jpg')), 'leaving the drive keeps the photos')
  await again.close()
})

test('restart keeps all drives and the selective sync choice', async (t) => {
  const { make, root } = await env(t)
  const a = await make('a')
  await a.setup({ mode: 'create', drive: 'One' })
  const two = await a.addSpace({ mode: 'create', name: 'Two' })
  await a.setExcluded(two.id, ['/big'])
  await a.close()
  const b = new App({ home: path.join(root, 'a', 'home'), defaultFolder: path.join(root, 'a', 'Syncker'), defaultName: 'a', port: 0 })
  await b.start()
  t.teardown(() => b.close())
  t.alike([...b.spaces.values()].map((s) => s.name), ['One', 'Two'])
  t.alike(b.spaces.get(two.id).engine.excluded, ['/big'])
  t.is(b.deviceName, 'a')
})

test('a setup from before shared drives is migrated in place', async (t) => {
  const { root, testnet } = await env(t)
  const home = path.join(root, 'old', 'home')
  const folder = path.join(root, 'old', 'Syncker')
  const secret = newSecret()
  // Old layout: config { secret, folder, deviceName }, engine data directly in home.
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ secret, folder, deviceName: 'old-pc' }))
  const e = new Engine({ home, folder, secret, deviceName: 'old-pc', bootstrap: testnet.bootstrap })
  await e.start()
  await fs.writeFile(path.join(folder, 'old.txt'), 'old')
  await e.sync()
  const key = e.key
  await e.close()

  const app = new App({ home, defaultFolder: folder, defaultName: 'x', port: 0, bootstrap: testnet.bootstrap })
  await app.start()
  t.teardown(() => app.close())
  t.is(app.deviceName, 'old-pc')
  t.is(app.spaces.size, 1)
  t.is(app.engine.key, key, 'same drive identity (data reused in place)')
  t.is(app.engine.index['/old.txt'] && app.engine.index['/old.txt'].size, 3, 'sync state reused')
  t.is(fromInvite(app.invite).secret, secret, 'same invite secret')
  // Adding a drive writes the new config format and keeps the old drive's data where it is.
  await app.addSpace({ mode: 'create', name: 'New' })
  const saved = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'))
  t.is(saved.version, 2)
  t.alike(saved.spaces.map((s) => s.home), ['', saved.spaces[1].home])
  t.ok(saved.spaces[1].home.startsWith('spaces'), 'new drive data in its own directory')
})

// Uses fetch (Node only); the engine side of this runs on Bare in selective.test.js.

httpTest('from the laptop UI API: choose what the phone syncs; the phone can lock it', async (t) => {
  const { make } = await env(t)
  const laptop = await make('laptop')
  const phone = await make('phone')
  const d = await laptop.setup({ mode: 'create', drive: 'Home' })
  await fs.mkdir(path.join(d.folder, 'Videos'))
  await fs.writeFile(path.join(d.folder, 'Videos', 'v.mp4'), 'video')
  await fs.writeFile(path.join(d.folder, 'notes.txt'), 'n')
  const pd = await phone.setup({ mode: 'join', invite: d.invite, name: 'phone' })
  await until(() => exists(path.join(pd.folder, 'Videos', 'v.mp4')), 30000, 'phone synced')
  const phoneKey = phone.engine.key
  await until(() => laptop.engine.selections.has(phoneKey), 20000, 'laptop sees the phone selection')

  const url = `http://127.0.0.1:${laptop.server.address().port}`
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const r = await post(`/api/selective?space=${d.id}&device=${phoneKey}`, { path: '/Videos', sync: false })
  t.is(r.status, 200)
  t.alike((await r.json()).excluded, ['/Videos'])
  await until(async () => !(await exists(path.join(pd.folder, 'Videos', 'v.mp4'))), 20000, 'phone dropped Videos')
  t.ok(await exists(path.join(pd.folder, 'notes.txt')), 'phone keeps the rest')
  t.ok(await exists(path.join(d.folder, 'Videos', 'v.mp4')), 'laptop keeps Videos')
  await until(async () => JSON.parse(await fs.readFile(path.join(phone.home, 'config.json'), 'utf8')).spaces[0].excluded[0] === '/Videos', 10000, 'phone config saved')
  t.pass('phone remembers the choice')
  const tree = await (await fetch(`${url}/api/tree?space=${d.id}&device=${phoneKey}`)).json()
  t.alike(tree.excluded, ['/Videos'], 'tree shows the phone\'s choice')

  // The phone turns remote changes off.
  await phone.setAllowRemote(phone.engine && [...phone.spaces.keys()][0], false)
  await until(() => laptop.engine.selections.get(phoneKey).allowRemote === false, 20000, 'laptop sees the lock')
  const r2 = await post(`/api/selective?space=${d.id}&device=${phoneKey}`, { path: '/Videos', sync: true })
  t.is(r2.status, 403, 'refused')
  t.alike(phone.engine.excluded, ['/Videos'], 'unchanged')
  const saved = JSON.parse(await fs.readFile(path.join(phone.home, 'config.json'), 'utf8'))
  t.is(saved.spaces[0].allowRemote, false, 'lock saved on the phone')
})

httpTest('big folders list quickly; photos get the small preview stored in them', { timeout: 60000 }, async (t) => {
  const { make } = await env(t)
  const a = await make('a')
  const d = await a.setup({ mode: 'create', drive: 'Photos' })
  const cam = path.join(d.folder, 'Camera')
  await fs.mkdir(path.join(cam, 'Old'), { recursive: true })
  for (let i = 0; i < 2000; i++) await fs.writeFile(path.join(cam, `IMG_${i}.txt`), 'x' + i)
  await fs.writeFile(path.join(cam, 'Old', 'a.txt'), 'aaa')
  await fs.copyFile(new URL('./fixtures/camera.jpg', import.meta.url).pathname, path.join(cam, 'cam.jpg'))
  await fs.writeFile(path.join(cam, 'plain.jpg'), 'not really a jpeg')
  await a.engine.sync()
  const url = `http://127.0.0.1:${a.server.address().port}`

  const list = await (await fetch(`${url}/api/list?space=${d.id}&dir=/Camera`)).json()
  t.is(list.items.length, 2003, 'every file and folder listed')
  t.ok(list.items.find((it) => it.name === 'IMG_1999.txt' && it.synced), 'files are synced')
  const top = await (await fetch(`${url}/api/list?space=${d.id}&dir=/`)).json()
  t.is(top.items.length, 1)
  t.is(top.items[0].dir, true)

  const r = await fetch(`${url}/api/thumb?space=${d.id}&path=/Camera/cam.jpg`)
  t.is(r.headers.get('content-type'), 'image/jpeg')
  const small = new Uint8Array(await r.arrayBuffer())
  const full = await fs.readFile(path.join(cam, 'cam.jpg'))
  t.ok(small.length < 1000 && small.length < full.length, 'the preview, not the photo')
  t.alike([small[0], small[1], small[2], small[3]], [0xff, 0xd8, 0xff, 0xe1], 'a JPEG that carries the orientation')
  t.is(small[31], 6, 'turned like the photo')
  const plain = await fetch(`${url}/api/thumb?space=${d.id}&path=/Camera/plain.jpg`)
  t.is(await plain.text(), 'not really a jpeg', 'no preview: the whole file')
})

test('status while a drive is still starting does not crash (SSE pushes during "join")', async (t) => {
  const { make } = await env(t)
  const a = await make('a')
  await a.setup({ mode: 'create', drive: 'One' })
  let calls = 0
  let failed = null
  let sawStarting = false
  const poll = setInterval(() => {
    try {
      const two = a.info().spaces.find((s) => s.name === 'Two')
      if (two && two.status.phase === 'starting') sawStarting = true
      calls++
    } catch (err) { failed = err }
  }, 1)
  await a.addSpace({ mode: 'create', name: 'Two' })
  clearInterval(poll)
  t.absent(failed, 'info() never threw (' + calls + ' calls)')
  t.ok(sawStarting, 'the starting drive was reported as "starting"')
  t.not(a.info().spaces.find((s) => s.name === 'Two').status.phase, 'starting', 'running once added')
})
