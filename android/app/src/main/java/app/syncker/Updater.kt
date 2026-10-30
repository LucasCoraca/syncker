package app.syncker

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * New versions come from the GitHub releases: the latest release's APK for this
 * phone's CPU, installed through Android's installer (which only accepts an
 * update signed with the same key as the installed app).
 */
object Updater {
    private const val LATEST = "https://api.github.com/repos/LucasCoraca/syncker/releases/latest"
    private const val EVERY = 12 * 3600 * 1000L

    class Update(val version: String, val notes: String, val url: String, val size: Long)

    fun current(context: Context): String = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0"

    /** Whether version [a] (like "1.2.10") is newer than [b]. */
    fun newer(a: String, b: String): Boolean {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
            if (d != 0) return d > 0
        }
        return false
    }

    private fun prefs(context: Context) = context.getSharedPreferences("syncker-update", Context.MODE_PRIVATE)

    /** Whether it's time for the automatic check (twice a day at most). */
    fun due(context: Context) = System.currentTimeMillis() - prefs(context).getLong("checked", 0) > EVERY

    /** Whether the user let Syncker install apps ("Install unknown apps" in Settings). */
    fun allowed(context: Context) = context.packageManager.canRequestPackageInstalls()

    fun skip(context: Context, version: String) = prefs(context).edit().putString("skip", version).apply()

    /**
     * The newer version on GitHub, if there is one this phone can install. Blocking.
     * [manual] checks also offer a version the user skipped.
     */
    fun check(context: Context, manual: Boolean): Update? {
        prefs(context).edit().putLong("checked", System.currentTimeMillis()).apply()
        val c = URL(LATEST).openConnection() as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 15000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        val j = try {
            if (c.responseCode != 200) throw IOException("GitHub answered ${c.responseCode}")
            JSONObject(c.inputStream.bufferedReader().readText())
        } finally { c.disconnect() }
        val version = j.optString("tag_name").removePrefix("v")
        if (!newer(version, current(context))) return null
        if (!manual && prefs(context).getString("skip", null) == version) return null
        val assets = j.optJSONArray("assets") ?: return null
        val names = List(assets.length()) { assets.getJSONObject(it) }
        // Release APKs are named syncker-<version>-<arm64|arm32>.apk.
        for (abi in Build.SUPPORTED_ABIS) {
            val tag = when (abi) { "arm64-v8a" -> "arm64"; "armeabi-v7a" -> "arm32"; else -> abi }
            val a = names.firstOrNull { it.optString("name").endsWith("-$tag.apk") } ?: continue
            return Update(version, notes(j.optString("body")), a.optString("browser_download_url"), a.optLong("size"))
        }
        return null
    }

    /** The "What's new" part of the release notes, without Markdown marks. */
    private fun notes(body: String): String {
        val part = body.substringAfter("## What's new", body).substringBefore("\n## ")
        return part.lines().map { it.trim().replace("**", "").replace("`", "") }.filter { it.isNotEmpty() }
            .joinToString("\n") { if (it.startsWith("- ")) "• " + it.substring(2) else it }
    }

    /** Downloads the APK to the app's cache, reporting the bytes so far. Blocking. */
    fun download(context: Context, u: Update, progress: (Long) -> Unit): File {
        val dir = File(context.cacheDir, "update").apply { deleteRecursively(); mkdirs() }
        val file = File(dir, "syncker-${u.version}.apk")
        var url = URL(u.url)
        // GitHub redirects to its file host; follow it ourselves (always https).
        repeat(5) {
            val c = url.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = 15000; c.readTimeout = 30000
            try {
                val code = c.responseCode
                if (code in 300..399) {
                    url = URL(url, c.getHeaderField("Location") ?: throw IOException("Bad redirect"))
                    if (url.protocol != "https") throw IOException("Insecure download link")
                    return@repeat
                }
                if (code != 200) throw IOException("Download failed ($code)")
                var got = 0L
                c.inputStream.use { input ->
                    file.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            got += n
                            progress(got)
                        }
                    }
                }
                if (u.size > 0 && got != u.size) throw IOException("Download incomplete")
                return file
            } finally { c.disconnect() }
        }
        throw IOException("Too many redirects")
    }

    /** Hands the APK to Android's installer, which asks the user to confirm. */
    fun install(context: Context, apk: File) {
        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        params.setSize(apk.length())
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("syncker.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; s.fsync(out) }
            val done = Intent(context, InstallReceiver::class.java)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE // the installer adds its result
            s.commit(PendingIntent.getBroadcast(context, id, done, flags).intentSender)
        }
    }
}

/** The installer's answer: show its confirmation screen, or why it failed. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> {}
            PackageInstaller.STATUS_FAILURE_ABORTED -> {}
            else -> {
                val why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"
                Toast.makeText(context, "The update was not installed: $why", Toast.LENGTH_LONG).show()
            }
        }
    }
}
