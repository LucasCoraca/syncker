package app.syncker

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * One file the camera app writes its photo to (a picture of an invite QR code),
 * read back by the page: content://app.syncker.photo/scan.jpg
 */
class PhotoProvider : ContentProvider() {
    companion object {
        val URI: Uri = Uri.parse("content://app.syncker.photo/scan.jpg")
        fun file(context: Context) = File(context.cacheDir, "scan.jpg")
    }

    override fun onCreate() = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (uri.path != URI.path) throw FileNotFoundException(uri.toString())
        return ParcelFileDescriptor.open(file(context!!), ParcelFileDescriptor.parseMode(mode))
    }

    override fun getType(uri: Uri) = "image/jpeg"

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val cursor = MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE))
        cursor.addRow(arrayOf<Any>("scan.jpg", file(context!!).length()))
        return cursor
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
