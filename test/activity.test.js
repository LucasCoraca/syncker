// Big files a device is still adding show up on the other devices as
// "being prepared" before they can be downloaded.
import test from 'brittle'
import fs from '#fs/promises'
import { setup, until, exists } from './helpers.js'
import { Transfers } from '../lib/transfers.js'

const prep = (e) => e.transfers.list().filter((t) => t.preparing != null)

test('a file still being added on one device is listed as preparing on the others', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await fs.writeFile(a.file('small.txt'), 'x')
  await a.sync()
  const b = await device('b')
  await until(async () => exists(b.file('small.txt')), 20000, 'connected and synced')

  // What _scan does while hashing and copying a big file.
  const size = 64 * 1024 * 1024
  const add = a.transfers.start('add:/big.iso', { dir: 'add', path: '/big.iso', device: 'a', size: size * 2 })
  a.transfers.progress(add, size * 0.8)
  await a._announce()
  await until(() => prep(b).length === 1 && prep(b)[0].preparing === 40, 20000, 'listed as preparing')
  const p = prep(b)[0]
  t.is(p.path, '/big.iso')
  t.is(p.size, size, 'real file size')
  t.is(p.device, 'a', 'from the device adding it')
  t.is(p.state, 'waiting')

  a.transfers.progress(add, size * 0.4)
  await a._announce()
  await until(() => prep(b).length === 1 && prep(b)[0].preparing === 60, 20000, 'progress updates')
  t.pass('progress updates')

  a.transfers.finish(add.id)
  await a._announce()
  await until(() => prep(b).length === 0, 20000, 'cleared once added')
  t.pass('cleared once added')
  t.absent(a._announced, 'nothing left to announce')
})

test('online-only paths are not listed as preparing', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await fs.writeFile(a.file('small.txt'), 'x')
  await a.sync()
  const b = await device('b', { excluded: ['/Videos'] })
  await until(async () => exists(b.file('small.txt')), 20000, 'connected and synced')
  const size = 64 * 1024 * 1024
  a.transfers.start('add:/Videos/v.mp4', { dir: 'add', path: '/Videos/v.mp4', device: 'a', size: size * 2 })
  a.transfers.start('add:/b.iso', { dir: 'add', path: '/b.iso', device: 'a', size: size * 2 })
  a.transfers.start('add:/tiny.txt', { dir: 'add', path: '/tiny.txt', device: 'a', size: 20 })
  await a._announce()
  await until(() => prep(b).length === 1, 20000, 'one listed')
  t.is(prep(b)[0].path, '/b.iso', 'excluded and tiny files are not listed')
})

test('adding a local file does not count as upload speed', async (t) => {
  const tr = new Transfers(() => {})
  const add = tr.start('add:/x', { dir: 'add', path: '/x', size: 10 * 1024 * 1024 })
  tr.progress(add, 5 * 1024 * 1024)
  t.is(tr.speeds().up, 0)
  const up = tr.start('up:/x', { dir: 'up', path: '/x', size: 10 * 1024 * 1024 })
  tr.progress(up, 1024 * 1024)
  t.ok(tr.speeds().up > 0)
  tr.close()
})

test('sync details: where each file is, on every device', async (t) => {
  const { device } = await setup(t)
  const a = await device('a')
  await fs.writeFile(a.file('doc.txt'), 'hello')
  await a.sync()
  const b = await device('b')
  await until(async () => exists(b.file('doc.txt')), 20000, 'synced')

  // b tells a it has it: a sees it there.
  await until(() => a.details('/doc.txt').devices[0].state === 'synced', 20000, 'a knows b has it')
  const d = a.details('/doc.txt')
  t.is(d.here.state, 'synced')
  t.is(d.devices[0].name, 'b')
  t.ok(d.devices[0].online && d.devices[0].via, 'connection route: ' + d.devices[0].via)
  t.alike(a.copies('/doc.txt'), { have: 1, missing: [] })
  t.ok(a.details('/doc.txt').activity.some((x) => x.text === 'Added on this device'), 'activity: added')
  await until(() => a.details('/doc.txt').activity.some((x) => x.text === 'Arrived on b'), 20000, 'activity: arrived on b')
  t.ok(b.details('/doc.txt').activity.some((x) => /^Downloaded from /.test(x.text)), 'receiver activity: downloaded')
  t.is(b.details('/doc.txt').devices[0].state, 'synced', 'b sees a has it (author)')

  // A change b does not have yet: listed as missing there.
  await b.setExcluded(['/doc.txt'])
  await until(() => a.details('/doc.txt').devices[0].state === 'online', 20000, 'online only on b')
  t.is(a.details('/doc.txt').devices[0].state, 'online')
  t.alike(a.copies('/doc.txt').missing, [], 'online-only is not missing')
  t.is(b.details('/doc.txt').here.state, 'online')

  await b.setExcluded([])
  await until(() => a.details('/doc.txt').devices[0].state === 'synced', 20000, 'back on b')
  await b.close()
  await fs.writeFile(a.file('doc.txt'), 'hello v2')
  await a.sync()
  await until(() => a.details('/doc.txt').devices[0].state === 'offline', 20000, 'b offline')
  t.is(a.details('/doc.txt').devices[0].text, 'Has an older version. Gets this one when it comes online')
  t.alike(a.copies('/doc.txt').missing, ['b'])
})
