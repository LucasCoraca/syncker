// Stress: N fresh pairs of devices, each must sync one file within 15 s.
// Catches rare connect-time races. Run: node test/stress.js 200
//                                    or: node node_modules/bare/bin/bare test/stress.js 200
import fs from '#fs/promises'
import { setup, sleep, exists } from './helpers.js'

const argv = globalThis.Bare ? Bare.argv : process.argv
const N = Number(argv[argv.length - 1]) || 50
let fails = 0
let total = 0
for (let i = 0; i < N; i++) {
  const t = { list: [], teardown (fn) { this.list.push(fn) } }
  const { device } = await setup(t)
  const a = await device('a')
  const b = await device('b')
  await fs.writeFile(a.file('x.txt'), 'x' + i)
  const start = Date.now()
  while (Date.now() - start < 15000 && !(await exists(b.file('x.txt')))) await sleep(50)
  const ms = Date.now() - start
  if (ms >= 15000) { fails++; console.log('FAIL', i) }
  total += ms
  for (const fn of t.list.reverse()) await fn()
}
console.log(`stress: ${N - fails}/${N} synced, avg ${Math.round(total / N)} ms`)
if (fails) throw new Error(fails + ' pairs never synced')
