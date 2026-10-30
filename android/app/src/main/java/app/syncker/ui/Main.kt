package app.syncker.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.PermanentDrawerSheet
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Wide screens (tablets, unfolded foldables, phones on their side) keep the drawer open as a sidebar. */
@Composable
fun wide() = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp >= 720

@Composable
fun MainScreen(m: AppModel) {
    if (wide()) {
        LaunchedEffect(Unit) { m.drawerOpen = false }
        Row(Modifier.fillMaxSize().background(colors.bg)) {
            PermanentDrawerSheet(Modifier.width(272.dp), drawerContainerColor = colors.bg) { DrawerBody(m) }
            Content(m, Modifier.padding(end = 8.dp, bottom = 8.dp).clip(RoundedCornerShape(16.dp)))
        }
        return
    }
    val drawer = rememberDrawerState(if (m.drawerOpen) DrawerValue.Open else DrawerValue.Closed)
    LaunchedEffect(m.drawerOpen) { if (m.drawerOpen) drawer.open() else drawer.close() }
    LaunchedEffect(drawer) { snapshotFlow { drawer.currentValue }.collect { m.drawerOpen = it == DrawerValue.Open } }
    ModalNavigationDrawer(drawerState = drawer, drawerContent = {
        ModalDrawerSheet(drawerContainerColor = colors.surface, modifier = Modifier.width(300.dp)) { DrawerBody(m) }
    }) {
        Content(m, Modifier.clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)))
    }
}

@Composable
private fun Content(m: AppModel, shape: Modifier) {
    Scaffold(
        containerColor = colors.bg,
        topBar = { TopBar(m) },
        snackbarHost = { SnackbarHost(m.snackbar) },
        floatingActionButton = { if (m.picked.isEmpty() && m.screen != Screen.Manage || m.cur == null) NewButton(m) },
        bottomBar = { TransferBar(m) }
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().then(shape).background(colors.surface)) {
            if (m.screen == Screen.Manage) ManageScreen(m) else FilesPane(m)
        }
    }
}

@Composable
private fun TopBar(m: AppModel) {
    var text by remember { mutableStateOf(m.query) }
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    LaunchedEffect(m.screen) { if (m.screen != Screen.Search) text = "" }
    LaunchedEffect(text) {
        kotlinx.coroutines.delay(200)
        if (text.trim() != m.query.trim()) m.search(text.trim())
    }
    val wide = wide()
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (!wide) IconButton({ m.drawerOpen = true }) { Ico("i-menu", tint = colors.muted) }
        Row(
            Modifier.weight(1f).wrapContentWidth(Alignment.Start).widthIn(max = 720.dp).fillMaxWidth().height(48.dp).clip(RoundedCornerShape(99.dp)).background(colors.surface2).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Ico("i-search", tint = colors.muted, size = 22.dp)
            Box(Modifier.weight(1f).padding(start = 10.dp)) {
                if (text.isEmpty()) Text("Search in Syncker", color = colors.muted, fontSize = 16.sp)
                BasicTextField(text, { text = it }, singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, color = colors.text),
                    cursorBrush = SolidColor(colors.accent), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { m.search(text.trim()); focus.clearFocus() }), modifier = Modifier.fillMaxWidth())
            }
            if (text.isNotEmpty()) IconButton({ text = ""; focus.clearFocus() }, Modifier.size(36.dp)) { Ico("i-close", tint = colors.muted, size = 20.dp) }
        }
        val s = chipState(m)
        IconButton({ m.panelClosed = false; m.show(Dialog.Transfers) }) {
            if (s.icon == "i-sync") Spin("i-sync", chipTint(s), 24.dp) else Ico(s.icon, tint = chipTint(s))
        }
    }
}

