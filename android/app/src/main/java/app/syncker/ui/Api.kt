package app.syncker.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import app.syncker.LocalApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

class ApiError(message: String, val status: Int = 0) : Exception(message)

/** The engine's HTTP API (lib/web.js), over the app's private socket. */
class Api(private val context: Context) {
    private fun target(path: String, query: Map<String, Any?>): String {
        val q = query.filterValues { it != null }.entries.joinToString("&") { (k, v) -> Uri.encode(k) + "=" + Uri.encode(v.toString()) }
        return if (q.isEmpty()) path else "$path?$q"
    }

    private suspend fun call(method: String, path: String, query: Map<String, Any?> = emptyMap(), body: Any? = null): String = withContext(Dispatchers.IO) {
        val bytes = body?.toString()?.toByteArray(StandardCharsets.UTF_8)
        val res = try {
            LocalApi.request(context, method, target(path, query), if (bytes != null) mapOf("Content-Type" to "application/json") else emptyMap(),
                bytes?.let { ByteArrayInputStream(it) }, bytes?.size?.toLong() ?: -1)
        } catch (e: IOException) {
            throw ApiError("Syncker is starting, try again in a moment")
        }
        val text = res.text
        if (res.status !in 200..299) {
            val msg = try { JSONObject(text).optString("error") } catch (_: Exception) { "" }
            throw ApiError(msg.ifBlank { res.reason }, res.status)
        }
        text
    }

    private suspend fun obj(method: String, path: String, query: Map<String, Any?> = emptyMap(), body: Any? = null): JSONObject {
        val t = call(method, path, query, body)
        return if (t.isBlank() || t == "null") JSONObject() else JSONObject(t)
    }

    suspend fun status() = Status.of(obj("GET", "/api/status"))
    suspend fun list(space: String, dir: String) = obj("GET", "/api/list", mapOf("space" to space, "dir" to dir))
    suspend fun search(q: String) = Item.list(obj("GET", "/api/search", mapOf("q" to q)))
    suspend fun recent() = Item.list(obj("GET", "/api/recent"))
    suspend fun details(space: String, path: String) = obj("GET", "/api/details", mapOf("space" to space, "path" to path))
    suspend fun versions(space: String, path: String) = JSONArray(call("GET", "/api/versions", mapOf("space" to space, "path" to path)))
    suspend fun mkdir(space: String, path: String) = obj("POST", "/api/mkdir", mapOf("space" to space, "path" to path))
    suspend fun move(space: String, from: String, to: String) = obj("POST", "/api/move", mapOf("space" to space, "from" to from, "to" to to))
    suspend fun delete(space: String, path: String) = obj("DELETE", "/api/file", mapOf("space" to space, "path" to path))
    suspend fun syncNow(space: String?) = obj("POST", "/api/sync", mapOf("space" to space))

    suspend fun setup(body: JSONObject) = Status.of(obj("POST", "/api/setup", body = body))
    suspend fun addDrive(body: JSONObject) = obj("POST", "/api/spaces", body = body)
    suspend fun suggestFolder(name: String) = obj("GET", "/api/spaces/suggest", mapOf("name" to name)).optString("folder")
    suspend fun renameDrive(space: String, name: String) = obj("POST", "/api/spaces/rename", mapOf("space" to space), JSONObject().put("name", name))
    suspend fun leaveDrive(space: String) = obj("POST", "/api/spaces/leave", mapOf("space" to space))
    suspend fun allowRemote(space: String, allow: Boolean) = obj("POST", "/api/spaces/remote", mapOf("space" to space), JSONObject().put("allow", allow))
    suspend fun camera(on: Boolean, folder: String?): JSONObject? {
        val t = call("POST", "/api/camera", body = JSONObject().put("on", on).put("folder", folder ?: JSONObject.NULL))
        return if (t.isBlank() || t == "null") null else JSONObject(t)
    }

    /** body: { path, sync } | { paths, sync } | { excluded } | { base, paths, sync } (a draft: nothing applied). */
    suspend fun selective(space: String, body: JSONObject, device: String? = null) =
        obj("POST", "/api/selective", mapOf("space" to space, "device" to device), body)
    suspend fun tree(space: String, dir: String, device: String?) = TreeLevel.of(obj("GET", "/api/tree", mapOf("space" to space, "dir" to dir, "device" to device)))
    suspend fun treeSelected(space: String, excluded: List<String>) = obj("POST", "/api/tree/selected", mapOf("space" to space), JSONObject().put("excluded", JSONArray(excluded)))
    suspend fun fsTree(folder: String, dir: String, ignore: Boolean) = TreeLevel.of(obj("GET", "/api/fs/tree", mapOf("folder" to folder, "dir" to dir, "ignore" to if (ignore) 1 else 0)))
    suspend fun fsSize(folder: String, dir: String, ignore: Boolean) = obj("GET", "/api/fs/size", mapOf("folder" to folder, "dir" to dir, "ignore" to if (ignore) 1 else 0))
    suspend fun fsToggle(body: JSONObject) = obj("POST", "/api/fs/toggle", body = body).optJSONArray("excluded")?.toStrings() ?: emptyList()
    suspend fun fsBrowse(path: String?) = obj("GET", "/api/fs/browse", mapOf("path" to path))
    suspend fun fsMkdir(path: String, name: String) = obj("POST", "/api/fs/mkdir", body = JSONObject().put("path", path).put("name", name))

