package app.syncker

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

/**
 * Keeps syncing while the app is closed: a foreground service (ongoing
 * notification) that hosts the Bare worklet running the sync engine and the
 * local web UI on 127.0.0.1:[PORT].
 *
 * Background strategy:
 *  - foreground service: Android does not kill the process for memory/idle
 *  - START_STICKY + BootReceiver: restarted after a crash, update or reboot
 *  - partial wake lock while the engine is busy (syncing / waiting for files),
 *    so transfers are not frozen by CPU sleep when the screen is off
 *  - an allow-while-idle alarm every ~15 min wakes the device briefly in Doze
 *    to look for peers and catch up
 *  - network callback: re-announce on the DHT as soon as connectivity changes
 */
class SyncService : Service() {
    companion object {
        const val TAG = "Syncker"
        const val PORT = 7777
        const val CHANNEL = "sync"
        const val NOTIFICATION_ID = 1
        const val ACTION_WAKE = "app.syncker.WAKE"
        const val EXTRA_BOOTSTRAP = "bootstrap"
        private const val WAKE_INTERVAL_MS = 15 * 60 * 1000L
        private const val WAKE_HOLD_MS = 60 * 1000L

        @Volatile var running = false
            private set
        @Volatile var ready = false
            private set

        fun start(context: Context, intent: Intent = Intent(context, SyncService::class.java)) {
            context.startForegroundService(intent.setClass(context, SyncService::class.java))
        }

        fun sharedFolder(): File = File(Environment.getExternalStorageDirectory(), "Syncker")

        /**
         * Default folder candidates, checked by the engine at setup time: shared
         * storage (needs "All files access"), else the app's own external dir.
         */
        fun defaultFolders(context: Context): String =
            listOf(sharedFolder(), File(context.getExternalFilesDir(null), "Syncker"))
                .joinToString("\n") { it.absolutePath }
    }

    private var worklet: Worklet? = null
    private var ipc: IPC? = null
    private val main = Handler(Looper.getMainLooper())
    private var inbox = StringBuilder()
    private var statusText = "Starting…"
    private var statusTitle = "Syncker"
    private var progress = -1 // 0..100 while files are moving, else -1
    private var busyLock: PowerManager.WakeLock? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var storageOk = false
    private val storageCheck = object : Runnable {
        override fun run() {
            checkStorage()
            main.postDelayed(this, 5000)
        }
    }

    /** Tells the engine when "All files access" is granted or revoked. */
    private fun checkStorage() {
        val ok = Environment.isExternalStorageManager()
        if (ok == storageOk) return
        storageOk = ok
        send(JSONObject().put("type", "storage").put("ok", ok))
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)

