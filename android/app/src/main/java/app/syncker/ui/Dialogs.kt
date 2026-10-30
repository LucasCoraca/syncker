package app.syncker.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.json.JSONObject

/** Every dialog on screen, oldest first. */
@Composable
fun Dialogs(m: AppModel) {
    for (d in m.dialogs.toList()) {
        val close = { m.close(d) }
        when (d) {
            is Dialog.Ask -> AskDialog(d, close)
            is Dialog.Menu -> ItemMenu(m, d.item, close)
            is Dialog.Details -> DetailsDialog(m, d.item, close)
            is Dialog.History -> HistoryDialog(d, close)
            is Dialog.AddDrive -> AddDriveDialog(m, d, close)
            is Dialog.Camera -> CameraDialog(m, close)
            is Dialog.Browse -> BrowseDialog(m, d, close)
            is Dialog.Choose -> ChooseDialog(m, d, close)
            is Dialog.Transfers -> TransfersSheet(m, close)
        }
    }
}

@Composable
private fun AskDialog(d: Dialog.Ask, close: () -> Unit) {
    var value by remember { mutableStateOf(TextFieldValue(d.value ?: "", TextRange(0, (d.value ?: "").lastIndexOf('.').takeIf { it > 0 } ?: (d.value ?: "").length))) }
    val focus = remember { FocusRequester() }
    val done = { v: String? -> close(); d.result(v) }
    AlertDialog(
        onDismissRequest = { done(null) },
        title = { Text(d.title) },
        text = {
            Column {
                if (d.text.isNotEmpty()) Text(d.text, color = colors.muted, fontSize = 14.sp)
                if (d.value != null) {
                    OutlinedTextField(value, { value = it }, Modifier.fillMaxWidth().padding(top = 8.dp).focusRequester(focus), singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done, capitalization = KeyboardCapitalization.Sentences),
                        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { done(value.text.trim()) }))
                    LaunchedEffect(Unit) { delay(100); focus.requestFocus() }
                }
            }
        },
        confirmButton = { TextButton({ done(if (d.value != null) value.text.trim() else "ok") }) { Text(d.ok, color = if (d.danger) colors.bad else colors.accent) } },
        dismissButton = { TextButton({ done(null) }) { Text("Cancel") } }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ItemMenu(m: AppModel, it: Item, close: () -> Unit) {
    ModalBottomSheet(onDismissRequest = close, containerColor = colors.surface) {
        Row(Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Ico("f-${kind(it)}", tint = colors.files[kind(it)] ?: colors.muted)
            Text(it.name, Modifier.padding(start = 14.dp), fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        HorizontalDivider(color = colors.line)
        val act = { f: () -> Unit -> { close(); f() } }
        Column(Modifier.padding(bottom = 24.dp)) {
            if (!it.pending) SheetRow("i-open", "Open", act { m.open(it) })
            if (m.screen != Screen.Files) SheetRow("f-folder", "Show file location", act { m.go(parentOf(it.path), m.spaceOf(it)) })
            if (it.online) SheetRow("i-offline-pin", if (it.dir) "Download to this device" else "Keep on this device", act { m.setSync(listOf(it), true) })
            else SheetRow("i-cloud", "Remove from this device", act { m.removeHere(listOf(it)) })
            if (!it.pending) {
                if (it.local) SheetRow("i-edit", "Rename", act { m.rename(it) })
                SheetRow("i-info", "Details", act { m.show(Dialog.Details(it)) })
                if (!it.dir) SheetRow("i-history", "Version history", act { m.history(it) })
                SheetRow("i-trash", "Delete from all devices", act { m.delete(listOf(it)) }, danger = true)
            }
        }
    }
}

@Composable
fun SheetRow(icon: String, label: String, onClick: () -> Unit, danger: Boolean = false) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Ico(icon, tint = if (danger) colors.bad else colors.muted)
        Text(label, Modifier.padding(start = 20.dp), color = if (danger) colors.bad else colors.text, fontSize = 16.sp)
    }
}

// ---- details ----

