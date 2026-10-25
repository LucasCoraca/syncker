import fsp from '#fs/promises'
import path from '#path'
import crypto from '#crypto'
import b4a from 'b4a'
import z32 from 'z32'

export function configStore (home) {
  const file = path.join(home, 'config.json')
  let queue = Promise.resolve()
  const write = async (config) => {
    await fsp.mkdir(home, { recursive: true })
    await fsp.writeFile(file + '.tmp', JSON.stringify(config, null, 2), { mode: 0o600 })
    await fsp.rename(file + '.tmp', file)
  }
  return {
    async load () {
      try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return null }
    },
    // One at a time: two saves at once would share the temp file.
    save (config) {
      const done = queue.then(() => write(config))
      queue = done.catch(() => {})
      return done
    }
  }
}

// Offered when a drive is made from an existing folder: build output and
// dependencies, never worth syncing.
export const DEV_IGNORE = ['node_modules', '.git', 'build', '.gradle', '.cxx', 'target', '__pycache__', '.venv', 'venv', '.cache', '.idea', 'CMakeFiles', '.next', '.dart_tool', 'Pods', 'DerivedData', '.pytest_cache', '.mypy_cache', '.tox', '.externalNativeBuild', 'intermediates']

export function newSecret () {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

// syncker:<z32 secret>[?name=<drive name>]. The name is only a suggestion
// for the joining device; the secret is the drive.
export function toInvite (secretHex, name = null) {
  const base = 'syncker:' + z32.encode(b4a.from(secretHex, 'hex'))
  return name ? base + '?name=' + encodeURIComponent(name) : base
}

export function fromInvite (invite) {
  const m = String(invite).trim().match(/^(?:syncker:)?([a-z0-9]+)(?:\?name=([^&#\s]*))?/i)
  let buf = null
  try { buf = m && z32.decode(m[1].toLowerCase()) } catch {}
  if (!buf || buf.byteLength !== 32) throw new Error('Invalid invite')
  let name = null
  try { name = m[2] ? decodeURIComponent(m[2]).slice(0, 64) : null } catch {}
  return { secret: b4a.toString(buf, 'hex'), name }
}
