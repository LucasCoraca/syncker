// Edge cases for the sync engine: odd names, sizes, renames, offline
// concurrency, malicious peers, symlinks, restarts.
//
// Tests named "BUG: ..." demonstrate engine bugs found while writing this
// suite; they fail until the engine is fixed. Set SKIP_KNOWN_BUGS=1 to turn
// them into todos (not run).
import test from 'brittle'
import fs from '#fs/promises'
import path from '#path'
import os from '#os'
import crypto from '#crypto'
import b4a from 'b4a'
import SubEncoder from 'sub-encoder'
import { setup, until, read, exists, converged, snapshot, sleep } from './helpers.js'

const env = (k) => typeof os.getEnv === 'function' ? os.getEnv(k) : (typeof process !== 'undefined' ? process.env[k] : undefined)
// EDGE_ONLY=<substring> runs only the matching tests.
function edgeTest (name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {} }
  const only = env('EDGE_ONLY')
  // A timeout fails this test instead of crashing the whole run.
  const body = async (t) => {
    try { await fn(t) } catch (err) { t.fail(err && err.message ? err.message : String(err)) }
  }
  return (only && !name.includes(only) ? test.skip : test)(name, opts, body)
}
function bug (name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {} }
  if (env('SKIP_KNOWN_BUGS')) return test.todo('BUG: ' + name, opts, fn)
  return edgeTest('BUG: ' + name, opts, fn)
}

const T = 20000
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const isConflict = (s) => s.includes(' (conflict ')

// Deterministic pseudo-random bytes (xorshift32).
function bytes (n, seed) {
  const buf = b4a.alloc(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    buf[i] = x & 255
  }
  return buf
}

// Every path under a folder, hidden ones included, without following symlinks.
async function rawList (folder) {
  const out = []
  async function walk (dir, rel) {
    let items
    try { items = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const p = rel + '/' + it.name
      out.push(p)
      if (it.isDirectory()) await walk(path.join(dir, it.name), p)
    }
  }
  await walk(folder, '')
  return out.sort()
}
const tmpLeftovers = async (folder) => (await rawList(folder)).filter((p) => path.basename(p).startsWith('.syncker-tmp-'))

async function write (e, rel, content) {
  await fs.mkdir(path.dirname(e.file(rel)), { recursive: true })
  await fs.writeFile(e.file(rel), content)
}

async function pair (t) {
  const s = await setup(t)
  const a = await s.device('a')
  const b = await s.device('b')
  return { ...s, a, b }
}

// Starts a device with nobody else online, lets fn change its folder, publishes, stops it.
async function alone (device, name, fn) {
  const e = await device(name)
  await fn(e)
  await e.sync()
  await e.close()
}

// Device names of a pair ordered by drive key: on equal clocks the higher key wins.
const byKey = (a, b) => a.key > b.key ? { hi: 'a', lo: 'b' } : { hi: 'b', lo: 'a' }

async function untilConverged (engines, check = () => true, ms = T, label = 'convergence') {
  try {
    return await until(async () => {
      const s = await converged(engines)
      return s && check(s) && s
    }, ms, label)
  } catch (err) {
    // Connection state, to tell "never connected" from "connected but not replicating".
    const diag = engines.map((e) => `${e.deviceName}: connections=${e.connections.size} peers=${e.peers.size} swarm=${e.swarm.connections.size} phase=${e.status.phase} files=${JSON.stringify([...e.view.keys()])}`)
    throw new Error(err.message + ' [' + diag.join('; ') + ']')
  }
}

// ---- 1 ----------------------------------------------------------------

edgeTest('unicode and odd filenames sync, edit and delete', async (t) => {
  const { a, b } = await pair(t)
  const deep = Array.from({ length: 10 }, (_, i) => 'level' + (i + 1)).join('/') + '/deep.txt'
  const names = [
    'with space.txt',
    'ção.txt',
    'emoji 😀🎉.txt',
    '中文文件名.txt',
    '日本語/ファイル.md',
    '.hidden',
    '.config/settings.json',
    'a'.repeat(200) + '.txt',
    deep,
    'weird #%&+=@!,;[]{}()\'".txt',
    'no-extension',
    'trailing.dot.'
  ]
  for (const [i, n] of names.entries()) await write(a, n, 'content ' + i + ' ' + n)
  await a.sync()
  const expected = names.map((n, i) => '/' + n + '=content ' + i + ' ' + n).sort()
  t.alike(await until(async () => {
    const s = await snapshot(b.folder)
    return s.length === names.length && s
  }, T, 'names arrive'), expected)

  await fs.writeFile(b.file('ção.txt'), 'edited ção')
  await fs.rm(b.file('emoji 😀🎉.txt'))
  await b.sync()
  await until(async () => (await read(a.file('ção.txt'))) === 'edited ção' && !(await exists(a.file('emoji 😀🎉.txt'))), T, 'edit + delete back')
  t.ok(await untilConverged([a, b]), 'converged')
  t.alike(await tmpLeftovers(b.folder), [])
})

