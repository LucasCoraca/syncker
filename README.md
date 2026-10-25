# Syncker

A Google-Drive-like folder that stays in sync between your devices (Linux and Android) with no
server. Built on the [Hypercore protocol](https://hypercore-protocol.github.io/new-website/)
stack using the current Holepunch modules: `hyperdrive`, `corestore`, `hyperswarm`, and the
`bare` runtime on Android.

- **Shared drives:** every invite is its own drive with its own folder, devices and invite. A
  device can be in several drives, for example "Work" with your laptops and "Family" with
  everyone's phones.
- A normal folder per drive on every device: `~/Syncker` and `~/Syncker - <drive>` on Linux,
  `Internal storage/Syncker…` on Android (visible to the gallery and file managers)
- A Google-Drive-style web UI:
  - browse, upload files and folders, rename, delete, search, recent files, list and grid views
  - version history and live progress for every transfer (percent, speed, time left, which
    device), including in the Android notification
  - `http://127.0.0.1:7777` on Linux; the Android app shows the same UI
- **Choose what to sync:** any folder or file (or a whole drive) can be online only on a device.
  It stays listed and opens on demand from another device, but takes no space. "Remove from this
  device" frees the space and keeps the file everywhere else; "Delete from all devices" deletes it.
- **Direct drives (no second copy):** a drive created with `--direct` (or `"direct": true` in
  `POST /api/spaces`) sends files straight from the folder instead of keeping a copy in the sync
  data, so a big folder like `~/Documents` takes no extra space. The receiver checks each file
  against the SHA-256 in its signed entry, interrupted downloads resume, any device that has a
  file can send it, and moved or duplicated files are taken from the local disk. The cost: only
  the latest version of a file can be downloaded, from a device that still has it, so "Remove
  from this device" waits until another device has the file. Devices joining a direct drive
  become direct too.
- **Ignore rules:** `--ignore node_modules,.git,build,*.log` (names or `*.suffix`) keeps folders
  and files out of a drive on that device: not shared, not downloaded into, and adding a rule
  later deletes nothing anywhere.
- **Select several files at once:** Ctrl/Cmd+click, Shift+click for a range, Ctrl+A, or the tick
  box on each file; long press on a phone. The selection bar then downloads, keeps on this device,
  removes from this device or deletes them all in one go (also from the right-click menu).
- **Choose folders in a tree:** making a drive from a folder that already has files opens a tree
  of its folders (no file names, sizes counted as you look) to tick what is shared; joining a
  drive opens the same tree to tick what this device keeps, with how much that is next to the free
  space.
- **Big drives ask first:** after joining a drive, nothing downloads until its size is known. A
  drive under 1 GB (that takes at most half the free space) syncs everything on its own; a bigger
  one asks: sync everything, choose folders, or keep it online only. The CLI syncs everything.
- **Sync details for every file:** which step it is in on this device (reading, storing in the
  drive, waiting for another device, downloading with speed and time left, saving), and whether
  each other device has it, is receiving it, has an older version or is offline, how each device is
  connected (local network, VPN, internet), plus a short activity log.
- **Set it remotely:** from any device you can choose what every other device of a drive
  stores, unless that device turned this off for itself.
- Pair a phone by scanning a QR code shown on the PC
- Works over the internet: devices find each other on a global DHT and connect directly
  (UDP hole-punching), end-to-end encrypted
- Keeps syncing in the background: systemd user service on Linux, foreground service on Android
  that survives screen-off, Doze, task removal, process kills and reboots
- Concurrent edits are never lost (`name (conflict <device> <hash>).ext`), an edit always beats a
  concurrent delete, and a missing or unreadable folder pauses sync instead of deleting files on
  the other devices

## How it works

```
 laptop                        phone                         desktop
 ~/Syncker  ⇄ scan/merge ⇄    Syncker/  ⇄ scan/merge ⇄      ~/Syncker
     │                            │                              │
 own Hyperdrive (writer)     own Hyperdrive (writer)        own Hyperdrive (writer)
     └──────── Hyperswarm topic = sha256(drive secret) ─────────┘
                every device replicates every device's drive
```

1. **One writer per device.** Each device has its own Hyperdrive, a signed, append-only log of its
   changes. No multi-writer coordination is needed.
2. **Drive secret.** Creating a shared drive makes a 32-byte secret, shared as the invite
   (`syncker:<z32>?name=<drive name>`, also shown as a QR code). Each drive runs its own engine,
   with its own Corestore, peers and swarm topic, so drives never see each other's files. Devices join the Hyperswarm topic derived from
   it. On each connection, both sides prove they know the secret with an HMAC over the Noise
   handshake hash, bound to each side's role. Only then do they exchange drive keys and replicate.
   Known devices are gossiped.
3. **Merge.** Every entry carries `{ vv, clock, hash, size, mtime, device }`. `vv` is a version
   vector: a local edit takes the vector of the version it replaced (what was on disk) and bumps
   its own counter. A version covered by another one is history. Versions that don't cover each
   other were made concurrently, and they are resolved without losing data:
   - An edit beats a concurrent delete.
   - Of several concurrent edits, the highest `(clock, driveKey)` wins (`clock` is a Lamport
     clock). The others are kept as `name (conflict <device> <hash>).ext`, with one name per
     losing version, so a later conflict on the same file gets its own copy.

   A device only folds a losing version into what it "knows" once that conflict copy exists on
   disk, so a later edit can't bury it. Deletes are tombstones.
4. **Materialize.** All metadata is replicated. File contents are fetched in the background from
   any device that has them, verified (SHA-256) and written atomically.
5. **Selective sync.** Each device has a list of online-only paths per drive.
   - Those paths are never downloaded. A copy already on the device is removed once it is safely
     in the drive, and that removal is never published as a deletion. Unsaved local edits are
     published first.
   - Opening an online-only file streams it from the drive.
   - Every device publishes, in its own drive, a record of what it wants each device to keep:
     `{ device: { excluded, clock } }`. Per device, the highest clock wins, so every device
     agrees, and an offline device applies changes when it comes back.
   - A device that turns off "Allow other devices to choose what this device syncs" follows only
     its own record. That flag is trusted only from the device's own drive.
   - A drive just joined is "on hold" (everything treated as online only, nothing removed) until
     its size is known (every connected device's file list fully read) and a choice is made.
6. **Where each file is.** Devices tell each other (over the authenticated connection) which
   files they have on disk, as path and hash prefix, so each file can show which devices have the
   latest version. Big files a device is still adding are announced in `/.syncker/activity`.
6. **Safety.**
   - The folder holds a `.syncker` marker. If the folder or marker is missing or unreadable
     (deleted, renamed, storage not mounted, Android permission revoked), sync pauses. An empty
     folder is never taken to mean "delete everything", and unreadable subfolders are treated as
     unknown, not deleted.
   - A file you save while a remote version downloads is kept (checked again right before the
     swap).
   - Nothing is ever written or deleted through a symlink.
   - A path that can't be written on this device (name too long, invalid characters, a folder in
     the way) is reported under "Couldn't sync" and never blocks other files. When a file and a
     folder end up with the same name, the folder keeps it and the file becomes a conflict copy
     on every device.
7. **Robust connections.**
   - Devices keep announcing themselves and look for missing peers again after 5, 10 and 20 s,
     then every 30 s.
   - Each device advertises its drive length on the authenticated channel. If replication makes
     no progress towards it for 8 s, the connection is redialed. This is a safety net: the
     connect-time deadlock it was added for is fixed. The hello handler must not hold a Protomux
     batch cork while it waits for data from the same connection.

Code: `lib/engine.js` (sync), `lib/app.js` (setup + lifecycle), `lib/web.js` + `lib/ui.html` (UI
and API), `bin/syncker.js` (Linux CLI), `android/` (Kotlin app + `worklet.js` running the same
engine in Bare). `package.json` `imports` maps `#fs`, `#crypto`, … to Node or Bare modules.

## Linux

Requires Node.js 20+.

```sh
git clone <this repo> syncker && cd syncker
npm install
npm link                      # puts `syncker` on your PATH
syncker install               # background service, starts at boot, opens on login
```

Then open `http://127.0.0.1:7777` (or "Syncker" in your app menu) and either create a shared
drive or join one. More drives are added from **New → New shared drive / Join shared drive**.
From the terminal (while the service is stopped) you can also use
`syncker init [--drive NAME]`, `syncker join <invite>` and `syncker invite` (lists every drive
and its invite).

Setups from before shared drives are migrated in place: the old folder becomes a drive named
after it, and its sync data is reused.

- `syncker install` writes `~/.config/systemd/user/syncker.service` with absolute paths to node
  and the script, sets `Restart=always`, and enables linger so syncing continues while you are
  logged out. Use `--print` to see the unit without installing, `--no-linger` to skip linger.
  `syncker uninstall` removes it.
- Logs: `journalctl --user -u syncker -f`
- `syncker start` runs in the foreground instead. `SYNCKER_HOME` changes the data dir (default
  `~/.syncker`).

## Android

Install the APK for your phone's CPU (`app-arm64-v8a-release.apk` for nearly all phones,
about 24 MB), or build it yourself (below). On first launch, the app asks for:

