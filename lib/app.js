// Runs Syncker on any platform: the web UI starts right away, the sync
// engines start once the device is set up (from the UI, or from the CLI).
// Every invite is its own shared drive: own secret, folder, data and peers.
// Shared by the Linux CLI (Node) and the Android worklet (Bare).

import { EventEmitter } from '#events'
import fsp from '#fs/promises'
import path from '#path'
import crypto from '#crypto'
import b4a from 'b4a'
import { Engine } from './engine.js'
import { configStore, newSecret, toInvite, fromInvite } from './config.js'
import { serve } from './web.js'
export { DEV_IGNORE } from './config.js'

const inside = (a, b) => a === b || a.startsWith(b + path.sep)

// Files a phone's camera app leaves while it is still writing a photo, or
// after one is moved to the gallery's trash: never worth syncing.
export const CAMERA_IGNORE = ['.pending-*', '.trashed-*', '.thumbnails']

// A drive just joined syncs everything on its own only when it is small:
// below this size, and taking at most half of the free space.
export const ASK_ABOVE = 1024 * 1024 * 1024

export class App extends EventEmitter {
  // defaultFolder may be a list: the first one that is writable at setup time
  // wins (on Android: shared storage if "All files access" is granted, else
  // the app's own folder). Later drives go next to it: "<folder> - <name>".
  // folderGuard(folder) -> reason | null: when it returns a reason, sync of that
  // folder is paused (Android: shared storage without "All files access").
  // cameraFolder: where the camera app saves photos (Android), offered once as
  // a drive of its own ("photo backup"); nothing is synced from it unless the
  // user says yes. May be a list: the first one with photos in it is offered
  // (camera apps differ: DCIM/Camera on most phones, Pictures on some).
  constructor ({ home, defaultFolder, defaultName, port = 7777, host = '127.0.0.1', socket = null, bootstrap, platform, folderGuard = () => null, askAbove = ASK_ABOVE, cameraFolder = null }) {
    super()
    this.cameraFolders = [].concat(cameraFolder || [])
    this.cameraFolder = this.cameraFolders[0] || null
    this.cameraAsked = false
    this.askAbove = askAbove
    this.home = home
    this.folderCandidates = [].concat(defaultFolder)
    this.defaultFolder = this.folderCandidates[0]
    this.defaultName = defaultName
    this.port = port
    this.host = host
    this.socket = socket
    this.bootstrap = bootstrap
    this.platform = platform
    this.folderGuard = folderGuard
    this.config = configStore(home)
    this.deviceName = null
    this.spaces = new Map() // id -> { id, name, secret, folder, home, excluded, engine, invite, error }
    this.server = null
  }

  // web: false starts the engines only (CLI commands).
  async start ({ web = true } = {}) {
    const config = migrate(await this.config.load())
    if (config) {
      this.deviceName = config.deviceName
      this.cameraAsked = !!config.cameraAsked
      for (const s of config.spaces) await this._startSpace(s)
    }
    await this._findCamera()
    if (web) this.server = await serve(this, { port: this.port, host: this.host, socket: this.socket })
    this.emit('change')
    return this
  }

  get configured () { return !!this.deviceName }

  // The first drive's engine (single-drive callers and tests).
  get engine () {
    const first = this.spaces.values().next().value
    return first ? first.engine : null
  }

  get invite () {
    const first = this.spaces.values().next().value
    return first ? first.invite : null
  }

  space (id) {
    const s = id ? this.spaces.get(id) : this.spaces.values().next().value
    if (!s) throw Object.assign(new Error('No such shared drive'), { status: 404 })
    return s
  }

  async resolveDefaultFolder () {
    for (const dir of this.folderCandidates) {
      if (await writable(dir)) {
        this.defaultFolder = dir
        return dir
      }
    }
    return this.defaultFolder
  }