// ---- 2 ----------------------------------------------------------------

edgeTest('empty files sync, get content, get truncated to 0 bytes', async (t) => {
  const { a, b } = await pair(t)
  await fs.writeFile(a.file('empty.txt'), '')
  await a.sync()
  await until(async () => (await exists(b.file('empty.txt'))) && (await read(b.file('empty.txt'))) === '', T, 'empty file')

  await fs.writeFile(a.file('empty.txt'), 'now has content')
  await a.sync()
  await until(async () => (await read(b.file('empty.txt'))) === 'now has content', T, 'update')

  await fs.writeFile(b.file('grow.txt'), 'some bytes here')
  await b.sync()
  await until(async () => (await read(a.file('grow.txt'))) === 'some bytes here', T, 'grow.txt')
  await fs.truncate(b.file('grow.txt'), 0)
  await fs.writeFile(b.file('empty.txt'), '')
  await b.sync()
  await until(async () => (await read(a.file('grow.txt'))) === '' && (await read(a.file('empty.txt'))) === '', T, 'truncated')
  t.alike(await untilConverged([a, b]), ['/empty.txt=', '/grow.txt='])
})

// ---- 3 ----------------------------------------------------------------

edgeTest('20 MB file syncs intact', { timeout: 60000 }, async (t) => {
  const { a, b } = await pair(t)
  const big = bytes(20 * 1024 * 1024, 42)
  await fs.writeFile(a.file('big.bin'), big)
  await a.sync()
  await until(async () => (await fs.stat(b.file('big.bin'))).size === big.byteLength, 40000, 'big file size')
  t.is(sha(await fs.readFile(b.file('big.bin'))), sha(big), 'hash matches')
  t.alike(await tmpLeftovers(b.folder), [])
})

// ---- 4 ----------------------------------------------------------------

edgeTest('500 small files across folders converge, then half are deleted', { timeout: 60000 }, async (t) => {
  const { a, b } = await pair(t)
  const names = []
  for (let d = 0; d < 10; d++) {
    await fs.mkdir(a.file('dir' + d + '/sub'), { recursive: true })
    for (let f = 0; f < 50; f++) {
      const n = 'dir' + d + (f % 2 ? '/sub' : '') + '/file' + f + '.txt'
      names.push(n)
      await fs.writeFile(a.file(n), 'file ' + n)
    }
  }
  await a.sync()
  const full = await untilConverged([a, b], (s) => s.length === 500, 40000, '500 files')
  t.is(full.length, 500)

  for (const n of names.filter((_, i) => i % 2)) await fs.rm(a.file(n))
  await a.sync()
  const half = await untilConverged([a, b], (s) => s.length === 250, 40000, '250 files')
  t.alike(half, names.filter((_, i) => i % 2 === 0).map((n) => '/' + n + '=file ' + n).sort())
})

// ---- 5 ----------------------------------------------------------------

edgeTest('20 rapid edits on one device: peer ends with the last one, no conflicts', async (t) => {
  const { a, b } = await pair(t)
  await fs.writeFile(a.file('rapid.txt'), 'start')
  await until(async () => (await read(b.file('rapid.txt'))) === 'start', T, 'initial')
  for (let i = 0; i < 20; i++) {
    await fs.writeFile(a.file('rapid.txt'), 'edit number ' + i)
    if (i % 3) await sleep(15)
    if (i % 7 === 0) a.sync() // interleave with sync cycles
  }
  await a.sync()
  await until(async () => (await read(b.file('rapid.txt'))) === 'edit number 19', T, 'last edit')
  await sleep(1500)
  await Promise.all([a.sync(), b.sync()])
  t.alike(await untilConverged([a, b]), ['/rapid.txt=edit number 19'], 'no conflict copies')
})

// ---- 6 ----------------------------------------------------------------