1. **All files access**, so the folder can live in `Internal storage/Syncker`. If you skip it,
   files stay in the app's own folder.
2. **Notifications**, for the ongoing "Syncker · Up to date" notification.
3. **Run in background** (battery optimization exemption), for the periodic wake-ups during deep
   sleep.

To pair with your PC, open the drive's **Manage** page in the PC's web UI, scan its QR code with
the phone camera, and tap **Join shared drive**. You can also use **Join with invite → Scan QR code** in the
app, or paste the invite.

Background behavior (tested on an Android 14 emulator, see below):
- A foreground service hosts the sync engine, so closing the app or swiping it away doesn't stop it.
- It restarts after a crash (`START_STICKY`), after an app update, and at boot.
- It keeps the network in Doze and holds a wake lock only while transfers are in flight.
- An allow-while-idle alarm every ~15 min checks for peers during deep sleep.
- A network callback re-announces as soon as connectivity returns.

If "All files access" is later revoked, sync pauses with "Paused: tap to allow file access" and
nothing is deleted. Some vendors (Xiaomi, Huawei, some Samsung modes) also kill background apps
on their own. Allow Syncker in their battery settings.

### Building the APK

Requires an Android SDK with NDK 29 and platform 34, plus JDK 17.

```sh
npm install
JAVA_HOME=/path/to/jdk17 scripts/build-android.sh assembleRelease
# -> android/app/build/outputs/apk/release/app-<abi>-release.apk
```