@Composable
private fun DrawerBody(m: AppModel) {
    run {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 16.dp)) {
            Row(Modifier.padding(start = 20.dp, bottom = 16.dp).height(32.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Logo(32.dp); Text("Syncker", fontSize = 22.sp)
            }
            NavRow("i-recent", "Recent", on = m.screen == Screen.Recent) { m.goTo(Screen.Recent) }
            Text("Shared drives", Modifier.padding(start = 20.dp, top = 14.dp, bottom = 4.dp), fontSize = 12.sp, fontWeight = FontWeight.Medium, color = colors.muted)
            for (d in m.drives) {
                val on = (m.screen == Screen.Files || m.screen == Screen.Manage) && d.id == m.space
                NavRow(if (d.camera) "f-image" else "i-drive", d.name, on = on, trailing = {
                    when {
                        d.phase == "error" -> Ico("i-error", tint = colors.bad, size = 18.dp)
                        d.busy -> Spin("i-sync", colors.accent, 18.dp)
                        else -> Small("${d.peers.count { it.online }}/${d.peers.size + 1}")
                    }
                }) { m.go("/", d.id) }
            }
            NavRow("i-plus", "New shared drive", sub = true) { m.drawerOpen = false; m.show(Dialog.AddDrive(false)) }
            NavRow("i-qr", "Join with invite", sub = true) { m.drawerOpen = false; m.show(Dialog.AddDrive(true)) }
            val cam = m.status?.camera
            if (cam != null && cam.space == null) NavRow("f-image", "Back up photos", sub = true) { m.drawerOpen = false; m.show(Dialog.Camera) }
            HorizontalDivider(Modifier.padding(start = 20.dp, top = 16.dp, bottom = 12.dp), color = colors.line)
            val files = m.drives.sumOf { it.files }; val bytes = m.drives.sumOf { it.bytes }
            Column(Modifier.padding(start = 20.dp)) {
                Text("${count(files, "1 file", "files")} on this device", fontWeight = FontWeight.Medium)
                Small("${size(bytes)} in ${count(m.drives.size, "1 drive", "drives")}")
                Gap(8.dp)
                Small("This device: ${m.status?.device ?: ""}")
                Gap(8.dp)
                Small("Syncker ${m.version} · Check for updates", Modifier.clip(RoundedCornerShape(4.dp)).clickable { m.drawerOpen = false; m.checkUpdate(true) }.padding(vertical = 4.dp), color = colors.accent)
            }
        }
    }
}

@Composable
private fun NavRow(icon: String, label: String, on: Boolean = false, sub: Boolean = false, trailing: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(end = 12.dp).height(44.dp).clip(RoundedCornerShape(topEnd = 99.dp, bottomEnd = 99.dp))
            .then(if (on) Modifier.background(colors.selected) else Modifier).clickable(onClick = onClick).padding(start = 20.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Ico(icon, tint = if (sub) colors.muted else colors.text, size = 20.dp)
        Text(label, Modifier.weight(1f), fontWeight = if (sub) FontWeight.Normal else FontWeight.Medium, color = if (sub) colors.muted else colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        trailing?.invoke()
    }
}

@Composable
private fun NewButton(m: AppModel) {
    var open by remember { mutableStateOf(false) }
    Box {
        FloatingActionButton({ open = true }, containerColor = colors.accentSoft, contentColor = colors.text, shape = RoundedCornerShape(16.dp)) { Ico("i-plus") }
        DropdownMenu(open, { open = false }) {
            if (m.cur != null) {
                MenuItem("i-newfolder", "New folder") { open = false; m.newFolder() }
                MenuItem("i-upfile", "Upload files") { open = false; m.upload() }
                HorizontalDivider(color = colors.line)
            }
            MenuItem("i-drive", "New shared drive") { open = false; m.show(Dialog.AddDrive(false)) }
            MenuItem("i-qr", "Join shared drive") { open = false; m.show(Dialog.AddDrive(true)) }
        }
    }
}

@Composable
fun MenuItem(icon: String, label: String, danger: Boolean = false, checked: Boolean? = null, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, color = if (danger) colors.bad else colors.text) },
        leadingIcon = { if (checked != null) Ico("i-tick", tint = if (checked) colors.text else androidx.compose.ui.graphics.Color.Transparent) else Ico(icon, tint = if (danger) colors.bad else colors.muted) },
        onClick = onClick
    )
}