edgeTest('edit on B right as A\'s update lands: newest content never lost', { timeout: 60000 }, async (t) => {
  const { a, b } = await pair(t)
  const rounds = 6
  for (let r = 0; r < rounds; r++) await fs.writeFile(a.file('race' + r + '.txt'), 'base ' + r)
  await a.sync()
  await untilConverged([a, b], (s) => s.length === rounds, T, 'base')

  for (let r = 0; r < rounds; r++) {
    await fs.writeFile(a.file('race' + r + '.txt'), 'from a ' + r)
    await a.sync() // A's version is now published and on its way to B
    if (r % 2) await sleep(r * 20)
    await fs.writeFile(b.file('race' + r + '.txt'), 'from b ' + r) // newer, written without seeing A's
    b.sync()
  }
  const final = await untilConverged([a, b], (s) => s.filter((x) => !isConflict(x)).length === rounds, T, 'race convergence')
  t.comment(final.join('\n'))
  for (let r = 0; r < rounds; r++) {
    const contents = final.filter((x) => x.startsWith('/race' + r + '.txt=') || x.startsWith('/race' + r + ' (conflict ')).map((x) => x.split('=')[1])
    t.ok(contents.includes('from b ' + r), `round ${r}: the newest write (B's) survives (${contents.join(' | ')})`)
  }
})

edgeTest('a user write that lands while a remote version downloads is kept', async (t) => {
  const { a, b } = await pair(t)
  await fs.writeFile(a.file('doc.txt'), 'base')
  await untilConverged([a, b], (s) => s.length === 1, T, 'base')

  // Simulate the user saving doc.txt on B after _merge checked that the file is
  // untouched but before the downloaded version is renamed over it (for a big
  // file this window is the whole local blob copy).
  const orig = b._materialize
  let injected = false
  b._materialize = async function (p, version, src) {
    if (p === '/doc.txt' && !injected) {
      injected = true
      await fs.writeFile(b.file('doc.txt'), 'user edit on b')
    }
    return orig.call(this, p, version, src)
  }
  await fs.writeFile(a.file('doc.txt'), 'from a')
  await a.sync()
  await until(() => injected, T, 'remote version materializing on b')
  await sleep(2000)
  await Promise.all([a.sync(), b.sync()])
  const final = await untilConverged([a, b], () => true, T, 'convergence')
  t.ok(final.some((x) => x.endsWith('=user edit on b')), 'the user edit on b is kept somewhere: ' + JSON.stringify(final))
})

// ---- 7 ----------------------------------------------------------------

edgeTest('same new path created on two offline devices: different content -> conflict copy, same content -> none', { timeout: 90000 }, async (t) => {
  const { device, a, b } = await pair(t)
  await fs.writeFile(a.file('hello.txt'), 'hi')
  await untilConverged([a, b], (s) => s.length === 1, T, 'connected')
  await Promise.all([a.close(), b.close()])

  await alone(device, 'a', async (e) => {
    await fs.writeFile(e.file('new.txt'), 'created on a')
    await fs.writeFile(e.file('same.txt'), 'identical')
  })
  await alone(device, 'b', async (e) => {
    await fs.writeFile(e.file('new.txt'), 'created on b')
    await fs.writeFile(e.file('same.txt'), 'identical')
  })
  const a2 = await device('a')
  const b2 = await device('b')
  const final = await untilConverged([a2, b2], (s) => s.length === 4, T, 'conflict convergence')
  t.comment(final.join('\n'))
  t.ok(final.includes('/hello.txt=hi'))
  t.ok(final.includes('/same.txt=identical'), 'same content kept once')
  t.absent(final.some((x) => x.startsWith('/same (conflict')), 'no conflict copy for identical content')
  const news = final.filter((x) => x.startsWith('/new')).map((x) => x.split('=')[1]).sort()
  t.alike(news, ['created on a', 'created on b'], 'both versions of new.txt kept')
  t.ok(final.some((x) => x.startsWith('/new (conflict ')), 'one of them as a conflict copy')
})

// ---- 8 ----------------------------------------------------------------