private val STATE_ROW = mapOf(
    "synced" to ("ok" to "i-cloud-ok"), "adding" to ("busy" to "i-sync"), "downloading" to ("busy" to "i-down"),
    "receiving" to ("busy" to "i-up"), "saving" to ("busy" to "i-sync"), "waiting" to ("wait" to "i-clock"),
    "pending" to ("wait" to "i-clock"), "new" to ("wait" to "i-clock"), "offline" to ("wait" to "i-cloud-off"),
    "online" to ("" to "i-cloud"), "failed" to ("bad" to "i-error"), "old" to ("wait" to "i-history"), "unknown" to ("" to "i-cloud")
)
private val VIA = mapOf("lan" to "local network", "vpn" to "VPN (e.g. Tailscale)", "internet" to "internet")

@Composable
private fun DetailsDialog(m: AppModel, it: Item, close: () -> Unit) {
    var d by remember { mutableStateOf<JSONObject?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    // Refreshes while open: a download's progress moves.
    LaunchedEffect(it) {
        while (true) {
            try { d = m.api.details(m.spaceOf(it), it.path); err = null } catch (e: Exception) { err = e.message }
            delay(1000)
        }
    }
    AlertDialog(
        onDismissRequest = close,
        title = { Row(verticalAlignment = Alignment.CenterVertically) { Ico("f-${kind(it)}", tint = colors.files[kind(it)] ?: colors.muted); Text("  " + it.name, maxLines = 2, overflow = TextOverflow.Ellipsis) } },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                val x = d
                when {
                    err != null && x == null -> Small(err!!)
                    x == null -> Small("Loading…")
                    else -> DetailsBody(m, it, x)
                }
            }
        },
        confirmButton = { TextButton(close) { Text("Close") } }
    )
}

