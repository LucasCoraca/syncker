// Scale: one device with N small files in a nested tree, a second device
// syncs them all. Reports how long the first scan, a quiet rescan and the
// transfer take, and the memory used. Run: node test/scale.js 100000
//                                     or: node node_modules/bare/bin/bare test/scale.js 20000
/* global Bare */
import fs from '#fs/promises'
import path from '#path'
import { setup, sleep } from './helpers.js'

const argv = globalThis.Bare ? Bare.argv : process.argv
const N = Number(argv[argv.length - 1]) || 20000
const mem = () => globalThis.process && process.memoryUsage ? Math.round(process.memoryUsage().rss / 1048576) + ' MB' : '?'
const t = { list: [], teardown (fn) { this.list.push(fn) } }
const { device } = await setup(t)
const a = await device('a', { direct: true })
await a.close() // write the files first, then time the first scan

const folder = a.folder
let made = 0
for (let i = 0; made < N; i++) {
  const dir = path.join(folder, 'p' + (i % 50), 'd' + Math.floor(i / 50))
  await fs.mkdir(dir, { recursive: true })
  for (let j = 0; j < 100 && made < N; j++, made++) await fs.writeFile(path.join(dir, 'f' + j + '.txt'), 'file ' + made + ' ' + 'x'.repeat(made % 2000))
}
console.log(`${N} files written`)

let start = Date.now()
const a2 = await device('a', { direct: true })
console.log(`a: first scan + publish ${Date.now() - start} ms (${Object.keys(a2.index).length} files), rss ${mem()}`)
start = Date.now()
await a2.sync()
console.log(`a: quiet pass ${Date.now() - start} ms`)

start = Date.now()
const b = await device('b', { direct: true })
let last = 0
while (Object.keys(b.index).length < N && Date.now() - start < 30 * 60 * 1000) {
  await sleep(2000)
  const n = Object.keys(b.index).length
  if (n !== last) console.log(`b: ${n}/${N} after ${Math.round((Date.now() - start) / 1000)} s, pass ${b._passMs} ms, rss ${mem()}`)
  last = n
}
console.log(`b: synced ${Object.keys(b.index).length}/${N} in ${Math.round((Date.now() - start) / 1000)} s`)
start = Date.now()
await b.sync()
console.log(`b: quiet pass ${Date.now() - start} ms`)
for (const fn of t.list.reverse()) await fn()