        val pm = getSystemService(PowerManager::class.java)
        busyLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "syncker:busy").apply { setReferenceCounted(false) }
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "syncker:wake").apply { setReferenceCounted(false) }
        // Lets local-network peer discovery packets through on Wi-Fi.
        multicastLock = getSystemService(WifiManager::class.java)?.createMulticastLock("syncker")?.apply {
            setReferenceCounted(false)
            acquire()
        }
        watchNetwork()
        scheduleWake()
        main.postDelayed(storageCheck, 5000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (worklet == null) startWorklet(intent?.getStringExtra(EXTRA_BOOTSTRAP))
        if (intent?.action == ACTION_WAKE) {
            // Periodic Doze wake-up: stay awake for a minute and look for peers.
            wakeLock?.acquire(WAKE_HOLD_MS)
            send(JSONObject().put("type", "sync"))
            scheduleWake()
        }
        return START_STICKY
    }

    private fun startWorklet(bootstrap: String?) {
        val home = File(filesDir, "syncker").apply { mkdirs() }.absolutePath
        val name = (Build.MODEL ?: "Android").trim()
        val shared = Environment.getExternalStorageDirectory().absolutePath
        storageOk = Environment.isExternalStorageManager()
        val args = arrayOf(home, defaultFolders(this), name, PORT.toString(), bootstrap ?: "-", shared, if (storageOk) "1" else "0")
        val w = Worklet(Worklet.Options())
        try {
            assets.open("syncker.bundle").use { w.start("/syncker.bundle", it, args) }
        } catch (e: Exception) {
            Log.e(TAG, "worklet failed to start", e)
            updateStatus("Failed to start: ${e.message}")
            return
        }
        worklet = w
        ipc = IPC(w).also { readLoop(it) }
    }

    private fun readLoop(ipc: IPC) {
        ipc.read { data: ByteBuffer?, error: Throwable? ->
            if (error != null) {
                Log.e(TAG, "ipc read failed", error)
                return@read
            }
            if (data != null) {
                val bytes = ByteArray(data.remaining()).also { data.get(it) }
                inbox.append(String(bytes, StandardCharsets.UTF_8))
                drainInbox()
            }
            readLoop(ipc)
        }
    }

    private fun drainInbox() {
        while (true) {
            val i = inbox.indexOf("\n")
            if (i < 0) return
            val line = inbox.substring(0, i)
            inbox.delete(0, i + 1)
            val msg = try { JSONObject(line) } catch (e: Exception) { continue }
            main.post { onMessage(msg) }
        }
    }

    private fun onMessage(msg: JSONObject) {
        when (msg.optString("type")) {
            "ready" -> {
                ready = true
                Log.i(TAG, "worklet ready on port ${msg.optInt("port")}")
                sendBroadcast(Intent("app.syncker.READY").setPackage(packageName))
            }
            "status" -> {
                updateStatus(msg.optString("text"), msg.optString("title", "Syncker"), msg.optInt("progress", -1))
                // Drive id -> folder, for FilesProvider and the storage check.
                getSharedPreferences("syncker", MODE_PRIVATE).edit()
                    .putString("folders", (msg.optJSONObject("folders") ?: JSONObject()).toString())
                    .apply()
                // Hold the CPU awake only while there is work in flight.
                if (msg.optBoolean("busy")) busyLock?.acquire(10 * 60 * 1000L) else busyLock?.release()
            }
            "fatal" -> {
                Log.e(TAG, "worklet fatal: ${msg.optString("message")}")
                updateStatus("Error: ${msg.optString("message").lineSequence().firstOrNull()}")
            }
        }
    }

    private fun send(msg: JSONObject) {
        val ipc = ipc ?: return
        val buf = ByteBuffer.wrap((msg.toString() + "\n").toByteArray(StandardCharsets.UTF_8))
        ipc.write(buf) { error -> if (error != null) Log.w(TAG, "ipc write failed", error) }
    }

    private fun watchNetwork() {
        val cm = getSystemService(ConnectivityManager::class.java)
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post { send(JSONObject().put("type", "sync")) }
            }
        }
        cm.registerDefaultNetworkCallback(cb)
        networkCallback = cb
    }

    private fun scheduleWake() {
        val am = getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(
            this, 0, Intent(this, WakeReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + WAKE_INTERVAL_MS, pi)
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL, "Sync status", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shows that Syncker is keeping your files in sync"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(statusTitle)
            .setContentText(statusText)
            .apply { if (progress >= 0) setProgress(100, progress, false) }
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun updateStatus(text: String, title: String = statusTitle, percent: Int = progress) {
        if (text == statusText && title == statusTitle && percent == progress) return
        statusText = text
        statusTitle = title
        progress = percent
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    override fun onDestroy() {
        running = false
        ready = false
        main.removeCallbacks(storageCheck)
        networkCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        multicastLock?.let { if (it.isHeld) it.release() }
        busyLock?.let { if (it.isHeld) it.release() }
        wakeLock?.let { if (it.isHeld) it.release() }
        try { ipc?.close() } catch (_: Exception) {}
        try { worklet?.terminate() } catch (_: Exception) {}
        worklet = null
        super.onDestroy()
    }
}
