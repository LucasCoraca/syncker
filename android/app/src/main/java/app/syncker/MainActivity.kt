package app.syncker

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.ClipData
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.provider.MediaStore
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

/**
 * The app window: a WebView of the sync engine's local web UI. Before the
 * first start it asks for the permissions that make background sync work.
 */
class MainActivity : Activity() {
    companion object {
        private const val REQ_FILES = 1
        private const val REQ_NOTIFY = 2
        private const val REQ_STORAGE = 3
        private const val REQ_BATTERY = 4
        private const val REQ_CAMERA = 5
        private const val REQ_PHOTO = 6
        private const val REQ_PHOTO_CAMERA = 7
        private const val HOME = "http://127.0.0.1:${SyncService.PORT}/"
    }

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraRequest: PermissionRequest? = null
    private var pendingInvite: String? = null
    private val main = Handler(Looper.getMainLooper())
    private var loaded = false

    private val readyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { load() }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Debug builds: allow chrome://inspect / DevTools (used by the UI tests).
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            overScrollMode = View.OVER_SCROLL_NEVER
            webViewClient = Client()
            webChromeClient = Chrome()
        }
        setContentView(web)
        pendingInvite = inviteFrom(intent)
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
        val invite = inviteFrom(intent) ?: return
        if (loaded) web.loadUrl(homeUrl(invite)) else pendingInvite = invite
    }

    /** A scanned invite QR code opens the app with syncker:<key>. */
    private fun inviteFrom(intent: Intent?): String? {
        val data = intent?.data ?: return null
        if (intent.action != Intent.ACTION_VIEW || data.scheme != "syncker") return null
        return data.toString()
    }

    private fun homeUrl(invite: String?) =
        if (invite == null) HOME else HOME + "?invite=" + Uri.encode(invite)

    override fun onDestroy() {
        unregisterReceiver(readyReceiver)
        web.destroy()
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

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == REQ_NOTIFY) askBattery()
        if (requestCode == REQ_PHOTO_CAMERA) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) takePhoto() else { fileCallback?.onReceiveValue(null); fileCallback = null }
        }
        if (requestCode == REQ_CAMERA) {
            val req = cameraRequest ?: return
            cameraRequest = null
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else req.deny()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        when (requestCode) {
            REQ_STORAGE -> {
                if (loaded) web.reload() // default folder may have changed to shared storage
                askNotifications()
            }
            REQ_BATTERY -> {}
            REQ_PHOTO -> {
                val shot = PhotoProvider.file(this)
                fileCallback?.onReceiveValue(if (resultCode == RESULT_OK && shot.length() > 0) arrayOf(PhotoProvider.URI) else null)
                fileCallback = null
            }
            REQ_FILES -> {
                val uris = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
                    ?: data?.clipData?.let { clip -> Array(clip.itemCount) { clip.getItemAt(it).uri } }
                fileCallback?.onReceiveValue(uris)
                fileCallback = null
            }
        }
    }

    private fun startSync() {
        SyncService.start(this)
        if (SyncService.ready) load()
    }

    private fun load() {
        if (loaded) return
        loaded = true
        web.loadUrl(homeUrl(pendingInvite))
        pendingInvite = null
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // The page first closes what is open (a menu, a dialog, a selection).
        web.evaluateJavascript("typeof onBack === 'function' && onBack()") { handled ->
            if (handled != "true") {
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true) // keep syncing, don't finish
            }
        }
    }

    // ---- WebView glue ---------------------------------------------------

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.host == "127.0.0.1" && url.path == "/api/file") {
                openFile(url.getQueryParameter("space") ?: "", url.getQueryParameter("path") ?: return true)
                return true
            }
            if (url.host != "127.0.0.1") {
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }
            return false
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            // The engine may still be starting: retry shortly.
            if (request.isForMainFrame) main.postDelayed({ view.loadUrl(request.url.toString()) }, 700)
        }
    }

    private inner class Chrome : WebChromeClient() {
        // getUserMedia from the local UI (QR scanner): only camera, only for our own page.
        override fun onPermissionRequest(request: PermissionRequest) {
            if (request.origin.host != "127.0.0.1" || !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                request.deny()
                return
            }
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            } else {
                cameraRequest?.deny()
                cameraRequest = request
                requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
            }
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            // <input capture> (the QR code scanner): a photo from the camera app.
            if (params.isCaptureEnabled && params.acceptTypes.any { it.startsWith("image/") }) {
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) takePhoto()
                else requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_PHOTO_CAMERA) // the camera app refuses us without it
                return true
            }
            val intent = params.createIntent().apply {
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            return try {
                startActivityForResult(intent, REQ_FILES)
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }
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
            fileCallback?.onReceiveValue(null)
            fileCallback = null
        }
    }

    private fun openFile(space: String, relPath: String) {
        val uri = FilesProvider.uriFor(space, relPath)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, FilesProvider.mimeOf(relPath))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(Intent.createChooser(intent, relPath.substringAfterLast('/')))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "No app can open this file", Toast.LENGTH_SHORT).show()
        }
    }
}
