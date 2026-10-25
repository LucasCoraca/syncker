// Minimal Chrome DevTools Protocol driver for UI tests (no puppeteer).
// Uses Node's built-in WebSocket (Node 22+).
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function findChrome () {
  const candidates = [process.env.CHROME, '/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  return candidates.find((c) => c && fs.existsSync(c))
}

// Snap's Chromium can only read/write under ~/snap/chromium/common.
export function chromeDir () {
  const snap = path.join(os.homedir(), 'snap', 'chromium', 'common')
  return findChrome() === '/snap/bin/chromium' ? snap : os.tmpdir()
}

export async function launch ({ args = [], port = 9333 } = {}) {
  const profile = fs.mkdtempSync(path.join(chromeDir(), 'syncker-chrome-'))
  const proc = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1200,900',
    ...args, 'about:blank'
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(100)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {}
  }
  if (!target) { proc.kill(); throw new Error('chrome did not start') }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const waiting = new Map()
  const listeners = []
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id)
      waiting.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    } else if (msg.method) for (const l of listeners) l(msg)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id
    waiting.set(n, { resolve, reject })
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  await send('Page.enable')
  await send('Runtime.enable')
  const errors = []
  listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  })

  const page = {
    errors,
    send,
    async goto (url) {
      const loaded = new Promise((resolve) => listeners.push(function l (m) { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); resolve() } }))
      await send('Page.navigate', { url })
      await loaded
    },
    // Evaluates an expression (may return a promise) in the page.
    async eval (expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    },
    async until (expression, ms = 10000) {
      const end = Date.now() + ms
      let last
      while (Date.now() < end) {
        try { last = await page.eval(expression); if (last) return last } catch (err) { last = err.message }
        await sleep(100)
      }
      throw new Error(`timed out waiting for ${expression} (last: ${JSON.stringify(last)})`)
    },
    async screenshot (file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
    },
    async close () {
      try { ws.close() } catch {}
      proc.kill()
      await sleep(200)
      fs.rmSync(profile, { recursive: true, force: true })
    }
  }
  return page
}
