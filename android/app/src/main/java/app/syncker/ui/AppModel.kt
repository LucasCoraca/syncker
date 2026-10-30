package app.syncker.ui

import android.content.Context
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.Collator
import java.util.Calendar

enum class Screen { Files, Recent, Search, Manage }

data class Sort(val key: String = "name", val asc: Boolean = true, val folders: Boolean = true)
data class Filter(val type: String = "", val avail: String = "", val whenAgo: String = "") {
    val on get() = type.isNotEmpty() || avail.isNotEmpty() || whenAgo.isNotEmpty()
}

val SORTS = listOf(
    Triple("name", true, "Name (A to Z)"), Triple("name", false, "Name (Z to A)"),
    Triple("mtime", false, "Newest first"), Triple("mtime", true, "Oldest first"),
    Triple("size", false, "Largest first"), Triple("size", true, "Smallest first"),
    Triple("type", true, "Type"), Triple("device", true, "Modified by")
)
fun sortLabel(s: Sort) = (SORTS.firstOrNull { it.first == s.key && it.second == s.asc } ?: SORTS.firstOrNull { it.first == s.key } ?: SORTS[0]).third

val FILTERS = linkedMapOf(
    "type" to ("Type" to listOf("image" to "Photos", "video" to "Videos", "audio" to "Audio", "docs" to "Documents", "zip" to "Archives")),
    "avail" to ("Availability" to listOf("here" to "On this device", "online" to "Online only", "syncing" to "Syncing", "conflict" to "Conflicts")),
    "when" to ("Modified" to listOf("today" to "Today", "7" to "Last 7 days", "30" to "Last 30 days", "year" to "This year"))
)

/** What the app needs from Android itself (MainActivity). */
interface Host {
    fun openFile(space: String, path: String)
    fun pickUploads(space: String, dir: String)
    fun scanQr(onResult: (String?) -> Unit)
    fun copy(label: String, text: String)
    fun share(text: String)
    fun exit()
}

/** A dialog on screen. */
sealed class Dialog {
    class Ask(val title: String, val text: String = "", val value: String? = null, val ok: String = "OK", val danger: Boolean = false, val result: (String?) -> Unit) : Dialog()
    class Details(val item: Item) : Dialog()
    class History(val item: Item, val versions: JSONArray) : Dialog()
    class AddDrive(val join: Boolean, val invite: String = "") : Dialog()
    object Camera : Dialog()
    class Browse(val start: String?, val pick: (String) -> Unit) : Dialog()
    /** Choose what a device syncs of a drive ([device] null: this one), or what a new drive shares of a folder ([disk]). */
    class Choose(val space: String? = null, val device: String? = null, val disk: DiskChoice? = null) : Dialog()
    class Menu(val item: Item) : Dialog()
    object Transfers : Dialog()
}

/** A new drive made from a folder that already has files: which of them it shares. */
class DiskChoice(val folder: String, val name: String, val done: (skip: List<String>, ignore: Boolean, direct: Boolean) -> Unit)

private val DEV_IGNORE = listOf("node_modules", ".git", "build", ".gradle", ".cxx", "target", "__pycache__", ".venv", "venv", ".cache", ".idea",
    "CMakeFiles", ".next", ".dart_tool", "Pods", "DerivedData", ".pytest_cache", ".mypy_cache", ".tox", ".externalNativeBuild", "intermediates")

class AppModel(context: Context, private val scope: CoroutineScope, val host: Host) {
    val api = Api(context)
    private val prefs = context.getSharedPreferences("syncker-ui", Context.MODE_PRIVATE)

    var status by mutableStateOf<Status?>(null)
    var connected by mutableStateOf(true)
    var space by mutableStateOf<String?>(prefs.getString("space", null))
    var dir by mutableStateOf("/")
    var screen by mutableStateOf(Screen.Files)
    var query by mutableStateOf("")
    var items by mutableStateOf<List<Item>>(emptyList())
    var loaded by mutableStateOf(false)
    var grid by mutableStateOf(prefs.getBoolean("grid", false))
    var sortAll by mutableStateOf(readSort("sort", Sort()))
    var sortCam by mutableStateOf(readSort("camSort", Sort("mtime", false)))
    var filter by mutableStateOf(Filter())
    val picked = mutableStateMapOf<String, Item>()
    val uploads = mutableStateMapOf<String, Transfer>()
    var panelClosed by mutableStateOf(false)
    val dialogs = mutableStateListOf<Dialog>()
    val snackbar = SnackbarHostState()
    var drawerOpen by mutableStateOf(false)
    private var camOffered = false
    private val askedHold = HashSet<String>()
    private var openWhenReady: Pair<String, String>? = null

