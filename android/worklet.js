// Android entry point, runs inside the Bare worklet started by SyncService.
// Args (from Kotlin): <home> <folders> <defaultName> <port> <bootstrap host:port,...|-> <sharedRoot> <storageOk 1|0>
//   <folders>: preferred default folders, newline separated (first writable wins)
//   <sharedRoot>/<storageOk>: shared storage root and whether we hold "All files access"
// Talks to Kotlin over BareKit.IPC with newline-delimited JSON:
//   worklet -> native: { type: 'status', title, text, progress (0-100 or -1), configured, folders: { driveId: folder }, busy }
//   native -> worklet: { type: 'sync' } (e.g. after the network comes back)
//                      { type: 'storage', ok } ("All files access" granted/revoked)

/* global Bare, BareKit */
import { App } from '../lib/app.js'

const [home, defaultFolder, defaultName, port, bootstrap, sharedRoot, storageArg] = Bare.argv.slice(-7)

// Without "All files access" Android still shows the files this app created,
// but hides everyone else's: the folder would look partly deleted. Pause.
let storageOk = storageArg === '1'
const NO_STORAGE = 'Folder unavailable: Syncker needs "All files access" to read ' + sharedRoot + '. Sync is paused; nothing was deleted.'
const folderGuard = (folder) => !storageOk && (folder === sharedRoot || folder.startsWith(sharedRoot + '/')) ? NO_STORAGE : null
const { IPC } = BareKit

function send (msg) {
  IPC.write(JSON.stringify(msg) + '\n')
}

const app = new App({
  home,
  defaultFolder: defaultFolder.split('\n'),
  defaultName,
  port: Number(port),
  host: '127.0.0.1',
  platform: 'android',
  folderGuard,
  cameraFolder: [sharedRoot + '/DCIM/Camera', sharedRoot + '/Pictures'],
  bootstrap: bootstrap && bootstrap !== '-' ? bootstrap.split(',').map((hp) => {
    const [host, p] = hp.split(':')
    return { host, port: Number(p) }
  }) : undefined
})

let last = ''
function report () {
  const info = app.info()
  let text = 'Tap to set up'
  let title = 'Syncker'
  let progress = -1
  let busy = false
  const spaces = info.spaces || []
  const folders = {}
  for (const sp of spaces) folders[sp.id] = sp.folder
  if (info.configured) {
    const peers = new Map()
    for (const sp of spaces) for (const p of sp.peers) peers.set(p.key, peers.get(p.key) || p.online)
    const online = [...peers.values()].filter(Boolean).length
    const errors = spaces.map((sp) => sp.status.phase === 'error' ? sp.status.error || 'error' : null).filter(Boolean)
    const pending = spaces.reduce((n, sp) => n + (sp.pendingCount != null ? sp.pendingCount : sp.pending.length), 0)
    const phase = errors.some((e) => /All files access/.test(e)) ? 'Paused: tap to allow file access'
      : errors.some((e) => /Folder unavailable/.test(e)) ? 'Paused: folder unavailable'
        : errors.length ? 'Sync error'
          : spaces.some((sp) => sp.status.phase === 'syncing') ? 'Syncing…' : 'Up to date'
    text = `${phase} · ${online}/${peers.size} device${peers.size === 1 ? '' : 's'} online` +
      (pending ? ` · ${pending} waiting` : '') +
      (spaces.length > 1 ? ` · ${spaces.length} drives` : '')
    // Files moving right now: show them with a progress bar.
    const moving = spaces.flatMap((sp) => sp.transfers).filter((t) => t.state === 'active' || t.state === 'saving')
    if (moving.length) {
      const down = moving.filter((t) => t.dir === 'down')
      const list = down.length ? down : moving
      const size = list.reduce((n, t) => n + t.size, 0)
      const bytes = list.reduce((n, t) => n + t.bytes, 0)
      progress = size ? Math.min(99, Math.floor(bytes * 100 / size)) : 0
      const speed = spaces.reduce((n, sp) => n + (down.length ? sp.speed.down : sp.speed.up), 0)
      const verb = down.length ? 'Downloading' : list[0].dir === 'up' ? 'Sending' : 'Adding'
      title = `${verb} ${list.length === 1 ? list[0].path.split('/').pop() : list.length + ' files'}`
      text = `${progress}% · ${human(bytes)} of ${human(size)}` + (speed ? ` · ${human(speed)}/s` : '')
    } else {
      // Big files another device is still adding: nothing to download yet.
      const prep = spaces.flatMap((sp) => sp.transfers).filter((t) => t.preparing != null)
      if (prep.length) {
        progress = Math.floor(prep.reduce((n, t) => n + t.preparing, 0) / prep.length)
        title = `Preparing ${prep.length === 1 ? prep[0].path.split('/').pop() : prep.length + ' files'}`
        text = `${progress}% · ${prep[0].device} is getting ${prep.length === 1 ? 'it' : 'them'} ready to send`
      }
    }
    // A big drive just joined waits for a choice.
    const ask = spaces.find((sp) => sp.hold && sp.hold.ready)
    if (ask && progress < 0) {
      title = 'Choose what to sync'
      text = `“${ask.name}” has ${human(ask.hold.bytes)}. Tap to choose what to keep on this phone.`
    }
    busy = spaces.some((sp) => sp.status.phase === 'syncing') || pending > 0 || progress >= 0
  }
  // busy: keep the CPU awake (transfers in flight or files still to fetch)
  const msg = { type: 'status', title, text, progress, configured: info.configured, folders, busy }
  const key = JSON.stringify(msg)
  if (key === last) return
  last = key
  send(msg)
}

function human (n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return (i ? n.toFixed(1) : n) + ' ' + u[i]
}

// A rescan runs every 15 s and finishes in well under a second, so only
// report "Syncing…" for work still going on 1.5 s later. Throttled, not
// debounced: during a transfer, changes never stop coming.
let reportTimer = null
app.on('change', () => {
  if (reportTimer) return
  reportTimer = setTimeout(() => { reportTimer = null; report() }, 1500)
})
app.on('error-log', (err) => console.error('syncker:', err && err.message))

let buffered = ''
IPC.on('data', (data) => {
  buffered += data.toString()
  let i
  while ((i = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, i)
    buffered = buffered.slice(i + 1)
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'storage') {
      storageOk = !!msg.ok
      app.recheckGuard()
    }
    if (msg.type === 'sync') {
      // Network changed: look for peers again right away.
      for (const sp of app.spaces.values()) {
        if (!sp.engine || sp.error || sp.starting) continue
        sp.engine.refreshDiscovery()
        sp.engine.sync()
      }
    }
  }
})

Bare.on('suspend', () => {}) // we keep running in the foreground service
Bare.on('teardown', () => app.close())

app.start().then(() => {
  send({ type: 'ready', port: app.server.address().port })
  report()
}, (err) => {
  send({ type: 'fatal', message: String(err && err.stack) })
})