// ---- the files of a folder, Recent or a search ----

@Composable
private fun FilesPane(m: AppModel) {
    val d = m.cur
    Column(Modifier.fillMaxSize()) {
        if (m.picked.isNotEmpty()) SelectionBar(m) else Header(m)
        val noDrive = m.screen == Screen.Files && d == null
        val listing = m.screen == Screen.Files && d != null && !d.listed
        if (!noDrive && !listing) Tools(m)
        Banner(m)
        when {
            noDrive -> Empty("i-drive", "No shared drives on this device", "Create one, or join one with an invite from another device.") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button({ m.show(Dialog.AddDrive(false)) }) { Text("New shared drive") }
                    OutlinedButton({ m.show(Dialog.AddDrive(true)) }) { Text("Join with invite") }
                }
            }
            listing -> {
                val l = d!!.listing
                val text = if (l == null || !l.optBoolean("online")) "Waiting for another device of this drive to come online."
                else {
                    val total = l.optLong("total"); val have = l.optLong("have")
                    "${if (total > 0) minOf(99, have * 100 / total) else 0}% · ${count(l.optInt("files"), "1 file", "files")} so far. Files show up once the whole list is here."
                }
                Empty("i-clock", "Getting the list of files", text)
            }
            else -> FileList(m)
        }
    }
}

@Composable
private fun Header(m: AppModel) {
    val d = m.cur
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 4.dp).height(52.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState(Int.MAX_VALUE)), verticalAlignment = Alignment.CenterVertically) {
            when {
                m.screen == Screen.Recent -> Crumb("Recent") {}
                m.screen == Screen.Search -> Crumb("Results for “${m.query}”") {}
                d == null -> Crumb("Shared drives") {}
                else -> {
                    Crumb(d.name) { m.go("/") }
                    var acc = ""
                    for (p in m.dir.split('/').filter { it.isNotEmpty() }) {
                        acc += "/$p"
                        val to = acc
                        Ico("i-chev", tint = colors.muted, size = 20.dp)
                        Crumb(p) { m.go(to) }
                    }
                }
            }
        }
        if (m.screen == Screen.Files && d != null) IconButton({ m.goTo(Screen.Manage) }, Modifier.border(1.dp, colors.line, RoundedCornerShape(99.dp))) { Ico("i-people", tint = colors.text) }
        Spacer(Modifier.width(8.dp))
        Row(Modifier.clip(RoundedCornerShape(99.dp)).border(1.dp, colors.line, RoundedCornerShape(99.dp))) {
            for ((g, ic) in listOf(false to "i-list", true to "i-grid")) {
                Box(Modifier.background(if (m.grid == g) colors.accentSoft else colors.surface).clickable { m.useGrid(g) }.padding(horizontal = 14.dp, vertical = 6.dp)) {
                    Ico(ic, tint = if (m.grid == g) colors.text else colors.muted)
                }
            }
        }
    }
}

@Composable
private fun Crumb(text: String, onClick: () -> Unit) {
    Text(text, Modifier.clip(RoundedCornerShape(99.dp)).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 4.dp), fontSize = 20.sp, maxLines = 1)
}

