package app.syncker

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException
import org.json.JSONObject

/**
 * Read-only content:// access to files of the shared drives, so other apps
 * (gallery, PDF viewer, ...) can open them. URIs: content://app.syncker.files/<drive id>/<relative path>
 * Files on this device are opened directly; online-only files are streamed
 * from the local Syncker server (which fetches them from other devices).
 */
class FilesProvider : ContentProvider() {
    companion object {
        const val AUTHORITY = "app.syncker.files"

        fun uriFor(space: String, relPath: String): Uri =
            Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(space.ifEmpty { "_" })
                .appendEncodedPath(Uri.encode(relPath.trimStart('/'), "/")).build()

        fun mimeOf(name: String): String =
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
                ?: "application/octet-stream"

        /** Drive id -> folder, as last reported by the worklet. */
        fun folders(context: Context): Map<String, String> {
            val json = context.getSharedPreferences("syncker", Context.MODE_PRIVATE).getString("folders", null) ?: return emptyMap()
            return try {
                val o = JSONObject(json)
                o.keys().asSequence().associateWith { o.getString(it) }
            } catch (e: Exception) { emptyMap() }
        }
    }

    private class Target(val space: String, val rel: String, val file: File?)

    private fun resolve(uri: Uri): Target {
        val segs = uri.pathSegments
        if (segs.isEmpty()) throw FileNotFoundException("no drive")
        val space = segs[0].takeIf { it != "_" } ?: ""
        val rel = segs.drop(1).joinToString("/")
        val all = folders(context!!)
        val folder = (if (space.isEmpty()) all.values.firstOrNull() else all[space]) ?: throw FileNotFoundException("unknown drive")
        val root = File(folder).canonicalFile
        val file = File(root, rel).canonicalFile
        if (!file.path.startsWith(root.path + File.separator)) throw FileNotFoundException("outside folder")
        return Target(space, rel, file.takeIf { it.isFile })
    }

    override fun onCreate() = true

    override fun getType(uri: Uri): String = mimeOf(uri.lastPathSegment ?: "")

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("read-only")
        val t = resolve(uri)
        t.file?.let { return ParcelFileDescriptor.open(it, ParcelFileDescriptor.MODE_READ_ONLY) }
        return stream(t)
    }

    // Online-only: pipe the download from the engine to the viewer.
    private fun stream(t: Target): ParcelFileDescriptor {
        val res = try {
            LocalApi.request(context!!, "GET", "/api/file?space=" + Uri.encode(t.space) + "&path=" + Uri.encode("/" + t.rel))
        } catch (e: java.io.IOException) {
            throw FileNotFoundException("not available: Syncker is not running")
        }
        if (res.status != 200) {
            res.body.close()
            throw FileNotFoundException("not available: no device that has it is online")
        }
        val pipe = ParcelFileDescriptor.createReliablePipe()
        Thread {
            ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { out ->
                try {
                    res.body.use { it.copyTo(out) }
                } catch (e: Exception) {
                    pipe[1].closeWithError(e.message ?: "download failed")
                }
            }
        }.start()
        return pipe[0]
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val t = resolve(uri)
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val name = t.rel.substringAfterLast('/')
        return MatrixCursor(cols, 1).apply {
            addRow(cols.map { if (it == OpenableColumns.SIZE) t.file?.length() else if (it == OpenableColumns.DISPLAY_NAME) name else null })
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
