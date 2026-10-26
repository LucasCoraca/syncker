// Syncker sync engine.
//
// Model: every device owns one single-writer Hyperdrive ("its log of changes").
// Devices in the same space find each other on Hyperswarm via a topic derived
// from the space secret, prove they know the secret, exchange drive keys and
// replicate all drives. Each device then materializes the merged view of all
// drives into a plain folder on disk.
//
// Every file entry carries metadata { vv, clock, hash, size, mtime, device };
// deletes are tombstones (entry without blob, metadata.deleted = true).
//  - vv is a version vector { deviceId: counter }: a local edit takes the vv
//    of the version it replaced (what was on disk) and bumps its own counter.
//    A version whose vv is covered by another's is history; the rest (the
//    "frontier") are concurrent.
//  - Concurrent versions are resolved without losing data: an edit beats a
//    delete, and of several edits the highest (clock, driveKey) wins while the
//    others are kept as "name (conflict <device> <hash>).ext" copies.
//  - clock is a Lamport clock, only used to pick the winner deterministically.
//
// File contents travel one of two ways:
//  - stored: the content is copied into the drive's blob core (Hypercore
//    verifies every block, old versions stay downloadable, but the data
//    takes the space twice on the device that adds it);
//  - direct: the entry only has metadata (direct: true) and devices send the
//    file straight from their folder over a separate channel ("files"); the
//    receiver checks the SHA-256 from the signed entry before using it. No
//    copy, but only versions some device still has on disk can be fetched.

import { EventEmitter } from '#events'
import crypto from '#crypto'
import fs from '#fs'
import fsp from '#fs/promises'
import path from '#path'
import { pipeline } from '#stream/promises'
import { PassThrough } from '#stream'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { Transfers } from './transfers.js'

const PROTOCOL = 'syncker/v1'
const TMP_PREFIX = '.syncker-tmp-'
// Marker file in the synced folder. If it is missing (folder deleted or moved,
// SD card / shared storage not mounted yet, permission revoked) the engine
// stops instead of reading an empty folder as "the user deleted everything".
const MARKER = '.syncker'
// Upper bound for clocks and version counters from peers; a huge value would
// otherwise make a path impossible to edit again.
const MAX_CLOCK = 2 ** 48
// File timestamps tick coarsely (a few ms on Linux). A file whose mtime is not
// clearly older than the moment we recorded it may have been rewritten with
// the same size in the same tick, so its size+mtime cannot be trusted: hash it
// (the "racily clean" problem git has too).
const RACY_MS = 50
const RESCAN_INTERVAL = 15_000 // fs.watch is unreliable on Android shared storage
const AUTH_TIMEOUT = 15_000
const CONN_TIMEOUT = 30_000 // live peers send a keepalive every 5 s: a silent connection is dead
// If a peer says its drive has N entries but replication makes no progress
// towards it for this long, the session is stuck: redial it. (Safety net; the
// deadlock that used to cause this is fixed in the hello handler.)
const STALL_TIMEOUT = 30_000 // generous: a phone busy with a big drive answers late
// Long loops over a big drive let the event loop run this often (ms), so
// connections and the UI are served meanwhile (a phone takes long).
const BREATHE_MS = 30
const PENDING_LISTED = 500 // waiting paths sent to the UI (the count is always exact)
const LOOKUP_DELAYS = [5_000, 10_000, 20_000, 30_000] // re-query the DHT while some device is unreachable
// Direct transfers (see the top of this file).
const FILES_PROTOCOL = 'syncker/files/v1'
const DIRECT_PARALLEL = 16 // files fetched at once (each small file costs a round trip)
const DIRECT_RETRY = 10_000 // a device that could not send a file is asked again after at most this long
const DIRECT_RETRY_MIN = 500 // (doubling from this: the first "not here" is often a moment too early)
const DIRECT_IDLE = 30_000 // a transfer with no data for this long is given up and retried
const DIRECT_SERVE = 64 // requests one connection may have open at once
const PART = '.part' // TMP_PREFIX + id + PART: a direct download in progress (resumable)
const WALK_PARALLEL = 64 // files of a folder checked at once by the scan
const INDEX_EVERY = 5000 // a long first scan saves its progress every this many files
// The folder is watched folder by folder (Node's recursive watch on Linux
// watches and re-reads every file, which costs more than the sync itself in
// a big folder, and would also watch ignored trees); past this many folders,
// only the periodic rescan sees changes. A slow rescan runs less often.
const MAX_WATCHED = 4096
const RESCAN_FACTOR = 10

export function topicFromSecret (secret) {
  return crypto.createHash('sha256').update('syncker-topic').update(secret).digest()
}

function proof (secret, handshakeHash, initiator) {
  return crypto.createHmac('sha256', secret)
    .update(handshakeHash)
    .update(initiator ? 'initiator' : 'responder')
    .digest('hex')
}

// A downloaded file keeps the modification time it had on the device that
// wrote it (set on the temp file, before it is moved into place). Never in the
// future: a peer's clock may be off.
async function keepTime (file, version) {
  const t = version.meta.mtime
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return
  const when = new Date(Math.min(t, Date.now()))
  await fsp.utimes(file, when, when).catch(() => {})
}

function ignored (name) {
  return name.startsWith(TMP_PREFIX) || name === '.syncker' || name === '.DS_Store'
}

// A drive's own ignore rules: names ("node_modules"), suffixes ("*.log") and
// prefixes (".pending-*"). Ignored files are neither published nor downloaded
// on that device, and never read as deleted.
function ignoreRules (list) {
  const names = new Set()
  const suffixes = []
  const prefixes = []
  for (const r of Array.isArray(list) ? list : []) {
    if (typeof r !== 'string' || !r.trim() || r.includes('/')) continue
    const x = r.trim()
    if (x.startsWith('*') && !x.slice(1).includes('*')) suffixes.push(x.slice(1))
    else if (x.endsWith('*') && x.length > 1 && !x.slice(0, -1).includes('*')) prefixes.push(x.slice(0, -1))
    else if (!x.includes('*')) names.add(x)
  }
  if (!names.size && !suffixes.length && !prefixes.length) return null
  return (name) => names.has(name) || suffixes.some((s) => name.endsWith(s)) || prefixes.some((s) => name.startsWith(s))
}

// Data of a direct transfer: { id, offset, data }.
const chunkEncoding = {
  preencode (state, m) { c.uint.preencode(state, m.id); c.uint.preencode(state, m.offset); c.raw.preencode(state, m.data) },
  encode (state, m) { c.uint.encode(state, m.id); c.uint.encode(state, m.offset); c.raw.encode(state, m.data) },
  decode (state) { return { id: c.uint.decode(state), offset: c.uint.decode(state), data: c.raw.decode(state) } }
}

const directId = (version, target) => version.meta.hash + ':' + target

async function hashFile (file, onchunk = null) {
  const h = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) {
    h.update(chunk)
    if (onchunk) onchunk(chunk.byteLength)
  }
  return h.digest('hex')
}

const SELECTION_KEY = '/.syncker/selection' // never a valid file path (.syncker is reserved)
// Big files this device is still adding (hashing, copying into its drive):
// the other devices list them as "being prepared" before they can download.
const ACTIVITY_KEY = '/.syncker/activity'
const ANNOUNCE_MIN = 8 * 1024 * 1024
const ANNOUNCE_INTERVAL = 2000
// Which files (path -> content hash prefix) each device has on disk, told to
// the others so every file can show where it already arrived.
const HAVE_CHUNK = 1000
const HAVE_HASH = 16
const ACTIVITY_PATHS = 3000 // files with a remembered activity log
const ACTIVITY_PER_FILE = 12

function validSelection (sel) {
  const out = {}
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return out
  for (const [target, rec] of Object.entries(sel).slice(0, 256)) {
    if (!/^[0-9a-f]{64}$/.test(target) || !rec || !validCounter(rec.clock) || !Array.isArray(rec.excluded) || rec.excluded.length > 1000) continue
    out[target] = { excluded: normalizeExcluded(rec.excluded), clock: rec.clock }
  }
  return out
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// Selective sync rules: "/a" keeps /a and everything under it online only,
// "+/a/b" syncs /a/b (and under it) anyway. The longest matching rule wins;
// no rule: synced. ["/", "+/Docs"] syncs only Docs, also as new folders
// appear elsewhere. (Older versions drop the "+" rules: online only there.)
export function offBy (rules, p) {
  let best = null
  for (const r of rules) {
    const inc = r.charCodeAt(0) === 43 // '+'
    const q = inc ? r.slice(1) : r
    if (!(q === '/' || p === q || p.startsWith(q + '/'))) continue
    if (!best || q.length > best.len) best = { len: q.length, off: !inc }
  }
  return best ? best.off : false
}

function normalizeExcluded (list) {
  const path = (r) => r.startsWith('+') ? r.slice(1) : r
  const byPath = new Map() // path -> online only? (a later rule for the same path wins)
  for (const r of Array.isArray(list) ? list : []) {
    if (typeof r !== 'string' || !(r.startsWith('/') || r.startsWith('+/'))) continue
    const x = r.length > 2 ? r.replace(/\/+$/, '') : r
    const p = path(x)
    if (p === '/' || validPath(p)) byPath.set(p, !x.startsWith('+'))
  }
  const rules = [...byPath].map(([p, off]) => off ? p : '+' + p)
  // A rule with the same effect as its parent folders' rules changes nothing.
  return rules.filter((r) => {
    const p = path(r)
    const above = rules.filter((x) => { const q = path(x); return q !== p && (q === '/' || p.startsWith(q + '/')) })
    return offBy(above, p) !== !r.startsWith('+')
  }).sort((a, b) => path(a) < path(b) ? -1 : path(a) > path(b) ? 1 : 0)
}

const blobId = (version) => version.keyHex + ':' + version.blob.blockOffset + ':' + (version.blob.blockOffset + version.blob.blockLength)

// Remote drives are written by other devices: never trust their paths or metadata.
const validCounter = (n) => Number.isSafeInteger(n) && n >= 1 && n <= MAX_CLOCK

function validVV (vv) {
  if (vv === undefined) return true // entries written before version vectors
  if (!vv || typeof vv !== 'object' || Array.isArray(vv)) return false
  const keys = Object.keys(vv)
  return keys.length <= 256 && keys.every((k) => /^[0-9a-f]{16}$/.test(k) && validCounter(vv[k]))
}

function validEntry (p, meta) {
  if (!meta || typeof meta !== 'object' || !validCounter(meta.clock) || !validVV(meta.vv)) return false
  if (!meta.deleted && (typeof meta.hash !== 'string' || !/^[0-9a-f]{64}$/.test(meta.hash))) return false
  return validPath(p)
}

function routeKind (host) {
  const [a, b] = host.split('.').map(Number)
  if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b < 32) || (a === 169 && b === 254)) return 'lan'
  if (a === 100 && b >= 64 && b < 128) return 'vpn' // CGNAT range: Tailscale and the like
  return 'internet'
}

function validPath (p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 4096 || p.includes('\\') || p.includes('\0')) return false
  return p.split('/').slice(1).every((seg) => seg && seg !== '.' && seg !== '..' && !ignored(seg))
}

function cleanName (name) {
  return typeof name === 'string' ? name.slice(0, 64) : ''
}

// One name per losing version: a later conflict on the same path gets a new copy.
function conflictName (p, device, hash) {
  const ext = path.posix.extname(p)
  const base = p.slice(0, p.length - ext.length)
  const safe = String(device).replace(/[^\w.-]+/g, '_').slice(0, 32)
  return `${base} (conflict ${safe} ${hash.slice(0, 6)})${ext}`
}

function wins (a, b) {
  if (a.meta.clock !== b.meta.clock) return a.meta.clock > b.meta.clock
  return a.keyHex > b.keyHex
}

const deviceId = (keyHex) => keyHex.slice(0, 16)

// a <= b: every counter in a is covered by b
function covered (a, b) {
  for (const k in a) if ((b[k] || 0) < a[k]) return false
  return true
}

function mergeVV (...vvs) {
  const out = {}
  for (const vv of vvs) for (const k in vv) out[k] = Math.max(out[k] || 0, vv[k])
  return out
}

const sameVV = (a, b) => covered(a, b) && covered(b, a)

// See RACY_MS. Entries without seenAt (older index) are checked once.
const racy = (idx) => !(idx.seenAt > idx.mtimeMs + RACY_MS)

// Is st still the file idx recorded? Size, mtime and the inode where known:
// a file renamed over another can have the same size and mtime (e.g. two
// files downloaded in the same millisecond).
const sameFile = (idx, st) => st.size === idx.size && st.mtimeMs === idx.mtimeMs && (!idx.ino || !st.ino || st.ino === idx.ino)

