import fs from '#fs/promises'
import os from '#os'
import path from '#path'
import createTestnet from 'hyperdht/testnet.js'
import { Engine } from '../lib/engine.js'
import { newSecret } from '../lib/config.js'

export { newSecret }

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const env = (k) => typeof os.getEnv === 'function' ? os.getEnv(k) : (typeof process !== 'undefined' ? process.env[k] : undefined)
// SYNCKER_DIRECT=1 runs every test device in direct mode (files sent straight from the folder).
export const DIRECT = env('SYNCKER_DIRECT') === '1'

// Polls until fn() returns truthy; throws with the last observed value on timeout.
export async function until (fn, ms = 20000, label = 'condition') {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) { last = err }
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}; last: ${last && last.message ? last.message : JSON.stringify(last)}`)
}

export const read = (f) => fs.readFile(f, 'utf8')
export const exists = (f) => fs.stat(f).then(() => true, () => false)

export async function setup (t, { nodes = 3 } = {}) {
  const testnet = await createTestnet(nodes)
  t.teardown(() => testnet.destroy(), { order: Infinity })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-'))
  t.teardown(() => fs.rm(root, { recursive: true, force: true }), { order: Infinity })
  const secret = newSecret()
  const open = new Set()

  // Starts (or restarts) the named device; its data survives restarts.
  async function device (name, opts = {}) {
    const e = new Engine({
      home: path.join(root, name, 'home'),
      folder: path.join(root, name, 'files'),
      secret: opts.secret || secret,
      deviceName: name,
      bootstrap: testnet.bootstrap,
      excluded: opts.excluded,
      direct: opts.direct !== undefined ? opts.direct : DIRECT,
      ignore: opts.ignore,
      listed: opts.listed
    })
    // SYNCKER_LOG=1 prints what the engines log (to debug a failing test).
    if (env('SYNCKER_LOG') === '1') e.on('error-log', (err) => console.log(`LOG ${name} ${Date.now() % 100000} ${err && err.message}`))
    await e.start()
    open.add(e)
    const close = e.close.bind(e)
    e.close = async () => { open.delete(e); await close() }
    e.file = (p) => path.join(e.folder, p)
    return e
  }
  t.teardown(() => Promise.all([...open].map((e) => e.close())))

  return { testnet, root, secret, device }
}

// Sorted "relpath=content" lines for every file under a folder.
export async function snapshot (folder) {
  const out = []
  async function walk (dir, rel) {
    let items
    try { items = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (it.name.startsWith('.syncker')) continue
      const abs = path.join(dir, it.name)
      if (it.isDirectory()) await walk(abs, rel + '/' + it.name)
      else out.push(rel + '/' + it.name + '=' + await fs.readFile(abs, 'utf8'))
    }
  }
  await walk(folder, '')
  return out.sort()
}

export async function converged (engines) {
  const snaps = await Promise.all(engines.map((e) => snapshot(e.folder)))
  const first = JSON.stringify(snaps[0])
  return snaps.every((s) => JSON.stringify(s) === first) ? snaps[0] : false
}
