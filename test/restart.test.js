// A device that goes away without a goodbye (here: frozen, so its connection
// stays open but silent, like a phone that lost its network or a killed
// process on another machine) and comes back as a new run: the others drop the
// dead connection and get files from the new run. Node only (child processes).
import test from 'brittle'
import fs from '#fs/promises'
import path from '#path'
import { setup, until, read, exists } from './helpers.js'

const nodeOnly = typeof process !== 'undefined' && process.versions && process.versions.node && !globalThis.Bare ? test : test.skip

nodeOnly('a device that vanished and came back: files come from its new run, not the dead connection', { timeout: 120000 }, async (t) => {
  const { spawn } = await import('node:child_process')
  const { device, root, secret, testnet } = await setup(t)
  const seed = await device('a', { direct: true })
  await fs.writeFile(seed.file('x.txt'), 'from a')
  await seed.sync()
  await seed.close()
  // Its second run starts from a copy (the frozen first run keeps its data locked).
  await fs.cp(path.join(root, 'a'), path.join(root, 'a2'), { recursive: true })
  await fs.rm(path.join(root, 'a2', 'home', 'store', 'CORESTORE')) // a copied store is refused otherwise

  const children = []
  t.teardown(() => { for (const c of children) { c.kill('SIGCONT'); c.kill('SIGKILL') } })
  const run = (dir) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'device.js'), path.join(root, dir, 'home'), path.join(root, dir, 'files'), secret, 'a', JSON.stringify(testnet.bootstrap)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    c.stderr.on('data', (d) => { err += d })
    children.push(c)
    c.stdout.once('data', (d) => resolve(JSON.parse(d.toString()).key))
    c.once('exit', (code, sig) => reject(new Error(`device ${dir} exited ${code || sig}: ${err.slice(-500)}`)))
  })
  const key = await run('a')
  const p = await device('p', { direct: true, excluded: ['/'] })
  await until(() => p.view.has('/x.txt') && [...p.connections.values()].some((c) => c.keyHex === key && c.files && c.files.opened), 30000, 'p connected to a')
  const first = [...p.connections.keys()]

  children[0].kill('SIGSTOP') // gone without a goodbye: p still thinks it is connected
  t.is(await run('a2'), key, 'same device')
  await until(() => [...p.connections].some(([r, c]) => c.keyHex === key && !first.includes(r)), 30000, 'p connected to the new run')
  t.absent([...p.connections.keys()].some((r) => first.includes(r)), 'the dead connection was dropped')

  const asked = Date.now()
  await p.setExcluded(['/', '+/x.txt'])
  await until(async () => (await exists(p.file('x.txt'))) && (await read(p.file('x.txt'))) === 'from a', 45000, 'p got the file')
  t.ok(Date.now() - asked < 10000, `downloaded in ${Date.now() - asked} ms`)
})