@Composable
private fun DetailsBody(m: AppModel, it: Item, d: JSONObject) {
    val rows = mutableListOf("Type" to typeName(it))
    if (d.optBoolean("dir")) {
        val files = d.optInt("files"); val folders = d.optInt("folders"); val here = d.optInt("here")
        rows += "Contains" to (if (files > 0) filesText(files) + (if (folders > 0) " in ${count(folders, "1 folder", "folders")}" else "") else "Empty")
        if (files > 0) {
            rows += "Size" to size(d.optLong("size"))
            rows += "On this device" to (if (d.optBoolean("online") && here == 0) "Online only" else if (here == files) "All files" else "${filesText(here)} of ${"%,d".format(files)} (${size(d.optLong("hereSize"))})")
        }
        if (d.optLong("mtime") > 0) rows += "Modified" to fullDate(d.optLong("mtime")) + " (its newest file)"
    } else {
        if (!d.isNull("size") && d.has("size")) { val s = d.optLong("size"); rows += "Size" to size(s) + (if (s >= 1024) " (${"%,d".format(s)} bytes)" else "") }
        if (d.optLong("mtime") > 0) rows += "Modified" to fullDate(d.optLong("mtime")) + (d.optString("author").takeIf { a -> a.isNotEmpty() && !d.isNull("author") }?.let { a -> " on $a" } ?: "")
    }
    if (d.optLong("created") > 0) rows += "Created here" to fullDate(d.optLong("created"))
    val drive = m.drives.firstOrNull { x -> x.id == m.spaceOf(it) }
    if (drive != null) rows += "In" to drive.name + (if (parentOf(it.path) == "/") "" else " › " + parentOf(it.path).drop(1).replace("/", " › "))
    for ((k, v) in rows) {
        Row(Modifier.padding(vertical = 3.dp)) {
            Text(k, Modifier.weight(0.38f), color = colors.muted, fontSize = 14.sp)
            Text(v, Modifier.weight(0.62f), fontSize = 14.sp)
        }
    }
    val where = d.optString("where").takeIf { w -> w.isNotEmpty() && !d.isNull("where") }
    if (where != null) {
        Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Location", Modifier.weight(0.38f), color = colors.muted, fontSize = 14.sp)
            Text(where, Modifier.weight(0.62f), fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            IconButton({ m.host.copy("Location", where); m.toast("Location copied") }, Modifier.size(36.dp)) { Ico("i-copy", tint = colors.muted, size = 20.dp) }
        }
    }
    if (d.optBoolean("dir")) return
    val here = d.optJSONObject("here") ?: return
    val devices = d.optJSONArray("devices")
    val others = List(devices?.length() ?: 0) { i -> devices!!.getJSONObject(i) }
    val ok = others.count { x -> x.optString("state") == "synced" } + (if (here.optString("state") == "synced") 1 else 0)
    val total = others.size + 1
    Text("SYNC", Modifier.padding(top = 18.dp, bottom = 6.dp), color = colors.muted, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    Small("$ok of $total device${if (total == 1) " has" else "s have"} the latest version" + (d.optString("hash").takeIf { h -> h.isNotEmpty() && !d.isNull("hash") }?.let { h -> " (SHA-256 ${h.take(12)}…)" } ?: ""))
    DetRow("${m.status?.device ?: "This device"} (this device)", here, "i-phone")
    for (x in others) DetRow(x.optString("name"), x, deviceIcon(x.optString("name")))
    val act = d.optJSONArray("activity")
    if (act != null && act.length() > 0) {
        Text("ACTIVITY (SINCE SYNCKER STARTED)", Modifier.padding(top = 18.dp, bottom = 6.dp), color = colors.muted, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        for (i in 0 until act.length()) {
            val a = act.getJSONObject(i)
            Row(Modifier.padding(vertical = 2.dp)) {
                Small(ago(a.optLong("at")), Modifier.weight(0.3f))
                Text(a.optString("text"), Modifier.weight(0.7f), fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun DetRow(name: String, x: JSONObject, icon: String) {
    val state = x.optString("state")
    val (cls, ic) = STATE_ROW[state] ?: ("" to "i-cloud")
    val tint = when (cls) { "ok" -> colors.ok; "busy" -> colors.accent; "bad" -> colors.bad; else -> colors.muted }
    val moving = state in listOf("adding", "downloading", "receiving", "waiting")
    val sub = mutableListOf<String>()
    if (x.has("bytes") && !x.isNull("bytes") && x.optLong("size") > 0 && moving) sub += "${size(x.optLong("bytes"))} of ${size(x.optLong("size"))}"
    if (x.optLong("speed") > 1024) sub += size(x.optLong("speed")) + "/s"
    if (x.has("eta") && !x.isNull("eta") && moving) sub += eta(x.optLong("eta"))
    VIA[x.optString("via")]?.let { sub += "connected via $it" }
    if (x.has("online") && !x.optBoolean("online", true)) sub += if (x.optLong("lastSeen") > 0) "offline · last seen ${ago(x.optLong("lastSeen"))}" else "offline"
    Row(Modifier.padding(vertical = 8.dp)) {
        Ico(ic, tint = tint, size = 20.dp)
        Column(Modifier.padding(start = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) { Ico(icon, tint = colors.muted, size = 16.dp); Text(" $name", fontWeight = FontWeight.Medium, fontSize = 14.sp) }
            Text(x.optString("text"), fontSize = 14.sp)
            if (moving && x.has("percent") && !x.isNull("percent")) LinearProgressIndicator({ x.optInt("percent") / 100f }, Modifier.padding(vertical = 4.dp).fillMaxWidth(), color = colors.accent, trackColor = colors.line)
            if (sub.isNotEmpty()) Small(sub.joinToString(" · "))
        }
    }
}

@Composable
private fun HistoryDialog(d: Dialog.History, close: () -> Unit) {
    AlertDialog(
        onDismissRequest = close,
        title = { Text(d.item.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (d.versions.length() == 0) Small("Not synced yet.")
                for (i in 0 until d.versions.length()) {
                    val v = d.versions.getJSONObject(i)
                    Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(if (i == 0) "Current" else "Older", Modifier.weight(0.25f), fontWeight = if (i == 0) FontWeight.Medium else FontWeight.Normal, fontSize = 14.sp)
                        Text(v.optString("device"), Modifier.weight(0.35f), fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Small(if (v.optBoolean("deleted")) "deleted" else size(v.optLong("size")), Modifier.weight(0.2f))
                        Small(whenText(v.optLong("mtime")), Modifier.weight(0.2f))
                    }
                }
            }
        },
        confirmButton = { TextButton(close) { Text("Close") } }
    )
}

// ---- drives ----

@Composable
private fun AddDriveDialog(m: AppModel, d: Dialog.AddDrive, close: () -> Unit) {
    var invite by remember { mutableStateOf(d.invite) }
    var name by remember { mutableStateOf(if (d.join) inviteName(d.invite) else "Untitled drive") }
    var folder by remember { mutableStateOf("") }
    var edited by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(name) { if (!edited) { delay(150); folder = try { m.api.suggestFolder(name.trim().ifEmpty { "Shared drive" }) } catch (_: Exception) { folder } } }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(if (d.join) "Join a shared drive" else "New shared drive") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (d.join) {
                    OutlinedTextField(invite, { v -> invite = v; inviteName(v).takeIf { it.isNotEmpty() && name.isEmpty() }?.let { name = it } },
                        Modifier.fillMaxWidth(), label = { Text("Invite from another device") }, placeholder = { Text("syncker:…") }, minLines = 2,
                        textStyle = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp))
                    TextButton({ m.host.scanQr { t -> if (t != null) { invite = t; if (name.isEmpty()) name = inviteName(t); m.toast("Invite scanned") } } }) { Ico("i-qr", size = 18.dp); Text("  Scan QR code") }
                }
                OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth().padding(top = 8.dp), label = { Text("Name") }, singleLine = true)
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(folder, { folder = it; edited = true }, Modifier.weight(1f), label = { Text("Folder on this device") }, singleLine = true)
                    TextButton({ m.show(Dialog.Browse(folder) { p -> folder = p; edited = true }) }) { Text("Browse") }
                }
            }
        },
        confirmButton = {
            TextButton({
                if (d.join && invite.isBlank()) return@TextButton m.toast("Paste or scan the invite first")
                busy = true
                m.addDrive(d.join, invite.trim(), name.trim(), folder.trim()) { close() }.invokeOnCompletion { busy = false }
            }, enabled = !busy) { Text(if (d.join) "Join" else "Create") }
        },
        dismissButton = { TextButton(close) { Text("Cancel") } }
    )
}

@Composable
private fun CameraDialog(m: AppModel, close: () -> Unit) {
    val cam = m.status?.camera ?: return close()
    var folder by remember { mutableStateOf(cam.folder) }
    var busy by remember { mutableStateOf(false) }
    val answer = { on: Boolean -> busy = true; m.camera(on, folder) { close() }.invokeOnCompletion { busy = false }; Unit }
    AlertDialog(
        onDismissRequest = { if (!busy) answer(false) },
        title = { Text("Back up your photos?") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("Every photo and video you take with this phone's camera will sync to your other devices, like a photo backup.", fontSize = 14.sp, color = colors.muted)
                Gap(8.dp)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("• From ", fontSize = 14.sp)
                    Text(folder.removePrefix("/storage/emulated/0/"), Modifier.weight(1f, fill = false), fontWeight = FontWeight.Medium, fontSize = 14.sp)
                    TextButton({ m.show(Dialog.Browse(folder) { p -> folder = p }) }) { Text("Change") }
                }
                for (t in listOf(
                    "They stay where they are: no extra space is used on this phone.",
                    "Your other devices get them once they join the new drive “${m.status?.device} photos” with its invite.",
                    "Deleting a photo on one device deletes it on the others too."
                )) Text("• $t", Modifier.padding(vertical = 3.dp), fontSize = 14.sp)
            }
        },
        confirmButton = { TextButton({ answer(true) }, enabled = !busy) { Text("Back up photos") } },
        dismissButton = { TextButton({ answer(false) }, enabled = !busy) { Text("Not now") } }
    )
}

