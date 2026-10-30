package app.syncker

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.lifecycle.lifecycleScope
import app.syncker.ui.AppModel
import app.syncker.ui.Host
import app.syncker.ui.SynckerApp
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors

/**
 * The app window: the native screens (app.syncker.ui), which talk to the sync
 * engine over its private socket ([LocalApi]). Before the first start it asks
 * for the permissions that make background sync work.
 */
class MainActivity : ComponentActivity(), Host {
    companion object {
        private const val REQ_NOTIFY = 2
        private const val REQ_STORAGE = 3
        private const val REQ_BATTERY = 4
        private const val REQ_PHOTO = 6
        private const val REQ_PHOTO_CAMERA = 7
        private const val REQ_UPLOAD = 8
    }

    private lateinit var model: AppModel
    private var started = false
    private var uploadTo: Pair<String, String>? = null
    private val uploader = Executors.newSingleThreadExecutor()
    private var uploadSeq = 0
    private var scanDone: ((String?) -> Unit)? = null

    private val readyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { load() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = AppModel(this, lifecycleScope, this)
        inviteFrom(intent)?.let(model::openInvite)
        setContent {
            BackHandler { if (!model.back()) moveTaskToBack(true) } // keep syncing, don't finish
            SynckerApp(model)
        }
        registerReceiver(readyReceiver, IntentFilter("app.syncker.READY"), RECEIVER_NOT_EXPORTED)
        // Sync runs regardless of the permission prompts below.
        startSync()
        askPermissions()
    }

    override fun onResume() {
        super.onResume()
        if (prefs.getBoolean("asked_storage", false)) checkLostStorage()
    }

