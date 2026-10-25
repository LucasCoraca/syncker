// A folder that disappears or becomes unreadable must never be read as
// "the user deleted everything" (and wipe the other devices).
import test from 'brittle'
import fs from '#fs/promises'
import b4a from 'b4a'
import crypto from '#crypto'
import { setup, until, read, exists, sleep, snapshot } from './helpers.js'

async function pair (t) {
  const { device } = await setup(t)
  const a = await device('a')
  const b = await device('b')
  await fs.mkdir(a.file('docs'))
  await fs.writeFile(a.file('docs/one.txt'), 'one')
  await fs.writeFile(a.file('two.txt'), 'two')
  await until(async () => (await read(b.file('docs/one.txt'))) === 'one' && (await read(b.file('two.txt'))) === 'two', 20000, 'initial sync')
  return { device, a, b }
}

test('synced folder deleted: sync pauses, nothing is deleted elsewhere', async (t) => {
  const { a, b } = await pair(t)
  await fs.rm(a.folder, { recursive: true })
  await a.sync()
  t.is(a.status.phase, 'error', 'a reports an error')
  t.ok(/Folder unavailable/.test(a.status.error), a.status.error)
  await sleep(1500)
  await b.sync()
  t.is(await read(b.file('docs/one.txt')), 'one', 'b keeps docs/one.txt')
  t.is(await read(b.file('two.txt')), 'two', 'b keeps two.txt')
  t.absent(await exists(a.folder), 'a does not recreate the folder by itself')
})

test('folder replaced by an empty one (unmounted storage): nothing is deleted', async (t) => {
  const { a, b } = await pair(t)
  await fs.rm(a.folder, { recursive: true })
  await fs.mkdir(a.folder) // empty mount point, no marker
  await a.sync()
  t.is(a.status.phase, 'error')
  await sleep(1500)
  await b.sync()
  t.alike(await snapshot(b.folder), ['/docs/one.txt=one', '/two.txt=two'])
})

test('engine restarted while the folder is missing: nothing is deleted, resumes when it is back', async (t) => {
  const { device, a, b } = await pair(t)
  await a.close()
  const backup = a.folder + '.away'
  await fs.rename(a.folder, backup)
  const a2 = await device('a')
  await a2.sync()
  t.is(a2.status.phase, 'error')
  t.absent(await exists(a2.folder), 'folder not recreated on restart')
  await sleep(1500)
  t.alike(await snapshot(b.folder), ['/docs/one.txt=one', '/two.txt=two'])

  await fs.rename(backup, a2.folder)
  await fs.writeFile(a2.file('three.txt'), 'three')
  await a2.sync()
  t.is(a2.status.phase, 'idle', 'resumes once the folder is back')
  await until(async () => (await read(b.file('three.txt'))) === 'three', 20000, 'sync resumed')
  t.alike(await snapshot(b.folder), ['/docs/one.txt=one', '/three.txt=three', '/two.txt=two'])
})

const isRoot = typeof process !== 'undefined' && process.getuid && process.getuid() === 0

test('unreadable subfolder is not treated as deleted', { skip: isRoot }, async (t) => {
  const { a, b } = await pair(t)
  await fs.chmod(a.file('docs'), 0o000)
  t.teardown(() => fs.chmod(a.file('docs'), 0o755).catch(() => {}))
  await a.sync()
  await sleep(1500)
  await b.sync()
  t.is(await read(b.file('docs/one.txt')), 'one', 'b keeps the file in the unreadable folder')
  await fs.chmod(a.file('docs'), 0o755)
})

test('folder from an older version (no marker) is adopted, not paused', async (t) => {
  const { a, b } = await pair(t)
  await fs.rm(a.file('.syncker'))
  await fs.writeFile(a.file('new.txt'), 'new')
  await a.sync()
  t.is(a.status.phase, 'idle')
  t.ok(await exists(a.file('.syncker')), 'marker written')
  await until(async () => (await read(b.file('new.txt'))) === 'new', 20000, 'still syncing')
})

test('paused engine (storage access revoked) neither scans nor writes, and resumes cleanly', async (t) => {
  const { a, b } = await pair(t)
  a.setPaused('Folder unavailable: no access')
  t.is(a.status.phase, 'error')
  await fs.rename(a.file('two.txt'), a.file('two.hidden')) // looks deleted while paused
  await fs.writeFile(b.file('from-b.txt'), 'b')
  await a.sync()
  await sleep(1500)
  await b.sync()
  t.is(await read(b.file('two.txt')), 'two', 'b keeps two.txt')
  t.absent(await exists(a.file('from-b.txt')), 'a does not write while paused')

  await fs.rename(a.file('two.hidden'), a.file('two.txt')) // access is back
  a.setPaused(null)
  await until(async () => (await read(a.file('from-b.txt'))) === 'b', 20000, 'a catches up after resume')
  t.is(a.status.phase, 'idle')
  t.is(await read(b.file('two.txt')), 'two')
})

test('data from before version vectors: the first edit after upgrading is not a conflict', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  const b = await device('b')
  // a publishes an old-format entry (no vv), b downloads it with an old-format index
  const buf = b4a.from('old')
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  await a.drive.put('/legacy.txt', buf, { metadata: { clock: 1, hash, size: 3, mtime: 1, device: 'a' } })
  await a.sync()
  await until(async () => (await read(b.file('legacy.txt'))) === 'old', 20000, 'legacy file arrives')
  delete b.index['/legacy.txt'].vv
  await fs.writeFile(b.file('legacy.txt'), 'edited after upgrade')
  await b.sync()
  await until(async () => (await read(a.file('legacy.txt'))) === 'edited after upgrade', 20000, 'edit arrives')
  await sleep(1000)
  t.alike(await snapshot(a.folder), ['/legacy.txt=edited after upgrade'], 'no conflict copy')
})