  // Where a new drive goes by default: the default folder for the first one,
  // then "<default folder> - <drive name>" next to it.
  async suggestFolder (name) {
    const base = await this.resolveDefaultFolder()
    if (!this.spaces.size) return base
    const safe = String(name || 'Shared drive').replace(/[\\/:*?"<>|\0]/g, '_').trim().slice(0, 64) || 'Shared drive'
    let dir = `${base} - ${safe}`
    for (let i = 2; [...this.spaces.values()].some((s) => s.folder === dir); i++) dir = `${base} - ${safe} (${i})`
    return dir
  }

  // First run: names this device and creates or joins its first drive.
  async setup ({ mode, invite, name, folder, drive, ask, direct, ignore, skip }) {
    if (this.configured) throw new Error('Already set up')
    this.deviceName = String(name || this.defaultName).trim().slice(0, 64) || this.defaultName
    try {
      return await this.addSpace({ mode, invite, name: drive, folder, ask, direct, ignore, skip })
    } catch (err) {
      this.deviceName = null
      throw err
    }
  }

  // Creates a new shared drive, or joins one from an invite. ask: a joined
  // drive waits until its size is known; a big one waits for a choice.
  // direct: send files straight from the folder, without a copy in the sync
  // data (see Engine). ignore: names / "*.ext" this device does not sync.
  // skip: paths in the folder this device does not share (chosen at creation).
  async addSpace ({ mode, invite, name, folder, ask = mode === 'join', direct = false, ignore = [], skip = [] }, { camera = false } = {}) {
    if (!this.configured) throw new Error('Not set up yet')
    if (mode !== 'create' && mode !== 'join') throw new Error('mode must be create or join')
    const parsed = mode === 'join' ? fromInvite(invite) : { secret: newSecret(), name: null }
    for (const s of this.spaces.values()) {
      if (s.secret === parsed.secret) throw new Error(`Already in this shared drive ("${s.name}")`)
    }
    name = cleanDriveName(name || parsed.name || (this.spaces.size ? 'Shared drive' : 'My drive'))
    folder = path.resolve(folder || await this.suggestFolder(name))
    for (const s of this.spaces.values()) {
      if (inside(folder, s.folder) || inside(s.folder, folder)) throw new Error(`That folder overlaps the folder of "${s.name}" (${s.folder})`)
    }
    const id = b4a.toString(crypto.randomBytes(4), 'hex')
    const space = { id, name, secret: parsed.secret, folder, home: path.join('spaces', id), excluded: [], hold: !!ask, listed: mode !== 'join', direct: !!direct, ignore: cleanIgnore(ignore), camera, skip: (Array.isArray(skip) ? skip : []).filter((p) => typeof p === 'string' && p.startsWith('/') && p !== '/').slice(0, 10000) }
    await this._startSpace(space, { strict: true })
    await this._save()
    this.emit('change')
    return this._public(this.spaces.get(id))
  }

  // Leaves a drive on this device: stops syncing it and deletes its sync
  // data. The files in its folder stay; other devices are not affected.
  async removeSpace (id) {
    const s = this.space(id)
    this.spaces.delete(s.id)
    await this._save()
    if (s.engine) await s.engine.close().catch(() => {})
    if (s.home) await fsp.rm(path.join(this.home, s.home), { recursive: true, force: true })
    this.emit('change')
  }

  // Photo backup: on makes the camera folder a drive of its own, synced
  // straight from the folder (no copy on the phone). Either answer is kept,
  // so the question is asked once.
  // folder: another folder than the one offered, picked by the user.
  async setCamera (on, folder = null) {
    if (!this.configured) throw new Error('Not set up yet')
    if (!this.cameraFolder) throw new Error('No camera folder on this device')
    if (folder != null && (typeof folder !== 'string' || !path.isAbsolute(folder))) throw new Error('folder must be absolute')
    const was = this.cameraAsked
    this.cameraAsked = true
    let added = null
    try {
      if (on && !this.cameraSpace()) added = await this.addSpace({ mode: 'create', name: `${this.deviceName} photos`, folder: folder || this.cameraFolder, direct: true, ignore: CAMERA_IGNORE }, { camera: true })
      else await this._save()
    } catch (err) {
      this.cameraAsked = was
      throw err
    }
    this.emit('change')
    return added
  }

  async _findCamera () {
    for (const dir of this.cameraFolders) {
      const names = await fsp.readdir(dir).catch(() => [])
      if (names.some((n) => /\.(jpe?g|heic|heif|dng|mp4)$/i.test(n))) {
        this.cameraFolder = dir
        return
      }
    }
  }

  cameraSpace () {
    return [...this.spaces.values()].find((s) => s.camera) || null
  }

  async renameSpace (id, name) {
    const s = this.space(id)
    s.name = cleanDriveName(name)
    s.invite = toInvite(s.secret, s.name)
    await this._save()
    this.emit('change')
  }

  // Selective sync: paths of a drive kept online only on this device, or
  // (device: another device's key) on another device of the drive.
  async setExcluded (id, excluded, device = null) {
    const s = this.space(id)
    if (!s.engine) throw new Error(`"${s.name}" is not running`)
    if (device && device !== s.engine.key) return s.engine.setSelection(device, excluded)
    const done = s.engine.setExcluded(excluded)
    s.excluded = s.engine.excluded
    s.hold = false // choosing what to sync is the answer to "sync everything?"
    await this._save()
    await done
    await s.engine.release()
  }

  // A drive just joined: sync it all right away if it is small enough.
  async _checkHold (s) {
    if (!s.hold || s.checking || !s.engine || s.starting || s.error) return
    const size = s.engine.size()
    if (!size.ready) return
    s.checking = true
    try {
      const free = await freeSpace(s.folder)
      s.free = free
      if (size.bytes <= this.askAbove && (free == null || size.bytes <= free / 2)) {
        s.hold = false
        const released = s.engine.release() // before saving: a failed save must not leave it waiting
        await this._save()
        await released
      } else this.emit('change')
    } finally { s.checking = false }
  }

  // Whether other devices may change what this device syncs in a drive.
  async setAllowRemote (id, allow) {
    const s = this.space(id)
    if (!s.engine) throw new Error(`"${s.name}" is not running`)
    s.allowRemote = !!allow
    await this._save()
    await s.engine.setAllowRemote(!!allow)
  }

  // strict: a drive being added must start, or it is not added.
  async _startSpace (space, { strict = false } = {}) {
    const s = { ...space, engine: null, invite: toInvite(space.secret, space.name), error: null, starting: true }
    this.spaces.set(s.id, s)
    const engine = new Engine({
      home: path.join(this.home, s.home),
      folder: s.folder,
      secret: s.secret,
      deviceName: this.deviceName,
      bootstrap: this.bootstrap,
      paused: this.folderGuard(path.resolve(s.folder)),
      excluded: s.excluded,
      allowRemote: s.allowRemote !== false,
      hold: !!s.hold,
      listed: s.listed !== false,
      direct: !!s.direct,
      ignore: s.ignore || [],
      skip: s.skip || []
    })
    engine.on('change', () => {
      this.emit('change')
      if (s.hold) this._checkHold(s).catch((err) => this.emit('error-log', err))
    })
    engine.on('file', (f) => this.emit('file', { ...f, space: s.name }))
    // The whole file list of a drive just joined has arrived.
    engine.on('listed', () => {
      s.listed = true
      this._save().catch((err) => this.emit('error-log', err))
    })
    // Another device made this drive direct.
    engine.on('direct', () => {
      s.direct = true
      this._save().catch((err) => this.emit('error-log', err))
    })
    engine.on('error-log', (err) => this.emit('error-log', err))
    // Another device changed what this device syncs: remember it.
    engine.on('excluded', (list, by) => {
      s.excluded = list
      this._save().catch((err) => this.emit('error-log', err))
      if (by) this.emit('error-log', new Error(`${by} changed what "${s.name}" syncs on this device`))
    })
    s.engine = engine
    try {
      await engine.start({ wait: false }) // a big folder's first scan must not hold up the app
      s.starting = false
    } catch (err) {
      s.starting = false
      // One broken drive (e.g. its data is locked) must not take the others down.
      if (strict) {
        this.spaces.delete(s.id)
        await engine.close().catch(() => {})
        throw err
      }
      s.error = err.message
      this.emit('error-log', err)
    }
  }

  async _save () {
    await this.config.save({
      version: 2,
      deviceName: this.deviceName,
      cameraAsked: this.cameraAsked,
      spaces: [...this.spaces.values()].map((s) => ({ id: s.id, name: s.name, secret: s.secret, folder: s.folder, home: s.home, excluded: s.excluded || [], allowRemote: s.allowRemote !== false, hold: !!s.hold, listed: s.listed !== false, direct: !!s.direct, ignore: s.ignore || [], skip: s.skip || [], ...(s.camera ? { camera: true } : {}) }))
    })
  }

  // Drives in a config, without starting anything (CLI "invite").
  listSpaces (config) {
    return (migrate(config) || { spaces: [] }).spaces.map((s) => ({ ...s, invite: toInvite(s.secret, s.name) }))
  }

  recheckGuard () {
    for (const s of this.spaces.values()) if (s.engine) s.engine.setPaused(this.folderGuard(s.engine.folder))
  }

  _public (s) {
    return { id: s.id, name: s.name, invite: s.invite, folder: s.folder, deviceName: this.deviceName, secret: s.secret }
  }

  info () {
    if (!this.configured) return { configured: false, defaultFolder: this.defaultFolder, defaultName: this.defaultName, platform: this.platform }
    const spaces = [...this.spaces.values()].map((s) => {
      const base = { id: s.id, name: s.name, invite: s.invite, camera: !!s.camera }
      // Not started (yet): status pushes can come while a drive is being added.
      if (!s.engine || s.error || s.starting) return { ...base, folder: s.folder, error: s.error, status: s.error ? { phase: 'error', error: s.error } : { phase: 'starting', error: null }, pending: [], failed: [], transfers: [], peers: [], excluded: s.excluded || [], totals: { files: 0, bytes: 0 }, speed: { down: 0, up: 0 } }
      const info = s.engine.info()
      if (info.hold) info.hold = { ...info.hold, free: s.free == null ? null : s.free }
      return { ...base, ...info }
    })
    const cam = this.cameraFolder && this.cameraSpace()
    const camera = this.cameraFolder ? { folder: this.cameraFolder, asked: this.cameraAsked, space: cam ? cam.id : null } : null
    return { configured: true, platform: this.platform, device: this.deviceName, camera, spaces }
  }

  async close () {
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()))
    for (const s of this.spaces.values()) if (s.engine) await s.engine.close().catch(() => {})
  }
}

function cleanIgnore (list) {
  return (Array.isArray(list) ? list : String(list || '').split(','))
    .map((r) => String(r).trim()).filter((r) => r && !r.includes('/')).slice(0, 256)
}

function cleanDriveName (name) {
  return String(name || '').replace(/[\0\r\n]/g, ' ').trim().slice(0, 64) || 'Shared drive'
}

async function freeSpace (dir) {
  try {
    const st = await fsp.statfs(dir)
    return st.bavail * st.bsize
  } catch {
    return null
  }
}

async function writable (dir) {
  try {
    await fsp.mkdir(dir, { recursive: true })
    const probe = path.join(dir, '.syncker-tmp-probe')
    await fsp.writeFile(probe, '')
    await fsp.rm(probe)
    return true
  } catch {
    return false
  }
}

// Config before shared drives: { secret, folder, deviceName }. Its data
// lives directly in home/, so that drive keeps home: ''.
function migrate (config) {
  if (!config) return null
  if (Array.isArray(config.spaces)) return config
  if (!config.secret) return null
  return {
    version: 2,
    deviceName: config.deviceName,
    spaces: [{ id: 'main', name: path.basename(config.folder) || 'My drive', secret: config.secret, folder: config.folder, home: '', excluded: [] }]
  }
}
