// Selective sync: online-only paths are never downloaded, and making
// something online-only never deletes it for the other devices.
import test from 'brittle'
import fs from '#fs/promises'
import path from '#path'
import { setup, until, read, exists, sleep } from './helpers.js'

async function put (e, p, content) {
  await fs.mkdir(path.dirname(e.file(p)), { recursive: true })
  await fs.writeFile(e.file(p), content)
}

async function readAll (stream) {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return Buffer.concat(chunks).toString()
}

test('excluded folder is listed but not downloaded; including it downloads it', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await put(a, 'Photos/x.jpg', 'photo')
  await put(a, 'Docs/d.txt', 'doc')
  await a.sync()
  const b = await device('b', { excluded: ['/Photos'] })
  await until(async () => (await exists(b.file('Docs/d.txt'))) && b.entries().length === 2, 20000, 'docs synced, photos listed')
  await sleep(1000)
  await b.sync()
  t.absent(await exists(b.file('Photos/x.jpg')), 'excluded file not downloaded')
  t.absent(b.pending.size, 'online-only files are not "waiting"')
  t.ok(b.entries().some((x) => x.path === '/Photos/x.jpg'), 'listed in the drive')
  t.is(await readAll(b.openRemote('/Photos/x.jpg').stream), 'photo', 'can be opened on demand')

  await put(a, 'Photos/x.jpg', 'photo v2')
  await a.sync()
  await until(() => b.entries().some((x) => x.path === '/Photos/x.jpg' && x.size === 8), 20000, 'update listed')
  await b.sync()
  t.absent(await exists(b.file('Photos/x.jpg')), 'remote update to an excluded file is not downloaded')

  await b.setExcluded([])
  await until(async () => (await exists(b.file('Photos/x.jpg'))) && (await read(b.file('Photos/x.jpg'))) === 'photo v2', 20000, 'downloaded after including')
  t.pass('including the folder downloads it')
})

test('making a synced folder online-only removes it here, never on other devices', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await put(a, 'Docs/d.txt', 'doc')
  await put(a, 'Docs/sub/e.txt', 'e')
  await put(a, 'keep.txt', 'k')
  await a.sync()
  const b = await device('b')
  await until(async () => exists(b.file('Docs/sub/e.txt')), 20000, 'synced')

  await b.setExcluded(['/Docs'])
  await until(async () => !(await exists(b.file('Docs'))), 10000, 'local copy removed')
  for (let i = 0; i < 3; i++) { await b.sync(); await a.sync(); await sleep(300) }
  t.is(await read(a.file('Docs/d.txt')), 'doc', 'still on the other device')
  t.is(await read(a.file('Docs/sub/e.txt')), 'e', 'nested file still on the other device')
  t.ok(await exists(b.file('keep.txt')), 'other files stay')
  t.ok(b.entries().some((x) => x.path === '/Docs/d.txt'), 'still listed on this device')

  // Restart keeps the choice and still deletes nothing.
  await b.close()
  const b2 = await device('b', { excluded: ['/Docs'] })
  await b2.sync()
  await sleep(500)
  await a.sync()
  t.is(await read(a.file('Docs/d.txt')), 'doc', 'restart did not publish a deletion')
})

test('an unpublished local edit is published before the copy is removed', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await put(a, 'Docs/d.txt', 'v1')
  await a.sync()
  const b = await device('b')
  await until(async () => exists(b.file('Docs/d.txt')), 20000, 'synced')
  await fs.writeFile(b.file('Docs/d.txt'), 'edited on b before excluding')
  await b.setExcluded(['/Docs'])
  await until(async () => (await read(a.file('Docs/d.txt')).catch(() => '')) === 'edited on b before excluding', 20000, 'edit reached a')
  await until(async () => !(await exists(b.file('Docs/d.txt'))), 10000, 'then removed locally')
  t.pass('edit kept')
})

test('whole drive online-only: nothing stored here, everything kept elsewhere', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await put(a, 'a.txt', 'a')
  await put(a, 'f/b.txt', 'b')
  await a.sync()
  const b = await device('b', { excluded: ['/'] })
  await until(() => b.entries().length === 2, 20000, 'listed')
  await b.sync()
  const files = (await fs.readdir(b.folder)).filter((n) => !n.startsWith('.syncker'))
  t.alike(files, [], 'nothing downloaded')
  await b.setExcluded([])
  await until(async () => exists(b.file('f/b.txt')), 20000, 'downloaded once included')
  await b.setExcluded(['/'])
  await until(async () => !(await exists(b.file('a.txt'))) && !(await exists(b.file('f'))), 10000, 'removed again')
  for (let i = 0; i < 3; i++) { await b.sync(); await a.sync(); await sleep(300) }
  t.ok((await exists(a.file('a.txt'))) && (await exists(a.file('f/b.txt'))), 'other device untouched')
  t.ok(await exists(path.join(b.folder, '.syncker')), 'marker kept (folder still recognized)')
})