// A deletes a file while B, offline, edits it. Both changes get the same clock.
async function deleteVsEdit (t, deleterIsHi) {
  const { device, a, b } = await pair(t)
  await fs.writeFile(a.file('doc.txt'), 'base')
  await untilConverged([a, b], (s) => s.length === 1, T, 'base')
  const { hi, lo } = byKey(a, b)
  const deleter = deleterIsHi ? hi : lo
  const editor = deleterIsHi ? lo : hi
  await Promise.all([a.close(), b.close()])

  await alone(device, deleter, (e) => fs.rm(e.file('doc.txt')))
  await alone(device, editor, (e) => fs.writeFile(e.file('doc.txt'), 'important edit'))
  const e1 = await device('a')
  const e2 = await device('b')
  await sleep(3000) // let them meet and settle
  const final = await untilConverged([e1, e2], () => true, T, 'convergence')
  t.comment(`deleter=${deleter} editor=${editor} final=${JSON.stringify(final)}`)
  t.ok(final.some((x) => x.endsWith('=important edit')), 'the concurrent edit is not silently lost')
}

edgeTest('delete vs concurrent offline edit, edit wins the clock tie: file kept with the edit', { timeout: 90000 }, (t) => deleteVsEdit(t, false))

edgeTest('delete vs concurrent offline edit, delete wins the clock tie: the edit is kept', { timeout: 90000 }, (t) => deleteVsEdit(t, true))

edgeTest('concurrent offline edits with unequal clocks: the lower-clock edit is kept as a conflict copy', { timeout: 90000 }, async (t) => {
  const { device, a, b } = await pair(t)
  await fs.writeFile(a.file('notes.txt'), 'base')
  await untilConverged([a, b], (s) => s.length === 1, T, 'base')
  await Promise.all([a.close(), b.close()])

  // A saves twice while offline (clock 2, then 3); B saves once (clock 2).
  await alone(device, 'a', async (e) => {
    await fs.writeFile(e.file('notes.txt'), 'a draft')
    await e.sync()
    await fs.writeFile(e.file('notes.txt'), 'a final')
  })
  await alone(device, 'b', (e) => fs.writeFile(e.file('notes.txt'), 'b work, never seen by a'))
  const a2 = await device('a')
  const b2 = await device('b')
  await sleep(3000)
  const final = await untilConverged([a2, b2], () => true, T, 'convergence')
  t.comment(JSON.stringify(final))
  t.ok(final.includes('/notes.txt=a final'))
  t.ok(final.some((x) => x.endsWith('=b work, never seen by a')), 'b\'s concurrent edit is kept as a conflict copy')
})

edgeTest('a second conflict on the same path gets its own conflict copy', { timeout: 120000 }, async (t) => {
  const { device, a, b } = await pair(t)
  await fs.writeFile(a.file('plan.txt'), 'base')
  await untilConverged([a, b], (s) => s.length === 1, T, 'base')
  const { hi, lo } = byKey(a, b)
  await Promise.all([a.close(), b.close()])

  // Round 1: concurrent edits, lo loses and gets "plan (conflict lo).txt".
  await alone(device, hi, (e) => fs.writeFile(e.file('plan.txt'), 'hi round 1'))
  await alone(device, lo, (e) => fs.writeFile(e.file('plan.txt'), 'lo round 1'))
  let x = await device('a')
  let y = await device('b')
  const isCopy = (line) => line.startsWith(`/plan (conflict ${lo} `) && line.endsWith('=lo round 1')
  const snap1 = await untilConverged([x, y], (s) => s.some(isCopy), T, 'round 1 conflict copy')
  const cp = snap1.find(isCopy).slice(1).split('=')[0]
  // The user resolves the conflict by deleting the copy.
  await fs.rm(x.file(cp))
  await x.sync()
  await untilConverged([x, y], (s) => s.length === 1, T, 'copy deleted')
  await Promise.all([x.close(), y.close()])

  // Round 2: same thing again.
  await alone(device, hi, (e) => fs.writeFile(e.file('plan.txt'), 'hi round 2'))
  await alone(device, lo, (e) => fs.writeFile(e.file('plan.txt'), 'lo round 2'))
  x = await device('a')
  y = await device('b')
  await sleep(3000)
  const final = await untilConverged([x, y], () => true, T, 'round 2')
  t.comment(JSON.stringify(final))
  t.ok(final.includes('/plan.txt=hi round 2'))
  t.ok(final.some((s) => s.endsWith('=lo round 2')), 'the losing round-2 edit is kept')
})

// ---- 9 / 10 -----------------------------------------------------------

