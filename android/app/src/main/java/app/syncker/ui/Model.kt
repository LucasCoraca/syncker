package app.syncker.ui

import org.json.JSONArray
import org.json.JSONObject

// What the engine reports (GET /api/status, the event stream and the listings),
// read from its JSON. Field names follow lib/app.js and lib/engine.js.

private fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k)
private fun JSONObject.long(k: String): Long? = if (has(k) && !isNull(k)) optLong(k) else null
private fun JSONObject.int(k: String): Int? = if (has(k) && !isNull(k)) optInt(k) else null
private fun JSONObject.bool(k: String): Boolean? = if (has(k) && !isNull(k)) optBoolean(k) else null
private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else List(length()) { optString(it) }
private fun <T> JSONArray?.map(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else List(length()) { f(getJSONObject(it)) }

data class Transfer(
    val id: String, val space: String, val dir: String, val path: String, val device: String?, val online: Boolean?,
    val preparing: Int?, val size: Long, val bytes: Long, val percent: Int, val speed: Long, val eta: Long?,
    val state: String, val finished: Long?, val error: String? = null
) {
    val moving get() = state == "active" || state == "saving" || state == "waiting"
    val name get() = path.substringAfterLast('/')

    companion object {
        fun of(j: JSONObject, space: String) = Transfer(
            j.optString("id"), space, j.optString("dir"), j.optString("path"), j.str("device"), j.bool("online"),
            j.int("preparing"), j.optLong("size"), j.optLong("bytes"), j.optInt("percent"), j.optLong("speed"),
            j.long("eta"), j.optString("state"), j.long("finished")
        )
    }
}

data class Peer(val key: String, val name: String, val online: Boolean, val lastSeen: Long?, val via: String?) {
    companion object {
        fun of(j: JSONObject) = Peer(j.optString("key"), j.optString("name"), j.optBoolean("online"), j.long("lastSeen"), j.str("via"))
    }
}

data class Hold(val ready: Boolean, val bytes: Long, val files: Int, val free: Long?) {
    companion object {
        fun of(j: JSONObject?) = j?.let { Hold(it.optBoolean("ready"), it.optLong("bytes"), it.optInt("files"), it.long("free")) }
    }
}

data class Selection(val excluded: List<String>, val allowRemote: Boolean?)

data class Drive(
    val id: String, val name: String, val invite: String, val camera: Boolean, val folder: String, val key: String,
    val phase: String, val error: String?, val lastSync: Long?,
    val pendingCount: Int, val pendingRev: String, val failed: List<Pair<String, String>>, val excluded: List<String>,
    val allowRemote: Boolean, val hold: Hold?, val listed: Boolean, val listing: JSONObject?,
    val selections: Map<String, Selection>, val transfers: List<Transfer>, val speedDown: Long, val speedUp: Long,
    val files: Int, val bytes: Long, val peers: List<Peer>, val network: JSONObject?, val direct: Boolean,
    val ignore: List<String>
) {
    val busy get() = transfers.any { it.state == "active" || it.state == "saving" } || phase == "syncing"

    companion object {
        fun of(j: JSONObject): Drive {
            val st = j.optJSONObject("status") ?: JSONObject()
            val sels = j.optJSONObject("selections")
            val id = j.optString("id")
            return Drive(
                id = id, name = j.optString("name"), invite = j.optString("invite"), camera = j.optBoolean("camera"),
                folder = j.optString("folder"), key = j.optString("key"),
                phase = st.optString("phase", "starting"), error = st.str("error"), lastSync = st.long("lastSync"),
                pendingCount = j.int("pendingCount") ?: (j.optJSONArray("pending")?.length() ?: 0),
                pendingRev = j.optString("pendingRev"),
                failed = j.optJSONArray("failed").map { it.optString("path") to it.optString("error") },
                excluded = j.optJSONArray("excluded").strings(), allowRemote = j.optBoolean("allowRemote", true),
                hold = Hold.of(j.optJSONObject("hold")), listed = j.optBoolean("listed", true), listing = j.optJSONObject("listing"),
                selections = sels?.keys()?.asSequence()?.associateWith { k ->
                    val r = sels.getJSONObject(k)
                    Selection(r.optJSONArray("excluded").strings(), r.bool("allowRemote"))
                } ?: emptyMap(),
                transfers = j.optJSONArray("transfers").map { Transfer.of(it, id) },
                speedDown = j.optJSONObject("speed")?.optLong("down") ?: 0, speedUp = j.optJSONObject("speed")?.optLong("up") ?: 0,
                files = j.optJSONObject("totals")?.optInt("files") ?: 0, bytes = j.optJSONObject("totals")?.optLong("bytes") ?: 0,
                peers = j.optJSONArray("peers").map(Peer::of), network = j.optJSONObject("network"),
                direct = j.optBoolean("direct"), ignore = j.optJSONArray("ignore").strings()
            )
        }
    }
}

data class Camera(val folder: String, val asked: Boolean, val space: String?)

data class Status(
    val configured: Boolean, val platform: String, val device: String, val defaultFolder: String, val defaultName: String,
    val camera: Camera?, val drives: List<Drive>
) {
    companion object {
        fun of(j: JSONObject): Status {
            val cam = j.optJSONObject("camera")
            return Status(
                j.optBoolean("configured"), j.optString("platform"), j.optString("device"), j.optString("defaultFolder"),
                j.optString("defaultName"),
                cam?.let { Camera(it.optString("folder"), it.optBoolean("asked"), it.str("space")) },
                j.optJSONArray("spaces").map(Drive::of)
            )
        }
    }
}

data class Copies(val have: Int, val missing: List<String>)

/** A file or folder in a listing, a search or Recent. */
data class Item(
    val name: String, val path: String, val dir: Boolean, val size: Long?, val mtime: Long?, val synced: Boolean?,
    val device: String?, val local: Boolean, val online: Boolean, val pending: Boolean, val copies: Copies?,
    val files: Int?, val space: String?, val spaceName: String?
) {
    companion object {
        fun of(j: JSONObject) = Item(
            j.optString("name"), j.optString("path"), j.optBoolean("dir"), j.long("size"), j.long("mtime"), j.bool("synced"),
            j.str("device"), j.optBoolean("local", true), j.optBoolean("online"), j.optBoolean("pending"),
            j.optJSONObject("copies")?.let { Copies(it.optInt("have"), it.optJSONArray("missing").strings()) },
            j.int("files"), j.str("space"), j.str("spaceName")
        )

        fun list(j: JSONObject) = j.optJSONArray("items").map(::of)
    }
}

/** One level of "choose what to sync": a drive's (/api/tree) or a folder's on disk (/api/fs/tree). */
data class TreeFolder(val path: String, val name: String, val files: Int?, val bytes: Long?, val hasFolders: Boolean)
data class Loose(val files: Int, val bytes: Long, val paths: List<String>)
data class TreeLevel(val files: Int?, val bytes: Long?, val folders: List<TreeFolder>, val loose: Loose?, val excluded: List<String>) {
    companion object {
        fun of(j: JSONObject) = TreeLevel(
            j.int("files"), j.long("bytes"),
            j.optJSONArray("folders").map { TreeFolder(it.optString("path"), it.optString("name"), it.int("files"), it.long("bytes"), it.optBoolean("folders", true)) },
            j.optJSONObject("loose")?.let { Loose(it.optInt("files"), it.optLong("bytes"), it.optJSONArray("paths").strings()) },
            j.optJSONArray("excluded").strings()
        )
    }
}

fun JSONArray.toStrings(): List<String> = strings()
