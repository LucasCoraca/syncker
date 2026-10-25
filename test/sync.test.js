import test from 'brittle'
import fs from '#fs/promises'
import path from '#path'
import b4a from 'b4a'
import { setup, until, read, exists, converged, newSecret, sleep } from './helpers.js'

test('three devices sync creates, edits, deletes and conflicts', async (t) => {
  const { device } = await setup(t)
  const a = await device('laptop')
  const b = await device('phone')

  await fs.mkdir(a.file('docs'))
  await fs.writeFile(a.file('docs/hello.txt'), 'hi from laptop')
  await until(async () => (await read(b.file('docs/hello.txt'))) === 'hi from laptop', 20000, 'create')

  await fs.writeFile(b.file('docs/hello.txt'), 'edited on phone')
  await until(async () => (await read(a.file('docs/hello.txt'))) === 'edited on phone', 20000, 'edit')

  const c = await device('desktop')
  await until(async () => (await read(c.file('docs/hello.txt'))) === 'edited on phone', 20000, 'late joiner')

  await fs.rm(c.file('docs/hello.txt'))
  await until(async () => !(await exists(a.file('docs/hello.txt'))) && !(await exists(b.file('docs/hello.txt'))), 20000, 'delete')

  await fs.writeFile(a.file('notes.md'), 'base')
  await until(async () => (await read(b.file('notes.md'))) === 'base' && (await read(c.file('notes.md'))) === 'base', 20000, 'base')
  await Promise.all([a.close(), b.close()])

  const a2 = await device('laptop')
  await fs.writeFile(a2.file('notes.md'), 'laptop version')
  await a2.sync()
  await a2.close()
  const b2 = await device('phone')
  await fs.writeFile(b2.file('notes.md'), 'phone version')
  await b2.sync()
  const a3 = await device('laptop')

  const final = await until(async () => {
    const s = await converged([a3, b2, c])
    return s && s.length === 2 && s
  }, 20000, 'conflict convergence')
  t.ok(final.some((s) => s.includes('(conflict ')), 'conflict copy exists')
  t.alike(final.map((s) => s.split('=')[1]).sort(), ['laptop version', 'phone version'])
})

test('wrong secret cannot join', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await fs.writeFile(a.file('secret.txt'), 'private')
  await a.sync()

  const evil = await device('evil', { secret: newSecret() })
  // Same topic, wrong HMAC key.
  await evil.swarm.join(a.topic, { server: true, client: true }).flushed()
  await sleep(3000)
  t.is(evil.peers.size, 0)
  t.is(a.peers.size, 0)
  t.absent(await exists(evil.file('secret.txt')))
})

test('content is relayed by another device while the author is offline', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  const b = await device('b')
  const big = b4a.alloc(3 * 1024 * 1024, 7)
  await fs.writeFile(a.file('photo.bin'), big)
  await until(async () => b4a.equals(await fs.readFile(b.file('photo.bin')), big), 20000, 'b download')
  await a.close()

  const c = await device('c')
  await until(async () => b4a.equals(await fs.readFile(c.file('photo.bin')), big), 20000, 'c relay')
  t.pass('relayed')
})

test('a long-running device keeps announcing and is found by a device that starts later', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await fs.writeFile(a.file('early.txt'), 'early')
  await sleep(17000) // past the 5 s and 10 s lookup retries
  t.ok(a.discovery.isServer, 'still announcing after retries')
  const b = await device('b')
  await until(async () => (await read(b.file('early.txt'))) === 'early', 15000, 'late device finds the long-running one')
})
