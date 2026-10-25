// Local web UI + JSON API. File operations only touch the synced folder on
// disk; the engine notices those changes like any other local edit.

import http from '#http'
import fs from '#fs'
import fsp from '#fs/promises'
import path from '#path'
import crypto from '#crypto'
import { pipeline } from '#stream/promises'
import b4a from 'b4a'
import qrcode from 'qrcode-generator'
import UI, { jsQR } from './ui.generated.js'
import { DEV_IGNORE } from './config.js'
import { offBy } from './engine.js'

const MAX_JSON = 4 * 1024 * 1024 // a choice of folders can list many paths

class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

async function readJSON (req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_JSON) throw new HttpError(413, 'body too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(b4a.toString(b4a.concat(chunks))) } catch { throw new HttpError(400, 'invalid json') }
}

// What a device of the drive keeps online only (this device: its live list).
function excludedOf (e, device) {
  if (device === e.key) return e.excluded
  const r = e.selections.get(device)
  return r ? r.excluded : []
}

// Files of a drive as everyone sees them (online-only ones included),
// newest first, for search and "Recent".
function driveFiles (space, match, limit = 100) {
  const e = space.engine
  const out = []
  for (const it of e.entries()) {
    if (!match(it.path)) continue
    out.push({ name: path.posix.basename(it.path), path: it.path, dir: false, size: it.size, mtime: it.mtime, device: it.device, space: space.id, spaceName: space.name, ...where(e, it.path) })
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  return out.slice(0, limit)
}

// local: a copy is on this device. online: kept online only (selective sync).
function where (e, p) {
  return { local: !!e.index[p], online: e.isExcluded(p), pending: e.pending.has(p) }
}

// The preview JPEG a camera stores in a photo's EXIF data (null if none), with
// the photo's orientation added so it shows the right way up.
function exifThumb (buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let at = 2
  while (at + 4 <= buf.length && buf[at] === 0xff) {
    const marker = buf[at + 1]
    const len = (buf[at + 2] << 8) | buf[at + 3]
    if (marker === 0xda || marker === 0xd9) return null // the image itself: no EXIF before it
    if (marker === 0xe1 && b4a.toString(buf.subarray(at + 4, at + 10), 'latin1') === 'Exif\0\0') {
      return fromTiff(buf.subarray(at + 10, Math.min(buf.length, at + 2 + len)))
    }
    at += 2 + len
  }
  return null

  function fromTiff (t) {
    const le = t[0] === 0x49
    const u16 = (o) => le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]
    const u32 = (o) => le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16)) + t[o + 3] * 2 ** 24 : t[o] * 2 ** 24 + ((t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3])
    const tags = (ifd) => {
      const out = new Map()
      if (ifd + 2 > t.length) return { out, next: 0 }
      const n = u16(ifd)
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12
        if (e + 12 > t.length) break
        out.set(u16(e), u16(e + 2) === 3 ? u16(e + 8) : u32(e + 8))
      }
      const nx = ifd + 2 + n * 12
      return { out, next: nx + 4 <= t.length ? u32(nx) : 0 }
    }
    const ifd0 = tags(u32(4))
    if (!ifd0.next) return null
    const ifd1 = tags(ifd0.next).out
    const off = ifd1.get(0x0201)
    const len = ifd1.get(0x0202)
    if (!off || !len || off + len > t.length || t[off] !== 0xff || t[off + 1] !== 0xd8) return null
    const jpeg = t.subarray(off, off + len)
    const orient = ifd0.out.get(0x0112) || 1
    if (orient === 1) return jpeg
    // SOI, then an EXIF segment holding only the orientation, then the preview.
    const app1 = b4a.from([0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orient, 0, 0, 0, 0, 0, 0])
    return b4a.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
  }
}

// Stats many files at once, a few at a time (null for ones that are gone).
async function statAll (files) {
  const out = new Array(files.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const i = next++
      out[i] = await fsp.stat(files[i]).catch(() => null)
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, worker))
  return out
}

// Immediate children (files and folders) of a folder, from the drive's entries.
function children (entries, dir) {
  const pre = dir === '/' ? '/' : dir + '/'
  const out = new Set()
  for (const it of entries) {
    if (!it.path.startsWith(pre)) continue
    out.add(pre + it.path.slice(pre.length).split('/')[0])
  }
  return [...out]
}

