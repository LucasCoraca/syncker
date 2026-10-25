// The UI's live status stream must keep delivering updates (regression: on
// Bare the request 'close' fired right after connect and pushes stopped).
import test from 'brittle'
import fs from '#fs/promises'
import os from '#os'
import path from '#path'
import http from '#http'
import createTestnet from 'hyperdht/testnet.js'
import { App } from '../lib/app.js'

test('status stream keeps pushing updates after the first one', async (t) => {
  const testnet = await createTestnet(3)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-sse-'))
  const app = new App({ home: path.join(root, 'home'), defaultFolder: path.join(root, 'files'), defaultName: 'sse', port: 0, bootstrap: testnet.bootstrap })
  await app.start()
  await app.setup({ mode: 'create' })
  t.teardown(async () => { await app.close(); await testnet.destroy(); await fs.rm(root, { recursive: true, force: true }) })

  const port = app.server.address().port
  let events = 0
  const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' })
  req.on('response', (res) => res.on('data', (d) => { events += (String(d).match(/^data:/gm) || []).length }))
  req.on('error', () => {})
  req.end()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const first = events
  await fs.writeFile(path.join(app.engine.folder, 'a.txt'), 'a')
  await app.engine.sync()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  t.ok(first >= 1, 'initial status received')
  t.ok(events > first, `update pushed after a change (${first} -> ${events})`)
  req.destroy()
})
