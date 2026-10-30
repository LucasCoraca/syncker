package app.syncker.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TriStateCheckbox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

private sealed class TreeRow(val depth: Int) {
    class Folder(val f: TreeFolder, depth: Int) : TreeRow(depth)
    class Files(val dir: String, val loose: Loose, depth: Int) : TreeRow(depth)
}

/**
 * Choosing folders in a tree loaded level by level (chooseSync / chooseFolders
 * in the web UI): what a device syncs of a drive, a draft while a drive just
 * joined waits for the choice, or what a new drive shares of a folder on disk.
 */
@Composable
fun ChooseDialog(m: AppModel, d: Dialog.Choose, close: () -> Unit) {
    val disk = d.disk
    val drive = m.drives.firstOrNull { it.id == d.space }
    val peer = if (d.device != null) drive?.peers?.firstOrNull { it.key == d.device } else null
    val locked = peer != null && drive?.selections?.get(d.device)?.allowRemote == false
    val scope = rememberCoroutineScope()
    val levels = remember { mutableStateMapOf<String, TreeLevel>() }
    val sizes = remember { mutableStateMapOf<String, JSONObject?>() }
    val open = remember { mutableStateMapOf("/" to true) }
    // A draft is edited without being applied: a drive just joined (nothing until ticked), or a new drive's folders.
    var draft by remember { mutableStateOf<List<String>?>(if (disk != null) emptyList() else if (d.device == null && drive?.hold != null) listOf("/") else null) }
    var ignore by remember { mutableStateOf(true) }
    var copies by remember { mutableStateOf(false) }
    var summary by remember { mutableStateOf("") }
    var tooBig by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val lock = remember { Mutex() }
    var reload by remember { mutableStateOf(0) }

    suspend fun level(dir: String): TreeLevel = levels[dir] ?: run {
        val l = if (disk != null) m.api.fsTree(disk.folder, dir, ignore) else m.api.tree(d.space!!, dir, d.device)
        levels[dir] = l
        l
    }

    val root = levels["/"]
    val ex = draft ?: root?.excluded ?: emptyList()
    val off = { p: String -> offBy(ex, p) }
    // Partly: some rule below p says otherwise.
    val partial = { p: String ->
        ex.any { r -> val q = r.removePrefix("+"); q != p && (if (p == "/") q != "/" else q.startsWith("$p/")) && offBy(ex, q) != off(p) }
    }
    val state = { p: String -> if (partial(p)) ToggleableState.Indeterminate else if (off(p)) ToggleableState.Off else ToggleableState.On }
    val looseState = { l: Loose ->
        val allOff = l.paths.isNotEmpty() && l.paths.all(off)
        if (allOff) ToggleableState.Off else if (l.paths.any(off)) ToggleableState.Indeterminate else ToggleableState.On
    }

    // Loads the open levels; for folders on disk, their sizes a few at a time.
    LaunchedEffect(reload, open.toMap(), ignore) {
        try {
            suspend fun walk(dir: String) { val l = level(dir); for (f in l.folders) if (open[f.path] == true) walk(f.path) }
            walk("/")
            error = null
        } catch (e: Exception) { error = e.message }
        if (disk != null) {
            val want = (listOf("/") + levels.values.flatMap { it.folders.map(TreeFolder::path) }).filter { it !in sizes }
            for (p in want) {
                sizes[p] = null
                launch { sizes[p] = try { m.api.fsSize(disk.folder, p, ignore) } catch (_: Exception) { null } }
            }
        }
    }
    // How much of the drive the choice keeps.
    LaunchedEffect(ex, root) {
        if (disk != null || root == null) return@LaunchedEffect
        try {
            val r = m.api.treeSelected(d.space!!, ex)
            val free = drive?.hold?.free
            summary = "Keeps ${size(r.optLong("bytes"))} of ${size(r.optLong("total"))} (${"%,d".format(r.optInt("files"))} of ${"%,d".format(r.optInt("totalFiles"))} files) on ${if (d.device != null) "that device" else "this device"}" +
                (if (free != null && d.device == null) " · ${size(free)} free" else "")
            tooBig = free != null && d.device == null && r.optLong("bytes") > free
        } catch (_: Exception) {}
    }

    // One at a time: each toggle builds on the choice the previous one left.
    fun toggle(paths: List<String>, sync: Boolean) = scope.launch {
        lock.withLock {
            try {
                val body = JSONObject().put("paths", JSONArray(paths)).put("sync", sync)
                when {
                    disk != null -> draft = m.api.fsToggle(body.put("folder", disk.folder).put("ignore", ignore).put("base", JSONArray(draft ?: emptyList<String>())))
                    draft != null -> draft = m.api.selective(d.space!!, body.put("base", JSONArray(draft))).optJSONArray("excluded")?.toStrings() ?: draft
                    else -> {
                        m.api.selective(d.space!!, body, d.device)
                        levels.clear() // re-read with the new choice
                        reload++
                        m.load()
                    }
                }
            } catch (e: Exception) { m.toast(e.message ?: "Could not change it") }
        }
    }

    val rows = mutableListOf<TreeRow>()
    fun build(dir: String, depth: Int) {
        val l = levels[dir] ?: return
        for (f in l.folders) {
            rows += TreeRow.Folder(f, depth)
            if (open[f.path] == true) build(f.path, depth + 1)
        }
        val lo = l.loose
        if (lo != null && lo.files > 0) rows += TreeRow.Files(dir, lo, depth)
    }
    build("/", 0)

    val name = disk?.folder?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { disk.folder } ?: drive?.name ?: ""
    val sizeText = { r: JSONObject? -> if (r == null) "…" else "${"%,d".format(r.optInt("files"))} file${if (r.optInt("files") == 1) "" else "s"} · ${size(r.optLong("bytes"))}${if (r.optBoolean("partial")) "+" else ""}" }
    val folderSize = { f: TreeFolder -> if (disk != null) sizeText(sizes[f.path]) else "${"%,d".format(f.files ?: 0)} file${if (f.files == 1) "" else "s"} · ${size(f.bytes)}" }

    AlertDialog(
        onDismissRequest = { if (disk == null) close() },
        title = {
            Text(when {
                disk != null -> "Choose what “${disk.name}” shares"
                peer != null -> "Choose what ${peer.name} syncs"
                draft != null -> "Choose what to sync from “${drive?.name}”"
                else -> "Choose what to sync on this device"
            })
        },
        text = {
            Column {
                if (locked) Small("${peer?.name} does not allow other devices to change what it syncs.", Modifier.padding(bottom = 6.dp), colors.bad)
                Small(when {
                    disk != null -> "The folders you tick are shared with the devices of this drive. Unticked ones stay in ${disk.folder} on this device only."
                    draft != null -> "Nothing is downloaded until you tick it. Unticked folders stay online only: you still see them and can open them while a device that has them is online."
                    else -> "Unticked folders stay online only: you still see them and can open them while a device that has them is online, but they take no space here."
                })
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    TriStateCheckbox(state("/"), { toggle(listOf("/"), off("/") || partial("/")) }, enabled = !locked)
                    Text("Everything in $name", Modifier.weight(1f), fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Small(if (disk != null) sizeText(sizes["/"]) else root?.let { "${"%,d".format(it.files ?: 0)} files · ${size(it.bytes)}" } ?: "")
                }
                HorizontalDivider(color = colors.line)
                LazyColumn(Modifier.heightIn(max = 340.dp)) {
                    if (error != null) item { Small(error!!, Modifier.padding(8.dp)) }
                    else if (root != null && rows.isEmpty()) item { Small(if (disk != null) "This folder is empty." else "This drive is empty.", Modifier.padding(8.dp)) }
                    items(rows) { r ->
                        Row(Modifier.fillMaxWidth().padding(start = (r.depth * 20).dp), verticalAlignment = Alignment.CenterVertically) {
                            when (r) {
                                is TreeRow.Folder -> {
                                    val f = r.f
                                    val kids = disk != null || f.hasFolders
                                    Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) {
                                        if (kids) IconButton({ if (open[f.path] == true) open.remove(f.path) else open[f.path] = true }) {
                                            Ico("i-chev", Modifier.rotate(if (open[f.path] == true) 90f else 0f), colors.muted, 20.dp)
                                        }
                                    }
                                    TriStateCheckbox(state(f.path), { toggle(listOf(f.path), off(f.path) || partial(f.path)) }, enabled = !locked)
                                    Ico("f-folder", tint = colors.files["folder"] ?: colors.muted, size = 20.dp)
                                    Text(" " + f.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
                                    Small(folderSize(f))
                                }
                                is TreeRow.Files -> {
                                    Spacer(Modifier.size(36.dp))
                                    val s = looseState(r.loose)
                                    TriStateCheckbox(s, { toggle(r.loose.paths, s != ToggleableState.On) }, enabled = !locked)
                                    Ico("f-file", tint = colors.muted, size = 20.dp)
                                    Text(" ${count(r.loose.files, "1 file", "files")} directly in ${if (r.dir == "/") name else r.dir.substringAfterLast('/')}",
                                        Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
                                    Small(size(r.loose.bytes))
                                }
                            }
                        }
                    }
                }
                if (summary.isNotEmpty()) Small(summary, Modifier.padding(top = 8.dp), if (tooBig) colors.bad else colors.muted)
                if (disk != null) {
                    Row(Modifier.fillMaxWidth().clickable { ignore = !ignore; levels.clear(); sizes.clear(); reload++ }.padding(top = 8.dp), verticalAlignment = Alignment.Top) {
                        Checkbox(ignore, null)
                        Text("Skip build and dependency folders (node_modules, .git, build, caches…)", Modifier.padding(start = 4.dp, top = 12.dp), fontSize = 13.sp)
                    }
                    Row(Modifier.fillMaxWidth().clickable { copies = !copies }, verticalAlignment = Alignment.Top) {
                        Checkbox(copies, null)
                        Text("Keep a copy of every version in the sync data (needs as much space again; old versions stay downloadable)", Modifier.padding(start = 4.dp, top = 12.dp), fontSize = 13.sp)
                    }
                }
            }
        },
        confirmButton = {
            when {
                disk != null -> TextButton({ scope.launch { lock.withLock {}; close(); disk.done(draft ?: emptyList(), ignore, !copies) } }) { Text("Create drive") }
                draft != null -> TextButton({
                    scope.launch {
                        lock.withLock {}
                        try { m.api.selective(d.space!!, JSONObject().put("excluded", JSONArray(draft))); close(); m.toast("Syncing ${drive?.name}"); m.load() } catch (e: Exception) { m.toast(e.message ?: "") }
                    }
                }) { Text("Start syncing") }
                else -> TextButton(close) { Text("Done") }
            }
        },
        dismissButton = { if (disk != null || draft != null) TextButton(close) { Text(if (disk != null) "Cancel" else "Later") } }
    )
}