edgeTest('rename a file, rename a folder with contents, move a file into a new subfolder', async (t) => {
  const { a, b } = await pair(t)
  await write(a, 'old.txt', 'file')
  await write(a, 'olddir/one.txt', 'one')
  await write(a, 'olddir/sub/two.txt', 'two')
  await write(a, 'loose.txt', 'loose')
  await a.sync()
  await untilConverged([a, b], (s) => s.length === 4, T, 'initial')

  await fs.rename(a.file('old.txt'), a.file('new.txt'))
  await fs.rename(a.file('olddir'), a.file('newdir'))
  await fs.mkdir(a.file('brand/new'), { recursive: true })
  await fs.rename(a.file('loose.txt'), a.file('brand/new/loose.txt'))
  await a.sync()
  const expected = ['/brand/new/loose.txt=loose', '/new.txt=file', '/newdir/one.txt=one', '/newdir/sub/two.txt=two']
  t.alike(await untilConverged([a, b], (s) => JSON.stringify(s) === JSON.stringify(expected), T, 'renames'), expected)
  t.absent(await exists(b.file('olddir')), 'old folder removed on peer')
  t.absent(await exists(b.file('old.txt')))
  t.absent(await exists(b.file('loose.txt')))
})

// ---- 11 / 12 ----------------------------------------------------------

edgeTest('recursive folder delete removes it on peers (empty dirs pruned)', async (t) => {
  const { a, b } = await pair(t)
  await write(a, 'keep.txt', 'keep')
  await write(a, 'tree/a.txt', 'a')
  await write(a, 'tree/x/b.txt', 'b')
  await write(a, 'tree/x/y/z/c.txt', 'c')
  await a.sync()
  await untilConverged([a, b], (s) => s.length === 4, T, 'initial')
  await fs.rm(a.file('tree'), { recursive: true })
  await a.sync()
  t.alike(await untilConverged([a, b], (s) => s.length === 1, T, 'delete'), ['/keep.txt=keep'])
  await until(async () => !(await exists(b.file('tree'))), T, 'tree dir pruned on b')
  t.pass('folder gone on b')
})

edgeTest('a deleted file can be recreated (same content, and from the other device)', async (t) => {
  const { a, b } = await pair(t)
  await fs.writeFile(a.file('phoenix.txt'), 'v1')
  await until(async () => (await read(b.file('phoenix.txt'))) === 'v1', T, 'create')
  await fs.rm(a.file('phoenix.txt'))
  await a.sync()
  await until(async () => !(await exists(b.file('phoenix.txt'))), T, 'delete')
  await fs.writeFile(a.file('phoenix.txt'), 'v1') // identical content
  await a.sync()
  await until(async () => (await exists(b.file('phoenix.txt'))) && (await read(b.file('phoenix.txt'))) === 'v1', T, 'recreate same content')
  await fs.rm(b.file('phoenix.txt'))
  await b.sync()
  await until(async () => !(await exists(a.file('phoenix.txt'))), T, 'delete from b')
  await fs.writeFile(b.file('phoenix.txt'), 'v2 from b')
  await b.sync()
  t.alike(await untilConverged([a, b], (s) => s.length === 1 && s[0] === '/phoenix.txt=v2 from b', T, 'recreate from b'), ['/phoenix.txt=v2 from b'])
})

// ---- 13 ---------------------------------------------------------------

edgeTest('file replaced by a folder of the same name and vice versa', async (t) => {
  const { a, b } = await pair(t)
  await write(a, 'x', 'x was a file')
  await write(b, 'y/inner.txt', 'y was a folder') // authored by b
  await write(b, 'z', 'z was a file') // authored by b
  await Promise.all([a.sync(), b.sync()])
  await untilConverged([a, b], (s) => s.length === 3, T, 'initial')

  await fs.rm(a.file('x'))
  await write(a, 'x/inner.txt', 'x is a folder now')
  await fs.rm(a.file('y'), { recursive: true })
  await write(a, 'y', 'y is a file now')
  await fs.rm(a.file('z'))
  await write(a, 'z/deep/f.txt', 'z is a folder now')
  await a.sync()
  const expected = ['/x/inner.txt=x is a folder now', '/y=y is a file now', '/z/deep/f.txt=z is a folder now']
  t.alike(await untilConverged([a, b], (s) => JSON.stringify(s) === JSON.stringify(expected), T, 'converge'), expected)
  await Promise.all([a.sync(), b.sync()])
  t.is(a.status.phase, 'idle', a.status.error || '')
  t.is(b.status.phase, 'idle', b.status.error || '')
})

