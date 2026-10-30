package app.syncker.ui

import java.text.DateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

// Text helpers, as in lib/ui.html: the app and the web UI word things alike.

fun size(n: Long?): String {
    if (n == null) return ""
    val u = listOf("B", "KB", "MB", "GB", "TB")
    var v = n.toDouble()
    var i = 0
    while (v >= 1024 && i < u.size - 1) { v /= 1024; i++ }
    return if (i == 0) "$n B" else (if (v < 10) String.format(Locale.US, "%.1f", v) else String.format(Locale.US, "%.0f", v)) + " " + u[i]
}

private fun sameDay(a: Calendar, b: Calendar) = a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)

/** Today: the time; this year: "Oct 21"; before: "Oct 21, 2025". */
fun whenText(t: Long?): String {
    if (t == null || t == 0L) return ""
    val d = Calendar.getInstance().apply { timeInMillis = t }
    val now = Calendar.getInstance()
    if (sameDay(d, now)) return DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(t))
    val pattern = if (d.get(Calendar.YEAR) == now.get(Calendar.YEAR)) "MMM d" else "MMM d, yyyy"
    return java.text.SimpleDateFormat(pattern, Locale.getDefault()).format(Date(t))
}

fun fullDate(t: Long): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(t))

fun ago(t: Long): String {
    val s = (System.currentTimeMillis() - t) / 1000
    return when {
        s < 60 -> "just now"
        s < 3600 -> "${s / 60} min ago"
        s < 86400 -> "${s / 3600} h ago"
        else -> whenText(t)
    }
}

fun eta(s: Long?): String = when {
    s == null -> ""
    s < 60 -> "$s s left"
    s < 3600 -> "${s / 60} min left"
    else -> "${s / 3600} h left"
}

fun count(n: Int, one: String, many: String) = if (n == 1) one else "${"%,d".format(n)} $many"
fun filesText(n: Int?): String = when (n) { null -> ""; 0 -> "Empty"; else -> count(n, "1 file", "files") }
fun folderText(it: Item): String = if ((it.files ?: 0) > 0) filesText(it.files) + " · " + size(it.size) else filesText(it.files)

private val EXT = mapOf(
    "image" to listOf("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "svg", "avif"),
    "video" to listOf("mp4", "mov", "mkv", "webm", "avi", "3gp", "m4v"),
    "audio" to listOf("mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"),
    "pdf" to listOf("pdf"),
    "doc" to listOf("doc", "docx", "odt", "txt", "md", "rtf"),
    "sheet" to listOf("xls", "xlsx", "ods", "csv"),
    "slide" to listOf("ppt", "pptx", "odp", "key"),
    "zip" to listOf("zip", "tar", "gz", "7z", "rar", "xz", "bz2", "apk"),
    "code" to listOf("js", "ts", "py", "json", "html", "css", "sh", "c", "cpp", "h", "rs", "go", "java", "kt", "xml", "yml", "yaml")
)
private val KIND_NAME = mapOf("image" to "image", "video" to "video", "audio" to "audio", "pdf" to "document", "doc" to "document",
    "sheet" to "spreadsheet", "slide" to "presentation", "zip" to "archive", "code" to "source file", "file" to "file")

fun ext(name: String) = if (name.contains('.')) name.substringAfterLast('.').lowercase() else ""
fun kind(name: String, dir: Boolean = false): String {
    if (dir) return "folder"
    val e = ext(name)
    return EXT.entries.firstOrNull { e in it.value }?.key ?: "file"
}
fun kind(it: Item) = kind(it.name, it.dir)
fun typeName(it: Item) = if (it.dir) "Folder" else ext(it.name).let { e -> if (e.isEmpty()) "File" else e.uppercase() + " " + KIND_NAME[kind(it)] }

fun parentOf(p: String) = p.substringBeforeLast('/').ifEmpty { "/" }
fun joinPath(d: String, name: String) = (if (d == "/") "" else d) + "/" + name

/** Selective sync rules: "/a" online only, "+/a/b" synced anyway; the longest matching rule wins (offBy in engine.js). */
fun offBy(rules: List<String>, p: String): Boolean {
    var best = -1
    var off = false
    for (r in rules) {
        val inc = r.startsWith("+")
        val q = if (inc) r.substring(1) else r
        if (!(q == "/" || p == q || p.startsWith("$q/"))) continue
        if (q.length > best) { best = q.length; off = !inc }
    }
    return off
}

fun inviteName(invite: String): String {
    val m = Regex("[?&]name=([^&#\\s]*)").find(invite) ?: return ""
    return try { java.net.URLDecoder.decode(m.groupValues[1], "UTF-8") } catch (_: Exception) { "" }
}

/** Phones and computers get their own icon, guessed from the device name. */
fun deviceIcon(name: String) = if (Regex("^(SM-|Pixel|moto|Redmi|M2|CPH|RMX|Galaxy|iPhone|phone|android|sdk_gphone)", RegexOption.IGNORE_CASE).containsMatchIn(name)) "i-phone" else "i-laptop"

val CONFLICT = Regex("\\(conflict ")