export class Engine extends EventEmitter {
  // paused: a reason string to start paused (see setPaused).
  // excluded: selective sync, see setExcluded. allowRemote: other devices of
  // the drive may change what this device syncs (see setSelection).
  // hold: a drive just joined, nothing is downloaded until its size is known
  // and someone decides what to sync (see App).
  // direct: publish new files as direct entries (see the top of this file);
  // adopted from the other devices once any of them uses it. ignore: names
  // and "*.ext" suffixes this device does not sync (see ignoreRules).
  // skip: paths (folders or files) of the folder this device does not share
  // (chosen when the drive was created); like ignore, but by path.
  constructor ({ home, folder, secret, deviceName, bootstrap, paused = null, excluded = [], allowRemote = true, hold = false, listed = true, direct = false, ignore = [], skip = [] }) {
    super()
    this.home = home
    this.folder = path.resolve(folder)
    this.secret = b4a.from(secret, 'hex')
    this.deviceName = deviceName
    this.topic = topicFromSecret(this.secret)
    this.bootstrap = bootstrap // custom DHT bootstrap nodes (tests)
    this._paused = paused
    this.excluded = normalizeExcluded(excluded)
    this.allowRemote = allowRemote !== false
    this.hold = !!hold
    this.listed = !!listed // false: a drive just joined whose whole file list has not arrived yet
    this._collected = new Map() // peer key -> drive length seen by the last listing
    this.selections = new Map() // device key -> { excluded, clock, by, allowRemote }, merged from every drive
    this._mine = {} // the selection records this device publishes: target key -> { excluded, clock }
    this._published = false
    this._announced = false // our activity record lists files still being added
    this._announceTimer = null
    this.haves = new Map() // device key -> Map(path -> hash prefix): what each device has on disk
    this._told = null // Map(path -> hash prefix): what the connected devices know we have
    this.activity = new Map() // path -> [{ at, text }], newest last (this session only)
    this.direct = !!direct
    this.ignore = Array.isArray(ignore) ? ignore.filter((r) => typeof r === 'string') : []
    this._ignore = ignoreRules(this.ignore)
    this.skip = normalizeExcluded(skip).filter((p) => p !== '/' && !p.startsWith('+'))
    this._skip = this.skip.length ? new Set(this.skip) : null
    this._jobs = new Map() // direct download id -> job (see _directReady)
    this._queue = [] // jobs waiting for a free slot (from _queueHead on)
    this._queueHead = 0
    this._wanted = null // direct ids the current merge pass asked for
    this._byHash = new Map() // content hash -> paths on disk (sources for direct transfers)
    this._parts = [] // direct downloads in progress found on disk by the last scan
    this._reqSeq = 0
    this._activeJobs = 0
    this._breath = 0
    this._pendingRev = 0
    this._ready = new Set() // paths whose direct download finished since the last pass
    this._fullWanted = false
    this._passMs = 0 // how long the last sync pass took
    this._watchers = new Map() // folder -> watcher (folder-by-folder watching)

    this.store = null
    this.drive = null // our own writable drive
    this.peers = new Map() // keyHex -> { drive, name, lastSeen }
    this.connections = new Map() // remote public key hex -> { name, keyHex, send }
    this.index = {} // path -> { hash, size, mtimeMs, ino, vv, seenAt } as last synced to disk
    this.view = new Map() // path -> [{ keyHex, meta, blob, drive }]
    this.pending = new Set() // paths waiting for content from an offline/slow peer
    this.failed = new Map() // path -> error code, for paths that could not be written
    this._fetching = new Map() // blob id -> download handle
    this.transfers = new Transfers(() => this.emit('change'))
    this._ranges = null // keyHex -> blob ranges sorted by offset (maps blocks to paths)
    this.status = { phase: 'starting', lastSync: null, error: null }

    this._running = null
    this._again = false
    this._timer = null
    this._closing = false
  }

  get key () { return this.drive ? b4a.toString(this.drive.key, 'hex') : null }

  // wait: false returns once the drive is open, the first pass (which reads
  // the whole folder) runs on (the app does not hold its UI on a big folder).
  async start ({ wait = true } = {}) {
    await fsp.mkdir(this.home, { recursive: true })

    this.store = new Corestore(path.join(this.home, 'store'))
    this.drive = new Hyperdrive(this.store.namespace('self'))
    await this.drive.ready()

    this.drive.core.on('append', () => this._announceLengths())
    this.drive.getBlobs().then((blobs) => {
      blobs.core.on('append', () => this._announceLengths())
      blobs.core.on('upload', (index, byteLength, from) => this._onupload(this.key, index, byteLength, from))
    }, () => {})
    this.index = await this._readJSON('index.json', {})
    if (Object.keys(this.index).length === 0 && !this._paused) {
      // Never synced from this folder yet: safe to create it and its marker.
      try {
        await fsp.mkdir(this.folder, { recursive: true })
        await this._writeMarker()
      } catch {} // reported by _checkFolder on the first sync
    }
    for (const [k, list] of Object.entries(await this._readJSON('haves.json', {}))) {
      if (/^[0-9a-f]{64}$/.test(k) && list && typeof list === 'object') this.haves.set(k, new Map(Object.entries(list)))
    }
    const known = await this._readJSON('peers.json', {})
    for (const [keyHex, info] of Object.entries(known)) await this._addPeer(keyHex, info.name, false)

    this.swarm = new Hyperswarm(this.bootstrap ? { bootstrap: this.bootstrap } : {})
    this.swarm.on('connection', (socket, info) => this._onconnection(socket, info))
    // Downloads waiting for a device that has their file: ask again now and then.
    this._waitingTimer = setInterval(() => { if (this._jobs.size) this._retryWaitingSoon() }, DIRECT_RETRY)
    if (this._waitingTimer.unref) this._waitingTimer.unref()
    this.discovery = this.swarm.join(this.topic, { server: true, client: true })
    // Two devices that join at the same moment each look up before the other
    // has announced, and hyperswarm would otherwise only retry after minutes.
    let attempt = 0
    const lookup = () => {
      if (this.connections.size < Math.max(1, this.peers.size)) this.refreshDiscovery()
      this._lookupTimer = setTimeout(lookup, LOOKUP_DELAYS[Math.min(++attempt, LOOKUP_DELAYS.length - 1)])
    }
    this._lookupTimer = setTimeout(lookup, LOOKUP_DELAYS[0])

    // Left over from a run that stopped while adding a file: clear it.
    const activity = await this.drive.entry(ACTIVITY_KEY).catch(() => null)
    if (activity && activity.value.metadata && Array.isArray(activity.value.metadata.adding) && activity.value.metadata.adding.length) {
      this._announced = true
      this._announceSoon()
    }

    this._watch()
    const rescan = () => {
      this._timer = setTimeout(() => this.sync().finally(rescan), Math.max(RESCAN_INTERVAL, this._passMs * RESCAN_FACTOR))
    }
    rescan()
    const first = this.sync()
    this.swarm.flush().then(() => this.sync()).catch(() => {})
    if (wait) await first
  }

  // Re-announce and look up again. Never pass { client, server } here: hyperswarm
  // treats those as permanent mode changes, and server: false stops announcing
  // (a device that does not announce can find others but never be found).
  refreshDiscovery () {
    if (this.discovery && !this._closing) this.discovery.refresh().catch(() => {})
  }

  async close () {
    this._closing = true
    clearTimeout(this._timer)
    clearTimeout(this._lookupTimer)
    clearTimeout(this._pumpTimer)
    clearTimeout(this._readyTimer)
    clearTimeout(this._shareTimer)
    for (const job of this._jobs.values()) if (job.cancel) job.cancel()
    clearTimeout(this._soonTimer)
    clearTimeout(this._lengthsTimer)
    clearTimeout(this._announceTimer)
    clearTimeout(this._havesTimer)
    clearTimeout(this._retryTimer)
    clearInterval(this._waitingTimer)
    this.transfers.close()
    for (const conn of this.connections.values()) clearTimeout(conn.stallTimer)
    for (const dl of this._fetching.values()) dl.destroy()
    for (const w of this._watchers.values()) w.close()
    if (this._running) await this._running.catch(() => {})
    if (this.swarm) await this.swarm.destroy()
    if (this.store) await this.store.close()
  }

  // ---- networking -------------------------------------------------------

  _onconnection (socket, info) {
    const remote = b4a.toString(info.publicKey, 'hex')
    socket.on('error', () => {})
    // A device that went away without closing (killed, lost its network) must
    // not keep a dead connection that hides its next one.
    if (socket.setTimeout) socket.setTimeout(CONN_TIMEOUT)

    // Use our own muxer first so nothing is replicated before the peer
    // proves it knows the space secret. Hypercore reuses socket.userData.
    const mux = Protomux.from(socket)
    socket.userData = mux

    let authed = false
    let mine = null // this connection, once authenticated
    const timeout = setTimeout(() => { if (!authed) socket.destroy() }, AUTH_TIMEOUT)

    const channel = mux.createChannel({
      protocol: PROTOCOL,
      id: this.topic,
      onopen: () => {
        hello.send({
          proof: proof(this.secret, socket.handshakeHash, socket.isInitiator),
          name: this.deviceName,
          key: this.key,
          known: this._knownPeers(),
          ...this._lengths()
        })
      },
      onclose: () => {
        clearTimeout(timeout)
        if (mine) clearTimeout(mine.stallTimer)
        if (mine && this.connections.get(remote) === mine) this.connections.delete(remote) // not a newer one to the same device
        this.emit('change')
      }
    })
    if (!channel) return socket.destroy()

    // Direct transfers. Ignored until the peer has proven it knows the secret;
    // a peer that never opens it (older version) is never asked for files.
    const fx = { remote, opened: false, closed: false, reqs: new Map(), serving: new Map(), waiters: [], conn: null }
    const files = mux.createChannel({
      protocol: FILES_PROTOCOL,
      id: this.topic,
      onopen: () => { fx.opened = true; this._retryWaitingSoon() },
      ondrain: () => { for (const fn of fx.waiters.splice(0)) fn() },
      onclose: () => {
        fx.closed = true
        for (const fn of fx.waiters.splice(0)) fn()
        for (const r of [...fx.reqs.values()]) r.close()
        for (const job of fx.serving.values()) job.canceled = true
      }
    })
    if (files) {
      fx.req = files.addMessage({ encoding: c.json, onmessage: (m) => { if (fx.conn) this._serve(fx, m).catch((err) => this.emit('error-log', err)) } })
      fx.data = files.addMessage({ encoding: chunkEncoding, onmessage: (m) => { const r = fx.conn && fx.reqs.get(m.id); if (r) r.data(m) } })
      fx.end = files.addMessage({ encoding: c.json, onmessage: (m) => { const r = fx.conn && m && fx.reqs.get(m.id); if (r) r.end(m) } })
      fx.cancel = files.addMessage({ encoding: c.json, onmessage: (m) => { const job = m && fx.serving.get(m.id); if (job) job.canceled = true } })
    }

    const hello = channel.addMessage({
      encoding: c.json,
      // Must not return a promise: when a message arrives in a batch, Protomux
      // keeps the connection corked (all outgoing messages queued) until the
      // handlers' promises settle, and _learn waits on data from this same
      // connection (a peer drive's header). That deadlocked now and then.
      onmessage: (m) => {
        if (!m || typeof m !== 'object') return socket.destroy()
        if (!authed) {
          const expected = proof(this.secret, socket.handshakeHash, !socket.isInitiator)
          const got = b4a.from(typeof m?.proof === 'string' ? m.proof : '')
          if (got.byteLength !== expected.length || !crypto.timingSafeEqual(got, b4a.from(expected))) {
            return socket.destroy()
          }
          authed = true
          clearTimeout(timeout)
          const conn = { name: cleanName(m.name), keyHex: m.key, socket, stallTimer: null, send: (msg) => hello.send(msg), files: files ? fx : null }
          // Connections to an earlier run of this device (it restarted) are stale.
          for (const [r, c] of this.connections) if (r !== remote && c.keyHex === conn.keyHex) c.socket.destroy()
          this.connections.set(remote, conn)
          mine = conn
          fx.conn = conn
          this.store.replicate(socket)
          this._sendHaves(this.connections.get(remote))
        } else if (m.have && typeof m.have === 'object') {
          return this._onhaves(remote, m)
        }
        this._learn(m).then(() => this._watchReplication(remote, m), (err) => this.emit('error-log', err))
      }
    })

    channel.open()
    if (files) files.open()
  }

  _lengths () {
    return { length: this.drive.core.length, blobsLength: this.drive.blobs ? this.drive.blobs.core.length : 0 }
  }

  // Tell connected peers how far our drive is, so they can detect a stuck
  // replication session (see STALL_TIMEOUT).
  _announceLengths () {
    clearTimeout(this._lengthsTimer)
    this._lengthsTimer = setTimeout(() => {
      for (const conn of this.connections.values()) conn.send({ proof: '', key: this.key, name: this.deviceName, ...this._lengths() })
    }, 300)
  }

  _watchReplication (remote, m) {
    const conn = this.connections.get(remote)
    const peer = conn && this.peers.get(conn.keyHex)
    if (!peer || !Number.isSafeInteger(m.length)) return
    conn.length = Math.max(conn.length || 0, m.length)
    const progress = () => peer.drive.core.length + (peer.drive.blobs ? peer.drive.blobs.core.length : 0)
    const behind = () => peer.drive.core.length < m.length ||
      (Number.isSafeInteger(m.blobsLength) && peer.drive.blobs && peer.drive.blobs.core.length < m.blobsLength)
    clearTimeout(conn.stallTimer)
    if (!behind()) return
    // Only a session that makes no progress at all is stuck; slow is fine.
    let seen = progress()
    const check = () => {
      if (this._closing || this.connections.get(remote) !== conn || !behind()) return
      const now = progress()
      if (now > seen) {
        seen = now
        conn.stallTimer = setTimeout(check, STALL_TIMEOUT)
        return
      }
      this.emit('error-log', new Error(`replication with ${conn.name || conn.keyHex.slice(0, 8)} stalled; reconnecting`))
      this.stalls = (this.stalls || 0) + 1
      conn.socket.destroy()
      this.refreshDiscovery()
    }
    conn.stallTimer = setTimeout(check, STALL_TIMEOUT)
  }