    // ---- basics ----

    val drives get() = status?.drives ?: emptyList()
    val cur get() = drives.firstOrNull { it.id == space }
    val isPhone get() = status?.platform == "android"
    fun driveName(id: String?) = drives.firstOrNull { it.id == id }?.name ?: ""
    fun spaceOf(it: Item) = it.space ?: space ?: ""
    fun pk(it: Item) = spaceOf(it) + "\u0000" + it.path

    fun toast(msg: String) { scope.launch { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(msg) } }
    fun show(d: Dialog) { dialogs.add(d) }
    fun close(d: Dialog) { dialogs.remove(d) }

    /** Runs [block], showing its error as a message. */
    fun run(block: suspend () -> Unit) = scope.launch {
        try { block() } catch (e: Exception) { toast(e.message ?: "Something went wrong") }
    }

    fun ask(title: String, text: String = "", value: String? = null, ok: String = "OK", danger: Boolean = false, result: (String?) -> Unit) =
        show(Dialog.Ask(title, text, value, ok, danger, result))

    private fun readSort(k: String, def: Sort): Sort {
        val j = prefs.getString(k, null) ?: return def
        return try { JSONObject(j).let { Sort(it.optString("key", def.key), it.optBoolean("asc", def.asc), it.optBoolean("folders", true)) } } catch (_: Exception) { def }
    }

    // ---- live status ----

    private var lastKey = ""
    private var reloadJob: Job? = null

    fun start() {
        scope.launch {
            api.events().collect { j ->
                if (j.optBoolean("_disconnected")) { connected = false; return@collect }
                connected = true
                val first = status == null || status?.configured != true
                onStatus(Status.of(j))
                if (status?.configured != true) return@collect
                // Reload the listing only when files may have changed, not on every progress tick.
                val key = drives.joinToString(";") { d ->
                    listOf(d.id, d.name, d.lastSync, d.pendingRev + ":" + d.pendingCount, d.files, d.bytes, d.excluded.joinToString("|"),
                        d.transfers.count { it.state == "done" }, d.listed).joinToString(",")
                }
                if (first) { lastKey = key; load(); return@collect }
                if (key != lastKey) {
                    lastKey = key
                    reloadJob?.cancel()
                    reloadJob = scope.launch { delay(300); load() }
                }
            }
        }
    }

    private fun onStatus(s: Status) {
        status = s
        if (!s.configured) return
        if (cur == null && s.drives.isNotEmpty()) space = s.drives[0].id
        // Photo backup: offered once on a phone, then from the drawer.
        val cam = s.camera
        if (cam != null && !cam.asked && cam.space == null && !camOffered && s.drives.isNotEmpty() && dialogs.isEmpty()) { camOffered = true; show(Dialog.Camera) }
        // A drive just joined: once its size is known, ask what to sync (once per drive).
        val d = cur
        if (d?.hold?.ready == true && d.phase != "error" && askedHold.add(d.id) && dialogs.isEmpty()) show(Dialog.Choose(d.id))
    }

    // ---- navigation ----

    fun go(d: String, sp: String? = null) {
        if (sp != null) space = sp
        dir = d
        goTo(Screen.Files)
    }

    fun goTo(s: Screen) {
        val where = listOf(s, space, dir)
        if (where != pickedWhere) { pickedWhere = where; picked.clear() }
        screen = s
        if (s != Screen.Search) query = ""
        drawerOpen = false
        space?.let { prefs.edit().putString("space", it).apply() }
        if (s != Screen.Manage) { items = if (s == Screen.Files) items else emptyList(); load() }
    }
    private var pickedWhere: List<Any?> = emptyList()

    fun search(q: String) {
        query = q
        if (q.isBlank()) { if (screen == Screen.Search) go(dir); return }
        screen = Screen.Search
        load()
    }

    /** Back: close what is open, then go up a folder, then leave the app. */
    fun back(): Boolean {
        if (dialogs.isNotEmpty()) { dialogs.removeAt(dialogs.lastIndex); return true }
        if (drawerOpen) { drawerOpen = false; return true }
        if (picked.isNotEmpty()) { picked.clear(); return true }
        if (screen == Screen.Files && cur != null && dir != "/") { go(parentOf(dir)); return true }
        if (screen != Screen.Files && cur != null) { go(if (screen == Screen.Manage) dir else "/"); return true }
        return false
    }