    /** Sync is paused if the folder is in shared storage and access was revoked. */
    private fun checkLostStorage() {
        if (Environment.isExternalStorageManager()) return
        val shared = Environment.getExternalStorageDirectory().absolutePath
        val folder = FilesProvider.folders(this).values.firstOrNull { it.startsWith(shared) } ?: return
        AlertDialog.Builder(this)
            .setTitle("Sync is paused")
            .setMessage("Syncker can no longer open $folder. Allow \"All files access\" again to resume syncing. Nothing was deleted.")
            .setPositiveButton("Open settings") { _, _ -> openStorageSettings() }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun openStorageSettings() {
        try {
            startActivityForResult(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")), REQ_STORAGE)
        } catch (e: ActivityNotFoundException) {
            startActivityForResult(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), REQ_STORAGE)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        inviteFrom(intent)?.let(model::openInvite)
    }

    /** A scanned invite QR code opens the app with syncker:<key>. */
    private fun inviteFrom(intent: Intent?): String? {
        val data = intent?.data ?: return null
        if (intent.action != Intent.ACTION_VIEW || data.scheme != "syncker") return null
        return data.toString()
    }

    override fun onDestroy() {
        unregisterReceiver(readyReceiver)
        uploader.shutdown()
        super.onDestroy()
    }

    // ---- permissions: storage -> notifications -> battery -> start ----------

    private val prefs get() = getSharedPreferences("syncker", MODE_PRIVATE)

    private fun askPermissions() {
        if (!Environment.isExternalStorageManager() && !prefs.getBoolean("asked_storage", false)) {
            prefs.edit().putBoolean("asked_storage", true).apply()
            AlertDialog.Builder(this)
                .setTitle("Keep your files in shared storage")
                .setMessage("Syncker keeps your synced folder at Internal storage/Syncker so your gallery and file manager can see it. Allow \"All files access\" on the next screen.\n\nIf you skip this, files stay inside the app's own folder.")
                .setPositiveButton("Continue") { _, _ -> openStorageSettings() }
                .setNegativeButton("Skip") { _, _ -> askNotifications() }
                .setCancelable(false)
                .show()
            return
        }
        askNotifications()
    }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !prefs.getBoolean("asked_notify", false)) {
            prefs.edit().putBoolean("asked_notify", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
            return
        }
        askBattery()
    }

    @SuppressLint("BatteryLife")
    private fun askBattery() {
        val pm = getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(packageName) && !prefs.getBoolean("asked_battery", false)) {
            prefs.edit().putBoolean("asked_battery", true).apply()
            // Without this, Doze cuts the network and files only sync while the phone is in use.
            try {
                startActivityForResult(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")), REQ_BATTERY)
            } catch (_: ActivityNotFoundException) {}
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIFY) askBattery()
        if (requestCode == REQ_PHOTO_CAMERA) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) takePhoto() else finishScan(null)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_STORAGE -> {
                model.load() // the default folder may have changed to shared storage
                askNotifications()
            }
            REQ_PHOTO -> {
                val shot = PhotoProvider.file(this)
                if (resultCode != RESULT_OK || shot.length() == 0L) return finishScan(null)
                model.toast("Reading the QR code…")
                lifecycleScope.launch {
                    val bmp = try {
                        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeFile(shot.path, o)
                        var sample = 1
                        while (maxOf(o.outWidth, o.outHeight) / (sample * 2) >= 2400) sample *= 2
                        BitmapFactory.decodeFile(shot.path, BitmapFactory.Options().apply { inSampleSize = sample })
                    } catch (_: Exception) { null }
                    val text = bmp?.let { model.api.readQr(it) }
                    if (text == null) model.toast("No Syncker invite found in the photo. Try again a little closer, with the whole code in view.")
                    finishScan(text)
                }
            }
            REQ_UPLOAD -> {
                val to = uploadTo ?: return
                uploadTo = null
                if (resultCode != RESULT_OK || data == null) return
                val uris = data.clipData?.let { clip -> List(clip.itemCount) { clip.getItemAt(it).uri } } ?: listOfNotNull(data.data)
                for (uri in uris) uploader.execute { upload(to.first, to.second, uri) }
            }
        }
    }

    private fun startSync() {
        SyncService.start(this)
        if (SyncService.ready) load()
    }

    private fun load() {
        if (started) return
        started = true
        model.start()
    }

    // ---- what the screens ask of Android ----

    override fun openFile(space: String, path: String) {
        val uri = FilesProvider.uriFor(space, path)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, FilesProvider.mimeOf(path))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(Intent.createChooser(intent, path.substringAfterLast('/')))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "No app can open this file", Toast.LENGTH_SHORT).show()
        }
    }

    /** Pick files on the phone and add them to a folder of a drive. */
    override fun pickUploads(space: String, dir: String) {
        uploadTo = space to dir
        val pick = Intent(Intent.ACTION_GET_CONTENT).setType("*/*")
            .addCategory(Intent.CATEGORY_OPENABLE)
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        try {
            startActivityForResult(Intent.createChooser(pick, "Upload to Syncker"), REQ_UPLOAD)
        } catch (e: ActivityNotFoundException) {
            uploadTo = null
            Toast.makeText(this, "No app to pick files with", Toast.LENGTH_SHORT).show()
        }
    }

    // Streams one picked file to the engine, telling the screens how far it got.
    private fun upload(space: String, dir: String, uri: Uri) {
        var name = "upload"
        var size = -1L
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    if (!c.isNull(0)) name = c.getString(0)
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        } catch (_: Exception) {}
        name = name.replace('/', '_').ifBlank { "upload" }
        val path = (if (dir == "/") "" else dir.trimEnd('/')) + "/" + name
        val id = "a" + (++uploadSeq)
        val report = { bytes: Long, state: String, error: String? ->
            val u = JSONObject().put("id", id).put("space", space).put("path", path).put("size", size).put("bytes", bytes).put("state", state)
            if (error != null) u.put("error", error)
            runOnUiThread { model.onUpload(u) }
        }
        report(0, "active", null)
        try {
            val input = contentResolver.openInputStream(uri) ?: throw IOException("can't read the file")
            val res = LocalApi.request(this, "PUT", "/api/file?space=" + Uri.encode(space) + "&path=" + Uri.encode(path), emptyMap(), input, size) { sent -> report(sent, "active", null) }
            val text = res.text
            if (res.status in 200..299) report(maxOf(size, 0), "done", null)
            else report(0, "failed", try { JSONObject(text).optString("error", res.reason) } catch (_: Exception) { res.reason })
        } catch (e: Exception) {
            report(0, "failed", e.message ?: "upload failed")
        }
    }

    /** A photo of the invite's QR code from the camera app: sharp and focused, read by the engine. */
    override fun scanQr(onResult: (String?) -> Unit) {
        scanDone = onResult
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) takePhoto()
        else requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_PHOTO_CAMERA) // the camera app refuses us without it
    }

    private fun takePhoto() {
        PhotoProvider.file(this).delete()
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, PhotoProvider.URI)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        intent.clipData = ClipData.newRawUri("", PhotoProvider.URI)
        try {
            startActivityForResult(intent, REQ_PHOTO)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "No camera app found", Toast.LENGTH_SHORT).show()
            finishScan(null)
        }
    }

    private fun finishScan(text: String?) {
        val f = scanDone
        scanDone = null
        f?.invoke(text)
    }

    override fun copy(label: String, text: String) {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(label, text))
    }

    override fun share(text: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        try { startActivity(Intent.createChooser(send, "Share invite")) } catch (_: ActivityNotFoundException) {}
    }

    override fun exit() { moveTaskToBack(true) }
}
