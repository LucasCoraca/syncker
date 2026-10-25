// Live progress of file transfers, for the UI: other devices' files being
// downloaded here, our files being fetched by other devices, and local files
// being added to the space. Purely informational: sync never depends on it.

const DONE_KEEP = 60000 // finished items stay listed this long
const UP_IDLE = 15000 // an upload with no requests for this long has stopped
const SPEED_WINDOW = 4000

class Meter {
  constructor () { this.samples = [] }

  add (bytes, now = Date.now()) {
    this.samples.push([now, bytes])
    this._trim(now)
  }

  speed (now = Date.now()) {
    this._trim(now)
    if (!this.samples.length) return 0
    let sum = 0
    for (const [, b] of this.samples) sum += b
    return Math.round(sum / (Math.max(1000, now - this.samples[0][0]) / 1000))
  }

  _trim (now) {
    while (this.samples.length && now - this.samples[0][0] > SPEED_WINDOW) this.samples.shift()
  }
}

export class Transfers {
  constructor (onchange) {
    this.onchange = onchange
    this.items = new Map() // id -> transfer
    this.done = new Set() // ids of finished items, oldest first (pruned first)
    this.down = new Meter()
    this.up = new Meter()
    this._timer = null
  }

  get (id) { return this.items.get(id) }

  // dir: 'down' | 'up' | 'add'. state: 'waiting' | 'active' | 'saving' | 'done' | 'failed'
  start (id, fields) {
    if (this.items.size >= 500) {
      // A first scan of a big folder adds thousands of files: forget the oldest finished ones.
      for (const k of this.done) {
        this.done.delete(k)
        this.items.delete(k)
        if (this.items.size < 400) break
      }
    }
    this.done.delete(id)
    const t = { id, bytes: 0, have: 0, blocks: 0, size: 0, state: 'active', started: Date.now(), updated: Date.now(), meter: new Meter(), ...fields }
    this.items.set(id, t)
    this.changed()
    return t
  }

  // A block of a transfer moved (blocks: hypercore blocks, bytes: payload).
  progress (t, bytes, blocks = 1) {
    const now = Date.now()
    t.bytes = Math.min(t.size || Infinity, t.bytes + bytes)
    t.have = Math.min(t.blocks || Infinity, t.have + blocks)
    t.updated = now
    if (t.state === 'waiting') t.state = 'active'
    t.meter.add(bytes, now)
    if (t.dir === 'down') this.down.add(bytes, now)
    else if (t.dir === 'up') this.up.add(bytes, now) // adding a local file is not network traffic
    this.changed()
  }

  set (t, fields) {
    Object.assign(t, fields, { updated: Date.now() })
    if (t.state === 'done' || t.state === 'failed') {
      t.finished = Date.now()
      if (this.items.get(t.id) === t) this.done.add(t.id)
    }
    this.changed()
  }

  finish (id, state = 'done') {
    const t = this.items.get(id)
    if (t && t.state !== 'done') this.set(t, { state, have: state === 'done' ? t.blocks : t.have, bytes: state === 'done' ? t.size : t.bytes })
  }

  drop (id) {
    this.done.delete(id)
    if (this.items.delete(id)) this.changed()
  }

  // Throttled: progress fires per 64 KB block, the UI needs a few updates a second.
  changed () {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.onchange()
    }, 400)
  }

  list (now = Date.now()) {
    const out = []
    for (const [id, t] of this.items) {
      if (t.finished && now - t.finished > DONE_KEEP) { this.items.delete(id); this.done.delete(id); continue }
      if (t.dir === 'up' && t.state === 'active' && now - t.updated > UP_IDLE) { this.items.delete(id); this.done.delete(id); continue }
      const speed = t.state === 'active' ? t.meter.speed(now) : 0
      const fraction = t.blocks ? t.have / t.blocks : t.size ? t.bytes / t.size : 0
      const percent = t.state === 'done' ? 100 : Math.min(99, Math.floor(fraction * 100))
      const bytes = t.state === 'done' ? t.size : Math.round(fraction * t.size)
      out.push({
        id,
        dir: t.dir,
        path: t.path,
        device: t.device,
        online: t.online,
        preparing: t.preparing,
        stage: t.stage,
        passes: t.passes,
        source: t.source,
        via: t.via,
        peer: t.peer,
        size: t.size,
        bytes,
        percent,
        speed,
        eta: speed > 0 && t.size ? Math.round((t.size - bytes) / speed) : null,
        state: t.state,
        started: t.started,
        finished: t.finished || null
      })
    }
    return out.sort((a, b) => (a.finished || Infinity) - (b.finished || Infinity) || a.started - b.started)
  }

  get active () {
    for (const t of this.items.values()) if (t.state === 'active' || t.state === 'saving') return true
    return false
  }

  speeds () { return { down: this.down.speed(), up: this.up.speed() } }

  close () { clearTimeout(this._timer) }
}