edgeTest('same name created as a file on one offline device and as a folder on another: converge, nothing lost', { timeout: 90000 }, async (t) => {
  const { device, a, b } = await pair(t)
  await fs.writeFile(a.file('hello.txt'), 'hi')
  await untilConverged([a, b], (s) => s.length === 1, T, 'connected')
  await Promise.all([a.close(), b.close()])
  await alone(device, 'a', (e) => fs.writeFile(e.file('x'), 'x as file'))
  await alone(device, 'b', async (e) => {
    await write(e, 'x/y.txt', 'x as folder')
    await write(e, 'zz.txt', 'unrelated file')
  })
  const a2 = await device('a')
  const b2 = await device('b')
  await sleep(4000)
  await Promise.all([a2.sync(), b2.sync()])
  t.comment('a: ' + a2.status.phase + ' ' + (a2.status.error || ''))
  t.ok(await exists(a2.file('zz.txt')), 'an unrelated file still arrives on a')
  t.is(a2.status.phase, 'idle', 'a is not stuck in error: ' + a2.status.error)
  const s = await until(() => converged([a2, b2]), 5000, 'convergence').catch(() => null)
  if (!s) t.comment('a: ' + JSON.stringify(await snapshot(a2.folder)) + ' b: ' + JSON.stringify(await snapshot(b2.folder)))
  t.ok(s, 'devices converge')
  if (s) {
    t.ok(s.some((x) => x.endsWith('=x as file')), 'file content kept')
    t.ok(s.some((x) => x.endsWith('=x as folder')), 'folder content kept')
  }
})

// ---- 14 ---------------------------------------------------------------

edgeTest('both devices change many files while apart, then converge', { timeout: 90000 }, async (t) => {
  const { device, a, b } = await pair(t)
  for (let i = 0; i < 20; i++) await write(a, 'f' + i + '.txt', 'base ' + i)
  await a.sync()
  await untilConverged([a, b], (s) => s.length === 20, T, 'base')
  await b.close()

  // a keeps working (online, but b is gone).
  for (let i = 0; i < 5; i++) await write(a, 'f' + i + '.txt', 'a edit ' + i)
  for (let i = 5; i < 10; i++) await fs.rm(a.file('f' + i + '.txt'))
  for (let i = 0; i < 10; i++) await write(a, 'a-new/n' + i + '.txt', 'a new ' + i)
  await a.sync()
  await a.close()

  await alone(device, 'b', async (e) => {
    for (let i = 10; i < 15; i++) await write(e, 'f' + i + '.txt', 'b edit ' + i)
    for (let i = 15; i < 18; i++) await fs.rm(e.file('f' + i + '.txt'))
    for (let i = 0; i < 10; i++) await write(e, 'b-new/n' + i + '.txt', 'b new ' + i)
  })

  const expected = []
  for (let i = 0; i < 20; i++) {
    if (i < 5) expected.push(`/f${i}.txt=a edit ${i}`)
    else if (i < 10 || (i >= 15 && i < 18)) continue
    else if (i < 15) expected.push(`/f${i}.txt=b edit ${i}`)
    else expected.push(`/f${i}.txt=base ${i}`)
  }
  for (let i = 0; i < 10; i++) expected.push(`/a-new/n${i}.txt=a new ${i}`, `/b-new/n${i}.txt=b new ${i}`)
  expected.sort()
  const a2 = await device('a')
  const b2 = await device('b')
  t.alike(await untilConverged([a2, b2], (s) => JSON.stringify(s) === JSON.stringify(expected), 30000, 'reconnect'), expected)
})

// ---- 15 ---------------------------------------------------------------

edgeTest('device restarted mid-transfer of a large file: completes, no partial file', { timeout: 90000 }, async (t) => {
  const { device, a, b } = await pair(t)
  await fs.writeFile(a.file('warmup.txt'), 'w')
  await until(async () => exists(b.file('warmup.txt')), T, 'connected')
  const big = bytes(20 * 1024 * 1024, 7)
  await fs.writeFile(a.file('big.bin'), big)
  a.sync()
  const end = Date.now() + T
  while (b._fetching.size === 0 && Date.now() < end && !(await exists(b.file('big.bin')))) await sleep(5)
  const caught = b._fetching.size > 0
  t.comment(caught ? 'closed b while the blob was downloading' : 'did not catch the transfer in flight')
  await b.close()
  t.absent(await exists(b.file('big.bin')) && caught, 'no partial big.bin after the interrupted transfer')
  t.alike(await tmpLeftovers(b.folder), [], 'no temp files after close')

  const b2 = await device('b')
  await until(async () => (await fs.stat(b2.file('big.bin'))).size === big.byteLength, 40000, 'transfer completes')
  t.is(sha(await fs.readFile(b2.file('big.bin'))), sha(big))
  t.alike(await tmpLeftovers(b2.folder), [], 'no temp files left')
  t.alike(await tmpLeftovers(a.folder), [])
})