@Composable
private fun SelectionBar(m: AppModel) {
    val list = m.picked.values.toList()
    val bytes = list.sumOf { if (it.dir) 0 else it.size ?: 0 }
    Row(
        Modifier.fillMaxWidth().padding(8.dp).height(48.dp).clip(RoundedCornerShape(99.dp)).background(colors.surface2).padding(end = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconButton({ m.picked.clear() }) { Ico("i-close", tint = colors.text) }
        Text("${list.size} selected", fontWeight = FontWeight.Medium)
        if (bytes > 0) Small(" · ${size(bytes)}")
        Spacer(Modifier.weight(1f))
        if (list.any { it.online }) IconButton({ m.setSync(list.filter { it.online }, true) }) { Ico("i-offline-pin", tint = colors.text) }
        if (list.any { !it.online }) IconButton({ m.removeHere(list.filter { !it.online }) }) { Ico("i-cloud", tint = colors.text) }
        if (list.any { !it.pending }) IconButton({ m.delete(list.filter { !it.pending }) }) { Ico("i-trash", tint = colors.bad) }
        val shown = m.shown()
        if (m.picked.size < shown.size) IconButton({ for (it in shown) m.picked[m.pk(it)] = it }) { Ico("i-selectall", tint = colors.text) }
    }
}

@Composable
private fun Tools(m: AppModel) {
    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (m.screen != Screen.Recent) item {
            var open by remember { mutableStateOf(false) }
            Box {
                Chip(sortLabel(m.sort), lead = "i-sort") { open = true }
                DropdownMenu(open, { open = false }) {
                    for ((key, asc, label) in SORTS) MenuItem("", label, checked = m.sort.key == key && m.sort.asc == asc) { open = false; m.setSort(m.sort.copy(key = key, asc = asc)) }
                    HorizontalDivider(color = colors.line)
                    MenuItem("", "Folders first", checked = m.sort.folders) { open = false; m.setSort(m.sort.copy(folders = !m.sort.folders)) }
                }
            }
        }
        for ((k, def) in FILTERS) item {
            val (label, opts) = def
            val v = when (k) { "type" -> m.filter.type; "avail" -> m.filter.avail; else -> m.filter.whenAgo }
            val set = { x: String -> m.filter = when (k) { "type" -> m.filter.copy(type = x); "avail" -> m.filter.copy(avail = x); else -> m.filter.copy(whenAgo = x) } }
            var open by remember { mutableStateOf(false) }
            Box {
                Chip(opts.firstOrNull { it.first == v }?.second ?: label, on = v.isNotEmpty()) { open = true }
                DropdownMenu(open, { open = false }) {
                    for ((x, l) in opts) MenuItem("", l, checked = v == x) { open = false; set(if (v == x) "" else x) }
                    if (v.isNotEmpty()) { HorizontalDivider(color = colors.line); MenuItem("i-close", "Clear") { open = false; set("") } }
                }
            }
        }
        if (m.filter.on) item { TextButton({ m.filter = Filter() }) { Text("Clear filters") } }
    }
}

@Composable
private fun Banner(m: AppModel) {
    val d = m.cur ?: return
    if (m.screen != Screen.Files) return
    val h = d.hold
    @Composable fun box(icon: String, info: Boolean, content: @Composable () -> Unit) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).clip(RoundedCornerShape(12.dp))
                .background(if (info) colors.accentSoft else colors.warnBg).padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Ico(icon, tint = if (info) colors.text else colors.bad, size = 20.dp)
            Column(Modifier.weight(1f)) { content() }
        }
    }
    when {
        h != null && d.phase != "error" -> box(if (h.ready) "i-cloud" else "i-clock", true) {
            if (!h.ready) Text("Checking how big “${d.name}” is… Nothing is downloaded until then." + if (d.peers.any { it.online }) "" else " Waiting for another device of this drive to come online.", fontSize = 14.sp)
            else {
                val fits = h.free == null || h.bytes < h.free
                Text("“${d.name}” has ${size(h.bytes)} in ${count(h.files, "1 file", "files")}. " +
                    (if (h.free != null) "This device has ${size(h.free)} free. " else "") +
                    (if (!fits) "It does not fit: choose what to sync. " else "") + "Sync everything to this device?", fontSize = 14.sp)
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (fits) Button({ m.holdChoice(emptyList(), "Syncing everything in ${d.name}") }) { Text("Sync everything") }
                    OutlinedButton({ m.show(Dialog.Choose(d.id)) }) { Text("Choose") }
                }
                TextButton({ m.holdChoice(listOf("/"), "Files stay online only. Open any of them, or choose what to keep, anytime.") }) { Text("Keep online only") }
            }
        }
        d.phase == "error" -> box("i-error", false) { Text(d.error ?: "Sync error", fontSize = 14.sp, color = colors.warnText) }
        d.failed.isNotEmpty() -> box("i-error", false) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${count(d.failed.size, "1 file", "files")} couldn't sync to this device", Modifier.weight(1f), fontSize = 14.sp, color = colors.warnText)
                TextButton({ m.goTo(Screen.Manage) }) { Text("Details") }
            }
        }
    }
}