  _knownPeers () {
    return [...this.peers].map(([keyHex, p]) => ({ key: keyHex, name: p.name }))
  }

  async _learn (m) {
    let added = false
    if (typeof m.key === 'string' && m.key !== this.key) added = (await this._addPeer(m.key, cleanName(m.name), true)) || added
    for (const p of Array.isArray(m.known) ? m.known.slice(0, 256) : []) {
      if (p && typeof p.key === 'string' && p.key !== this.key) added = (await this._addPeer(p.key, cleanName(p.name), false)) || added
    }
    if (added) {
      // Gossip so devices that never met directly still learn about each other.
      for (const conn of this.connections.values()) {
        conn.send({ proof: '', name: this.deviceName, key: this.key, known: this._knownPeers() })
      }
      await this._savePeers()
    }
    this.emit('change')
    this.sync()
  }

  async _addPeer (keyHex, name, seen) {
    if (!/^[0-9a-f]{64}$/.test(keyHex)) return false
    const existing = this.peers.get(keyHex)
    if (existing) {
      if (name) existing.name = name
      if (seen) existing.lastSeen = Date.now()
      return false
    }
    const drive = new Hyperdrive(this.store, b4a.from(keyHex, 'hex'))
    await drive.ready()
    drive.core.download({ start: 0, end: -1 }) // keep all metadata local, files on demand
    // 'append' fires before the new metadata blocks arrive; resync once they have.
    drive.core.on('append', () => this._soon())
    drive.core.on('download', () => this._soon())
    drive.getBlobs().then((blobs) => {
      blobs.core.on('download', (index, byteLength, from) => {
        this._ondownload(keyHex, index, byteLength, from)
        this._soon(1000) // finished fetches resync right away (see _available)
      })
      // Devices also pass on each other's files.
      blobs.core.on('upload', (index, byteLength, from) => this._onupload(keyHex, index, byteLength, from))
      this._soon()
    }, () => {})
    this.peers.set(keyHex, { drive, name: name || keyHex.slice(0, 8), lastSeen: seen ? Date.now() : 0 })
    return true
  }

  async _savePeers () {
    const out = {}
    for (const [k, p] of this.peers) out[k] = { name: p.name, lastSeen: p.lastSeen }
    await this._writeJSON('peers.json', out)
  }

  // ---- sync loop --------------------------------------------------------

  // Runs a sync within `delay` ms. Never postpones one already scheduled:
  // events that keep coming (blocks of a big download) must not starve it.
  _soon (delay = 100) {
    const due = Date.now() + delay
    if (this._soonTimer && this._soonDue <= due) return
    clearTimeout(this._soonTimer)
    this._soonDue = due
    this._soonTimer = setTimeout(() => {
      this._soonTimer = null
      this.sync()
    }, delay)
  }

  // Stops scanning and writing the folder (e.g. Android revoked storage
  // access, so the folder only looks partly empty). Networking keeps running.
  setPaused (reason) {
    if (reason === this._paused) return
    this._paused = reason || null
    if (this._paused) {
      this.status = { phase: 'error', lastSync: this.status.lastSync, error: this._paused }
      this.emit('change')
    } else {
      this.sync()
    }
  }

  // Serialized: at most one cycle runs; requests during a cycle rerun it once.
  // A full pass: read every drive, scan the folder, merge every path.
  // Serialized: at most one pass runs; requests during a pass rerun it once.
  sync () {
    if (this._closing) return Promise.resolve()
    this._fullWanted = true
    return this._loop()
  }

  // Between full passes, direct downloads that finished are moved into place
  // right away (a full pass over a big drive can take a while).
  _loop () {
    if (this._running) return this._running
    this._running = (async () => {
      while (!this._closing && (this._fullWanted || this._ready.size)) {
        if (!this._fullWanted) {
          const paths = [...this._ready]
          this._ready.clear()
          await this._mergeSome(paths).catch((err) => this.emit('error-log', err))
          continue
        }
        this._fullWanted = false
        this._again = false
        this._ready.clear() // the full pass handles them
        if (this._paused) {
          this.status = { phase: 'error', lastSync: this.status.lastSync, error: this._paused }
          this.emit('change')
          break
        }
        const began = Date.now()
        try {
          this.status.phase = 'syncing'
          this.emit('change')
          await this._checkFolder()
          await this._collect()
          // A drive just joined: files already in its folder are matched with
          // the drive's files once the whole list is here, not published as new.
          const published = this.listed ? await this._scan() : false
          this._indexHashes()
          if (published) await this._collect() // our own new entries (others' changes trigger another pass)
          await this._merge()
          this._indexHashes()
          this._shareHaves()
          this._passMs = Date.now() - began
          this.status = { phase: 'idle', lastSync: Date.now(), error: null }
        } catch (err) {
          this.status = { phase: 'error', lastSync: this.status.lastSync, error: err.message }
          this.emit('error-log', err)
        }
        this.emit('change')
        if (this._again) this._fullWanted = true
      }
    })().finally(() => { this._running = null })
    return this._running
  }

  // Merges a few paths with the view of the last full pass.
  async _mergeSome (paths) {
    if (this._paused || this.hold) return
    let dirty = false
    for (const p of paths) {
      if (!this.view.has(p)) continue
      const pending = new Set()
      try {
        if (await this._mergePath(p, pending)) dirty = true
        this.failed.delete(p)
      } catch (err) {
        this._fullWanted = true // the full pass reports it (or moves a blocking file aside)
        continue
      }
      if (!pending.has(p) && this.pending.delete(p)) this._pendingRev++
      for (const q of pending) if (!this.pending.has(q)) { this.pending.add(q); this._pendingRev++ }
    }
    if (this._indexDirty) { this._indexDirty = false; dirty = true }
    if (dirty) await this._writeJSON('index.json', this.index)
    if (this._again) this._fullWanted = true
    this._shareHavesSoon()
    this.emit('change')
  }

  _readySoon () {
    if (this._readyTimer || this._closing) return
    this._readyTimer = setTimeout(() => { this._readyTimer = null; this._loop() }, 100)
  }

  _shareHavesSoon () {
    if (this._shareTimer || this._closing) return
    this._shareTimer = setTimeout(() => { this._shareTimer = null; this._shareHaves() }, 2000)
  }