// ---- 16 ---------------------------------------------------------------

edgeTest('malicious peer: invalid paths and metadata are ignored, nobody crashes', async (t) => {
  const { root, device, a, b } = await pair(t)
  const evil = await device('evil')
  const d = evil.drive
  await d.getBlobs()
  const keyEncoding = new SubEncoder('files', 'utf-8')
  const meta = (buf, extra = {}) => ({ clock: 5, hash: sha(buf), size: buf.byteLength, mtime: Date.now(), device: 'evil', ...extra })
  const buf = b4a.from('pwned')
  const blob = await d.blobs.put(buf)
  const raw = (key, metadata) => d.db.put(key, { executable: false, linkname: null, blob, metadata }, { keyEncoding })

  await raw('/../escape.txt', meta(buf)) // bypasses hyperdrive's path normalization
  await raw('/../../escape2.txt', meta(buf))
  await raw('relative.txt', meta(buf))
  await raw('/dir/../../escape3.txt', meta(buf))
  await raw('/a//b.txt', meta(buf))
  await raw('/back\\slash.txt', meta(buf))
  await raw('/nul\0byte.txt', meta(buf))
  await raw('/./dot.txt', meta(buf))
  await d.putEntry('/noclock.txt', { blob, metadata: { hash: sha(buf), size: 5 } })
  await d.putEntry('/nometa.txt', { blob, metadata: null })
  await d.putEntry('/stringmeta.txt', { blob, metadata: 'clock=99' })
  await d.putEntry('/negclock.txt', { blob, metadata: meta(buf, { clock: -1 }) })
  await d.putEntry('/floatclock.txt', { blob, metadata: meta(buf, { clock: 1.5 }) })
  await d.putEntry('/strclock.txt', { blob, metadata: meta(buf, { clock: '7' }) })
  await d.putEntry('/badhash.txt', { blob, metadata: meta(buf, { hash: 'not-a-hash' }) })
  await d.putEntry('/wronghash.txt', { blob, metadata: meta(buf, { hash: sha(b4a.from('something else')) }) })
  await d.putEntry('/.syncker', { blob, metadata: meta(buf) })
  await d.putEntry('/.syncker-tmp-deadbeef', { blob, metadata: meta(buf) })
  await d.putEntry('/sub/.syncker-tmp-x', { blob, metadata: meta(buf) })
  await d.putEntry('/noblob.txt', { blob: null, metadata: meta(buf) })
  const ok = b4a.from('legit')
  await d.put('/ok.txt', ok, { metadata: meta(ok, { clock: 1 }) })
  await evil.sync()

  await until(async () => (await exists(a.file('ok.txt'))) && (await exists(b.file('ok.txt'))), T, 'legit file arrives')
  await sleep(1500)
  await Promise.all([a.sync(), b.sync()])
  for (const e of [a, b]) {
    const files = await snapshot(e.folder)
    t.alike(files, ['/ok.txt=legit'], e.deviceName + ' only has the legit file: ' + JSON.stringify(files))
    t.is(e.status.phase, 'idle', e.deviceName + ' status ' + (e.status.error || ''))
    t.is(await read(e.file('.syncker')), 'This folder is synced by Syncker. Do not delete this file.\n', 'marker untouched')
    t.alike(await tmpLeftovers(e.folder), [])
  }
  for (const n of ['a', 'b']) {
    for (const f of ['escape.txt', 'escape2.txt', 'escape3.txt']) {
      t.absent(await exists(path.join(root, n, f)), n + ': no ' + f + ' outside the folder')
    }
  }
  t.absent(await exists(path.join(root, 'escape.txt')))
  t.absent(await exists(path.join(root, 'escape2.txt')))
})

