// Direct drives: files are sent straight from the folder (no copy in the sync
// data), checked against the hash of their entry, resumed after an
// interruption, taken from any device that has them, moved locally instead
// of downloaded again. Plus ignore rules.
import test from 'brittle'
import fs from '#fs/promises'
import path from '#path'
import crypto from '#crypto'
import b4a from 'b4a'
import { setup, until, read, exists, sleep } from './helpers.js'

async function put (e, p, content) {
  await fs.mkdir(path.dirname(e.file(p)), { recursive: true })
  await fs.writeFile(e.file(p), content)
}

async function readAll (stream) {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return b4a.toString(b4a.concat(chunks))
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

async function du (dir) {
  let n = 0
  for (const it of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = path.join(dir, it.name)
    if (it.isDirectory()) n += await du(abs)
    else n += (await fs.stat(abs)).size
  }
  return n
}

async function parts (dir) {
  const out = []
  for (const it of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (it.name.startsWith('.syncker-tmp-')) out.push(it.name)
    if (it.isDirectory()) out.push(...await parts(path.join(dir, it.name)))
  }
  return out
}

test('direct: files sync without a copy in the sync data', async (t) => {
  const { device, root } = await setup(t)
  const a = await device('a', { direct: true })
  const big = crypto.randomBytes(3 * 1024 * 1024)
  await put(a, 'big.bin', big)
  await put(a, 'docs/small.txt', 'small')
  await put(a, 'empty.txt', '')
  await a.sync()
  const b = await device('b', { direct: true })
  await until(async () => (await exists(b.file('big.bin'))) && (await exists(b.file('empty.txt'))) && (await exists(b.file('docs/small.txt'))), 30000, 'synced')
  t.is(sha(await fs.readFile(b.file('big.bin'))), sha(big), 'big file intact')
  t.is(await read(b.file('docs/small.txt')), 'small')
  t.is(await read(b.file('empty.txt')), '', 'empty file')
  const stored = await du(path.join(root, 'a', 'home', 'store'))
  t.ok(stored < 1024 * 1024, `sync data of the author stays small (${stored} bytes)`)
  t.ok((await du(path.join(root, 'b', 'home', 'store'))) < 1024 * 1024, 'and of the receiver')
  t.ok(a.view.get('/big.bin').every((v) => v.meta.direct && !v.blob), 'entry is direct')
  t.alike(await parts(b.folder), [], 'no partial files left')
  const d = a.details('/big.bin')
  await until(() => a.details('/big.bin').devices[0].state === 'synced', 10000, 'a knows b has it')
  t.is(d.here.state, 'synced')

  // Edit and delete propagate too.
  await put(a, 'docs/small.txt', 'edited')
  await fs.rm(a.file('big.bin'))
  await a.sync()
  await until(async () => (await read(b.file('docs/small.txt'))) === 'edited' && !(await exists(b.file('big.bin'))), 20000, 'edit + delete')
  t.pass('edit and delete arrived')
})

test('direct: an interrupted download resumes where it stopped', { timeout: 120000 }, async (t) => {
  const { device } = await setup(t)
  const a = await device('a', { direct: true })
  const big = crypto.randomBytes(24 * 1024 * 1024)
  await put(a, 'big.bin', big)
  await a.sync()
  let b = await device('b', { direct: true })
  // Stop b once part of the file has arrived.
  const partial = await until(async () => {
    const p = (await parts(b.folder))[0]
    const st = p && await fs.stat(path.join(b.folder, p)).catch(() => null)
    return st && st.size > 2 * 1024 * 1024 && st.size < big.byteLength ? st.size : 0
  }, 30000, 'partial download')
  await b.close()
  t.ok(partial > 0, `stopped with ${partial} bytes`)
  b = await device('b', { direct: true })
  let resumedAt = null
  const seen = setInterval(() => {
    for (const x of b.transfers.items.values()) if (x.direct && resumedAt === null && x.bytes) resumedAt = x.bytes
  }, 20)
  await until(() => exists(b.file('big.bin')), 60000, 'completed')
  clearInterval(seen)
  t.is(sha(await fs.readFile(b.file('big.bin'))), sha(big), 'intact after resuming')
  t.ok(resumedAt === null || resumedAt >= partial, `resumed from ${resumedAt}`)
  t.alike(await parts(b.folder), [], 'no partial file left')
})

test('direct: a file comes from another device when its author is offline', { timeout: 90000 }, async (t) => {
  const { device } = await setup(t)
  const a = await device('a', { direct: true })
  await put(a, 'x.txt', 'from a')
  await a.sync()
  const b = await device('b', { direct: true })
  await until(() => exists(b.file('x.txt')), 20000, 'b has it')
  await until(() => a.haves.get(b.key) && a.haves.get(b.key).has('/x.txt'), 10000, 'b told a')
  await sleep(500)
  await a.close()
  const c = await device('c', { direct: true })
  await until(async () => (await exists(c.file('x.txt'))) && (await read(c.file('x.txt'))) === 'from a', 30000, 'c got it from b')
  t.ok((c.activity.get('/x.txt') || []).some((x) => x.text === 'Downloaded from b'), 'logged as downloaded from b')
})

test('direct: the same file made on two devices comes from either one', { timeout: 90000 }, async (t) => {
  const { device, root } = await setup(t)
  // Copied in by hand on two devices while apart: two versions, same content.
  let a = await device('a', { direct: true })
  await put(a, 'x.txt', 'same')
  await a.sync()
  await a.close()
  await fs.mkdir(path.join(root, 'b', 'files'), { recursive: true })
  await fs.writeFile(path.join(root, 'b', 'files', 'x.txt'), 'same')
  const b = await device('b', { direct: true })
  await b.sync()
  a = await device('a', { direct: true })
  await until(() => [a, b].every((e) => (e.view.get('/x.txt') || []).length === 2), 20000, 'both versions seen')
  const winner = a._resolve('/x.txt').winner.keyHex
  const [author, other] = winner === a.key ? [a, b] : [b, a]
  await until(() => author.haves.get(other.key) && author.haves.get(other.key).has('/x.txt'), 10000, 'the other one says it has it')
  await sleep(500)
  await author.close()
  const c = await device('c', { direct: true })
  await until(async () => (await exists(c.file('x.txt'))) && (await read(c.file('x.txt'))) === 'same', 30000, 'c got it while its author is offline')
  t.pass('from ' + other.deviceName)
})

test('a device joining with the files already in its folder publishes none of them', { timeout: 90000 }, async (t) => {
  const { device, root } = await setup(t)
  const a = await device('a', { direct: true })
  for (let i = 0; i < 200; i++) await put(a, `d/f${i}.txt`, 'c' + i)
  await a.sync()
  // A reinstall: the same files are still in the folder, the device is new.
  await fs.mkdir(path.join(root, 'b', 'files', 'd'), { recursive: true })
  for (let i = 0; i < 200; i++) await fs.writeFile(path.join(root, 'b', 'files', 'd', `f${i}.txt`), 'c' + i)
  const b = await device('b', { direct: true, listed: false })
  await until(() => b.listed && Object.keys(b.index).length === 200, 30000, 'matched')
  await b.sync()
  await until(() => a.haves.get(b.key) && a.haves.get(b.key).size === 200, 20000, 'b says it has them')
  const own = [...b.view.values()].flat().filter((v) => v.keyHex === b.key)
  t.is(own.length, 0, 'nothing published as new')
})

test('direct: details of a waiting download say why each connected device is not asked', { timeout: 60000 }, async (t) => {
  const { device } = await setup(t)
  const a = await device('a', { direct: true })
  await put(a, 'x.txt', 'from a')
  await a.sync()
  const b = await device('b', { direct: true, excluded: ['/'] })
  const c = await device('c', { direct: true, excluded: ['/'] })
  await until(() => b.view.has('/x.txt') && [...b.connections.values()].some((x) => x.keyHex === c.key), 20000, 'b knows x and sees c')
  await a.close()
  await b.setExcluded([])
  await until(() => /c: does not have it/.test(b.details('/x.txt').here.text), 20000, 'reason shown')
  t.pass(b.details('/x.txt').here.text)
})

test('a stored version whose author is gone comes from a device that has the same file on disk', { timeout: 90000 }, async (t) => {
  const { device, root } = await setup(t)
  // The same file added on two devices while apart, before the drive was direct.
  let a = await device('a', { direct: false })
  await put(a, 'x.txt', 'same')
  await a.sync()
  await a.close()
  await fs.mkdir(path.join(root, 'b', 'files'), { recursive: true })
  await fs.writeFile(path.join(root, 'b', 'files', 'x.txt'), 'same')
  const b = await device('b', { direct: false })
  await b.sync()
  a = await device('a', { direct: false })
  await until(() => [a, b].every((e) => (e.view.get('/x.txt') || []).length === 2), 20000, 'both versions seen')
  const winner = a._resolve('/x.txt').winner
  t.absent(winner.meta.direct, 'a stored version')
  const [author, other] = winner.keyHex === a.key ? [a, b] : [b, a]
  await until(() => author.haves.get(other.key) && author.haves.get(other.key).has('/x.txt'), 10000, 'the other one says it has it')
  await sleep(500)
  await author.close() // gone for good, with the only stored copy
  const c = await device('c', { direct: false })
  await until(async () => (await exists(c.file('x.txt'))) && (await read(c.file('x.txt'))) === 'same', 30000, 'c got it from the disk of ' + other.deviceName)
  t.pass('from ' + other.deviceName)
})

test('the same file added on two devices: deleting it on one deletes it everywhere, an edit makes no conflict copy', { timeout: 90000 }, async (t) => {
  const { device, root } = await setup(t)
  let a = await device('a')
  await put(a, 'x.txt', 'same')
  await put(a, 'y.txt', 'same y')
  await a.sync()
  await a.close()
  await fs.mkdir(path.join(root, 'b', 'files'), { recursive: true })
  await fs.writeFile(path.join(root, 'b', 'files', 'x.txt'), 'same')
  await fs.writeFile(path.join(root, 'b', 'files', 'y.txt'), 'same y')
  const b = await device('b')
  await b.sync()
  a = await device('a')
  await until(() => [a, b].every((e) => ['/x.txt', '/y.txt'].every((p) => (e.view.get(p) || []).length === 2)), 20000, 'both versions seen')
  await a.sync()
  await b.sync()

  await fs.rm(a.file('x.txt'))
  await a.sync()
  await sleep(2000)
  await a.sync()
  await b.sync()
  await sleep(1000)
  t.absent(await exists(a.file('x.txt')), 'x stays deleted on a')
  t.absent(await exists(b.file('x.txt')), 'x deleted on b')

  await fs.writeFile(a.file('y.txt'), 'edited')
  await a.sync()
  await until(async () => (await read(b.file('y.txt'))) === 'edited', 20000, 'b got the edit')
  await sleep(1000)
  await b.sync()
  const names = [...(await fs.readdir(a.folder)), ...(await fs.readdir(b.folder))].filter((n) => /conflict/.test(n))
  t.alike(names, [], 'no conflict copies')
})

test('direct: a moved file is moved, not downloaded again', async (t) => {
  const { device } = await setup(t)
  const a = await device('a', { direct: true })
  const big = crypto.randomBytes(2 * 1024 * 1024)
  await put(a, 'old/big.bin', big)
  await a.sync()
  const b = await device('b', { direct: true })
  await until(async () => (await exists(b.file('old/big.bin'))) || Promise.reject(new Error(`b: conns ${b.connections.size} pending ${[...b.pending]} jobs ${JSON.stringify([...b._jobs.values()].map((j) => [j.target, j.state, [...j.failedFrom.values()]]))} xf ${JSON.stringify(b.transfers.list().map((x) => [x.path, x.state, x.bytes]))} status ${JSON.stringify(b.status)}`)), 20000, 'synced')
  await fs.mkdir(a.file('new'), { recursive: true })
  await fs.rename(a.file('old/big.bin'), a.file('new/big.bin'))
  await a.sync()
  await until(async () => (await exists(b.file('new/big.bin'))) && !(await exists(b.file('old'))), 20000, 'moved on b')
  t.is(sha(await fs.readFile(b.file('new/big.bin'))), sha(big))
  const log = (b.activity.get('/new/big.bin') || []).map((x) => x.text)
  t.ok(log.includes('Moved here from /old/big.bin'), 'moved locally: ' + log.join(', '))
  t.alike(await parts(b.folder), [], 'no partial files')
})

test('direct: a file changed while it is sent ends up as its latest version', { timeout: 90000 }, async (t) => {
  const { device } = await setup(t)
  const a = await device('a', { direct: true })
  await put(a, 'f.bin', crypto.randomBytes(16 * 1024 * 1024))
  await a.sync()
  const b = await device('b', { direct: true })
  await until(async () => (await parts(b.folder)).length > 0, 30000, 'download started')
  const last = crypto.randomBytes(1024 * 1024)
  await fs.writeFile(a.file('f.bin'), last)
  await a.sync()
  await until(async () => (await exists(b.file('f.bin'))) && sha(await fs.readFile(b.file('f.bin'))) === sha(last), 60000, 'latest version')
  t.pass('b has the latest version')
  await sleep(1000)
  await b.sync()
  t.alike(await parts(b.folder), [], 'no partial files')
})

test('direct: online-only files open from another device', async (t) => {
  const { device } = await setup(t)
  const a = await device('a', { direct: true })
  await put(a, 'Photos/x.jpg', 'photo')
  await a.sync()
  const b = await device('b', { direct: true, excluded: ['/Photos'] })
  await until(() => b.entries().length === 1 && b.connections.size > 0, 20000, 'listed')
  await sleep(500)
  t.is(await readAll(b.openRemote('/Photos/x.jpg').stream), 'photo', 'opened on demand')
  t.absent(await exists(b.file('Photos/x.jpg')), 'not stored')
  await a.close()
  await t.exception(readAll(b.openRemote('/Photos/x.jpg').stream), /no device/, 'fails when nobody has it')
})

test('direct: a device joining a direct drive becomes direct', async (t) => {
  const { device } = await setup(t)
  const a = await device('a', { direct: true })
  await put(a, 'a.txt', 'a')
  await a.sync()
  const b = await device('b', { direct: false })
  await until(() => exists(b.file('a.txt')), 20000, 'synced')
  await until(() => b.direct, 10000, 'b direct') // may switch while it starts
  t.ok(b.direct, 'b is direct now')
  await put(b, 'b.txt', 'b')
  await b.sync()
  await until(() => exists(a.file('b.txt')), 20000, 'b file arrived')
  t.ok(b.view.get('/b.txt').every((v) => v.meta.direct), 'b publishes direct entries')
})

test('ignore rules: ignored files are not synced, and a rule added later deletes nothing', async (t) => {
  const { device } = await setup(t)
  let a = await device('a', { direct: true })
  await put(a, 'app/node_modules/lib/index.js', 'dep')
  await put(a, 'app/src/main.js', 'main')
  await put(a, 'app/debug.log', 'log')
  await put(a, 'app/build/out.bin', 'out')
  await a.sync()
  const b = await device('b', { direct: true })
  await until(async () => (await exists(b.file('app/src/main.js'))) && (await exists(b.file('app/build/out.bin'))) && (await exists(b.file('app/node_modules/lib/index.js'))) && (await exists(b.file('app/debug.log'))), 20000, 'synced')
  t.ok(await exists(b.file('app/node_modules/lib/index.js')), 'without rules everything syncs')

  // Restart a with rules: nothing it already shared is deleted anywhere.
  await a.close()
  a = await device('a', { direct: true, ignore: ['node_modules', '*.log', 'build'] })
  await put(a, 'app/node_modules/new/x.js', 'new dep')
  await put(a, 'app/new.log', 'new log')
  await put(a, 'app/src/more.js', 'more')
  await a.sync()
  await until(() => exists(b.file('app/src/more.js')), 20000, 'new file arrived')
  await sleep(1000)
  await Promise.all([a.sync(), b.sync()])
  t.absent(await exists(b.file('app/node_modules/new/x.js')), 'new ignored folder not sent')
  t.absent(await exists(b.file('app/new.log')), 'new ignored suffix not sent')
  t.ok(await exists(b.file('app/node_modules/lib/index.js')), 'adding the rule deleted nothing on b')
  t.ok(await exists(b.file('app/debug.log')), 'nor the old log')
  t.ok(await exists(a.file('app/build/out.bin')), 'nor on a')
  t.absent(a.entries().some((x) => x.path === '/app/new.log'), 'not published')

  // Changes on b inside a's ignored folders do not reach a's folder.
  await put(b, 'app/build/from-b.bin', 'b build')
  await b.sync()
  await until(() => a.entries().some((x) => x.path === '/app/build/from-b.bin'), 20000, 'listed on a')
  await sleep(1000)
  await a.sync()
  t.absent(await exists(a.file('app/build/from-b.bin')), 'not downloaded into an ignored folder')
})
