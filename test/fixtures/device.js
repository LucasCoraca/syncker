// A device in its own process, so a test can kill it without warning
// (node test/fixtures/device.js <home> <folder> <secret> <name> <bootstrap json>).
import { Engine } from '../../lib/engine.js'

const [home, folder, secret, deviceName, bootstrap] = process.argv.slice(2)
const e = new Engine({ home, folder, secret, deviceName, bootstrap: JSON.parse(bootstrap), direct: true })
await e.start()
await e.sync()
process.stdout.write(JSON.stringify({ key: e.key }) + '\n')
