// Randomized convergence test: 3 devices, random creates/edits/deletes/renames
// on random devices (also while a device is stopped), random restarts.
//
//   FUZZ_SEED=123 node test/fuzz.test.js      one seed (comma-separated list for several)
//   FUZZ_OPS=100                              number of operations (default 60)
//
// Invariants once all devices are back online:
//   - all three folders converge to the same content
//   - no .syncker-tmp-* leftovers
//   - for every path whose last operation (globally, in op order) was a write,
//     that content exists at the path or in one of its conflict copies.
//     (Known to fail: concurrent delete/edit and unequal-clock edits lose data;
//     SKIP_KNOWN_BUGS=1 reports losses as comments instead of failures.)
import test from 'brittle'
import fs from '#fs/promises'
import path from '#path'
import os from '#os'
import { setup, until, converged, snapshot, sleep } from './helpers.js'

const env = (k) => typeof os.getEnv === 'function' ? os.getEnv(k) : (typeof process !== 'undefined' ? process.env[k] : undefined)

function mulberry32 (seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOL = ['a.txt', 'b.txt', 'c.md', 'notes/d.txt', 'notes/e.txt', 'deep/x/f.txt', 'deep/x/g.bin']
const NAMES = ['d0', 'd1', 'd2']
const OPS = Number(env('FUZZ_OPS')) || 60
const seeds = env('FUZZ_SEED')
  ? env('FUZZ_SEED').split(',').map((s) => Number(s.trim()) >>> 0)
  : [(Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0]

// Regular files under a folder (relative, no leading slash), skipping engine files.
async function files (folder) {
  const out = []
  async function walk (dir, rel) {
    let items
    try { items = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (it.name.startsWith('.syncker')) continue
      const r = rel ? rel + '/' + it.name : it.name
      if (it.isDirectory()) await walk(path.join(dir, it.name), r)
      else if (it.isFile()) out.push(r)
    }
  }
  await walk(folder, '')
  return out.sort()
}

async function tmpLeftovers (folder) {
  const out = []
  async function walk (dir) {
    let items
    try { items = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (it.name.startsWith('.syncker-tmp-')) out.push(path.join(dir, it.name))
      if (it.isDirectory()) await walk(path.join(dir, it.name))
    }
  }
  await walk(folder)
  return out
}

function isVariant (p, candidate) {
  if (candidate === p) return true
  const ext = path.posix.extname(p)
  const base = p.slice(0, p.length - ext.length)
  return candidate.startsWith(base + ' (conflict ') && candidate.endsWith(ext)
}

for (const seed of seeds) {
  test(`fuzz: 3 devices, ${OPS} random ops, seed ${seed}`, { timeout: 180000 }, async (t) => {
    t.comment(`FUZZ_SEED=${seed}`)
    const rnd = mulberry32(seed)
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
    const { root, device } = await setup(t)
    const folderOf = (name) => path.join(root, name, 'files')
    const running = {}
    for (const n of NAMES) running[n] = await device(n)

    const log = []
    const last = {} // path -> { op, content, i }

    for (let i = 0; i < OPS; i++) {
      const dev = pick(NAMES)
      const folder = folderOf(dev)
      const r = rnd()
      const state = running[dev] ? 'on' : 'off'
      if (r < 0.45) {
        const existing = await files(folder)
        const p = existing.length && rnd() < 0.15 ? pick(existing) : pick(POOL)
        const content = `op${i} by ${dev} #${Math.floor(rnd() * 1e9)}`
        await fs.mkdir(path.dirname(path.join(folder, p)), { recursive: true })
        await fs.writeFile(path.join(folder, p), content)
        last[p] = { op: 'write', content, i, dev }
        log.push(`${i} ${dev}(${state}) write ${p} = ${content}`)
      } else if (r < 0.6) {
        const existing = await files(folder)
        if (!existing.length) { log.push(`${i} ${dev} delete: nothing`); continue }
        const p = pick(existing)
        // A running device may have just changed it (a sync from another device).
        if (!(await fs.rm(path.join(folder, p)).then(() => true, (err) => { if (err.code !== 'ENOENT') throw err; return false }))) { log.push(`${i} ${dev} delete ${p}: vanished`); continue }
        last[p] = { op: 'delete', i, dev }
        log.push(`${i} ${dev}(${state}) delete ${p}`)
      } else if (r < 0.75) {
        const existing = await files(folder)
        if (!existing.length) { log.push(`${i} ${dev} rename: nothing`); continue }
        const src = pick(existing)
        const dst = pick(POOL.filter((x) => x !== src))
        const content = await fs.readFile(path.join(folder, src), 'utf8').catch(() => null)
        await fs.mkdir(path.dirname(path.join(folder, dst)), { recursive: true })
        const moved = content != null && await fs.rename(path.join(folder, src), path.join(folder, dst)).then(() => true, (err) => { if (err.code !== 'ENOENT') throw err; return false })
        if (!moved) { log.push(`${i} ${dev} rename ${src}: vanished`); continue }
        last[src] = { op: 'delete', i, dev }
        last[dst] = { op: 'write', content, i, dev }
        log.push(`${i} ${dev}(${state}) rename ${src} -> ${dst}`)
      } else if (r < 0.9) {
        const ms = 200 + Math.floor(rnd() * 800)
        log.push(`${i} settle ${ms}ms`)
        await sleep(ms)
      } else {
        if (running[dev]) {
          await running[dev].close()
          running[dev] = null
          log.push(`${i} ${dev} stop`)
        } else {
          running[dev] = await device(dev)
          log.push(`${i} ${dev} start`)
        }
      }
      await sleep(Math.floor(rnd() * 150))
    }

    for (const n of NAMES) if (!running[n]) { running[n] = await device(n); log.push(`end ${n} start`) }
    const engines = NAMES.map((n) => running[n])

    let final = null
    try {
      final = await until(async () => {
        await Promise.all(engines.map((e) => e.sync()))
        return converged(engines)
      }, 60000, 'fuzz convergence')
    } catch (err) {
      for (const e of engines) t.comment(e.deviceName + ': ' + JSON.stringify(await snapshot(e.folder)) + ' status=' + e.status.phase + ' ' + (e.status.error || ''))
    }
    t.ok(final, 'all three devices converge')

    for (const e of engines) {
      t.alike(await tmpLeftovers(e.folder), [], e.deviceName + ': no .syncker-tmp leftovers')
      // A periodic cycle may be running right now: wait for it to settle (an error would stay).
      await e.sync()
      t.is(e.status.phase, 'idle', e.deviceName + ' idle ' + (e.status.error || ''))
    }

    let lost = 0
    if (final) {
      const byPath = final.map((s) => { const at = s.indexOf('='); return [s.slice(1, at), s.slice(at + 1)] })
      for (const [p, l] of Object.entries(last)) {
        if (l.op !== 'write') continue
        // The user later wrote/deleted/renamed one of this path's conflict copies:
        // that content was replaced on purpose, not lost.
        if (Object.entries(last).some(([q, m]) => q !== p && isVariant(p, q) && m.i > l.i)) continue
        const found = byPath.some(([fp, c]) => c === l.content && isVariant(p, fp))
        if (!found) {
          lost++
          const versions = engines[0].versions('/' + p).map((v) => `${v.device}@${v.clock}${v.deleted ? ' (deleted)' : ''}`)
          ;(env('SKIP_KNOWN_BUGS') ? t.comment : t.fail).call(t, `last write to ${p} (op ${l.i} by ${l.dev}: "${l.content}") is lost; versions: ${versions.join(', ')}; final at path: ${JSON.stringify(byPath.filter(([fp]) => isVariant(p, fp)))}`)
        }
      }
      if (!env('SKIP_KNOWN_BUGS')) t.is(lost, 0, 'no last write lost')
    }
    if (!final || lost) t.comment('op log:\n' + log.join('\n'))
  })
}
