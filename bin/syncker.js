#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { App } from '../lib/app.js'
import { configStore } from '../lib/config.js'

const HOME = process.env.SYNCKER_HOME || path.join(os.homedir(), '.syncker')
const DEFAULT_FOLDER = path.join(os.homedir(), 'Syncker')
const SCRIPT = fileURLToPath(import.meta.url)

const USAGE = `syncker - peer-to-peer folder sync (Hypercore)

  syncker start [--port 7777] [--host 127.0.0.1]       run sync + web UI (set up from the UI)
  syncker init  [--drive NAME] [--folder DIR] [--name DEVICE]           create a new shared drive
               [--direct]          send files straight from the folder (no copy in the sync data)
               [--ignore a,b,*.x]  names / suffixes this device does not sync (e.g. node_modules,.git)
  syncker join  <invite> [--drive NAME] [--folder DIR] [--name DEVICE]  join a shared drive
  syncker invite                                        list your shared drives and their invites
  syncker install [--no-linger] [--print]               run in the background (systemd user service)
  syncker uninstall                                     remove the background service

Data lives in ${HOME} (override with SYNCKER_HOME).`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    folder: { type: 'string' },
    name: { type: 'string' },
    drive: { type: 'string' },
    direct: { type: 'boolean' },
    ignore: { type: 'string' },
    port: { type: 'string', default: '7777' },
    host: { type: 'string', default: '127.0.0.1' },
    'no-linger': { type: 'boolean' },
    print: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  }
})

const [cmd, arg] = positionals
const config = configStore(HOME)
const fail = (msg) => { console.error(msg); process.exit(1) }

function newApp () {
  return new App({
    home: HOME,
    defaultFolder: DEFAULT_FOLDER,
    defaultName: os.hostname(),
    port: Number(values.port),
    host: values.host,
    platform: 'linux'
  })
}

async function setup (mode) {
  const app = new App({ home: HOME, defaultFolder: DEFAULT_FOLDER, defaultName: os.hostname() })
  await app.start({ web: false })
  if ([...app.spaces.values()].some((s) => s.error)) {
    await app.close()
    fail('Syncker is running. Add shared drives from its web UI (http://127.0.0.1:7777), or stop it first.')
  }
  let d
  try {
    const opts = { mode, invite: arg, folder: values.folder, ask: false, direct: !!values.direct, ignore: values.ignore || [] } // the CLI syncs everything
    d = app.configured
      ? await app.addSpace({ ...opts, name: values.drive })
      : await app.setup({ ...opts, name: values.name, drive: values.drive })
  } catch (err) {
    await app.close()
    fail(err.message)
  }
  await app.close()
  console.log(`Device "${d.deviceName}" syncing shared drive "${d.name}" in ${d.folder}`)
  console.log(`Invite other devices with:\n\n  ${d.invite}\n`)
  console.log('Then run: syncker start   (or "syncker install" to run in the background)')
}

async function start () {
  const app = newApp()
  app.on('file', (f) => console.log(`↓ ${f.space}: ${f.path} (from ${f.from})`))
  app.on('error-log', (err) => console.warn('!', err.message))
  try {
    await app.start()
  } catch (err) {
    if (err.code === 'EADDRINUSE') fail(`Port ${values.port} is in use. Is syncker already running? Try --port.`)
    if (/could not be locked/.test(err.message)) fail(`Syncker is already running for ${HOME} (another process holds its data).`)
    throw err
  }
  const url = `http://${values.host}:${app.server.address().port}`
  for (const s of app.spaces.values()) console.log(`Syncing "${s.name}" in ${s.folder} as "${app.deviceName}"${s.error ? ' (error: ' + s.error + ')' : ''}`)
  if (!app.configured) console.log('Not set up yet: open the web UI to create or join a shared drive.')
  console.log(`Web UI: ${url}`)

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user')
const APPS_DIR = path.join(os.homedir(), '.local', 'share', 'applications')

async function install () {
  const port = Number(values.port)
  const env = process.env.SYNCKER_HOME ? `Environment=SYNCKER_HOME=${HOME}\n` : ''
  // Absolute paths: systemd does not see the PATH of your shell (nvm, ~/.local/bin, ...).
  const unit = `[Unit]
Description=Syncker peer-to-peer folder sync
Wants=network-online.target
After=network-online.target

[Service]
ExecStart="${process.execPath}" "${SCRIPT}" start --port ${port}
${env}Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
  const desktop = `[Desktop Entry]
Type=Application
Name=Syncker
Comment=Your synced files
Exec=xdg-open http://127.0.0.1:${port}
Icon=folder-remote
Categories=Network;FileTransfer;
`
  if (values.print) {
    process.stdout.write(unit)
    return
  }
  await fs.mkdir(UNIT_DIR, { recursive: true })
  await fs.mkdir(APPS_DIR, { recursive: true })
  await fs.writeFile(path.join(UNIT_DIR, 'syncker.service'), unit)
  await fs.writeFile(path.join(APPS_DIR, 'syncker.desktop'), desktop)
  execFileSync('systemctl', ['--user', 'daemon-reload'])
  execFileSync('systemctl', ['--user', 'enable', '--now', 'syncker.service'])
  execFileSync('systemctl', ['--user', 'restart', 'syncker.service'])
  if (!values['no-linger']) {
    // Keep running when you log out and start at boot before login.
    try { execFileSync('loginctl', ['enable-linger', os.userInfo().username]) } catch {
      console.warn('Could not enable linger; syncing will stop when you log out.')
    }
  }
  console.log('Installed. Syncker now runs in the background and starts at boot.')
  console.log(`Open http://127.0.0.1:${port} or "Syncker" in your app menu.`)
  console.log('Logs: journalctl --user -u syncker -f')
}

async function uninstall () {
  try { execFileSync('systemctl', ['--user', 'disable', '--now', 'syncker.service'], { stdio: 'ignore' }) } catch {}
  await fs.rm(path.join(UNIT_DIR, 'syncker.service'), { force: true })
  await fs.rm(path.join(APPS_DIR, 'syncker.desktop'), { force: true })
  try { execFileSync('systemctl', ['--user', 'daemon-reload']) } catch {}
  console.log(`Removed the background service. Your files and ${HOME} were left in place.`)
}

if (values.help || !cmd) console.log(USAGE)
else if (cmd === 'init') await setup('create')
else if (cmd === 'join') {
  if (!arg) fail('Usage: syncker join <invite>')
  await setup('join')
} else if (cmd === 'invite') {
  const app = new App({ home: HOME, defaultFolder: DEFAULT_FOLDER, defaultName: os.hostname() })
  const c = await config.load()
  if (!c) fail('Not set up yet.')
  for (const s of app.listSpaces(c)) console.log(`${s.name}  (${s.folder})\n  ${s.invite}\n`)
} else if (cmd === 'start') await start()
else if (cmd === 'install') await install()
else if (cmd === 'uninstall') await uninstall()
else { console.log(USAGE); process.exit(1) }