    private var loadSeq = 0
    fun load() {
        if (screen == Screen.Manage || status?.configured != true) return
        val seq = ++loadSeq
        val s = screen; val sp = space; val d = dir; val q = query
        scope.launch {
            try {
                val list = when (s) {
                    Screen.Recent -> api.recent()
                    Screen.Search -> api.search(q)
                    else -> if (sp == null) emptyList() else Item.list(api.list(sp, d))
                }
                if (seq != loadSeq) return@launch
                items = list
                loaded = true
                // Keep what is still listed in the selection (with its fresh state).
                val now = list.associateBy(::pk)
                for (k in picked.keys.toList()) { val it = now[k]; if (it != null) picked[k] = it else picked.remove(k) }
                openIfReady()
            } catch (e: Exception) { if (seq == loadSeq) toast(e.message ?: "Could not list the files") }
        }
    }

    // ---- sort and filter ----

    val camView get() = screen == Screen.Files && cur?.camera == true
    val sort get() = if (camView) sortCam else sortAll

    fun setSort(s: Sort) {
        val k = if (camView) "camSort" else "sort"
        if (camView) sortCam = s else sortAll = s
        prefs.edit().putString(k, JSONObject().put("key", s.key).put("asc", s.asc).put("folders", s.folders).toString()).apply()
    }

    fun useGrid(on: Boolean) { grid = on; prefs.edit().putBoolean("grid", on).apply() }

    private val byName = Collator.getInstance().apply { strength = Collator.SECONDARY }
    private fun cmpName(a: String, b: String): Int {
        // Numbers in names sort as numbers (IMG_2 before IMG_10).
        val ra = Regex("\\d+|\\D+").findAll(a).map { it.value }.toList()
        val rb = Regex("\\d+|\\D+").findAll(b).map { it.value }.toList()
        for (i in 0 until minOf(ra.size, rb.size)) {
            val x = ra[i]; val y = rb[i]
            val c = if (x[0].isDigit() && y[0].isDigit()) (x.toBigInteger().compareTo(y.toBigInteger())) else byName.compare(x, y)
            if (c != 0) return c
        }
        return ra.size - rb.size
    }

    fun shown(): List<Item> {
        val list = items.filter(::matches)
        if (screen == Screen.Recent) return list
        val s = sort
        val dirn = if (s.asc) 1 else -1
        val typeKey = { it: Item -> if (it.dir) "" else kind(it) + "." + ext(it.name) }
        val by: (Item, Item) -> Int = when (s.key) {
            "size" -> { a, b -> (a.size ?: 0).compareTo(b.size ?: 0) }
            "mtime" -> { a, b -> (a.mtime ?: 0).compareTo(b.mtime ?: 0) }
            "type" -> { a, b -> cmpName(typeKey(a), typeKey(b)) }
            "device" -> { a, b -> cmpName(a.device ?: "", b.device ?: "") }
            else -> { _, _ -> 0 }
        }
        return list.sortedWith { a, b ->
            val f = if (s.folders) b.dir.compareTo(a.dir) else 0
            if (f != 0) f else (by(a, b).takeIf { it != 0 } ?: cmpName(a.name, b.name)) * dirn
        }
    }