The script embeds the UI, bundles `android/worklet.js` with `bare-pack`, links native addons with
`bare-link`, fetches the prebuilt bare-kit runtime (from `react-native-bare-kit`, without React
Native) and runs Gradle. Release builds are signed with the debug key, so set up your own signing
config before publishing.

## Over the internet

Devices don't need to be on the same network. Things to know:

- **Devices sync while they're online at the same time.** There's no server holding your files.
  An always-on Linux box at home works as your "cloud": it receives everything and serves it to
  your other devices.
- Hole-punching fails only when *both* devices are behind strict NATs, for example certain
  carrier CGNATs talking to a corporate network. An always-on device with a public IP or a
  forwarded UDP port fixes this for everyone.

## Security notes

- Anyone with a drive's invite (or a photo of its QR code) can read and change every file in
  that drive, and nothing in your other drives. Treat it like a password.
- Any member can also change what other devices of the drive store, unless a device turned that
  off. This never deletes files from the drive.
- The web UI has no login and binds to `127.0.0.1`. It rejects cross-origin requests and foreign
  Host headers (DNS rebinding). Don't use `--host 0.0.0.0` on an untrusted network.
- Data from other devices is validated: paths can't escape the folder, metadata is type-checked,
  and gossiped peer lists are capped.

## Limits / next steps

- Empty folders aren't synced until they contain a file.
- A rename is synced as a delete plus a create, so the content is transferred again.
- There are no per-member permissions (owner, read-only). Removing a device and rotating the
  secret isn't implemented. A device that was reset keeps
  showing as an offline device.
- Filenames that are valid on Linux but not on Android shared storage (`: * ? " < > |`) fail to
  download on Android, and the error is logged.

## Tests

```sh
npm test            # engine tests on Node (local DHT testnet)
npm run test:bare   # the same tests on the Bare runtime (what Android runs)
npm run test:ui     # drives the web UI in headless Chromium (incl. a 768 MB transfer)
test/android/background.sh <adb-serial> <linux-folder> [scenario...]
```

Engine tests cover:
- create/edit/delete across 3 devices, a late joiner, concurrent-edit conflicts, a peer with the
  wrong secret, relaying content while its author is offline
- a long-running device still being found by a new one
- folder deleted, replaced by an empty mount, or missing at restart; unreadable subfolders;
  paused storage; marker migration
- 25 edge cases (`test/edge.test.js`):
  - odd and Unicode names, empty and 20 MB files, 500 files, rapid edits
  - edit/edit, edit/delete and create/create races, a save during a download, renames and moves
  - file vs folder with the same name, symlinks, malicious peers and absurd clocks, restarts
    mid-transfer, offline edits
- a seeded random-operation fuzz test that checks convergence and that no last write is lost
  (`FUZZ_SEED=1,2,3 node test/fuzz.test.js`)
- selective sync (online-only folders, a whole drive online only, unsaved edits, restarts) and
  setting it remotely (offline devices, locked devices)
- several shared drives per device, isolation between drives, migration of old setups
- the UI's live status stream, plus a connect-race stress tool (`npm run stress`,
  `npm run stress:bare`)

The Android script checks phone ↔ PC sync in each background scenario: `background` (screen
off), `recents`, `doze`, `kill`, `network`, `restricted`, `reboot`.
