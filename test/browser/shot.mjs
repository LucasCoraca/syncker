// Screenshot the UI at phone width with long names (manual visual check).
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { App } from '../../lib/app.js'
import { launch, chromeDir } from './cdp.js'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncker-shot-'))
const app = new App({ home: path.join(root, 'h'), defaultFolder: path.join(root, 'f'), defaultName: 'shot', port: 0 })
await app.start(); await app.setup({ mode: 'create', name: 'laptop' })
for (const n of ['Camera/IMG_0001.jpg', 'a short.txt', 'Quarterly report final version (conflict sdk_gphone64_x86_64 afb126).pdf', 'notes.md']) {
  await fs.mkdir(path.dirname(path.join(app.engine.folder, n)), { recursive: true }); await fs.writeFile(path.join(app.engine.folder, n), 'x'.repeat(1234))
}
await app.engine.sync()
const page = await launch({ args: ['--window-size=390,844'] })
await page.goto(`http://127.0.0.1:${app.server.address().port}/`)
await page.until("document.getElementById('files').textContent.includes('notes.md')")
await page.screenshot(path.join(chromeDir(), 'shot-phone.png'))
await page.close(); await app.close(); await fs.rm(root, { recursive: true, force: true })
process.exit(0)