    private fun since(w: String): Long {
        val c = Calendar.getInstance().apply { set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0) }
        when (w) {
            "year" -> c.set(Calendar.DAY_OF_YEAR, 1)
            "today" -> {}
            else -> c.add(Calendar.DAY_OF_YEAR, -(w.toInt() - 1))
        }
        return c.timeInMillis
    }

    fun syncing(it: Item): Boolean {
        val sp = spaceOf(it)
        if (it.dir) return allTransfers().any { t -> t.moving && t.space == sp && t.path.startsWith(it.path + "/") }
        val t = transferFor(it.path, sp)
        return it.pending || it.synced == false || (t != null && t.state != "failed") || (it.copies?.missing?.isNotEmpty() == true) || (!it.local && !it.online)
    }

    // Folders stay so you can still go into them, unless the filter is about them too.
    fun matches(it: Item): Boolean {
        val f = filter
        if (f.type.isNotEmpty() && !it.dir) {
            val k = kind(it)
            if (if (f.type == "docs") k !in listOf("pdf", "doc", "sheet", "slide") else k != f.type) return false
        }
        if (f.whenAgo.isNotEmpty() && (it.mtime ?: 0) < since(f.whenAgo)) return false
        when (f.avail) {
            "here" -> if (if (it.dir) it.online else !it.local) return false
            "online" -> if (!(if (it.dir) it.online else it.online && !it.local)) return false
            "syncing" -> if (!syncing(it)) return false
            "conflict" -> if (it.dir || !CONFLICT.containsMatchIn(it.name)) return false
        }
        return true
    }

    // ---- transfers ----

    fun allTransfers(): List<Transfer> = uploads.values.toList() + drives.flatMap { it.transfers }

    /** The transfer that best describes a path right now (download beats send). */
    fun transferFor(p: String, sp: String): Transfer? {
        var best: Transfer? = null
        for (t in allTransfers()) {
            if (t.path != p || t.space != sp || t.state == "done") continue
            if (best == null || (t.dir == "down" && best.dir != "down")) best = t
        }
        return best
    }

    /** An upload from this phone (MainActivity streams it to the engine). */
    fun onUpload(u: JSONObject) {
        val id = u.optString("id")
        val was = uploads[id]
        val size = u.optLong("size", -1).let { if (it >= 0) it else u.optLong("bytes") }
        val state = u.optString("state")
        uploads[id] = Transfer(id, u.optString("space"), "browser", u.optString("path"), "this phone", null, null, size, u.optLong("bytes"),
            if (state == "done") 100 else if (size > 0) (u.optLong("bytes") * 100 / size).toInt() else 0, 0, null, state,
            if (state == "active") null else System.currentTimeMillis(), u.optString("error").ifBlank { null })
        if (was == null) panelClosed = false
        if (state == "failed") toast("${u.optString("path").substringAfterLast('/')}: ${u.optString("error").ifBlank { "upload failed" }}")
        if (state == "done") { uploadsDone++; reloadJob?.cancel(); reloadJob = scope.launch { delay(800); toast(if (uploadsDone == 1) "Uploaded “${u.optString("path").substringAfterLast('/')}”" else "$uploadsDone files uploaded"); uploadsDone = 0; load() } }
    }
    private var uploadsDone = 0

    fun closePanel() {
        panelClosed = true
        for ((k, u) in uploads.toMap()) if (u.state != "active") uploads.remove(k)
    }

    // ---- actions on files ----

    fun open(it: Item) {
        if (it.dir) return go(it.path, spaceOf(it))
        if (it.pending) {
            val t = transferFor(it.path, spaceOf(it))
            return toast(if (t != null && t.bytes > 0) "Still downloading (${t.percent}%)" else "Waiting for a device that has this file to come online")
        }
        if (!it.local) {
            return ask("Download “${it.name}”?", "It isn't on this device yet${if (it.size != null) " (${size(it.size)})" else ""}. It will be downloaded${if (it.device != null) " from the other devices" else ""}, kept on this device, and opened when it's done.", ok = "Download") { ok ->
                if (ok != null) { openWhenReady = spaceOf(it) to it.path; setSync(listOf(it), true) }
            }
        }
        host.openFile(spaceOf(it), it.path)
    }

    private fun openIfReady() {
        val (sp, p) = openWhenReady ?: return
        val it = items.firstOrNull { x -> x.path == p && spaceOf(x) == sp } ?: return
        if (!it.local || it.pending) return
        openWhenReady = null
        open(it)
    }

    fun setSync(list: List<Item>, on: Boolean) = run {
        for ((sp, its) in list.groupBy(::spaceOf)) api.selective(sp, JSONObject().put("paths", JSONArray(its.map { it.path })).put("sync", on))
        val what = if (list.size == 1) "“${list[0].name}”" else "${list.size} items"
        toast(if (on) "$what will be kept on this device" else "$what removed from this device (still on the others)")
        picked.clear()
        load()
    }

    fun removeHere(list: List<Item>) {
        val only = list.count { !it.dir && it.copies?.have == 0 }
        val one = list.size == 1
        ask(
            if (one) "Remove “${list[0].name}” from this device?" else "Remove ${list.size} items from this device?",
            (if (only > 0) (if (one) "No other device has finished downloading it yet: it stays in this device's sync data until one does. "
            else "${if (only == 1) "One of them has" else "$only of them have"} not finished downloading on any other device yet: ${if (only == 1) "it stays" else "they stay"} in this device's sync data until one does. ")
            else if (one) "Other devices keep it. " else "Other devices keep them. ") +
                (if (one) "It stays listed here as online only; open it, or choose “Keep on this device”, to get it back."
                else "They stay listed here as online only; open them, or choose “Keep on this device”, to get them back."),
            ok = "Remove"
        ) { if (it != null) setSync(list, false) }
    }

    fun delete(list: List<Item>) {
        val one = list.size == 1
        ask(if (one) "Delete “${list[0].name}”?" else "Delete ${list.size} items?",
            if (one) "It will be removed from every device in this drive." else "They will be removed from every device in this drive.", ok = "Delete", danger = true) { ok ->
            if (ok == null) return@ask
            run {
                var failed = 0
                for (it in list) try { api.delete(spaceOf(it), it.path) } catch (_: Exception) { failed++ }
                toast(if (one && failed == 0) "“${list[0].name}” deleted" else if (failed > 0) "${list.size - failed} deleted, $failed could not be deleted" else "${list.size} items deleted")
                picked.clear()
                load()
            }
        }
    }

    fun rename(it: Item) = ask("Rename", value = it.name) { name ->
        if (name.isNullOrBlank() || name == it.name) return@ask
        if (name.contains('/')) return@ask toast("Names cannot contain “/”")
        run { api.move(spaceOf(it), it.path, joinPath(parentOf(it.path), name)); toast("Renamed"); load() }
    }

    fun history(it: Item) = run { show(Dialog.History(it, api.versions(spaceOf(it), it.path))) }

    fun newFolder() {
        val d = cur ?: return
        ask("New folder", value = "Untitled folder", ok = "Create") { name ->
            if (name.isNullOrBlank()) return@ask
            if (name.contains('/')) return@ask toast("Names cannot contain “/”")
            val base = if (screen == Screen.Files) dir else "/"
            run {
                api.mkdir(d.id, joinPath(base, name))
                toast("Folders sync to other devices once they contain a file")
                go(joinPath(base, name))
            }
        }
    }

    fun upload() {
        val d = cur ?: return toast("Open a shared drive first")
        host.pickUploads(d.id, if (screen == Screen.Files) dir else "/")
    }

    fun syncNow() = run { api.syncNow(space); toast("Synced"); load() }

    // ---- drives ----

    /** body: { mode, invite, name, folder }. A new drive from a folder with files asks what it shares first. */
    fun addDrive(join: Boolean, invite: String, name: String, folder: String, setup: Boolean = false, deviceName: String = "", done: () -> Unit) = run {
        val body = JSONObject().put("mode", if (join) "join" else "create").put("invite", invite).put("name", name).put("folder", folder)
        if (setup) body.put("drive", name).put("name", deviceName)
        val submit: (JSONObject) -> Unit = { b ->
            run {
                if (setup) {
                    onStatus(api.setup(b))
                    go("/")
                } else {
                    val d = api.addDrive(b)
                    onStatus(api.status())
                    toast(if (join) "Joined “${d.optString("name")}”" else "Created “${d.optString("name")}”")
                    space = d.optString("id")
                    if (join) go("/") else goTo(Screen.Manage)
                }
                done()
            }
        }
        if (join || folder.isBlank()) return@run submit(body)
        val level = try { api.fsTree(folder, "/", true) } catch (_: Exception) { null } // not there yet: a new, empty folder
        if (level == null || (level.folders.isEmpty() && (level.loose?.files ?: 0) == 0)) return@run submit(body)
        show(Dialog.Choose(disk = DiskChoice(folder, name.ifBlank { "the new drive" }) { skip, ignore, direct ->
            body.put("skip", JSONArray(skip)).put("ignore", JSONArray(if (ignore) DEV_IGNORE else emptyList())).put("direct", direct)
            submit(body)
        }))
    }

    fun renameDrive() {
        val d = cur ?: return
        ask("Rename shared drive", "The new name is used on this device and in new invites.", d.name) { name ->
            if (name.isNullOrBlank() || name == d.name) return@ask
            run { api.renameDrive(d.id, name); toast("Renamed") }
        }
    }

    fun leaveDrive() {
        val d = cur ?: return
        ask("Leave “${d.name}” on this device?", "Syncing stops here. Files already in ${d.folder} stay, and other devices keep the drive. You can join again with its invite.", ok = "Leave", danger = true) { ok ->
            if (ok == null) return@ask
            run {
                api.leaveDrive(d.id)
                toast("Left “${d.name}”")
                onStatus(api.status())
                space = drives.firstOrNull()?.id
                go("/")
            }
        }
    }

    fun holdChoice(excluded: List<String>, msg: String) {
        val d = cur ?: return
        run { api.selective(d.id, JSONObject().put("excluded", JSONArray(excluded))); toast(msg); load() }
    }

    fun camera(on: Boolean, folder: String?, done: () -> Unit) = run {
        val d = api.camera(on, folder)
        done()
        if (d != null) {
            space = d.optString("id")
            onStatus(api.status())
            goTo(Screen.Manage)
            toast("Backing up your photos. To get them on your computer, join this drive there with its invite.")
        } else toast("You can turn on photo backup anytime from the menu")
    }

    /** Opened from a scanned invite link (syncker:...). */
    fun openInvite(invite: String) {
        if (status?.configured == true) show(Dialog.AddDrive(true, invite)) else pendingInvite = invite
    }
    var pendingInvite by mutableStateOf<String?>(null)
}