// ---- choosing folders in a folder on disk (a drive about to be created) ----

const devIgnore = new Set(DEV_IGNORE)
const hiddenName = (name, ignore) => name.startsWith('.syncker') || name === '.DS_Store' || (ignore && devIgnore.has(name))

// The folder an API call names, absolute; p (a path inside it) must stay inside.
function diskPath (folder, p = '/') {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new HttpError(400, 'folder must be an absolute path')
  const root = path.resolve(folder)
  const abs = path.resolve(root, '.' + path.posix.normalize('/' + (p || '')))
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, 'bad path')
  return { root, abs, rel: '/' + path.relative(root, abs).split(path.sep).join('/') }
}

// Subfolders of one folder, and the files directly in it.
async function diskLevel (folder, dir, ignore) {
  const { abs, rel } = diskPath(folder, dir)
  const items = await fsp.readdir(abs, { withFileTypes: true }).catch((err) => { throw new HttpError(err.code === 'ENOENT' ? 404 : 400, err.code === 'ENOENT' ? 'no such folder' : err.message) })
  const folders = []
  const loose = { files: 0, bytes: 0 }
  const pre = rel === '/' ? '/' : rel + '/'
  for (const it of items) {
    if (hiddenName(it.name, ignore)) continue
    if (it.isDirectory()) folders.push({ path: pre + it.name, name: it.name })
    else if (it.isFile()) {
      loose.files++
      loose.bytes += (await fsp.stat(path.join(abs, it.name)).catch(() => ({ size: 0 }))).size
      if (loose.files <= 1000) (loose.paths = loose.paths || []).push(pre + it.name)
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  return { dir: rel, folders, loose }
}

// Files and bytes under a folder on disk (stops counting after a while).
async function diskSize (abs, ignore, out = { files: 0, bytes: 0, folders: 0, partial: false }, until = Date.now() + 20000) {
  let items
  try { items = await fsp.readdir(abs, { withFileTypes: true }) } catch { return out }
  for (const it of items) {
    if (Date.now() > until) { out.partial = true; return out }
    if (hiddenName(it.name, ignore)) continue
    const p = path.join(abs, it.name)
    if (it.isDirectory()) { out.folders++; await diskSize(p, ignore, out, until) } else if (it.isFile()) {
      out.files++
      out.bytes += (await fsp.stat(p).catch(() => ({ size: 0 }))).size
    }
  }
  return out
}

// One (un)ticked path of a draft choice for a folder on disk.
async function toggleDisk (body, base, p) {
  const { rel: target } = diskPath(body.folder, p)
  // toggleExcluded splits an excluded folder into its other parts: list the levels it needs.
  const entries = []
  const under = (p, d) => d === '/' || p === d || p.startsWith(d + '/')
  const anc = base.find((e) => under(target, e))
  if (anc && body.sync) {
    let cur = anc
    while (cur !== target) {
      const level = await diskLevel(body.folder, cur, !!body.ignore).catch(() => null)
      if (!level) break
      for (const f of level.folders) entries.push({ path: f.path })
      const { abs } = diskPath(body.folder, cur)
      for (const it of await fsp.readdir(abs, { withFileTypes: true }).catch(() => [])) {
        if (it.isFile() && !hiddenName(it.name, !!body.ignore)) entries.push({ path: (cur === '/' ? '' : cur) + '/' + it.name })
      }
      const next = level.folders.find((f) => under(target, f.path))
      if (!next) break
      cur = next.path
    }
  }
  return toggleExcluded(base, target, !!body.sync, entries)
}

// Selective sync rules (see offBy in engine.js) after (un)ticking one path:
// the rules under it go, and it gets its own rule if its folders say otherwise.
export function toggleRule (rules, target, sync) {
  const path = (r) => r.startsWith('+') ? r.slice(1) : r
  const list = rules.filter((r) => { const p = path(r); return !(target === '/' || p === target || p.startsWith(target + '/')) })
  const inherited = offBy(list, target)
  if (sync && inherited) list.push('+' + target)
  if (!sync && !inherited) list.push(target)
  return list
}

// Paths not shared from a folder on disk (a drive being made), after
// (un)ticking one: ticking something inside an unticked folder splits that
// folder into its other parts.
export function toggleExcluded (excluded, target, sync, entries) {
  const under = (p, dir) => dir === '/' || p === dir || p.startsWith(dir + '/')
  if (!sync) return [...excluded, target]
  let list = excluded.filter((e) => !under(e, target))
  const anc = list.find((e) => under(target, e))
  if (!anc) return list
  list = list.filter((e) => e !== anc)
  let cur = anc
  while (cur !== target) {
    const next = children(entries, cur).find((k) => under(target, k))
    if (!next) break
    for (const k of children(entries, cur)) if (k !== next) list.push(k)
    cur = next
  }
  return list
}

export function serve (app, { port = 7777, host = '127.0.0.1' }) {
  const clients = new Set()
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  const status = () => JSON.stringify(app.info())
  let pushTimer = null
  // Heartbeat comment: keeps idle proxies/WebViews from dropping the stream.
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n') }, 25000)
  // Throttled, not debounced: during a transfer changes never stop coming.
  app.on('change', () => {
    if (pushTimer) return
    pushTimer = setTimeout(() => {
      pushTimer = null
      const msg = `data: ${status()}\n\n`
      for (const res of clients) res.write(msg)
    }, 250)
  })

  const space = (q) => {
    if (!app.configured) throw new HttpError(409, 'not set up yet')
    const s = app.space(q.get('space'))
    if (!s.engine || s.error || s.starting) throw new HttpError(503, `"${s.name}" is not running: ${s.error || 'starting'}`)
    return s
  }
  const engineOf = (q) => space(q).engine

  const resolve = (q, p) => {
    const root = engineOf(q).folder
    const abs = path.resolve(root, '.' + path.posix.normalize('/' + (p || '')))
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, 'bad path')
    if (abs.slice(root.length).split(path.sep).some((part) => part.startsWith('.syncker'))) throw new HttpError(400, 'reserved name')
    return abs
  }

  const json = (res, code, data) => {
    const body = JSON.stringify(data)
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': b4a.byteLength(body) })
    res.end(body)
  }

  const routes = {
    'GET /': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b4a.byteLength(UI) })
      res.end(UI)
    },

    'GET /api/status': async (req, res) => {
      if (!app.configured) await app.resolveDefaultFolder()
      json(res, 200, app.info())
    },

    // A drive's invite as a QR code, for the phone's camera (or the in-app scanner).
    'GET /api/invite.svg': (req, res, q) => {
      if (!app.configured) throw new HttpError(409, 'not set up yet')
      const qr = qrcode(0, 'M')
      qr.addData(app.space(q.get('space')).invite)
      qr.make()
      const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': b4a.byteLength(svg), 'cache-control': 'no-store' })
      res.end(svg)
    },

    'GET /vendor/jsqr.js': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': b4a.byteLength(jsQR), 'cache-control': 'max-age=86400' })
      res.end(jsQR)
    },

    'GET /api/events': async (req, res) => {
      if (!app.configured) await app.resolveDefaultFolder()
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${status()}\n\n`)
      clients.add(res)
      // Only the response's close means the client went away: on Bare the
      // request emits 'close' as soon as its (empty) body has been read.
      res.on('close', () => clients.delete(res))
      res.on('error', () => clients.delete(res))
    },

    // First run: device name + first shared drive.
    'POST /api/setup': async (req, res) => {
      const body = await readJSON(req)
      if (body.mode !== 'create' && body.mode !== 'join') throw new HttpError(400, 'mode must be create or join')
      try {
        await app.setup(body)
      } catch (err) {
        throw new HttpError(400, err.message)
      }
      json(res, 201, app.info())
    },

    // ---- shared drives ----

    'POST /api/spaces': async (req, res) => {
      const body = await readJSON(req)
      let d
      try {
        d = await app.addSpace(body)
      } catch (err) {
        throw new HttpError(400, err.message)
      }
      json(res, 201, { id: d.id, name: d.name, folder: d.folder })
    },

    // Photo backup (phones): { on } -> the camera drive, or null for "not now".
    'POST /api/camera': async (req, res) => {
      const body = await readJSON(req)
      let d
      try {
        d = await app.setCamera(!!body.on, body.folder || null)
      } catch (err) {
        throw new HttpError(400, err.message)
      }
      json(res, 200, d ? { id: d.id, name: d.name, folder: d.folder } : null)
    },

    'GET /api/spaces/suggest': async (req, res, q) => json(res, 200, { folder: await app.suggestFolder(q.get('name')) }),

    'POST /api/spaces/rename': async (req, res, q) => {
      const body = await readJSON(req)
      await app.renameSpace(app.space(q.get('space')).id, body.name)
      json(res, 200, { ok: true })
    },

    'POST /api/spaces/leave': async (req, res, q) => {
      await app.removeSpace(app.space(q.get('space')).id)
      json(res, 200, { ok: true })
    },

    // Selective sync of this device, or ?device=<key> of another device in the
    // drive. Body: { path, sync: true|false }, { paths: [...], sync } or { excluded: [...] }.
    'POST /api/selective': async (req, res, q) => {
      const s = space(q)
      const body = await readJSON(req)
      const device = q.get('device') || s.engine.key
      let list
      if (Array.isArray(body.excluded)) list = body.excluded
      else if (Array.isArray(body.base)) {
        // A draft being edited (choosing what to sync from a drive just joined): nothing is applied.
        let draft = body.base.filter((x) => typeof x === 'string')
        for (const x of Array.isArray(body.paths) ? body.paths : [body.path]) {
          const p = x === '/' ? '/' : path.posix.normalize(String(x || '/')).replace(/\/+$/, '')
          draft = toggleRule(draft, p, !!body.sync)
        }
        return json(res, 200, { excluded: draft })
      } else {
        // One path, or several at once (a multiple selection): applied as one change.
        const paths = Array.isArray(body.paths) ? body.paths : [body.path]
        if (!paths.length || !paths.every((x) => typeof x === 'string' && x.startsWith('/'))) throw new HttpError(400, 'path required')
        // A drive not synced yet (just joined): everything is online only so far.
        list = s.engine.hold && device === s.engine.key ? ['/'] : excludedOf(s.engine, device)
        for (const x of paths) list = toggleRule(list, x === '/' ? '/' : path.posix.normalize(x).replace(/\/+$/, ''), !!body.sync)
      }
      try {
        await app.setExcluded(s.id, list, device)
      } catch (err) {
        throw new HttpError(403, err.message)
      }
      json(res, 200, { excluded: excludedOf(s.engine, device) })
    },

    'POST /api/spaces/remote': async (req, res, q) => {
      const body = await readJSON(req)
      await app.setAllowRemote(space(q).id, !!body.allow)
      json(res, 200, { ok: true })
    },

    // One level of a drive's folders with their sizes, for "choose what to
    // sync" (?dir=/a/b, default the top). loose: the files directly in dir.
    'GET /api/tree': (req, res, q) => {
      const e = engineOf(q)
      const device = q.get('device') || e.key
      const dir = q.get('dir') && q.get('dir') !== '/' ? path.posix.normalize(q.get('dir')).replace(/\/+$/, '') : '/'
      const pre = dir === '/' ? '/' : dir + '/'
      const folders = new Map()
      const loose = { files: 0, bytes: 0 }
      let files = 0
      let bytes = 0
      for (const it of e.entries()) {
        if (!it.path.startsWith(pre)) continue
        files++
        bytes += it.size || 0
        const rest = it.path.slice(pre.length)
        const cut = rest.indexOf('/')
        if (cut < 0) { loose.files++; loose.bytes += it.size || 0; if (loose.files <= 1000) (loose.paths = loose.paths || []).push(it.path); continue }
        const name = rest.slice(0, cut)
        const f = folders.get(name) || { path: pre + name, name, files: 0, bytes: 0, folders: false }
        f.files++
        f.bytes += it.size || 0
        if (rest.indexOf('/', cut + 1) >= 0) f.folders = true
        folders.set(name, f)
      }
      const list = [...folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      json(res, 200, { dir, files, bytes, folders: list, loose, excluded: excludedOf(e, device) })
    },

    // The same for a folder on disk, before a drive is made from it.
    // ?folder=/abs&dir=/a&ignore=1 (leave out build and dependency folders).
    'GET /api/fs/tree': async (req, res, q) => {
      json(res, 200, await diskLevel(q.get('folder'), q.get('dir') || '/', q.get('ignore') === '1'))
    },

    // Folders on this device, to pick the folder of a new drive. Starts where
    // drives go by default (home, or shared storage on Android).
    'GET /api/fs/browse': async (req, res, q) => {
      const home = path.dirname(app.defaultFolder)
      const want = q.get('path') || home
      if (!path.isAbsolute(want)) throw new HttpError(400, 'path must be absolute')
      const abs = path.resolve(want)
      const items = await fsp.readdir(abs, { withFileTypes: true }).catch((err) => { throw new HttpError(err.code === 'ENOENT' ? 404 : 403, err.code === 'ENOENT' ? 'no such folder' : `cannot open this folder (${err.code || err.message})`) })
      const folders = items.filter((it) => it.isDirectory() && !it.name.startsWith('.')).map((it) => it.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      json(res, 200, { path: abs, parent: path.dirname(abs) === abs ? null : path.dirname(abs), home, folders })
    },

    'POST /api/fs/mkdir': async (req, res) => {
      const body = await readJSON(req)
      const name = String(body.name || '').trim()
      if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) throw new HttpError(400, 'path must be absolute')
      if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new HttpError(400, 'bad folder name')
      const abs = path.join(path.resolve(body.path), name)
      await fsp.mkdir(abs).catch((err) => { throw new HttpError(err.code === 'EEXIST' ? 409 : 403, err.code === 'EEXIST' ? 'a folder with that name already exists' : `cannot create it (${err.code || err.message})`) })
      json(res, 200, { path: abs })
    },

    'GET /api/fs/size': async (req, res, q) => {
      json(res, 200, await diskSize(diskPath(q.get('folder'), q.get('dir') || '/').abs, q.get('ignore') === '1'))
    },

    // (Un)ticking one path of a draft choice for a folder on disk: { folder,
    // base, path, sync, ignore } -> { excluded }. Nothing is applied.
    'POST /api/fs/toggle': async (req, res) => {
      const body = await readJSON(req)
      let draft = (Array.isArray(body.base) ? body.base : []).filter((x) => typeof x === 'string' && x.startsWith('/'))
      for (const x of Array.isArray(body.paths) ? body.paths : [body.path]) draft = await toggleDisk(body, draft, x)
      json(res, 200, { excluded: draft })
    },

    // What a draft choice keeps of a drive: { excluded } -> { files, bytes, total }.
    'POST /api/tree/selected': async (req, res, q) => {
      const body = await readJSON(req)
      const ex = (Array.isArray(body.excluded) ? body.excluded : []).filter((x) => typeof x === 'string')
      const out = { files: 0, bytes: 0, totalFiles: 0, total: 0 }
      for (const it of engineOf(q).entries()) {
        out.totalFiles++
        out.total += it.size || 0
        if (offBy(ex, it.path)) continue
        out.files++
        out.bytes += it.size || 0
      }
      json(res, 200, out)
    },

    // ---- files ----

    'GET /api/list': async (req, res, q) => {
      const s = space(q)
      const e = s.engine
      // A drive just joined: nothing is shown until its whole file list is here.
      if (!e.listed) return json(res, 200, { dir: q.get('dir') || '/', space: s.id, items: [], listing: true })
      const dir = resolve(q, q.get('dir'))
      const rel = '/' + path.relative(e.folder, dir).split(path.sep).join('/')
      const items = (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((it) => !it.name.startsWith('.syncker'))
      const stats = await statAll(items.map((it) => path.join(dir, it.name)))
      const out = new Map()
      items.forEach((it, i) => {
        const st = stats[i]
        if (!st) return
        const p = path.posix.join(rel, it.name)
        const versions = !st.isDirectory() && e.view.get(p)
        const winner = versions && e._resolve(p).winner
        out.set(p, { name: it.name, path: p, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, synced: !!e.index[p], device: winner ? winner.meta.device : null, local: true, online: e.isExcluded(p), copies: winner ? e.copies(p) : null })
      })
      // What other devices have that is not here: online-only, or still downloading.
      const { files, folders } = e.dirEntries(rel)
      for (const it of files) {
        if (out.has(it.path)) continue
        out.set(it.path, { name: path.posix.basename(it.path), path: it.path, dir: false, size: it.size, mtime: it.mtime, device: it.device, ...where(e, it.path), copies: e.copies(it.path) })
      }
      for (const [p, f] of folders) {
        if (out.has(p)) out.get(p).online = out.get(p).online || e.isExcluded(p)
        else out.set(p, { ...f, local: false, online: e.isExcluded(p) })
      }
      for (const p of e.pending) {
        if (path.posix.dirname(p) !== rel || out.has(p)) continue
        out.set(p, { name: path.posix.basename(p), path: p, dir: false, pending: true, local: false, online: false })
      }
      // Big files another device is still adding.
      for (const t of e.transfers.items.values()) {
        if (t.preparing == null || path.posix.dirname(t.path) !== rel || out.has(t.path)) continue
        out.set(t.path, { name: path.posix.basename(t.path), path: t.path, dir: false, size: t.size, device: t.device, pending: true, local: false, online: false })
      }
      json(res, 200, { dir: rel, space: s.id, items: [...out.values()] })
    },

    // Search and recent span every drive.
    'GET /api/search': (req, res, q) => {
      const needle = String(q.get('q') || '').toLowerCase().trim()
      const items = []
      if (needle) for (const s of listed()) items.push(...driveFiles(s, (p) => path.posix.basename(p).toLowerCase().includes(needle)))
      json(res, 200, { items: items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 200) })
    },

    'GET /api/recent': (req, res) => {
      const items = []
      for (const s of listed()) items.push(...driveFiles(s, () => true))
      json(res, 200, { items: items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 100) })
    },

    'GET /api/versions': (req, res, q) => json(res, 200, engineOf(q).versions(q.get('path'))),

    // What is happening with one file: here, on every other device, and lately.
    'GET /api/details': async (req, res, q) => {
      const e = engineOf(q)
      const abs = resolve(q, q.get('path'))
      const p = '/' + path.relative(e.folder, abs).split(path.sep).join('/')
      const st = await fsp.stat(abs).catch(() => null)
      const d = e.details(p)
      if (st && !st.isDirectory()) Object.assign(d, { local: { size: st.size, mtime: st.mtimeMs } })
      if (d.size == null && st) Object.assign(d, { size: st.size, mtime: st.mtimeMs })
      json(res, 200, d)
    },

    // A file from this device, or streamed from the drive if it is online-only.
    'GET /api/file': async (req, res, q) => {
      const abs = resolve(q, q.get('path'))
      const st = await fsp.stat(abs).catch(() => null)
      const name = encodeURIComponent(path.basename(abs))
      const headers = (size) => ({
        'content-length': size,
        'content-type': 'application/octet-stream',
        'content-disposition': `${q.get('inline') ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`
      })
      if (st) {
        if (!st.isFile()) throw new HttpError(400, 'not a file')
        res.writeHead(200, headers(st.size))
        await pipeline(fs.createReadStream(abs), res)
        return
      }
      const remote = engineOf(q).openRemote('/' + path.relative(engineOf(q).folder, abs).split(path.sep).join('/'))
      if (!remote) throw new HttpError(404, 'not found')
      // Nobody online has it: fail instead of hanging.
      const failed = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(new HttpError(504, 'no device that has this file is online')), 20000)
        const done = (err) => { clearTimeout(timer); resolve(err) }
        remote.stream.once('readable', () => done(null))
        remote.stream.once('end', () => done(null))
        remote.stream.once('error', done)
      })
      if (failed) {
        remote.stream.destroy()
        throw failed.status ? failed : new HttpError(502, failed.message)
      }
      res.writeHead(200, headers(remote.size))
      await pipeline(remote.stream, res)
    },

    // A small picture for the grid: the preview a camera puts inside a JPEG, or
    // else the whole file.
    'GET /api/thumb': async (req, res, q) => {
      const abs = resolve(q, q.get('path'))
      const st = await fsp.stat(abs).catch(() => null)
      if (!st || !st.isFile()) throw new HttpError(404, 'not found')
      let small = null
      if (/\.jpe?g$/i.test(abs)) {
        const fh = await fsp.open(abs, 'r')
        try {
          const buf = b4a.alloc(Math.min(st.size, 140 * 1024))
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
          small = exifThumb(buf.subarray(0, bytesRead))
        } catch {} finally { await fh.close() }
      }
      const headers = { 'content-type': small ? 'image/jpeg' : 'application/octet-stream', 'cache-control': 'private, max-age=86400' }
      if (small) {
        res.writeHead(200, { ...headers, 'content-length': small.length })
        res.end(small)
        return
      }
      res.writeHead(200, { ...headers, 'content-length': st.size })
      await pipeline(fs.createReadStream(abs), res)
    },

    'PUT /api/file': async (req, res, q) => {
      const abs = resolve(q, q.get('path'))
      if (abs === engineOf(q).folder) throw new HttpError(400, 'bad path')
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      const tmp = path.join(path.dirname(abs), '.syncker-tmp-' + b4a.toString(crypto.randomBytes(6), 'hex'))
      try {
        await pipeline(req, fs.createWriteStream(tmp))
        await fsp.rename(tmp, abs)
      } catch (err) {
        await fsp.rm(tmp, { force: true })
        throw err
      }
      engineOf(q).sync()
      json(res, 201, { ok: true })
    },

    'POST /api/mkdir': async (req, res, q) => {
      await fsp.mkdir(resolve(q, q.get('path')), { recursive: true })
      json(res, 201, { ok: true })
    },

    'POST /api/move': async (req, res, q) => {
      const from = resolve(q, q.get('from'))
      const to = resolve(q, q.get('to'))
      if (from === engineOf(q).folder) throw new HttpError(400, 'cannot move root')
      if (to.startsWith(from + path.sep)) throw new HttpError(400, 'cannot move a folder into itself')
      if (await fsp.stat(to).then(() => true, () => false)) throw new HttpError(409, 'target exists')
      if (!(await fsp.stat(from).then(() => true, () => false))) throw new HttpError(409, 'online-only items can be renamed once they are on this device')
      await fsp.mkdir(path.dirname(to), { recursive: true })
      await fsp.rename(from, to)
      engineOf(q).sync()
      json(res, 200, { ok: true })
    },

    'DELETE /api/file': async (req, res, q) => {
      const abs = resolve(q, q.get('path'))
      if (abs === engineOf(q).folder) throw new HttpError(400, 'cannot delete root')
      const e = engineOf(q)
      if (await fsp.stat(abs).then(() => true, () => false)) {
        await fsp.rm(abs, { recursive: true, force: true })
        e.sync()
      } else {
        // Online-only: nothing here to delete, publish the deletion directly.
        await e.deleteRemote('/' + path.relative(e.folder, abs).split(path.sep).join('/'))
      }
      json(res, 200, { ok: true })
    },

    'POST /api/sync': async (req, res, q) => {
      const list = q.get('space') ? [space(q)] : running()
      await Promise.all(list.map((s) => { s.engine.refreshDiscovery(); return s.engine.sync() }))
      json(res, 200, { ok: true })
    }
  }

  const running = () => [...app.spaces.values()].filter((s) => s.engine && !s.error && !s.starting)
  const listed = () => running().filter((s) => s.engine.listed)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const route = routes[req.method + ' ' + url.pathname]
    // No auth on this API: block other web pages (Origin) and DNS rebinding (Host).
    const origin = req.headers.origin
    const hostname = (req.headers.host || '').replace(/:\d+$/, '')
    if (loopback && !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return json(res, 403, { error: 'forbidden' })
    if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'forbidden' })
    if (!route) return json(res, 404, { error: 'not found' })
    try {
      await route(req, res, url.searchParams)
    } catch (err) {
      const code = err.status || (err.code === 'ENOENT' ? 404 : 500)
      if (!res.headersSent) json(res, code, { error: code === 500 ? 'internal error' : err.message })
      else res.destroy()
      if (code === 500) app.emit('error-log', err)
    }
  })

  const close = server.close.bind(server)
  server.close = (cb) => {
    clearTimeout(pushTimer)
    clearInterval(heartbeat)
    for (const res of clients) res.end()
    clients.clear()
    close(cb)
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}