test('remote: another device chooses what this device syncs, also while it was offline', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await put(a, 'Photos/x.jpg', 'photo')
  await put(a, 'Docs/d.txt', 'doc')
  await a.sync()
  const b = await device('b')
  const c = await device('c')
  await until(async () => exists(b.file('Photos/x.jpg')), 20000, 'b synced')
  await until(() => a.peers.has(b.key) && a.selections.has(b.key), 20000, 'a knows b and its selection')

  const events = []
  b.on('excluded', (list, by) => events.push([list, by]))
  await a.setSelection(b.key, ['/Photos'])
  await until(async () => !(await exists(b.file('Photos/x.jpg'))), 20000, 'b dropped Photos')
  t.alike(b.excluded, ['/Photos'], 'b follows the remote choice')
  t.alike(events[0], [['/Photos'], 'a'], 'b is told who changed it')
  t.ok(await exists(b.file('Docs/d.txt')), 'b keeps the rest')
  t.is(await read(a.file('Photos/x.jpg')), 'photo', 'nothing deleted on a')
  await until(() => c.selections.get(b.key) && c.selections.get(b.key).excluded.length === 1, 20000, 'c sees it too')
  t.pass('every device agrees on what b stores')

  // b goes offline; c changes b's choice; b picks it up when it returns.
  await b.close()
  await until(() => c.connections.size === 1, 20000, 'c sees b gone')
  await c.setSelection(b.key, [])
  const b2 = await device('b')
  await until(() => b2.excluded.length === 0, 20000, 'newest choice')
  t.pass('restart: b took the newest choice from the drives')
  await until(async () => exists(b2.file('Photos/x.jpg')), 20000, 'b has Photos again')
  t.pass('applied after coming back online')

  // b's own later choice wins over the older remote one.
  await b2.setExcluded(['/Docs'])
  await until(() => a.selections.get(b2.key) && a.selections.get(b2.key).excluded[0] === '/Docs', 20000, 'a sees b\'s own choice')
  t.alike(b2.excluded, ['/Docs'])
})

test('remote: a device can refuse remote changes', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await put(a, 'Photos/x.jpg', 'photo')
  await a.sync()
  const b = await device('b')
  await until(async () => exists(b.file('Photos/x.jpg')), 20000, 'b synced')
  await b.setAllowRemote(false)
  await until(() => a.selections.get(b.key) && a.selections.get(b.key).allowRemote === false, 20000, 'a sees b is locked')
  await t.exception(() => a.setSelection(b.key, ['/Photos']), /does not allow/, 'refused on a')

  // Even a record written anyway (e.g. before a saw the lock) is ignored by b.
  a._mine[b.key] = { excluded: ['/Photos'], clock: 99 }
  await a._publishSelections()
  await sleep(1500)
  await b.sync()
  t.alike(b.excluded, [], 'b ignores it')
  t.ok(await exists(b.file('Photos/x.jpg')), 'b keeps its files')

  await b.setAllowRemote(true)
  await until(() => b.excluded.length === 1, 20000, 'allowed again: the newest remote choice applies')
  t.alike(b.excluded, ['/Photos'])
})

test('"only these folders": a ticked folder syncs, folders added later stay online only', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await put(a, 'Docs/d.txt', 'doc')
  await put(a, 'Photos/p.jpg', 'photo')
  await put(a, 'top.txt', 'top')
  await a.sync()
  const b = await device('b', { excluded: ['/', '+/Docs', '/Docs/Old'] })
  await until(async () => exists(b.file('Docs/d.txt')), 20000, 'ticked folder synced')
  await put(a, 'Docs/new.txt', 'new in docs')
  await put(a, 'Docs/Old/o.txt', 'old')
  await put(a, 'Later/l.txt', 'later')
  await a.sync()
  await until(async () => exists(b.file('Docs/new.txt')), 20000, 'new file in a ticked folder')
  await until(() => b.entries().some((x) => x.path === '/Later/l.txt'), 20000, 'listed')
  await sleep(1000)
  await b.sync()
  t.absent(await exists(b.file('Photos/p.jpg')), 'unticked folder online only')
  t.absent(await exists(b.file('top.txt')), 'unticked file online only')
  t.absent(await exists(b.file('Later/l.txt')), 'a folder added later stays online only')
  t.absent(await exists(b.file('Docs/Old/o.txt')), 'an unticked folder inside a ticked one stays online only')
  t.is(b.pending.size, 0, 'nothing waiting')
  t.is(await read(a.file('Photos/p.jpg')), 'photo', 'nothing deleted elsewhere')
  t.alike(b.excluded, ['/', '+/Docs', '/Docs/Old'], 'rules kept as given')
})
