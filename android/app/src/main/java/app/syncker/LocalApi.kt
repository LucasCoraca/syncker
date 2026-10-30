package app.syncker

import android.content.Context
import android.net.LocalSocket
import android.net.LocalSocketAddress
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets

/**
 * The engine's API, reached over a socket file in the app's private folder.
 * There is no network port: no other app on the phone can talk to it.
 *
 * A minimal HTTP/1.1 client: one connection per request (Connection: close),
 * bodies sent with a length or chunked, responses read with a length, chunked
 * or until the engine closes the connection.
 */
object LocalApi {
    fun socketFile(context: Context): File = File(File(context.filesDir, "syncker"), "api.sock")

    class Response(
        val status: Int,
        val reason: String,
        /** Header names in lower case. */
        val headers: Map<String, String>,
        /** Closing it closes the connection. */
        val body: InputStream
    ) {
        val text: String get() = body.use { String(it.readBytes(), StandardCharsets.UTF_8) }
    }

    /**
     * [body]: the request body, if any; [length]: its size, or -1 to send it
     * chunked; [progress]: bytes sent so far, called as the body goes out.
     */
    @Throws(IOException::class)
    fun request(
        context: Context,
        method: String,
        target: String,
        headers: Map<String, String> = emptyMap(),
        body: InputStream? = null,
        length: Long = -1,
        progress: ((Long) -> Unit)? = null
    ): Response {
        val sock = LocalSocket()
        try {
            sock.connect(LocalSocketAddress(socketFile(context).absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
            val out = sock.outputStream
            val head = StringBuilder("$method $target HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n")
            for ((k, v) in headers) {
                if (k.equals("host", true) || k.equals("connection", true) || k.equals("content-length", true) ||
                    k.equals("transfer-encoding", true) || k.equals("origin", true)) continue
                head.append(k).append(": ").append(v.replace("\r", "").replace("\n", "")).append("\r\n")
            }
            when {
                body == null -> head.append(if (method == "GET" || method == "HEAD") "" else "Content-Length: 0\r\n")
                length >= 0 -> head.append("Content-Length: $length\r\n")
                else -> head.append("Transfer-Encoding: chunked\r\n")
            }
            head.append("\r\n")
            out.write(head.toString().toByteArray(StandardCharsets.UTF_8))
            if (body != null) sendBody(out, body, length < 0, progress)
            out.flush()
            return readResponse(sock, method)
        } catch (e: IOException) {
            try { sock.close() } catch (_: IOException) {}
            throw e
        }
    }

    private fun sendBody(out: OutputStream, body: InputStream, chunked: Boolean, progress: ((Long) -> Unit)?) {
        val buf = ByteArray(64 * 1024)
        var sent = 0L
        var lastReport = 0L
        body.use {
            while (true) {
                val n = it.read(buf)
                if (n < 0) break
                if (n == 0) continue
                if (chunked) out.write((Integer.toHexString(n) + "\r\n").toByteArray())
                out.write(buf, 0, n)
                if (chunked) out.write("\r\n".toByteArray())
                sent += n
                val now = System.currentTimeMillis()
                if (progress != null && now - lastReport > 200) { lastReport = now; progress(sent) }
            }
        }
        if (chunked) out.write("0\r\n\r\n".toByteArray())
        progress?.invoke(sent)
    }

    private fun readResponse(sock: LocalSocket, method: String): Response {
        val input = BufferedInputStream(sock.inputStream, 64 * 1024)
        val statusLine = readLine(input) ?: throw IOException("the engine closed the connection")
        val parts = statusLine.split(" ", limit = 3)
        val status = parts.getOrNull(1)?.toIntOrNull() ?: throw IOException("bad response: $statusLine")
        val reason = parts.getOrNull(2)?.ifBlank { null } ?: "OK"
        val headers = LinkedHashMap<String, String>()
        while (true) {
            val line = readLine(input) ?: throw IOException("the engine closed the connection")
            if (line.isEmpty()) break
            val i = line.indexOf(':')
            if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
        val raw: InputStream = object : FilterInputStream(input) {
            override fun close() { try { super.close() } finally { sock.close() } }
        }
        val body = when {
            method == "HEAD" || status == 204 || status == 304 -> { raw.close(); InputStream.nullInputStream() }
            headers["transfer-encoding"]?.contains("chunked", true) == true -> Chunked(raw)
            headers["content-length"] != null -> Bounded(raw, headers["content-length"]!!.toLong())
            else -> raw
        }
        return Response(status, reason, headers, body)
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (buf.size() == 0) null else buf.toString("UTF-8")
            if (b == '\n'.code) break
            if (b != '\r'.code) buf.write(b)
            if (buf.size() > 64 * 1024) throw IOException("header line too long")
        }
        return buf.toString("UTF-8")
    }

    /** The first [left] bytes of a stream. */
    private class Bounded(private val src: InputStream, private var left: Long) : InputStream() {
        override fun read(): Int {
            if (left <= 0) return -1
            val b = src.read()
            if (b >= 0) left--
            return b
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = src.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
        override fun available(): Int = minOf(src.available().toLong(), left).toInt()
        override fun close() = src.close()
    }

    /** Decodes Transfer-Encoding: chunked. */
    private class Chunked(private val src: InputStream) : InputStream() {
        private var left = 0L
        private var done = false

        private fun next(): Boolean {
            if (done) return false
            if (left > 0) return true
            val line = readLine(src) ?: run { done = true; return false }
            val size = line.substringBefore(';').trim().ifEmpty { readLine(src)?.substringBefore(';')?.trim() ?: "0" }
            left = size.toLong(16)
            if (left == 0L) { done = true; return false }
            return true
        }

        override fun read(): Int {
            if (!next()) return -1
            val b = src.read()
            if (b < 0) { done = true; return -1 }
            if (--left == 0L) readLine(src)
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (!next()) return -1
            val n = src.read(b, off, minOf(len.toLong(), left).toInt())
            if (n < 0) { done = true; return -1 }
            left -= n
            if (left == 0L) readLine(src) // the CRLF after the chunk
            return n
        }

        override fun close() = src.close()
    }
}