edgeTest('a remote path that cannot be created on disk does not block other paths', async (t) => {
  const { device, a } = await pair(t)
  const evil = await device('evil')
  // 300-byte folder name: valid for the engine, ENAMETOOLONG on most filesystems.
  // A file/folder clash ('/taken.txt/x' while taken.txt is a file) does the same.
  const bad = b4a.from('bad')
  await evil.drive.put('/' + 'd'.repeat(300) + '/f.txt', bad, { metadata: { clock: 1, hash: sha(bad), size: 3, mtime: 1, device: 'evil' } })
  const ok = b4a.from('ok')
  await evil.drive.put('/zz-after.txt', ok, { metadata: { clock: 1, hash: sha(ok), size: 2, mtime: 1, device: 'evil' } })
  await evil.sync()
  const arrived = await until(async () => exists(a.file('zz-after.txt')), 8000, 'zz-after.txt').catch(() => false)
  t.comment('a status: ' + a.status.phase + ' ' + (a.status.error || ''))
  t.ok(arrived, 'a file sorted after the bad path still syncs')
})

edgeTest('a peer publishing absurd clocks cannot make a path unwritable', async (t) => {
  const { device, a } = await pair(t)
  const evil = await device('evil')
  // Out of range: ignored entirely.
  const huge = b4a.from('huge clock')
  await evil.drive.put('/huge.txt', huge, { metadata: { clock: Number.MAX_SAFE_INTEGER, hash: sha(huge), size: huge.byteLength, mtime: 1, device: 'evil' } })
  // At the limit: accepted, but a later local edit still wins (it builds on it).
  const buf = b4a.from('evil content')
  await evil.drive.put('/shared.txt', buf, { metadata: { clock: 2 ** 48, vv: { [evil.key.slice(0, 16)]: 2 ** 48 }, hash: sha(buf), size: buf.byteLength, mtime: 1, device: 'evil' } })
  await evil.sync()
  await until(async () => (await read(a.file('shared.txt'))) === 'evil content', T, 'limit version arrives')
  t.absent(await exists(a.file('huge.txt')), 'out-of-range clock ignored')
  await fs.writeFile(a.file('shared.txt'), 'honest edit')
  await a.sync()
  await sleep(1000)
  await a.sync()
  t.is(await read(a.file('shared.txt')), 'honest edit', 'the local edit is not reverted on a')
})

// ---- 17 ---------------------------------------------------------------

edgeTest('symlinks in the folder are not followed or synced', async (t) => {
  const { root, a, b } = await pair(t)
  const outside = path.join(root, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside secret')
  await fs.symlink(outside, a.file('dirlink'))
  await fs.symlink(path.join(outside, 'secret.txt'), a.file('filelink.txt'))
  await fs.symlink('/nonexistent/target', a.file('dangling'))
  await fs.writeFile(a.file('normal.txt'), 'normal')
  await a.sync()
  await until(async () => exists(b.file('normal.txt')), T, 'normal file')
  await sleep(1000)
  await a.sync()
  t.alike(await snapshot(b.folder), ['/normal.txt=normal'], 'only the regular file synced')
  t.is(a.status.phase, 'idle', a.status.error || '')
  t.is(await read(path.join(outside, 'secret.txt')), 'outside secret')
})

edgeTest('a remote file under a local symlink name is never written outside the folder', async (t) => {
  const { root, a, b } = await pair(t)
  const outside = path.join(root, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, a.file('shared'))
  await a.sync()
  await write(b, 'shared/planted.txt', 'from b')
  await b.sync()
  await sleep(3000)
  await a.sync()
  t.absent(await exists(path.join(outside, 'planted.txt')), 'nothing written through the symlink into ' + outside)
})

// ---- 18 ---------------------------------------------------------------

edgeTest('changes made on disk while the engine was stopped are picked up on restart', { timeout: 60000 }, async (t) => {
  const { device, a, b } = await pair(t)
  await write(a, 'keep.txt', 'keep')
  await write(a, 'edit.txt', 'before')
  await write(a, 'del.txt', 'delete me')
  await write(a, 'dir/x.txt', 'x')
  await write(a, 'same-size.txt', 'aaaa')
  await a.sync()
  await untilConverged([a, b], (s) => s.length === 5, T, 'initial')
  await a.close()

  await fs.writeFile(a.file('edit.txt'), 'edited while stopped')
  await fs.writeFile(a.file('same-size.txt'), 'bbbb')
  await fs.rm(a.file('del.txt'))
  await fs.rm(a.file('dir'), { recursive: true })
  await write(a, 'new/created.txt', 'created while stopped')

  const a2 = await device('a')
  const expected = ['/edit.txt=edited while stopped', '/keep.txt=keep', '/new/created.txt=created while stopped', '/same-size.txt=bbbb']
  t.alike(await untilConverged([a2, b], (s) => JSON.stringify(s) === JSON.stringify(expected), T, 'offline edits'), expected)
})