  // Reads every drive into the merged view. Only what changed since the last
  // pass is read (a diff between versions); the view is rebuilt, in path
  // order, only when something changed.
  async _collect () {
    const drives = [[this.key, this.drive], ...[...this.peers].map(([k, p]) => [k, p.drive])]
    const collected = new Map()
    let changed = !this._lists
    if (!this._lists) this._lists = new Map() // keyHex -> { drive, length, entries: Map(path -> version), record, activity }
    for (const [keyHex, drive] of drives) {
      let list = this._lists.get(keyHex)
      if (list && list.drive !== drive) list = null
      try {
        const length = Math.min(drive.core.length, drive.core.contiguousLength) // fully listed up to here
        if (list && list.length === length) { collected.set(keyHex, length); continue }
        const next = list || { drive, length: 0, entries: new Map(), record: null, activity: null }
        if (length > 0) {
          const snap = drive.checkout(length)
          try {
            if (list && list.length > 0 && list.length < length) {
              for await (const { left, right } of snap.diff(list.length, '/', { wait: false })) {
                await this._breathe()
                const node = left || right
                this._listEntry(next, keyHex, drive, node.key, left ? left.value : null)
              }
            } else {
              next.entries = new Map()
              for await (const entry of snap.list('/', { recursive: true, wait: false })) {
                await this._breathe()
                this._listEntry(next, keyHex, drive, entry.key, entry.value)
              }
            }
          } finally {
            await snap.close().catch(() => {})
          }
        }
        next.length = length
        this._lists.set(keyHex, next)
        collected.set(keyHex, length)
        changed = true
      } catch {
        // Peer metadata not downloaded yet; it will trigger another sync on append.
        if (list) collected.set(keyHex, list.length) // keep its last complete listing
      }
    }
    for (const keyHex of [...this._lists.keys()]) if (!drives.some(([k]) => k === keyHex)) { this._lists.delete(keyHex); changed = true }
    this._collected = collected
    if (changed) {
      const view = new Map()
      for (const list of this._lists.values()) {
        for (const [p, v] of list.entries) {
          const vs = view.get(p)
          if (vs) vs.push(v)
          else view.set(p, [v])
          if (view.size % 4096 === 0) await this._breathe()
        }
      }
      this.view = new Map([...view].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      this._ranges = null
    }
    const records = []
    const activity = []
    for (const [keyHex, list] of this._lists) {
      if (list.record) records.push([keyHex, list.record])
      if (list.activity && keyHex !== this.key) activity.push([keyHex, list.activity])
    }
    await this._applySelections(records)
    this._applyActivity(activity)
    if (!this.listed && this._listing().ready) {
      this.listed = true
      this.emit('listed')
      this.emit('change')
    }
  }

  _listEntry (list, keyHex, drive, key, value) {
    if (key === SELECTION_KEY) { list.record = value ? value.metadata : null; return }
    if (key === ACTIVITY_KEY) { list.activity = value ? value.metadata : null; return }
    const meta = value && value.metadata
    if (!value || !validEntry(key, meta)) { list.entries.delete(key); return }
    const vv = meta.vv || { [deviceId(keyHex)]: meta.clock }
    list.entries.set(key, { keyHex, path: key, meta, vv, blob: value.blob, drive })
  }

  // ---- files other devices are still adding --------------------------------

  // Shows other devices' big files that are not in their drive yet as
  // waiting downloads ("being prepared on <device> · 40%").
  _applyActivity (records) {
    const online = new Set([...this.connections.values()].map((c) => c.keyHex))
    const seen = new Set()
    for (const [writer, meta] of records) {
      if (!online.has(writer) || !meta || !Array.isArray(meta.adding)) continue // offline: it will tell again
      for (const f of meta.adding.slice(0, 100)) {
        if (!f || !validPath(f.path) || this.isExcluded(f.path)) continue
        const id = 'prep:' + writer + f.path
        // Already published: the real download takes over.
        if (this.pending.has(f.path) && [...this.transfers.items.values()].some((t) => t.dir === 'down' && t.path === f.path && !t.id.startsWith('prep:') && !t.finished)) continue
        seen.add(id)
        const size = Math.max(0, Number(f.size) || 0)
        const preparing = Math.max(0, Math.min(99, Math.floor(Number(f.percent) || 0)))
        const t = this.transfers.get(id)
        if (!t) this.transfers.start(id, { dir: 'down', state: 'waiting', path: f.path, device: this._name(writer), size, preparing, online: true })
        else if (t.preparing !== preparing || t.size !== size) this.transfers.set(t, { preparing, size })
      }
    }
    for (const id of [...this.transfers.items.keys()]) if (id.startsWith('prep:') && !seen.has(id)) this.transfers.drop(id)
  }

  // ---- where each file is --------------------------------------------------

  _log (p, text) {
    let list = this.activity.get(p)
    if (list && list.length && list[list.length - 1].text === text) return
    if (!list) {
      if (this.activity.size >= ACTIVITY_PATHS) this.activity.delete(this.activity.keys().next().value)
      list = []
      this.activity.set(p, list)
    }
    list.push({ at: Date.now(), text })
    if (list.length > ACTIVITY_PER_FILE) list.shift()
  }

  // Files this device has, minus the ones it published itself: the others
  // know the author has its own version (a big drive would mean a huge list).
  _haveNow () {
    const out = new Map()
    for (const [p, idx] of Object.entries(this.index)) {
      if (!idx.hash) continue
      if (this._mineWins(p, idx.hash)) continue
      out.set(p, idx.hash.slice(0, HAVE_HASH))
    }
    return out
  }

  // Whether the current version of p is this device's own, with this content:
  // the others then know it has it (see _elsewhere) without being told.
  // Another device's version with the same content still has to be told.
  _mineWins (p, hash) {
    const vs = this.view.get(p)
    if (!vs || !vs.some((v) => v.keyHex === this.key && v.meta.hash === hash)) return false
    const winner = vs.length === 1 ? vs[0] : this._resolve(p).winner
    return !!winner && winner.keyHex === this.key && winner.meta.hash === hash
  }

  async _breathe () {
    if (Date.now() - this._breath < BREATHE_MS) return
    await new Promise((resolve) => setTimeout(resolve, 0))
    this._breath = Date.now()
  }

  // Everything we have, to a device that just connected.
  _sendHaves (conn) {
    const now = this._haveNow()
    const entries = [...now]
    for (let i = 0; i === 0 || i < entries.length; i += HAVE_CHUNK) {
      conn.send({ proof: '', key: this.key, name: this.deviceName, ...this._lengths(), reset: i === 0, have: Object.fromEntries(entries.slice(i, i + HAVE_CHUNK)) })
    }
    if (!this._told) this._told = now
  }

  // What changed since the last pass, to every connected device.
  _shareHaves () {
    const now = this._haveNow()
    const before = this._told || new Map()
    this._told = now
    if (!this.connections.size) return
    const diff = []
    for (const [p, h] of now) if (before.get(p) !== h) diff.push([p, h])
    for (const p of before.keys()) if (!now.has(p)) diff.push([p, ''])
    for (let i = 0; i < diff.length; i += HAVE_CHUNK) {
      const msg = { proof: '', key: this.key, name: this.deviceName, ...this._lengths(), have: Object.fromEntries(diff.slice(i, i + HAVE_CHUNK)) }
      for (const conn of this.connections.values()) conn.send(msg)
    }
  }

  _onhaves (remote, m) {
    const conn = this.connections.get(remote)
    if (!conn || !/^[0-9a-f]{64}$/.test(conn.keyHex || '')) return
    let list = this.haves.get(conn.keyHex)
    if (!list || m.reset) {
      list = new Map()
      this.haves.set(conn.keyHex, list)
    }
    let fresh = false
    for (const [p, h] of Object.entries(m.have).slice(0, HAVE_CHUNK)) {
      if (!validPath(p) || typeof h !== 'string' || h.length > 64) continue
      if (!h) { list.delete(p); continue }
      if (!m.reset && list.get(p) !== h && this.index[p] && this.index[p].hash.startsWith(h)) this._log(p, `Arrived on ${conn.name}`)
      if (list.get(p) !== h) fresh = true
      list.set(p, h)
    }
    if (fresh) this._retryWaitingSoon()
    // Their lengths ride along: keep stall detection fed.
    this._watchReplication(remote, m)
    clearTimeout(this._havesTimer)
    this._havesTimer = setTimeout(() => {
      const out = {}
      for (const [k, l] of this.haves) out[k] = Object.fromEntries(l)
      this._writeJSON('haves.json', out).catch(() => {})
    }, 5000)
    this.transfers.changed()
    this._pumpSoon()
  }

  // A device just said it has files: downloads waiting for a device that has
  // them try again now, not on the next pass.
  _retryWaitingSoon () {
    if (this._retryTimer || this._closing) return
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      for (const job of this._jobs.values()) {
        if (job.state !== 'idle' || job.queued || job.retryAt > Date.now() || !this._sources(job.version, job).length) continue
        job.queued = true
        this._queue.push(job)
      }
      this._pumpSoon()
    }, 200)
  }

  // Another device says it has this version of p.
  _elsewhere (p, hash) {
    const { winner } = this._resolve(p)
    if (winner && winner.keyHex !== this.key && winner.meta.hash === hash) return true // its author (see _haveNow)
    const h = hash.slice(0, HAVE_HASH)
    for (const has of this.haves.values()) if (has.get(p) === h) return true
    return false
  }

  _jobFor (p) {
    for (const job of this._jobs.values()) if (job.target === p) return job
    return null
  }

  // Where a file is: on this device, and on each other device of the drive.
  details (p) {
    const { winner } = this._resolve(p)
    const idx = this.index[p]
    const live = winner && !winner.meta.deleted ? winner : null
    const hash = live ? live.meta.hash : idx ? idx.hash : null
    const h = hash ? hash.slice(0, HAVE_HASH) : null
    const xs = this.transfers.list().filter((t) => t.path === p)
    const open = xs.filter((t) => t.state !== 'done' && t.state !== 'failed')
    const now = Date.now()

    let here
    const add = open.find((t) => t.dir === 'add')
    const down = open.find((t) => t.dir === 'down')
    if (add && add.passes === 1) {
      here = { state: 'adding', percent: add.percent, text: `Reading the file to check it · ${add.percent}%` }
    } else if (add) {
      const pct = add.stage === 'hashing' ? Math.min(99, add.percent * 2) : Math.max(0, add.percent * 2 - 100)
      here = { state: 'adding', percent: pct, text: add.stage === 'hashing' ? `Reading the file to check it (step 1 of 2) · ${pct}%` : `Storing it in the drive so other devices can download it (step 2 of 2) · ${pct}%` }
    } else if (down && down.preparing != null) {
      here = { state: 'waiting', percent: down.preparing, text: `${down.device} is still preparing it (${down.preparing}%). The download starts when it is done.` }
    } else if (down && down.state === 'saving') {
      here = { state: 'saving', percent: 100, text: 'Downloaded. Checking it and saving it to the folder…' }
    } else if (down && (down.state === 'active' || down.bytes) && down.speed) {
      here = { state: 'downloading', percent: down.percent, speed: down.speed, eta: down.eta, bytes: down.bytes, size: down.size, via: down.via, text: `Downloading from ${down.source || down.device}` }
    } else if (down) {
      const owner = this.peers.get(down.owner)
      const on = [...this.connections.values()].some((c) => c.keyHex === down.owner)
      // Any connected device that has it (not only the one that made this version).
      const job = this._jobFor(p)
      const [, src] = (job && this._sources(job.version, job)[0]) || []
      const text = (src ? `${src.name} has it: the download starts shortly`
        : !this.connections.size ? 'Waiting for another device of this drive to come online'
          : on ? `Waiting for ${down.device} to send it` : `Waiting for a device that has it to come online (${down.device} made this version)`) +
        (job && this.connections.size ? ` · ${this._whyNot(job)}` : '')
      here = { state: 'waiting', percent: down.percent, bytes: down.bytes, size: down.size, text, lastSeen: owner && owner.lastSeen }
    } else if (this.hold) {
      here = { state: 'waiting', text: 'Not downloaded: choose what to sync from this drive first' }
    } else if (this.failed.has(p)) {
      here = { state: 'failed', text: `Could not save it here: ${this.failed.get(p)}` }
    } else if (this.isExcluded(p)) {
      here = { state: 'online', text: 'Online only: not stored on this device. It opens from another device.' }
    } else if (this.pending.has(p) && this._jobFor(p)) {
      const job = this._jobFor(p)
      if (job.state === 'ready') here = { state: 'saving', percent: 100, text: 'Downloaded and checked. Saving it to the folder…' }
      else if (this._sources(job.version).length) here = { state: 'waiting', text: `Queued: ${DIRECT_PARALLEL} files are downloaded at a time` }
      else here = { state: 'waiting', text: !this.connections.size ? 'Waiting for another device of this drive to come online' : 'Waiting for a device that has it to come online' }
    } else if (this.pending.has(p)) {
      here = { state: 'waiting', text: 'Waiting for a device that has it to come online' }
    } else if (idx && hash && idx.hash === hash) {
      here = { state: 'synced', text: 'On this device, up to date' }
    } else if (idx) {
      here = { state: 'pending', text: 'Changed on this device; it is sent on the next scan' }
    } else if (!live) {
      here = { state: 'new', text: 'New on this device; it is added on the next scan' }
    } else {
      here = { state: 'waiting', text: 'Not downloaded yet' }
    }

    const online = new Map([...this.connections.values()].map((c) => [c.keyHex, c]))
    const devices = [...this.peers].map(([k, peer]) => {
      const base = { key: k, name: peer.name, online: online.has(k), lastSeen: peer.lastSeen || null, ...this._route(k) }
      const has = this.haves.get(k)
      const theirs = has && has.get(p)
      const up = open.find((t) => t.dir === 'up' && t.peer === k)
      const sel = this.selections.get(k)
      const excluded = sel && offBy(sel.excluded, p)
      if (!h) return { ...base, state: 'unknown', text: 'Not in the drive yet' }
      if ((live && live.keyHex === k) || (theirs && theirs === h)) return { ...base, state: 'synced', text: live && live.keyHex === k && !theirs ? 'Has it (it made this version)' : 'Has it, up to date' }
      if (up) return { ...base, state: 'receiving', percent: up.percent, speed: up.speed, eta: up.eta, bytes: up.bytes, size: up.size, text: 'Receiving it from this device' }
      if (excluded) return { ...base, state: 'online', text: 'Online only on that device (not stored there)' }
      const prep = add || (here.state === 'pending' || here.state === 'new')
      if (prep) return { ...base, state: 'waiting', text: 'Gets it once this device has finished adding it' }
      if (!base.online) return { ...base, state: 'offline', text: theirs ? 'Has an older version. Gets this one when it comes online' : 'Gets it when it comes online' }
      if (!has) return { ...base, state: 'unknown', text: 'Online, but it runs an older Syncker that does not report its files' }
      return { ...base, state: 'waiting', text: theirs ? 'Has an older version; downloading the new one should start soon' : 'Has not downloaded it yet' }
    })
    return {
      path: p,
      size: live ? live.meta.size : idx ? idx.size : null,
      mtime: live ? live.meta.mtime : idx ? idx.mtimeMs : null,
      author: live ? live.meta.device : null,
      hash,
      here,
      devices,
      activity: (this.activity.get(p) || []).slice().reverse(),
      at: now
    }
  }

  // Devices that have the current version of each path (for the file list).
  copies (p) {
    const { winner } = this._resolve(p)
    if (!winner || winner.meta.deleted) return null
    const h = winner.meta.hash.slice(0, HAVE_HASH)
    let have = 0
    const missing = []
    for (const [k, peer] of this.peers) {
      const has = this.haves.get(k)
      if (winner.keyHex === k || (has && has.get(p) === h)) { have++; continue }
      const sel = this.selections.get(k)
      if (sel && offBy(sel.excluded, p)) continue
      if (has) missing.push(peer.name)
    }
    return { have, missing }
  }

  _announceSoon () {
    if (this._announceTimer || this._closing) return
    this._announceTimer = setTimeout(() => {
      this._announceTimer = null
      this._announce().catch((err) => this.emit('error-log', err))
    }, ANNOUNCE_INTERVAL)
  }

  // Publishes the big files being added right now (sizes count both passes).
  async _announce () {
    if (this._closing) return
    const adding = this.transfers.list()
      .filter((t) => t.dir === 'add' && t.state === 'active' && t.size >= (t.passes || 2) * ANNOUNCE_MIN)
      .slice(0, 100)
      .map((t) => ({ path: t.path, size: Math.round(t.size / (t.passes || 2)), percent: t.percent }))
    if (adding.length || this._announced) await this.drive.putEntry(ACTIVITY_KEY, { blob: null, metadata: { adding } })
    this._announced = adding.length > 0
    if (adding.length) this._announceSoon()
  }

  // ---- selective sync set from any device ---------------------------------
  //
  // Every device publishes, in its own drive, what it wants each device of the
  // shared drive to keep online only: { target key: { excluded, clock } }. Per
  // target the record with the highest clock wins (then the writer's key), so
  // all devices agree, and offline devices catch up when they reconnect. A
  // device only follows records written by others while it allows it; that
  // flag is trusted only from the device's own drive.

  async _applySelections (records) {
    // This device's own record: what it holds in memory is newer than a listing
    // read while a change was being written. The first time, the saved record
    // is merged in (a choice made since then wins).
    const theirs = records.find(([w, meta]) => w === this.key && meta && typeof meta === 'object')
    if (!this._published && theirs) {
      for (const [k, r] of Object.entries(validSelection(theirs[1].selection))) if (!this._mine[k] || r.clock > this._mine[k].clock) this._mine[k] = r
    }
    records = records.filter(([w]) => w !== this.key)
    if (this._published || theirs) records.push([this.key, this._record()])
    const merged = new Map()
    const allow = new Map()
    for (const [writer, meta] of records) {
      if (!meta || typeof meta !== 'object') continue
      allow.set(writer, meta.allowRemote !== false)
      for (const [target, rec] of Object.entries(validSelection(meta.selection))) {
        const best = merged.get(target)
        if (!best || rec.clock > best.clock || (rec.clock === best.clock && writer > best.by)) merged.set(target, { ...rec, by: writer })
      }
    }
    // A device that does not allow remote changes: only its own record counts.
    for (const [target, rec] of merged) {
      if (rec.by === target || allow.get(target) !== false) continue
      const own = records.find(([w]) => w === target)
      const r = own && validSelection(own[1].selection)[target]
      if (r) merged.set(target, { ...r, by: target })
      else merged.delete(target)
    }
    for (const [target, rec] of merged) rec.allowRemote = allow.get(target) !== false
    this.selections = merged
    // A drive is direct once any device uses direct: everyone follows.
    if (!this.direct && (records.some(([, meta]) => meta && meta.direct === true) || (theirs && theirs[1].direct === true))) {
      this.direct = true
      this.emit('direct')
      if (this._published) await this._publishSelections()
    }

    const mine = merged.get(this.key)
    if (!this._published) {
      this._published = true
      // First run with this drive: tell the others what this device keeps
      // (local config wins over nothing; a newer remote choice wins below).
      if (!mine || !theirs || (theirs[1].allowRemote !== false) !== this.allowRemote || (theirs[1].direct === true) !== this.direct) {
        if (!mine) this._mine[this.key] = { excluded: this.excluded, clock: 1 }
        await this._publishSelections()
        return this._applySelections(records.filter(([w]) => w !== this.key).concat([[this.key, this._record()]]))
      }
    }
    if (!mine) return
    if (mine.by !== this.key && !this.allowRemote) return
    if (sameList(mine.excluded, this.excluded)) return
    this.excluded = mine.excluded
    this.emit('excluded', this.excluded, mine.by === this.key ? null : this._name(mine.by))
    this.emit('change')
  }

  _record () {
    return { selection: this._mine, allowRemote: this.allowRemote, device: this.deviceName, direct: this.direct }
  }

  async _publishSelections () {
    await this.drive.putEntry(SELECTION_KEY, { blob: null, metadata: this._record() })
  }

  _name (keyHex) {
    if (keyHex === this.key) return this.deviceName
    const p = this.peers.get(keyHex)
    return p ? p.name : keyHex.slice(0, 8)
  }

  // Sets what another device of the drive (or this one) keeps online only.
  async setSelection (target, list) {
    if (target === this.key) return this.setExcluded(list)
    if (!this.peers.has(target)) throw new Error('Unknown device')
    const cur = this.selections.get(target)
    if (cur && cur.allowRemote === false) throw new Error(`${this._name(target)} does not allow other devices to change what it syncs`)
    const excluded = normalizeExcluded(list)
    this._mine[target] = { excluded, clock: Math.min(MAX_CLOCK, (cur ? cur.clock : 0) + 1) }
    this.selections.set(target, { ...this._mine[target], by: this.key, allowRemote: true })
    await this._publishSelections()
    this.emit('change')
  }

  async setAllowRemote (allow) {
    this.allowRemote = !!allow
    // Locking keeps what this device syncs right now (possibly set remotely):
    // record it as this device's own choice, or the older own one would win.
    const cur = this.selections.get(this.key)
    this._mine[this.key] = { excluded: this.excluded, clock: Math.min(MAX_CLOCK, (cur ? cur.clock : 0) + 1) }
    this.selections.set(this.key, { ...this._mine[this.key], by: this.key, allowRemote: this.allowRemote })
    await this._publishSelections()
    this.emit('change')
  }

  _maxClock (p) {
    let max = 0
    for (const v of this.view.get(p) || []) max = Math.max(max, v.meta.clock)
    return max
  }

  _nextClock (p) {
    return Math.min(this._maxClock(p) + 1, MAX_CLOCK)
  }

  // vv for a new local version of p, replacing what this device had on disk.
  _nextVV (p, base) {
    const me = deviceId(this.key)
    const own = (this.view.get(p) || []).find((v) => v.keyHex === this.key)
    const counter = Math.min(Math.max(base[me] || 0, own ? own.vv[me] || 0 : 0) + 1, MAX_CLOCK)
    return { ...base, [me]: counter }
  }

  // Resolves the versions of p:
  //   winner:  the version to have on disk
  //   losers:  concurrent edits with other content (kept as conflict copies)
  //   deletes: concurrent deletes that lost to an edit
  _resolve (p) {
    const versions = this.view.get(p) || []
    const frontier = versions.filter((v) => !versions.some((w) => w !== v && covered(v.vv, w.vv) && !sameVV(v.vv, w.vv)))
    const live = frontier.filter((v) => !v.meta.deleted)
    const pick = (list) => list.reduce((best, v) => (!best || wins(v, best) ? v : best), null)
    if (live.length === 0) return { winner: pick(frontier), losers: [], deletes: frontier }
    const winner = pick(live)
    const losers = []
    for (const v of live) {
      if (v === winner || v.meta.hash === winner.meta.hash || losers.some((l) => l.meta.hash === v.meta.hash)) continue
      losers.push(v)
    }
    return { winner, losers, deletes: frontier.filter((v) => v.meta.deleted), frontier }
  }

  async _writeMarker () {
    const file = path.join(this.folder, MARKER)
    if (await fsp.stat(file).then(() => true, () => false)) return
    await fsp.writeFile(file, 'This folder is synced by Syncker. Do not delete this file.\n')
  }

  async _checkFolder () {
    let markerMissing = false
    try {
      await fsp.readdir(this.folder)
      markerMissing = !(await fsp.stat(path.join(this.folder, MARKER)).then(() => true, () => false))
    } catch (err) {
      throw new Error(`Folder unavailable (${err.code || err.message}): ${this.folder}. Sync is paused until it is back.`)
    }
    if (!markerMissing) return
    // Folders set up before the marker existed: adopt the folder if files we
    // synced are still in it (an empty mount point would not have them).
    for (const p of Object.keys(this.index)) {
      if (await fsp.stat(this._abs(p)).then(() => true, () => false)) return this._writeMarker()
    }
    if (Object.keys(this.index).length === 0) return this._writeMarker()
    throw new Error(`Folder unavailable (marker ${MARKER} missing): ${this.folder}. Sync is paused until it is back.`)
  }

  // Returns the files on disk plus the paths whose state is unknown
  // (unreadable folders or files), which must never be read as deletions.
  // Also lists the folders (for watching) and direct downloads in progress.
  async _walk (dir = this.folder, rel = '', out = { files: new Map(), unknown: [], dirs: [], parts: [] }) {
    let items
    try {
      items = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (dir === this.folder) throw err
      out.unknown.push(rel + '/')
      return out
    }
    out.dirs.push(dir)
    const files = []
    const subdirs = []
    for (const it of items) {
      if (ignored(it.name)) {
        if (it.name.startsWith(TMP_PREFIX) && it.name.endsWith(PART)) out.parts.push(path.join(dir, it.name))
        continue
      }
      if (this._ignore && this._ignore(it.name)) continue
      const abs = path.join(dir, it.name)
      const p = rel + '/' + it.name
      if (this._skip && this._skip.has(p)) continue
      if (it.isDirectory()) subdirs.push([abs, p])
      else if (it.isFile()) files.push([abs, p])
    }
    // A folder's files are checked in parallel (a big folder has many).
    for (let i = 0; i < files.length; i += WALK_PARALLEL) {
      await Promise.all(files.slice(i, i + WALK_PARALLEL).map(async ([abs, p]) => {
        try { out.files.set(p, await fsp.stat(abs)) } catch (err) {
          if (err.code !== 'ENOENT') out.unknown.push(p)
        }
      }))
    }
    for (const [abs, p] of subdirs) await this._walk(abs, p, out)
    return out
  }

  // Record local changes (new, modified, deleted files) into our drive.
  // Returns true if it published anything.
  async _scan () {
    const { files: disk, unknown, dirs, parts } = await this._walk()
    const isUnknown = (p) => unknown.some((u) => u.endsWith('/') ? p.startsWith(u) : p === u)
    let dirty = false
    let published = false
    let added = 0
    this._parts = parts
    this._watchDirs(dirs)

    for (const [p, st] of disk) {
      await this._breathe()
      const idx = this.index[p]
      if (idx && sameFile(idx, st) && !racy(idx)) {
        if (!idx.ino && st.ino) { idx.ino = st.ino; dirty = true } // index from before inodes were recorded
        continue
      }
      const abs = this._abs(p)
      let hash
      // Shown as "adding" in the UI: hashing, then (stored drives) copying into
      // the drive. size counts every pass.
      const passes = this.direct ? 1 : 2
      const t = this.transfers.start('add:' + p, { dir: 'add', path: p, device: this.deviceName, size: st.size * passes, passes, stage: 'hashing' })
      if (st.size >= ANNOUNCE_MIN) this._announceSoon()
      let read = 0
      try { hash = await hashFile(abs, (n) => { read += n; this.transfers.progress(t, n) }) } catch { this.transfers.drop(t.id); continue } // unreadable or vanished: try next pass
      const current = await fsp.stat(abs).catch(() => null)
      // Still being written (its mtime may not even tick): next pass.
      if (!current || current.mtimeMs !== st.mtimeMs || current.ino !== st.ino || current.size !== st.size || read !== st.size) { this.transfers.drop(t.id); continue }
      dirty = true
      if (idx && idx.hash === hash) {
        // Same content (touched, or racy and now verified): just refresh the record.
        this.index[p] = { ...idx, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, seenAt: Date.now() }
        this.transfers.drop(t.id)
        continue
      }

      const { winner } = this._resolve(p)
      if (!idx && winner && !winner.meta.deleted && winner.meta.hash === hash) {
        // Same content already in the space (e.g. copied in by hand on two devices).
        this.index[p] = { hash, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, vv: winner.vv, seenAt: Date.now() }
        this.transfers.finish(t.id)
        continue
      }
      // A file we never had is concurrent with whatever exists remotely (base {}),
      // except a deletion we know about: re-creating a deleted file replaces it.
      // An index entry from before version vectors: this device had seen every
      // version known at the time, so build on all of them.
      const legacy = () => mergeVV(...(this.view.get(p) || []).filter((v) => v.meta.vv === undefined).map((v) => v.vv))
      const base = idx ? this._seenVV(p, idx, legacy) : (winner && winner.meta.deleted ? mergeVV(...this._resolve(p).deletes.map((d) => d.vv)) : {})
      const vv = this._nextVV(p, base)
      // Recorded first: other devices ask for a direct file as soon as its entry arrives.
      this.index[p] = { hash, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, vv, seenAt: Date.now() }
      try {
        this.transfers.set(t, { stage: 'copying' })
        await this._publish(p, abs, { hash, size: st.size, mtime: st.mtimeMs, vv }, (n) => this.transfers.progress(t, n))
      } catch (err) {
        if (idx) this.index[p] = idx
        else delete this.index[p]
        this.transfers.drop(t.id)
        throw err
      }
      this.transfers.finish(t.id)
      published = true
      this._log(p, idx ? 'Changed on this device' : 'Added on this device')
      if (++added % INDEX_EVERY === 0) await this._writeJSON('index.json', this.index)
    }

    for (const p of Object.keys(this.index)) {
      await this._breathe()
      if (disk.has(p) || isUnknown(p) || this._ignoredPath(p)) continue // an ignore rule added later deletes nothing
      dirty = true
      const base = this._seenVV(p, this.index[p], () => mergeVV(...(this.view.get(p) || []).filter((v) => v.meta.vv === undefined).map((v) => v.vv)))
      delete this.index[p]
      await this.drive.putEntry(p, {
        blob: null,
        metadata: { vv: this._nextVV(p, base), clock: this._nextClock(p), deleted: true, mtime: Date.now(), device: this.deviceName }
      })
      published = true
    }

    if (dirty) await this._writeJSON('index.json', this.index)
    return published
  }

  // What this device has seen of p when it last had the file: its recorded
  // versions, plus every live version with the same content.
  _seenVV (p, idx, legacy) {
    const same = (this.view.get(p) || []).filter((v) => !v.meta.deleted && v.meta.hash === idx.hash).map((v) => v.vv)
    return mergeVV(idx.vv || legacy(), ...same)
  }

  async _publish (p, abs, { hash, size, mtime, vv }, onchunk = null) {
    const metadata = { vv, clock: this._nextClock(p), hash, size, mtime, device: this.deviceName }
    if (this.direct) return this.drive.putEntry(p, { blob: null, metadata: { ...metadata, direct: true } })
    const ws = this.drive.createWriteStream(p, { metadata })
    const rs = fs.createReadStream(abs)
    if (onchunk) rs.on('data', (d) => onchunk(d.byteLength))
    await pipeline(rs, ws)
  }

  // Publishes a conflict copy just written to cp. Every device that makes
  // this copy publishes it with the losing version's vv, so their copies are
  // one version: deleting the copy on any device deletes all of them.
  async _publishCopy (cp, v) {
    const st = await this._lstat(cp)
    if (!st || st.other) return
    this.index[cp] = { hash: v.meta.hash, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, vv: v.vv, seenAt: Date.now() }
    try {
      await this._publish(cp, this._abs(cp), { hash: v.meta.hash, size: st.size, mtime: st.mtimeMs, vv: v.vv })
    } catch (err) {
      delete this.index[cp] // the next scan publishes it as a new file
      throw err
    }
    this._log(cp, `Conflict copy of the version from ${v.meta.device || v.keyHex.slice(0, 8)}`)
  }

  // Bring the folder on disk in line with the merged view. Each path is
  // handled on its own: one path that cannot be written (name too long, a
  // folder where a file should go, ...) is reported and never blocks the rest.
  async _merge () {
    let dirty = false
    const pending = new Set()
    const failed = new Map()
    this._wanted = new Set()
    this._liveByHash = null

    for (const p of [...this.view.keys()]) {
      await this._breathe()
      try {
        if (await this._mergePath(p, pending)) dirty = true
      } catch (err) {
        if (err.code === 'ENOTDIR' && err.blocker && await this._yieldToFolder(err.blocker)) { this._again = true; continue }
        failed.set(p, err.code || err.message)
        this._log(p, `Could not save here (${err.code || err.message})`)
      }
    }

    if (pending.size !== this.pending.size || [...pending].some((p) => !this.pending.has(p))) this._pendingRev++ // the UI reloads its list on a change
    this.pending = pending
    this.failed = failed
    await this._dropStaleJobs()
    if (this._indexDirty) { this._indexDirty = false; dirty = true }
    const online = this.connections.size > 0
    for (const t of [...this.transfers.items.values()]) {
      if (t.dir !== 'down' || t.state === 'done' || t.id.startsWith('prep:') || t.direct) continue // direct: see _dropStaleJobs
      if (!pending.has(t.path)) this.transfers.drop(t.id) // superseded by a newer version
      else if (t.online !== online) this.transfers.set(t, { online })
    }
    if (dirty) await this._writeJSON('index.json', this.index)
  }

  async _mergePath (p, pending) {
    if (this.hold) return false
    if (this._ignoredPath(p)) return false
    if (this.isExcluded(p)) return this._dropLocal(p)
    const { winner, losers, deletes, frontier } = this._resolve(p)
    if (!winner) return false
    let dirty = false

    // Conflict copies first: a loser is only folded into what this device
    // "knows" once its copy exists, so a later edit can never bury it.
    const absorbed = [winner.vv, ...deletes.map((d) => d.vv)]
    // Versions with the same content as the winner (the same file added on two
    // devices) are all seen once it is here: a delete or edit replaces them all.
    for (const v of frontier || []) if (v !== winner && !v.meta.deleted && v.meta.hash === winner.meta.hash) absorbed.push(v.vv)
    for (const v of losers) {
      const cp = conflictName(p, v.meta.device || v.keyHex.slice(0, 8), v.meta.hash)
      if (this.view.has(cp) || this.index[cp] || await this._lexists(cp)) {
        absorbed.push(v.vv)
        continue
      }
      if (!(await this._available(v, cp))) { pending.add(cp); continue }
      if (await this._materialize(cp, v, { sourcePath: p, expect: null })) {
        absorbed.push(v.vv)
        await this._publishCopy(cp, v)
        dirty = true
      }
    }
    const known = mergeVV(...absorbed)

    const idx = this.index[p]
    // Already up to date (most paths, most of the time): nothing to check on disk.
    if (idx && !losers.length && !winner.meta.deleted && idx.hash === winner.meta.hash && idx.vv && sameVV(idx.vv, known)) return dirty
    // Direct: a losing version whose only copy is the file at p must reach its
    // conflict copy before p is overwritten.
    if (idx && losers.some((v) => v.meta.direct && v.meta.hash === idx.hash && !absorbed.includes(v.vv))) { pending.add(p); return dirty }
    const st = await this._lstat(p)
    if (st && st.other && !winner.meta.deleted) {
      // A local folder has this name: the folder keeps it, the file becomes a conflict copy.
      const cp = conflictName(p, winner.meta.device || winner.keyHex.slice(0, 8), winner.meta.hash)
      if (this.view.has(cp) || await this._lexists(cp)) return dirty
      if (!(await this._available(winner, cp))) { pending.add(cp); return dirty }
      if (await this._materialize(cp, winner, { sourcePath: p, expect: null })) this._again = true
      return dirty
    }
    if (!(await this._unchanged(p, idx, st))) return dirty // local change not scanned yet; the scan publishes it

    if (winner.meta.deleted) {
      if (!idx) return dirty
      // A move: the new path takes this file's content first (see _runJob).
      if (this._neededElsewhere(p, idx.hash)) return dirty
      await this._remove(p, st)
      delete this.index[p]
      return true
    }

    if (idx && idx.hash === winner.meta.hash) {
      if (!idx.vv || !sameVV(idx.vv, known)) {
        this.index[p] = { ...idx, vv: known }
        dirty = true
      }
      return dirty
    }
    if (!(await this._available(winner, p))) { pending.add(p); return dirty }
    if (await this._materialize(p, winner, { vv: known, expect: idx })) dirty = true
    return dirty
  }

  // ---- selective sync ---------------------------------------------------

  // Paths (a file, or a folder and everything under it; '/' is the whole
  // drive) kept online only on this device: listed, openable on demand,
  // never downloaded. Local copies already here are removed once they are
  // safely in the drive; that is never published as a deletion.
  setExcluded (list) {
    this.excluded = normalizeExcluded(list)
    const cur = this.selections.get(this.key)
    if (this.drive) {
      this._mine[this.key] = { excluded: this.excluded, clock: Math.min(MAX_CLOCK, (cur ? cur.clock : 0) + 1) }
      this.selections.set(this.key, { ...this._mine[this.key], by: this.key, allowRemote: this.allowRemote })
      // Publish before syncing: the sync re-reads the records and must see this one.
      return this._publishSelections().then(() => {
        this.emit('change')
        return this.sync()
      })
    }
    this.emit('change')
    return this.sync()
  }

  isExcluded (p) {
    if (this.hold) return true
    return offBy(this.excluded, p)
  }

  async _dropLocal (p) {
    const idx = this.index[p]
    if (!idx) return false // nothing synced here (a new local file is published by the scan first)
    const st = await this._lstat(p)
    if (!st || st.other) return false
    if (!(await this._unchanged(p, idx, st))) return false // unpublished local edit: the next scan publishes it first
    // Direct: this file may be the only copy of its version. Keep it until another device has it.
    const { winner } = this._resolve(p)
    if (winner && winner.meta.direct && winner.meta.hash === idx.hash && !this._elsewhere(p, idx.hash)) return false
    // Forget it before removing it: the scan must never see "synced file gone" (a deletion).
    delete this.index[p]
    await this._writeJSON('index.json', this.index)
    await this._remove(p, st)
    this._log(p, 'Removed from this device (online only)')
    return false
  }

  // How big the drive is. ready: every connected device's file list is fully
  // read (a drive just joined only knows its size once a device is online).
  size () {
    let files = 0
    let bytes = 0
    for (const it of this.entries()) { files++; bytes += it.size || 0 }
    return { files, bytes, ready: this._listing().ready }
  }

  // How much of the connected devices' file lists has been read. ready: all of it.
  _listing () {
    const conns = [...this.connections.values()].filter((c) => this.peers.has(c.keyHex))
    let have = 0
    let total = 0
    for (const c of conns) {
      const n = Number.isSafeInteger(c.length) ? c.length : 0
      total += n
      have += Math.min(n, this._collected.get(c.keyHex) || 0)
    }
    const ready = conns.length > 0 && conns.every((c) => Number.isSafeInteger(c.length) && (this._collected.get(c.keyHex) || 0) >= c.length)
    return { have, total, ready }
  }

  // Ends the hold of a drive just joined: syncs what is not excluded.
  release () {
    if (!this.hold) return
    this.hold = false
    this.emit('change')
    return this.sync()
  }

  // Files of the drive as other devices see them (including online-only ones).
  // Worked out once per view (a new view replaces the old one, it never changes).
  // Callers must not change the list.
  entries () {
    if (!this._entries || this._entries.view !== this.view) {
      const list = []
      for (const p of this.view.keys()) {
        const { winner } = this._resolve(p)
        if (winner && !winner.meta.deleted) list.push({ path: p, size: winner.meta.size, mtime: winner.meta.mtime, device: winner.meta.device })
      }
      this._entries = { view: this.view, list, dirs: null }
    }
    return this._entries.list
  }

  // One folder of entries(): its files, and its subfolders with their totals.
  dirEntries (dir) {
    const cache = this._entries && this._entries.view === this.view ? this._entries : (this.entries(), this._entries)
    if (!cache.dirs) {
      const dirs = new Map()
      const at = (d) => {
        let f = dirs.get(d)
        if (!f) dirs.set(d, (f = { files: [], folders: new Map() }))
        return f
      }
      for (const it of cache.list) {
        const parts = it.path.split('/') // ['', 'a', 'b', 'file']
        at(parts.slice(0, -1).join('/') || '/').files.push(it)
        let d = '/'
        for (let i = 1; i < parts.length - 1; i++) {
          const sub = (d === '/' ? '' : d) + '/' + parts[i]
          const folders = at(d).folders
          let f = folders.get(sub)
          if (!f) folders.set(sub, (f = { name: parts[i], path: sub, dir: true, size: 0, mtime: 0, files: 0 }))
          f.size += it.size || 0
          f.files++
          f.mtime = Math.max(f.mtime, it.mtime || 0)
          d = sub
        }
      }
      cache.dirs = dirs
    }
    return cache.dirs.get(dir) || { files: [], folders: new Map() }
  }

  // Everything under a folder: how much there is, and how much of it is here.
  folderInfo (dir) {
    const pre = dir === '/' ? '/' : dir + '/'
    const out = { files: 0, folders: 0, size: 0, mtime: 0, here: 0, hereSize: 0, online: this.isExcluded(dir) }
    for (const it of this.entries()) {
      if (!it.path.startsWith(pre)) continue
      out.files++
      out.size += it.size || 0
      out.mtime = Math.max(out.mtime, it.mtime || 0)
      if (this.index[it.path]) { out.here++; out.hereSize += it.size || 0 }
    }
    this.dirEntries(dir) // builds the map of folders
    for (const d of this._entries.dirs.keys()) if (d !== dir && d.startsWith(pre)) out.folders++
    return out
  }

  // Deletes a path (and everything under it) that is not on this device, e.g.
  // online-only. Like a local delete, a concurrent edit elsewhere wins.
  async deleteRemote (p) {
    if (this._running) await this._running.catch(() => {})
    let n = 0
    for (const it of this.entries()) {
      if (it.path !== p && !it.path.startsWith(p + '/')) continue
      if (this.index[it.path]) continue // a local copy: deleting the file on disk is the way
      const base = mergeVV(...this.view.get(it.path).map((v) => v.vv))
      await this.drive.putEntry(it.path, {
        blob: null,
        metadata: { vv: this._nextVV(it.path, base), clock: this._nextClock(it.path), deleted: true, mtime: Date.now(), device: this.deviceName }
      })
      n++
    }
    this.sync()
    return n
  }

  // Streams the current version of a file from the drive (fetched from other
  // devices as needed), for online-only files.
  openRemote (p) {
    const { winner } = this.view.has(p) ? this._resolve(p) : {}
    if (!winner || winner.meta.deleted) return null
    const author = [...this.connections.values()].some((c) => c.keyHex === winner.keyHex)
    if (winner.meta.direct || (!author && this._sources(winner).length)) return { size: winner.meta.size, stream: this._directStream(winner) }
    return { size: winner.meta.size, stream: winner.drive.createReadStream(p) }
  }

  // A stored version whose content only its (offline) author has in its sync
  // data, while a connected device has the same file on disk: fetch it from
  // that disk instead (a drive that was stored before it became direct).
  async _storedElsewhere (version) {
    const blob = version.blob
    if (!blob || blob.blockLength === 0) return false
    if ([...this.connections.values()].some((c) => c.keyHex === version.keyHex)) return false
    if (!this._sources(version).length) return false
    const blobs = version.drive.blobs
    return !(blobs && await blobs.core.has(blob.blockOffset, blob.blockOffset + blob.blockLength))
  }

  // True if the content of a version is stored locally. Otherwise start
  // fetching it in the background (the sync loop never waits on the network)
  // and resync when it lands.
  async _available (version, p) {
    if (version.meta.direct || this._jobs.has(directId(version, p))) return this._directReady(version, p)
    if (await this._storedElsewhere(version)) {
      const id = blobId(version)
      if (this._fetching.has(id)) { this._fetching.get(id).destroy(); this._fetching.delete(id) }
      this.transfers.drop(id) // its row as a stored download, waiting for the author
      return this._directReady(version, p)
    }
    const blob = version.blob
    if (!blob || blob.blockLength === 0) return true
    const blobs = version.drive.blobs
    const id = blobId(version)
    if (!blobs) {
      // blobs core still opening; its 'download' listener resyncs
      if (!this.transfers.get(id)) this._trackDownload(id, version, p, null)
      return false
    }
    const start = blob.blockOffset
    const end = start + blob.blockLength
    if (await blobs.core.has(start, end)) return true
    if (!this._fetching.has(id)) {
      const dl = blobs.core.download({ start, end })
      this._fetching.set(id, dl)
      let t = this.transfers.get(id)
      if (!t || t.state === 'done') t = this._trackDownload(id, version, p, blobs.core)
      else this._countHave(blobs.core, t).catch(() => {})
      dl.done().then(() => {
        if (t.state !== 'done') this.transfers.set(t, { state: 'saving', have: t.blocks, bytes: t.size })
        this._soon()
      }, () => {}).finally(() => this._fetching.delete(id))
    }
    return false
  }

  // ---- direct transfers ---------------------------------------------------
  //
  // A direct version is downloaded by a job into TMP_PREFIX<id>.part next to
  // its path, checked against the hash of the (signed) entry, and moved into
  // place by _materialize. Jobs run in the background, a few at a time; a
  // merge pass that no longer asks for a job drops it (see _dropStaleJobs).

  // True once the content of a direct version for target is downloaded and
  // checked. Throws like _materialize when target cannot be written (a file
  // where a folder should be: _merge resolves that).
  async _directReady (version, target) {
    const id = directId(version, target)
    if (this._wanted) this._wanted.add(id)
    let job = this._jobs.get(id)
    if (job && job.state === 'ready') return true
    await this._safeParents(target)
    if (!job) {
      const abs = this._abs(target)
      const tmp = path.join(path.dirname(abs), TMP_PREFIX + crypto.createHash('sha256').update(id).digest('hex').slice(0, 24) + PART)
      job = { id, target, tmp, hash: version.meta.hash, size: version.meta.size || 0, version, state: 'idle', retryAt: 0, failedFrom: new Map(), cancel: null, queued: false }
      this._jobs.set(id, job)
    }
    job.version = version
    if (job.state === 'idle' && !job.queued && job.retryAt <= Date.now()) {
      job.queued = true
      this._queue.push(job)
      this._pumpSoon()
    }
    return false
  }

  _pumpSoon () {
    if (this._pumpTimer || this._closing) return
    this._pumpTimer = setTimeout(() => { this._pumpTimer = null; this._pump() }, 0)
  }

  _pump () {
    while (this._activeJobs < DIRECT_PARALLEL && this._queueHead < this._queue.length && !this._closing) {
      const job = this._queue[this._queueHead++]
      if (this._queueHead > 1024 && this._queueHead * 2 > this._queue.length) {
        this._queue = this._queue.slice(this._queueHead)
        this._queueHead = 0
      }
      job.queued = false
      if (this._jobs.get(job.id) !== job || job.state !== 'idle') continue
      this._activeJobs++
      this._runJob(job).catch((err) => this.emit('error-log', err)).finally(() => { this._activeJobs--; this._pumpSoon() })
    }
  }

  async _runJob (job) {
    job.state = 'running'
    // Listed while it runs (queued ones show as pending: thousands of small files would flood the list).
    const v = job.version
    let t = this.transfers.get(job.id)
    if (!t || t.state === 'done') t = this.transfers.start(job.id, { dir: 'down', direct: true, path: job.target, device: v.meta.device || v.keyHex.slice(0, 8), owner: v.keyHex, size: job.size })
    try {
      await this._safeParents(job.target)
      await fsp.mkdir(path.dirname(job.tmp), { recursive: true })
      if (!(await this._fromLocal(job, t)) && !(await this._fromRemote(job, t))) return
      if (this._jobs.get(job.id) !== job) return
      job.state = 'ready'
      if (t) this.transfers.set(t, { state: 'saving', bytes: job.size })
      this._ready.add(job.version.path) // the path whose merge writes job.target
      this._readySoon()
    } catch (err) {
      if (job.state === 'running') job.state = 'idle'
      job.retryAt = Date.now() + DIRECT_RETRY_MIN
      if (err.code !== 'ECANCELED') this.emit('error-log', err)
    } finally {
      if (job.state === 'running') job.state = 'idle'
      if (this._jobs.get(job.id) !== job) await fsp.rm(job.tmp, { force: true }).catch(() => {}) // dropped while it ran
    }
  }

  // The same content is already on this device (a moved, copied or
  // duplicated file): take it from there instead of the network.
  async _fromLocal (job, t) {
    const src = await this._localSource(job.hash, null)
    if (!src) return false
    const idx = this.index[src.path]
    // Moved: its old path is deleted in the drive, so move the file itself.
    const { winner } = this.view.has(src.path) ? this._resolve(src.path) : {}
    const before = await fsp.lstat(src.abs).catch(() => null)
    if (winner && winner.meta.deleted && idx && before && await this._unchanged(src.path, idx)) {
      let moved = false
      try {
        await fsp.rename(src.abs, job.tmp)
        moved = true
      } catch {} // another file system: copy it
      if (moved) {
        // Someone may have put another file at that path since it was checked.
        const after = await fsp.lstat(job.tmp).catch(() => null)
        if (!after || after.ino !== before.ino || !sameFile(idx, after)) {
          if (!(await this._lexists(src.path))) await fsp.rename(job.tmp, src.abs).catch(() => {})
          else await fsp.rename(job.tmp, this._abs(conflictName(src.path, this.deviceName, b4a.toString(crypto.randomBytes(3), 'hex')))).catch(() => {})
          this._again = true
          return false
        }
        delete this.index[src.path]
        this._indexDirty = true
        await this._pruneDirs(path.dirname(src.abs))
        this._log(job.target, `Moved here from ${src.path}`)
        return true
      }
    }
    const h = crypto.createHash('sha256')
    const rs = fs.createReadStream(src.abs)
    rs.on('data', (d) => { h.update(d); if (t) this.transfers.progress(t, d.byteLength, 0) })
    await pipeline(rs, fs.createWriteStream(job.tmp))
    if (h.digest('hex') !== job.hash) { await fsp.rm(job.tmp, { force: true }); return false } // changed meanwhile
    if (t) this.transfers.set(t, { source: this.deviceName + ' (copied from ' + src.path + ')' })
    return true
  }

  // Devices that can send a version: its author, and any device that says it has it.
  _sources (version, job = null) {
    const h = version.meta.hash.slice(0, HAVE_HASH)
    const now = Date.now()
    const out = []
    for (const [remote, conn] of this.connections) {
      if (!conn.files || !conn.files.opened || conn.files.closed) continue
      const has = this.haves.get(conn.keyHex)
      if (conn.keyHex !== version.keyHex && !(has && has.get(version.path) === h)) continue
      const f = job && job.failedFrom.get(conn.keyHex)
      if (f && now < f.until) continue
      out.push([remote, conn])
    }
    // Prefer the local network, then the device with the fewest requests going.
    const rank = ([remote, conn]) => (this._via(remote) === 'lan' ? 0 : 1000) + conn.files.reqs.size
    return out.sort((a, b) => rank(a) - rank(b))
  }

  // Why each connected device is not asked for a job's file (shown in its details).
  _whyNot (job) {
    const h = job.version.meta.hash.slice(0, HAVE_HASH)
    const now = Date.now()
    return [...this.connections.values()].map((c) => {
      const has = this.haves.get(c.keyHex)
      const f = job.failedFrom.get(c.keyHex)
      const why = !c.files ? 'no transfer channel'
        : !c.files.opened ? 'transfer channel not open yet'
          : c.files.closed ? 'transfer channel closed'
            : c.keyHex !== job.version.keyHex && !(has && has.get(job.version.path) === h) ? (has && has.get(job.version.path) ? 'has another version' : 'does not have it')
              : f && now < f.until ? `failed ${f.n}×, retrying in ${Math.ceil((f.until - now) / 1000)} s`
                : `can send it (download ${job.state}${job.queued ? ', queued' : ''}, ${this._activeJobs}/${DIRECT_PARALLEL} running)`
      return `${c.name}: ${why}`
    }).join('; ')
  }

  async _fromRemote (job, t) {
    const [remote, conn] = this._sources(job.version, job)[0] || []
    if (!conn) {
      if (t) this.transfers.set(t, { state: 'waiting' })
      return false // asked again on the next pass
    }
    if (t) this.transfers.set(t, { source: conn.name, remote, via: this._via(remote) })
    // Resume: hash what an earlier attempt already got.
    const h = crypto.createHash('sha256')
    let start = 0
    const st = await fsp.stat(job.tmp).catch(() => null)
    if (st && st.size <= job.size) {
      for await (const d of fs.createReadStream(job.tmp)) h.update(d)
      start = st.size
      if (t) this.transfers.set(t, { bytes: start })
    }
    let got
    try {
      got = await this._fetch(conn, job, start, (d) => { h.update(d); if (t) this.transfers.progress(t, d.byteLength, 0) })
    } catch (err) {
      this._failedFrom(job, conn)
      throw err
    }
    if (got !== job.size || h.digest('hex') !== job.hash) {
      // Changed on that device while it was sent: it gets a new version soon.
      await fsp.rm(job.tmp, { force: true })
      this._failedFrom(job, conn)
      this._log(job.target, `${conn.name} sent a different version than expected, retrying`)
      throw Object.assign(new Error('direct transfer did not match its hash: ' + job.target), { code: 'EMISMATCH' })
    }
    return true
  }

  _failedFrom (job, conn) {
    const n = ((job.failedFrom.get(conn.keyHex) || {}).n || 0) + 1
    job.failedFrom.set(conn.keyHex, { n, until: Date.now() + Math.min(DIRECT_RETRY, DIRECT_RETRY_MIN * 2 ** (n - 1)) })
    const timer = setTimeout(() => this._soon(), Math.min(DIRECT_RETRY, DIRECT_RETRY_MIN * 2 ** (n - 1)) + 50) // ask again then
    if (timer.unref) timer.unref()
  }

  // Requests a file from start on and appends it to job.tmp. Resolves with
  // the size of job.tmp once the sender is done.
  _fetch (conn, job, start, ondata) {
    const fx = conn.files
    const id = ++this._reqSeq
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(job.tmp, { flags: start ? 'a' : 'w' })
      let offset = start
      let settled = false
      let idle = null
      const kick = () => { clearTimeout(idle); idle = setTimeout(() => finish(Object.assign(new Error('direct transfer stalled'), { code: 'ESTALLED' }), true), DIRECT_IDLE) }
      const finish = (err, tell = false) => {
        if (settled) return
        settled = true
        clearTimeout(idle)
        fx.reqs.delete(id)
        job.cancel = null
        if (tell && !fx.closed) fx.cancel.send({ id })
        ws.on('close', () => err ? reject(err) : resolve(offset))
        ws.end()
      }
      ws.on('error', (err) => finish(err, true))
      fx.reqs.set(id, {
        data: (m) => {
          if (settled) return
          if (m.offset !== offset || offset + m.data.byteLength > job.size) return finish(new Error('direct transfer out of order'), true)
          ws.write(m.data)
          offset += m.data.byteLength
          ondata(m.data)
          kick()
        },
        end: (m) => finish(m.error ? Object.assign(new Error(`${conn.name}: ${String(m.error).slice(0, 64)}`), { code: 'EREMOTE' }) : null),
        close: () => finish(Object.assign(new Error('connection closed'), { code: 'ECLOSED' }))
      })
      job.cancel = () => finish(Object.assign(new Error('canceled'), { code: 'ECANCELED' }), true)
      kick()
      fx.req.send({ id, hash: job.hash, path: job.version.path, start })
    })
  }

  // An online-only direct file, streamed from a device that has it (checked
  // at the end: a mismatch ends the stream with an error).
  _directStream (version) {
    const out = new PassThrough()
    const [, conn] = this._sources(version)[0] || []
    if (!conn) {
      setTimeout(() => out.destroy(new Error('no device that has this file is online')), 0)
      return out
    }
    const fx = conn.files
    const id = ++this._reqSeq
    const h = crypto.createHash('sha256')
    let offset = 0
    const done = (err) => { fx.reqs.delete(id); if (err) out.destroy(err); else out.end() }
    fx.reqs.set(id, {
      data: (m) => {
        if (m.offset !== offset) return done(new Error('direct transfer out of order'))
        offset += m.data.byteLength
        h.update(m.data)
        out.write(m.data)
      },
      end: (m) => done(m.error ? new Error(`${conn.name}: ${String(m.error).slice(0, 64)}`) : offset !== version.meta.size || h.digest('hex') !== version.meta.hash ? new Error('the file changed while it was sent') : null),
      close: () => done(new Error('connection closed'))
    })
    out.on('close', () => { if (fx.reqs.has(id)) { fx.reqs.delete(id); if (!fx.closed) fx.cancel.send({ id }) } })
    fx.req.send({ id, hash: version.meta.hash, path: version.path, start: 0 })
    return out
  }

  // Sends a file another device asked for, from this device's folder.
  async _serve (fx, m) {
    if (!m || !Number.isSafeInteger(m.id) || m.id < 1) return
    if (typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/.test(m.hash) || !Number.isSafeInteger(m.start) || m.start < 0) return fx.end.send({ id: m.id, error: 'bad request' })
    if (fx.serving.size >= DIRECT_SERVE || fx.serving.has(m.id)) return fx.end.send({ id: m.id, error: 'busy' })
    const job = { canceled: false }
    fx.serving.set(m.id, job)
    try {
      const src = await this._localSource(m.hash, typeof m.path === 'string' ? m.path : null)
      if (!src) return fx.end.send({ id: m.id, error: 'not here' })
      if (m.start > src.size) return fx.end.send({ id: m.id, error: 'bad range' })
      const conn = fx.conn
      const t = src.size - m.start > 0
        ? this.transfers.start('up:' + conn.keyHex + ':' + m.id, { dir: 'up', path: src.path, device: conn.name, peer: conn.keyHex, via: this._via(fx.remote), size: src.size - m.start })
        : null
      let offset = m.start
      if (offset < src.size) {
        for await (const data of fs.createReadStream(src.abs, { start: offset })) {
          if (job.canceled || fx.closed) break
          if (!fx.data.send({ id: m.id, offset, data })) await new Promise((resolve) => fx.waiters.push(resolve))
          offset += data.byteLength
          if (t) this.transfers.progress(t, data.byteLength, 0)
        }
      }
      if (job.canceled || fx.closed) { if (t) this.transfers.drop(t.id); return }
      fx.end.send({ id: m.id })
      if (t) {
        this.transfers.finish(t.id)
        this._log(src.path, `Sent to ${conn.name}`)
      }
    } catch (err) {
      if (!fx.closed) fx.end.send({ id: m.id, error: 'read failed' })
    } finally {
      fx.serving.delete(m.id)
    }
  }

  // A file on this device with this content, unchanged since it was hashed
  // (path first). The receiver checks the hash again anyway.
  async _localSource (hash, p) {
    const cands = []
    if (p && validPath(p)) cands.push(p)
    for (const q of this._byHash.get(hash) || []) if (q !== p) cands.push(q)
    for (const q of cands) {
      const idx = this.index[q]
      if (!idx || idx.hash !== hash || this._ignoredPath(q)) continue
      const st = await this._lstat(q)
      if (st && !st.other && sameFile(idx, st)) return { path: q, abs: this._abs(q), size: st.size }
    }
    return null
  }

  _indexHashes () {
    const by = new Map()
    for (const [p, idx] of Object.entries(this.index)) {
      if (!idx.hash) continue
      const list = by.get(idx.hash)
      if (list) list.push(p)
      else by.set(idx.hash, [p])
    }
    this._byHash = by
  }

  // Is a file's content about to be taken by another path (a move)? Then its
  // deletion waits until that path has it.
  _neededElsewhere (p, hash) {
    if (!this._liveByHash) {
      this._liveByHash = new Map()
      for (const q of this.view.keys()) {
        const { winner } = this._resolve(q)
        if (!winner || winner.meta.deleted || !winner.meta.direct) continue
        if (!this._liveByHash.has(winner.meta.hash)) this._liveByHash.set(winner.meta.hash, [])
        this._liveByHash.get(winner.meta.hash).push(q)
      }
    }
    return (this._liveByHash.get(hash) || []).some((q) => q !== p && !(this.index[q] && this.index[q].hash === hash) &&
      !this.isExcluded(q) && !this._ignoredPath(q) && !this.failed.has(q))
  }

  // Jobs no merge pass asked for (superseded, excluded, deleted) and
  // leftover partial downloads on disk.
  async _dropStaleJobs () {
    const wanted = this._wanted
    this._wanted = null
    if (!wanted) return
    const keep = new Set()
    for (const [id, job] of [...this._jobs]) {
      if (wanted.has(id)) { keep.add(job.tmp); continue }
      this._jobs.delete(id)
      this.transfers.drop(id)
      if (job.cancel) job.cancel()
      if (job.state !== 'running') await fsp.rm(job.tmp, { force: true }).catch(() => {})
    }
    for (const part of this._parts) if (!keep.has(part)) await fsp.rm(part, { force: true }).catch(() => {})
    this._parts = []
  }

  // Ignored by a name rule or skipped by path (see the constructor).
  _ignoredPath (p) {
    if (!this._ignore && !this._skip) return false
    let i = 1
    while (i < p.length) {
      const j = p.indexOf('/', i)
      const seg = j < 0 ? p.slice(i) : p.slice(i, j)
      if (this._ignore && this._ignore(seg)) return true
      if (this._skip && this._skip.has(j < 0 ? p : p.slice(0, j))) return true
      if (j < 0) break
      i = j + 1
    }
    return false
  }

  // ---- transfer progress (UI only) ----------------------------------------

  _trackDownload (id, version, p, core) {
    const blob = version.blob
    const t = this.transfers.start(id, {
      dir: 'down',
      path: p,
      device: version.meta.device || version.keyHex.slice(0, 8),
      owner: version.keyHex,
      offset: blob.blockOffset,
      size: blob.byteLength,
      blocks: blob.blockLength,
      state: 'waiting'
    })
    if (core) this._countHave(core, t).catch(() => {})
    return t
  }

  // Blocks already stored (an interrupted download resumes where it was).
  async _countHave (core, t) {
    const STEP = 256
    let have = 0
    for (let i = t.offset; i < t.offset + t.blocks; i += STEP) {
      const end = Math.min(i + STEP, t.offset + t.blocks)
      if (await core.has(i, end)) { have += end - i; continue }
      for (let j = i; j < end; j++) if (await core.has(j)) have++
    }
    if (have > t.have) this.transfers.set(t, { have, bytes: Math.round(t.size * have / t.blocks) })
  }

  _ondownload (keyHex, index, byteLength, from) {
    const remote = from && from.remotePublicKey ? b4a.toString(from.remotePublicKey, 'hex') : ''
    for (const t of this.transfers.items.values()) {
      if (t.dir === 'down' && t.owner === keyHex && index >= t.offset && index < t.offset + t.blocks && t.state !== 'done') {
        if (remote && t.remote !== remote) {
          // Blocks can come from any device that has them, not only the author.
          const conn = this.connections.get(remote)
          t.remote = remote
          t.source = conn ? conn.name : t.device
          t.via = this._via(remote)
        }
        this.transfers.progress(t, byteLength)
      }
    }
  }

  _onupload (keyHex, index, byteLength, from) {
    const remote = from && from.remotePublicKey ? b4a.toString(from.remotePublicKey, 'hex') : ''
    const file = this._fileAt(keyHex, index)
    if (!file) return
    const id = 'up:' + remote + ':' + keyHex + ':' + file.offset
    let t = this.transfers.get(id)
    if (!t || t.state === 'done') {
      const conn = this.connections.get(remote)
      t = this.transfers.start(id, { dir: 'up', path: file.path, device: conn ? conn.name : remote.slice(0, 8), peer: conn ? conn.keyHex : null, via: this._via(remote), size: file.size, blocks: file.blocks })
    }
    this.transfers.progress(t, byteLength)
    if (t.have >= t.blocks) {
      this.transfers.finish(id)
      this._log(file.path, `Sent to ${t.device}`)
    }
  }

  // Which file a block of a drive's blob core belongs to (binary search).
  _fileAt (keyHex, index) {
    if (!this._ranges) {
      this._ranges = new Map()
      for (const [p, versions] of this.view) {
        for (const v of versions) {
          if (!v.blob || !v.blob.blockLength) continue
          if (!this._ranges.has(v.keyHex)) this._ranges.set(v.keyHex, [])
          this._ranges.get(v.keyHex).push({ path: p, offset: v.blob.blockOffset, blocks: v.blob.blockLength, size: v.blob.byteLength })
        }
      }
      for (const list of this._ranges.values()) list.sort((a, b) => a.offset - b.offset)
    }
    const list = this._ranges.get(keyHex)
    if (!list) return null
    let lo = 0
    let hi = list.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const r = list[mid]
      if (index < r.offset) hi = mid - 1
      else if (index >= r.offset + r.blocks) lo = mid + 1
      else return r
    }
    return null
  }

  // Writes a version to p (atomically, via a temp file). expect is the index
  // entry p was checked against (null: p must not exist); if p changes while
  // we download, the local change wins and nothing is overwritten.
  async _materialize (p, version, { sourcePath = p, vv = version.vv, expect = null } = {}) {
    const abs = this._abs(p)
    await this._safeParents(p)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    if (version.meta.direct || this._jobs.has(directId(version, p))) {
      // Already downloaded and checked by _runJob: move it into place.
      const id = directId(version, p)
      const job = this._jobs.get(id)
      if (!job || job.state !== 'ready') return false
      await keepTime(job.tmp, version)
      if (!(await this._unchanged(p, expect))) return false // the local change wins; the job is dropped once stale
      await fsp.rename(job.tmp, abs)
      this._jobs.delete(id)
      return this._materialized(p, version, id, version.meta.hash, sourcePath, vv)
    }
    const tmp = path.join(path.dirname(abs), TMP_PREFIX + b4a.toString(crypto.randomBytes(6), 'hex'))
    try {
      const rs = version.drive.createReadStream(sourcePath, { wait: false })
      const h = crypto.createHash('sha256')
      rs.on('data', (d) => h.update(d))
      await pipeline(rs, fs.createWriteStream(tmp))
      const hash = h.digest('hex')
      if (hash !== version.meta.hash) throw new Error('hash mismatch for ' + p)
      await keepTime(tmp, version)

      if (!(await this._unchanged(p, expect))) throw Object.assign(new Error('changed locally while downloading: ' + p), { code: 'ECHANGED' })
      await fsp.rename(tmp, abs)
      return this._materialized(p, version, blobId(version), hash, sourcePath, vv)
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      if (err.code === 'ECHANGED') return false
      this._log(p, /hash mismatch/.test(err.message) ? 'Download was corrupted, retrying' : 'Download interrupted, will retry')
      this.emit('error-log', err) // usually: owner offline and nobody else has the blob yet
      return false
    }
  }

  // Bookkeeping once a version is in place at p.
  async _materialized (p, version, id, hash, sourcePath, vv) {
    this.transfers.finish(id)
    if (sourcePath !== p) return true // a conflict copy: the scan publishes it as a local file
    const st = await fsp.stat(this._abs(p))
    this.index[p] = { hash, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, vv, seenAt: Date.now() }
    const t = this.transfers.get(id)
    this._log(p, `Downloaded from ${(t && t.source) || version.meta.device}`)
    this.emit('file', { path: p, from: version.meta.device })
    return true
  }

  // Never write or delete through a symlink inside the folder: it could point
  // anywhere on disk.
  async _safeParents (p) {
    const parts = p.split('/').slice(1, -1)
    let cur = this.folder
    for (const part of parts) {
      cur = path.join(cur, part)
      const st = await fsp.lstat(cur).catch(() => null)
      if (!st) return
      if (st.isSymbolicLink()) throw Object.assign(new Error('refusing to follow symlink ' + cur), { code: 'ESYMLINK' })
      if (!st.isDirectory()) throw Object.assign(new Error('a file is in the way: ' + cur), { code: 'ENOTDIR', blocker: '/' + path.relative(this.folder, cur).split(path.sep).join('/') })
    }
  }

  // A remote folder needs a name that is a file here: move our file aside to
  // the same conflict name the other devices give it, so everyone converges.
  async _yieldToFolder (q) {
    const idx = this.index[q]
    const st = await this._lstat(q)
    if (!idx || !st || st.other || !sameFile(idx, st)) return false
    const live = (this.view.get(q) || []).filter((v) => !v.meta.deleted)
    const mine = live.find((v) => v.meta.hash === idx.hash) || { meta: { device: this.deviceName }, keyHex: this.key }
    const cp = conflictName(q, mine.meta.device || mine.keyHex.slice(0, 8), idx.hash)
    if (await this._lexists(cp)) return false
    await fsp.rename(this._abs(q), this._abs(cp))
    return true // the next scan publishes the delete of q and the new copy
  }

  // Is p on disk exactly what idx recorded (or absent when idx is null)?
  async _unchanged (p, idx, st) {
    if (st === undefined) st = await this._lstat(p)
    if (!idx) return !st
    if (!st || st.other || !sameFile(idx, st)) return false
    if (!racy(idx)) return true
    try { return (await hashFile(this._abs(p))) === idx.hash } catch { return false }
  }

  async _lstat (p) {
    const st = await fsp.lstat(this._abs(p)).catch(() => null)
    return st && st.isFile() ? st : (st ? { size: -1, mtimeMs: -1, other: true } : null)
  }

  async _lexists (p) {
    return !!(await fsp.lstat(this._abs(p)).catch(() => null))
  }

  async _remove (p, st) {
    if (!st || st.other) return // not a plain file (folder, symlink): leave it alone
    await this._safeParents(p)
    const abs = this._abs(p)
    await fsp.rm(abs, { force: true })
    await this._pruneDirs(path.dirname(abs))
  }

  async _pruneDirs (dir) {
    while (dir.startsWith(this.folder + path.sep)) {
      try { await fsp.rmdir(dir) } catch { return }
      dir = path.dirname(dir)
    }
  }

  // ---- local fs ---------------------------------------------------------

  _watch () {
    let t = null
    this._kick = (_, name) => {
      if (name && (ignored(path.basename(name)) || (this._ignore && this._ignore(path.basename(name))))) return
      clearTimeout(t)
      t = setTimeout(() => this.sync(), 500)
    }
    this._watchDirs([this.folder]) // the rest after the first scan (see _watchDirs)
  }

  // Watches the folders of the last scan one by one (shallowest first).
  _watchDirs (dirs) {
    if (this._closing) return
    const depth = (d) => d.split(path.sep).length
    const want = new Set(dirs.length > MAX_WATCHED ? dirs.slice().sort((a, b) => depth(a) - depth(b)).slice(0, MAX_WATCHED) : dirs)
    for (const [d, w] of this._watchers) {
      if (want.has(d)) continue
      w.close()
      this._watchers.delete(d)
    }
    for (const d of want) {
      if (this._watchers.has(d)) continue
      try {
        const w = fs.watch(d, (ev, name) => this._kick(ev, name))
        w.on('error', () => {})
        this._watchers.set(d, w)
      } catch { break } // out of watches (inotify limit): the periodic rescan covers the rest
    }
  }

  _abs (p) {
    const abs = path.resolve(this.folder, '.' + p)
    if (abs !== this.folder && !abs.startsWith(this.folder + path.sep)) throw new Error('bad path: ' + p)
    return abs
  }

  // ---- history / info ---------------------------------------------------

  // All versions of a path across devices, newest first (for the UI).
  versions (p) {
    return (this.view.get(p) || [])
      .slice()
      .sort((a, b) => (wins(a, b) ? -1 : 1))
      .map((v) => ({ device: v.meta.device, deleted: !!v.meta.deleted, clock: v.meta.clock, size: v.meta.size, mtime: v.meta.mtime }))
  }

  info () {
    const online = new Set([...this.connections.values()].map((c) => c.keyHex))
    return {
      device: this.deviceName,
      key: this.key,
      folder: this.folder,
      status: this.status,
      pending: [...this.pending].slice(0, PENDING_LISTED),
      pendingCount: this.pending.size,
      pendingRev: this._pendingRev,
      failed: [...this.failed].map(([path, error]) => ({ path, error })),
      excluded: this.excluded,
      allowRemote: this.allowRemote,
      hold: this.hold ? this.size() : null,
      listed: this.listed,
      listing: this.listed ? null : { ...this._listing(), files: this.view.size, online: this.connections.size > 0 },
      selections: Object.fromEntries([...this.selections].map(([k, r]) => [k, { excluded: r.excluded, by: this._name(r.by), allowRemote: r.allowRemote }])),
      transfers: this.transfers.list(),
      speed: this.transfers.speeds(),
      totals: this._totals(),
      peers: [...this.peers].map(([k, p]) => ({ key: k, name: p.name, online: online.has(k), lastSeen: p.lastSeen, ...this._route(k) })),
      network: this._network(),
      direct: this.direct,
      ignore: this.ignore,
      skip: this.skip
    }
  }

  _via (remote) {
    const c = this.connections.get(remote)
    const raw = c && c.socket && c.socket.rawStream
    return raw && raw.remoteHost ? routeKind(raw.remoteHost) : null
  }

  // How a connected peer is reached right now (the stream can move to a better path).
  _route (keyHex) {
    for (const c of this.connections.values()) {
      const raw = c.keyHex === keyHex && c.socket && c.socket.rawStream
      if (raw && raw.remoteHost) return { address: raw.remoteHost + ':' + raw.remotePort, via: routeKind(raw.remoteHost) }
    }
    return {}
  }

  _totals () {
    let files = 0
    let bytes = 0
    for (const idx of Object.values(this.index)) { files++; bytes += idx.size || 0 }
    return { files, bytes }
  }

  // DHT reachability, for the UI and for debugging "devices never connect".
  _network () {
    const dht = this.swarm && this.swarm.dht
    if (!dht) return null
    return {
      online: !dht.destroyed && dht.bootstrapped !== false && dht.toArray().length > 0,
      nodes: dht.toArray().length,
      firewalled: dht.firewalled,
      host: dht.host || null,
      port: dht.port || null,
      connections: this.swarm.connections.size,
      connecting: this.swarm.connecting
    }
  }

  async _readJSON (name, fallback) {
    try { return JSON.parse(await fsp.readFile(path.join(this.home, name), 'utf8')) } catch { return fallback }
  }

  async _writeJSON (name, data) {
    const file = path.join(this.home, name)
    await fsp.writeFile(file + '.tmp', JSON.stringify(data))
    await fsp.rename(file + '.tmp', file)
  }
}
