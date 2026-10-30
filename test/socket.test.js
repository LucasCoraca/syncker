// The API on a private socket file (how the Android app runs it): it answers
// there, the file is only for its owner, and no port is opened.
import test from 'brittle'
import fs from '#fs/promises'
import os from '#os'
import path from '#path'
import Pipe from '#pipe'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../lib/app.js'

// One request over the socket; resolves with the raw response text (latin1,
// so a binary body arrives byte for byte).
const body = (res) => res.slice(res.indexOf('\r\n\r\n') + 4)
const chunks = (raw) => {
  let out = ''
  let at = 0
  for (;;) {
    const nl = raw.indexOf('\r\n', at)
    const n = parseInt(raw.slice(at, nl), 16)
    if (!n) return out
    out += raw.slice(nl + 2, nl + 2 + n)
    at = nl + 2 + n + 2
  }
}
const jsonOf = (res) => JSON.parse(/transfer-encoding: chunked/i.test(res) ? chunks(body(res)) : body(res))

// One request over the socket; resolves with the raw response text.
async function ask (file, req) {
  const conn = Pipe ? Pipe.createConnection(file) : (await import('net')).createConnection(file)
  return new Promise((resolve, reject) => {
    let out = ''
    conn.on('data', (d) => { out += d.toString('latin1') })
    conn.on('end', () => resolve(out))
    conn.on('close', () => resolve(out))
    conn.on('error', reject)
    for (const part of [].concat(req)) conn.write(part)
  })
}

test('API over a private socket: answers there, owner only, no port', async (t) => {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-socket-'))
  const file = path.join(root, 'api.sock')
  await fs.writeFile(file, 'left over from a crash')
  const app = new App({ home: path.join(root, 'h'), defaultFolder: path.join(root, 'f'), defaultName: 'phone', socket: file, bootstrap: testnet.bootstrap })
  await app.start()
  t.teardown(async () => {
    await app.close()
    await testnet.destroy()
    await fs.rm(root, { recursive: true, force: true })
  })

  const st = await fs.stat(file)
  t.is(st.mode & 0o077, 0, 'nobody else may open it')

  const res = await ask(file, 'GET /api/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
  t.ok(/^HTTP\/1\.1 200/.test(res), 'answers')
  t.ok(res.includes('"configured":false'), 'the status')

  // A web page's Origin does not matter here: only this app can connect.
  const body = JSON.stringify({ name: 'phone', drive: 'Family', mode: 'create' })
  const made = await ask(file, `POST /api/setup HTTP/1.1\r\nHost: localhost\r\nOrigin: https://appassets.androidplatform.net\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
  t.ok(/^HTTP\/1\.1 201/.test(made), 'set up over the socket')
  t.ok(app.configured, 'and it took')

  t.absent(app.server.address() && app.server.address().port, 'no TCP port')

  // The app draws the invite's QR code itself, and reads one from a photo.
  const id = app.info().spaces[0].id
  const qr = jsonOf(await ask(file, `GET /api/invite.json?space=${id} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`))
  t.is(qr.rows.length, qr.size, 'rows of the code')
  const cell = 4
  const side = (qr.size + 8) * cell
  const px = new Uint8Array(side * side * 4).fill(255)
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.rows[r][c] !== '1') continue
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const i = (((r + 4) * cell + y) * side + (c + 4) * cell + x) * 4
          px[i] = px[i + 1] = px[i + 2] = 0
        }
      }
    }
  }
  const read = jsonOf(await ask(file, [`POST /api/qr?w=${side}&h=${side} HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${px.byteLength}\r\nConnection: close\r\n\r\n`, px]))
  t.is(read.text, app.info().spaces[0].invite, 'the invite read back from the picture')
  const blank = jsonOf(await ask(file, [`POST /api/qr?w=8&h=8 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 256\r\nConnection: close\r\n\r\n`, new Uint8Array(256).fill(255)]))
  t.is(blank.text, null, 'no code: nothing')
})