/** Picking a folder on this device (a new drive's, or the camera's). */
@Composable
private fun BrowseDialog(m: AppModel, d: Dialog.Browse, close: () -> Unit) {
    var at by remember { mutableStateOf<JSONObject?>(null) }
    val open = { p: String? -> m.run { at = m.api.fsBrowse(p) }; Unit }
    // Start at the folder given, or the nearest one of its parents that exists.
    LaunchedEffect(Unit) {
        var p = d.start?.takeIf { it.startsWith("/") }
        while (true) {
            try { at = m.api.fsBrowse(p); break } catch (e: Exception) {
                if (p == null || p == "/") { m.toast(e.message ?: "Cannot open this folder"); close(); break }
                p = parentOf(p)
            }
        }
    }
    val x = at
    AlertDialog(
        onDismissRequest = close,
        title = { Text("Choose a folder") },
        text = {
            Column {
                Small(x?.optString("path") ?: "")
                LazyColumn(Modifier.heightIn(max = 360.dp).padding(top = 8.dp)) {
                    val parent = x?.optString("parent")?.takeIf { !x.isNull("parent") && it.isNotEmpty() }
                    if (parent != null) item { FsRow("i-up", "Up one folder") { open(parent) } }
                    val names = x?.optJSONArray("folders")?.toStrings() ?: emptyList()
                    items(names) { n -> FsRow("f-folder", n) { open(x!!.optString("path").trimEnd('/') + "/" + n) } }
                    if (x != null && names.isEmpty()) item { Small("No folders here", Modifier.padding(8.dp)) }
                }
            }
        },
        confirmButton = { TextButton({ x?.optString("path")?.let(d.pick); close() }, enabled = x != null) { Text("Use this folder") } },
        dismissButton = {
            Row {
                TextButton({
                    val here = x?.optString("path") ?: return@TextButton
                    m.ask("New folder", "In $here", "", "Create") { name -> if (!name.isNullOrBlank()) m.run { at = m.api.fsBrowse(m.api.fsMkdir(here, name).optString("path")) } }
                }) { Text("New folder") }
                TextButton(close) { Text("Cancel") }
            }
        }
    )
}