@Composable
fun Empty(icon: String, title: String, text: String, actions: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Ico(icon, tint = colors.line, size = 96.dp)
        Gap(12.dp)
        Text(title, fontSize = 20.sp)
        Gap(4.dp)
        Text(text, color = colors.muted, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (actions != null) { Gap(12.dp); actions() }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FileList(m: AppModel) {
    val list = m.shown()
    if (list.isEmpty()) {
        if (!m.loaded) return
        if (m.items.isNotEmpty() && m.filter.on) {
            return Empty("i-empty", "Nothing matches these filters", "${count(m.items.size, "1 item is", "items are")} hidden here.") {
                OutlinedButton({ m.filter = Filter() }) { Text("Clear filters") }
            }
        }
        val (t, s) = when (m.screen) {
            Screen.Search -> "No results" to "Try a different name."
            Screen.Recent -> "No recent files" to "Files you add or change on any device show up here."
            else -> "Nothing here yet" to "Add files with the + button."
        }
        return Empty("i-empty", t, s)
    }
    val click = { it: Item -> if (m.picked.isNotEmpty()) toggle(m, it) else m.open(it) }
    val long = { it: Item -> toggle(m, it) }
    if (m.grid) {
        LazyVerticalGrid(GridCells.Adaptive(160.dp), contentPadding = PaddingValues(12.dp, 8.dp, 12.dp, 96.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(list, key = { m.pk(it) }) { FileCard(m, it, click, long) }
        }
    } else {
        LazyColumn(contentPadding = PaddingValues(bottom = 96.dp)) {
            items(list, key = { m.pk(it) }) { FileRow(m, it, click, long) }
        }
    }
}

private fun toggle(m: AppModel, it: Item) {
    val k = m.pk(it)
    if (m.picked.containsKey(k)) m.picked.remove(k) else m.picked[k] = it
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FileRow(m: AppModel, it: Item, click: (Item) -> Unit, long: (Item) -> Unit) {
    val sel = m.picked.containsKey(m.pk(it))
    val dim = it.online && !it.local
    Row(
        Modifier.fillMaxWidth().background(if (sel) colors.selected else colors.surface)
            .combinedClickable(onClick = { click(it) }, onLongClick = { long(it) })
            .padding(start = 16.dp, end = 4.dp).height(68.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
            if (sel) Box(Modifier.size(28.dp).clip(RoundedCornerShape(14.dp)).background(colors.accent), contentAlignment = Alignment.Center) { Ico("i-tick", tint = colors.onAccent, size = 20.dp) }
            else FileIcon(m, it, thumbs = true)
        }
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(it.name, Modifier.weight(1f, fill = false), color = if (dim) colors.muted else colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 16.sp)
                if (CONFLICT.containsMatchIn(it.name)) ConflictTag()
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StateLine(m, it)
                val where = if (m.screen != Screen.Files && it.spaceName != null) it.spaceName + (if (parentOf(it.path) == "/") "" else " › " + parentOf(it.path).drop(1).replace("/", " › ")) else null
                Small(listOfNotNull(if (it.dir) folderText(it) else size(it.size), whenText(it.mtime), where).filter { s -> s.isNotEmpty() }.joinToString(" · "), maxLines = 1)
            }
            ProgressFor(m, it)
        }
        IconButton({ m.show(Dialog.Menu(it)) }) { Ico("i-more", tint = colors.muted) }
    }
    HorizontalDivider(Modifier.padding(start = 70.dp), color = colors.line)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FileCard(m: AppModel, it: Item, click: (Item) -> Unit, long: (Item) -> Unit) {
    val sel = m.picked.containsKey(m.pk(it))
    Column(
        Modifier.clip(RoundedCornerShape(12.dp)).background(if (sel) colors.selected else colors.surface2)
            .combinedClickable(onClick = { click(it) }, onLongClick = { long(it) })
    ) {
        Row(Modifier.padding(start = 10.dp).height(44.dp), verticalAlignment = Alignment.CenterVertically) {
            if (sel) Ico("i-tick", tint = colors.accent, size = 20.dp) else Ico("f-${kind(it)}", tint = colors.files[kind(it)] ?: colors.muted, size = 20.dp)
            Text(it.name, Modifier.weight(1f).padding(start = 8.dp), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            IconButton({ m.show(Dialog.Menu(it)) }, Modifier.size(36.dp)) { Ico("i-more", tint = colors.muted, size = 20.dp) }
        }
        Box(Modifier.padding(horizontal = 8.dp).fillMaxWidth().aspectRatio(1.3f).clip(RoundedCornerShape(8.dp)).background(colors.surface), contentAlignment = Alignment.Center) {
            FileIcon(m, it, 56.dp, thumbs = true)
        }
        Row(Modifier.padding(horizontal = 8.dp, vertical = 6.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { StateLine(m, it) }
            Small(if (it.dir) folderText(it) else size(it.size), maxLines = 1)
        }
    }
}

// ---- transfers ----

@Composable
private fun TransferBar(m: AppModel) {
    val all = m.allTransfers().filter { it.dir != "add" || it.size > 2 * 1024 * 1024 || it.state != "done" } // tiny local adds are noise
    if (all.isEmpty() || m.panelClosed) return
    val active = all.filter { it.moving }
    val title = transferTitle(all, active)
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)).background(colors.surface2)
            .clickable { m.show(Dialog.Transfers) }.padding(start = 20.dp, end = 4.dp).height(56.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (active.isNotEmpty()) {
                val b = active.sumOf { it.bytes }; val s = active.sumOf { it.size }
                Small("${if (s > 0) b * 100 / s else 0}% · ${size(b)} of ${size(s)}", maxLines = 1)
            }
        }
        IconButton({ m.show(Dialog.Transfers) }) { Ico("i-expand", tint = colors.muted) }
        IconButton({ m.closePanel() }) { Ico("i-close", tint = colors.muted) }
    }
}

fun transferTitle(all: List<Transfer>, active: List<Transfer>): String {
    val down = active.filter { it.dir == "down" }
    val prep = down.filter { it.preparing != null }
    val sending = active.filter { it.dir != "down" }
    return when {
        active.isEmpty() -> count(all.count { it.state == "done" }, "1 file synced", "files synced")
        prep.isNotEmpty() && prep.size == down.size && sending.isEmpty() -> "Waiting for ${prep[0].device} to prepare ${count(prep.size, "1 file", "files")}"
        down.isNotEmpty() -> "Downloading ${count(down.size, "1 file", "files")}"
        else -> "Sending ${count(sending.size, "1 file", "files")}"
    }
}

fun describe(m: AppModel, t: Transfer): String {
    val where = if (m.drives.size > 1) " · ${m.driveName(t.space)}" else ""
    val who = t.device ?: "device"
    val rate = (if (t.speed > 0) " · ${size(t.speed)}/s" else "") + (if (t.eta != null) " · ${eta(t.eta)}" else "")
    return when {
        t.state == "failed" -> "Failed" + (t.error?.let { ": $it" } ?: "")
        t.dir == "browser" -> (if (t.state == "done") "Uploaded" else "Uploading · ${size(t.bytes)} of ${size(t.size)}") + where
        t.dir == "add" -> (if (t.state == "done") "Added to the drive" else "Preparing · ${t.percent}%") + where
        t.dir == "up" -> (if (t.state == "done") "Sent to $who" else "Sending to $who · ${size(t.bytes)} of ${size(t.size)}$rate") + where
        t.state == "done" -> "Downloaded from $who$where"
        t.state == "saving" -> "Saving…"
        t.preparing != null -> "Being prepared on $who · ${t.preparing}%$where"
        t.state == "waiting" || (t.bytes == 0L && t.speed == 0L) -> if (t.online == false) "Waiting for $who to come online" else "Waiting for $who…"
        else -> "${size(t.bytes)} of ${size(t.size)}$rate$where"
    }
}