    /** The invite's QR code: rows of '1' (dark) and '0'. */
    suspend fun inviteQr(space: String): List<String> = obj("GET", "/api/invite.json", mapOf("space" to space)).optJSONArray("rows")?.toStrings() ?: emptyList()

    /** A Syncker invite in a photo of a QR code, or null. Tries a few sizes, of the whole photo and of its middle. */
    suspend fun readQr(photo: Bitmap): String? = withContext(Dispatchers.Default) {
        for (part in listOf(1.0, 0.6)) {
            val sw = (photo.width * part).toInt(); val sh = (photo.height * part).toInt()
            val crop = Bitmap.createBitmap(photo, (photo.width - sw) / 2, (photo.height - sh) / 2, sw, sh)
            for (max in listOf(1000, 1600, 600)) {
                val scale = minOf(1.0, max.toDouble() / maxOf(sw, sh))
                val w = (sw * scale).toInt().coerceAtLeast(1); val h = (sh * scale).toInt().coerceAtLeast(1)
                val small = Bitmap.createScaledBitmap(crop, w, h, true).copy(Bitmap.Config.ARGB_8888, false)
                // Android keeps ARGB_8888 as RGBA bytes in memory: what jsQR reads.
                val buf = ByteBuffer.allocate(w * h * 4)
                small.copyPixelsToBuffer(buf)
                val t = try {
                    withContext(Dispatchers.IO) {
                        val res = LocalApi.request(context, "POST", target("/api/qr", mapOf("w" to w, "h" to h)), emptyMap(), ByteArrayInputStream(buf.array()), buf.capacity().toLong())
                        JSONObject(res.text).let { if (it.isNull("text")) null else it.optString("text") }
                    }
                } catch (_: Exception) { null }
                val hit = t?.trim()
                if (hit != null && hit.startsWith("syncker:", true)) return@withContext hit
                if (scale == 1.0) break
            }
        }
        null
    }

    private val thumbs = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    fun cachedThumb(key: String): Bitmap? = thumbs.get(key)

    /** The small preview of a photo (the one stored in its EXIF data when it has one). */
    suspend fun thumb(space: String, path: String, mtime: Long?, px: Int): Bitmap? = withContext(Dispatchers.IO) {
        val key = "$space\u0000$path\u0000$mtime"
        thumbs.get(key)?.let { return@withContext it }
        try {
            val res = LocalApi.request(context, "GET", target("/api/thumb", mapOf("space" to space, "path" to path, "v" to (mtime ?: 0))))
            if (res.status != 200) { res.body.close(); return@withContext null }
            val bytes = res.body.use(InputStream::readBytes)
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
            var sample = 1
            while (o.outWidth / (sample * 2) >= px && o.outHeight / (sample * 2) >= px) sample *= 2
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return@withContext null
            thumbs.put(key, bmp)
            bmp
        } catch (_: Exception) { null }
    }

    /** The engine's status, pushed whenever it changes (GET /api/events). Reconnects on its own. */
    fun events(): Flow<JSONObject> = callbackFlow {
        var open: LocalApi.Response? = null
        val job = launch(Dispatchers.IO) {
            while (isActive) {
                try {
                    val res = LocalApi.request(context, "GET", "/api/events")
                    open = res
                    res.body.bufferedReader(StandardCharsets.UTF_8).use { r ->
                        val data = StringBuilder()
                        while (isActive) {
                            val line = r.readLine() ?: break
                            when {
                                line.startsWith("data:") -> data.append(line.substring(5).trimStart())
                                line.isEmpty() && data.isNotEmpty() -> {
                                    try { trySend(JSONObject(data.toString())) } catch (_: Exception) {}
                                    data.setLength(0)
                                }
                            }
                        }
                    }
                } catch (_: Exception) {}
                trySend(JSONObject().put("_disconnected", true))
                delay(1000)
            }
        }
        // Closing the connection ends the blocked read.
        awaitClose { job.cancel(); try { open?.body?.close() } catch (_: Exception) {} }
    }.flowOn(Dispatchers.IO)
}