@Composable
private fun FsRow(icon: String, label: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Ico(icon, tint = colors.files["folder"] ?: colors.muted, size = 20.dp)
        Text(label, Modifier.padding(start = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ---- transfers ----

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TransfersSheet(m: AppModel, close: () -> Unit) {
    ModalBottomSheet(onDismissRequest = close, containerColor = colors.surface) {
        val all = m.allTransfers().filter { it.dir != "add" || it.size > 2 * 1024 * 1024 || it.state != "done" }
        val active = all.filter { it.moving }
        Column(Modifier.padding(horizontal = 20.dp)) {
            val s = chipState(m)
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (s.icon == "i-sync") Spin("i-sync", chipTint(s), 20.dp) else Ico(s.icon, tint = chipTint(s), size = 20.dp)
                Text("  " + s.text, fontWeight = FontWeight.Medium)
            }
            if (all.isNotEmpty()) {
                Gap(8.dp)
                Text(transferTitle(all, active), fontSize = 14.sp)
                val b = active.sumOf { it.bytes }; val t = active.sumOf { it.size }
                val down = m.drives.sumOf { it.speedDown }; val up = m.drives.sumOf { it.speedUp }
                Small(if (active.isEmpty()) "All done" else "${if (t > 0) b * 100 / t else 0}% · ${size(b)} of ${size(t)}" +
                    (if (down > 1024) " · ↓ ${size(down)}/s" else "") + (if (up > 1024) " · ↑ ${size(up)}/s" else ""))
            }
        }
        HorizontalDivider(Modifier.padding(top = 12.dp), color = colors.line)
        val order = all.sortedWith(compareByDescending<Transfer> { it.moving }.thenByDescending { it.finished ?: 0 }).take(50)
        LazyColumn(Modifier.heightIn(max = 480.dp).padding(bottom = 24.dp)) {
            if (order.isEmpty()) item { Small("Nothing is being sent or received right now.", Modifier.padding(20.dp)) }
            items(order, key = { it.space + it.id + it.dir }) { t ->
                Row(Modifier.fillMaxWidth().clickable { close(); m.go(parentOf(t.path), t.space) }.padding(horizontal = 20.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Ico("f-${kind(t.name)}", tint = colors.files[kind(t.name)] ?: colors.muted)
                    Column(Modifier.weight(1f).padding(start = 14.dp)) {
                        Text(t.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Small(describe(m, t), maxLines = 2)
                        if (t.moving && t.state != "waiting") LinearProgressIndicator({ t.percent / 100f }, Modifier.padding(top = 4.dp).fillMaxWidth(), color = colors.accent, trackColor = colors.line)
                    }
                    Box(Modifier.padding(start = 8.dp)) {
                        when (t.state) {
                            "done" -> Ico("i-check", tint = colors.ok, size = 20.dp)
                            "failed" -> Ico("i-error", tint = colors.bad, size = 20.dp)
                            else -> Small(if (t.preparing != null) "${t.preparing}%" else "${t.percent}%")
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun FullWidthDivider() = HorizontalDivider(color = colors.line)

@Composable
fun Pill(text: String) = Text(text, Modifier.clip(RoundedCornerShape(99.dp)).background(colors.accentSoft).padding(horizontal = 10.dp, vertical = 2.dp), fontSize = 12.sp)

@Composable
fun Spaced(content: @Composable () -> Unit) = Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
