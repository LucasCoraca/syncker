package app.syncker.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** A spinning icon (work going on). */
@Composable
fun Spin(id: String, tint: Color, size: Dp = 16.dp) {
    val t = rememberInfiniteTransition(label = "spin")
    val a by t.animateFloat(0f, 360f, infiniteRepeatable(tween(1200, easing = LinearEasing), RepeatMode.Restart), label = "spin")
    Ico(id, Modifier.rotate(a), tint, size)
}

/** The colored icon of a file kind, or a photo's thumbnail. */
@Composable
fun FileIcon(m: AppModel, it: Item, size: Dp = 24.dp, thumbs: Boolean = false) {
    val k = kind(it)
    val photo = thumbs && k == "image" && it.local && !it.pending && (it.size ?: 0) < 25L * 1024 * 1024 && !Regex("\\.hei[cf]$", RegexOption.IGNORE_CASE).containsMatchIn(it.name)
    if (photo) {
        val key = "${m.spaceOf(it)}\u0000${it.path}\u0000${it.mtime}"
        var bmp by remember(key) { mutableStateOf(m.api.cachedThumb(key)) }
        LaunchedEffect(key) { if (bmp == null) bmp = m.api.thumb(m.spaceOf(it), it.path, it.mtime, 256) }
        val b = bmp
        if (b != null) {
            Image(b.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            return
        }
    }
    Ico("f-$k", tint = colors.files[k] ?: colors.muted, size = size)
}

/** How a file stands on this device: synced, downloading 40%, online only… (as stateHtml in the web UI). */
@Composable
fun StateLine(m: AppModel, it: Item) {
    val sp = m.spaceOf(it)
    val small = 12.sp
    @Composable fun line(icon: String?, text: String, tint: Color, spin: Boolean = false) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (icon != null) if (spin) Spin(icon, tint) else Ico(icon, tint = tint, size = 16.dp)
            if (text.isNotEmpty()) Text(text, color = tint, fontSize = small, maxLines = 1)
        }
    }
    if (it.dir) {
        val n = m.allTransfers().count { t -> t.moving && t.space == sp && t.path.startsWith(it.path + "/") }
        if (n > 0) line("i-sync", "$n syncing", colors.accent, spin = true)
        else if (it.online) line("i-cloud", "Online only", colors.muted)
        return
    }
    val t = m.transferFor(it.path, sp)
    when {
        t != null && t.dir == "down" -> when {
            t.preparing != null -> line("i-clock", "Preparing ${t.preparing}%", colors.muted)
            t.state == "waiting" || (t.speed == 0L && t.bytes == 0L) -> line("i-clock", if (t.online == false) "Waiting for device" else "Waiting…", colors.muted)
            t.state == "saving" -> line("i-down", "Saving…", colors.accent)
            else -> line("i-down", "${t.percent}%", colors.accent)
        }
        it.pending -> line("i-clock", "Waiting for device", colors.muted)
        t != null && t.state == "active" -> line(if (t.dir == "add" || t.dir == "browser") "i-sync" else "i-up", (if (t.dir == "up") "Sending " else "") + "${t.percent}%", colors.accent, spin = t.dir == "add")
        it.online && !it.local -> line("i-cloud", "Online only", colors.muted)
        it.synced == false -> line("i-sync", "Syncing…", colors.accent, spin = true)
        it.copies?.missing?.isNotEmpty() == true -> {
            val miss = it.copies.missing
            line("i-up", "Not on ${if (miss.size == 1) miss[0] else "${miss.size} devices"} yet", colors.muted)
        }
        else -> line("i-cloud-ok", "", colors.muted)
    }
}

@Composable
fun ProgressFor(m: AppModel, it: Item) {
    if (it.dir) return
    val t = m.transferFor(it.path, m.spaceOf(it)) ?: return
    if (t.state == "done") return
    val mod = Modifier.padding(top = 4.dp).width(160.dp).height(3.dp).clip(RoundedCornerShape(2.dp))
    if (t.state == "waiting" || t.state == "saving") LinearProgressIndicator(mod, color = colors.accent, trackColor = colors.line)
    else LinearProgressIndicator({ t.percent / 100f }, mod, color = colors.accent, trackColor = colors.line)
}

/** The little "conflict" tag after a conflicted copy's name. */
@Composable
fun ConflictTag() {
    Text("conflict", Modifier.padding(start = 6.dp).background(colors.warnBg, RoundedCornerShape(99.dp)).padding(horizontal = 8.dp, vertical = 1.dp),
        color = colors.warnText, fontSize = 11.sp, maxLines = 1)
}

/** A chip as in the web UI's sort and filter row. */
@Composable
fun Chip(text: String, on: Boolean = false, lead: String? = null, onClick: () -> Unit) {
    Row(
        Modifier.height(32.dp).clip(RoundedCornerShape(8.dp))
            .then(if (on) Modifier.background(colors.accentSoft) else Modifier.border(1.dp, colors.faint, RoundedCornerShape(8.dp)))
            .clickable(onClick = onClick).padding(start = 12.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        if (on) Ico("i-tick", size = 18.dp, tint = colors.text) else if (lead != null) Ico(lead, size = 18.dp, tint = colors.text)
        Text(text, fontSize = 14.sp, color = colors.text, maxLines = 1)
        Ico("i-drop", size = 18.dp, tint = colors.muted)
    }
}

/** The invite's QR code, drawn from its rows with a quiet zone around it. */
@Composable
fun QrCode(rows: List<String>, modifier: Modifier = Modifier) {
    Canvas(modifier.background(Color.White)) {
        val n = rows.size
        if (n == 0) return@Canvas
        val cell = size.minDimension / (n + 4)
        for (r in 0 until n) for (c in 0 until n) {
            if (rows[r][c] == '1') drawRect(Color.Black, Offset((c + 2) * cell, (r + 2) * cell), Size(cell + 0.5f, cell + 0.5f))
        }
    }
}

@Composable
fun Small(text: String, modifier: Modifier = Modifier, color: Color = colors.muted, maxLines: Int = Int.MAX_VALUE) =
    Text(text, modifier, color = color, fontSize = 12.sp, maxLines = maxLines, overflow = TextOverflow.Ellipsis)

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) =
    Text(text, modifier.padding(top = 24.dp, bottom = 8.dp), fontSize = 16.sp, fontWeight = FontWeight.Medium)

@Composable
fun Logo(size: Dp = 32.dp) = Ico("i-logo", tint = Color.Unspecified, size = size)

@Composable
fun Gap(h: Dp) = Spacer(Modifier.height(h))

/** The sync chip at the top: all drives together (as render() in the web UI). */
data class ChipState(val text: String, val icon: String, val tint: String)

fun chipState(m: AppModel): ChipState {
    if (!m.connected) return ChipState("Disconnected from Syncker", "i-error", "bad")
    val all = m.drives
    val peers = HashMap<String, Boolean>()
    for (d in all) for (p in d.peers) peers[p.key] = (peers[p.key] ?: false) || p.online
    val online = peers.values.count { it }
    val active = m.allTransfers().filter { it.moving }
    val errs = all.filter { it.phase == "error" }
    val pending = all.sumOf { it.pendingCount }
    val down = active.filter { it.dir == "down" && it.state != "waiting" && (it.bytes > 0 || it.speed > 0) }
    return when {
        errs.isNotEmpty() -> {
            val e = errs[0].error ?: ""
            ChipState(if (e.contains("All files access")) "Paused: allow file access" else if (e.contains("Folder unavailable")) "Paused: folder unavailable" else "Sync error", "i-error", "bad")
        }
        down.isNotEmpty() || active.any { it.state == "active" && it.dir != "down" } -> {
            val list = down.ifEmpty { active }
            val b = list.sumOf { it.bytes }; val s = list.sumOf { it.size }
            ChipState("Syncing ${count(list.size, "1 file", "files")} · ${if (s > 0) b * 100 / s else 0}%", "i-sync", "busy")
        }
        active.any { it.preparing != null } -> {
            val prep = active.filter { it.preparing != null }
            ChipState("${prep[0].device} is preparing ${count(prep.size, "1 file", "files")} · ${prep.sumOf { it.preparing ?: 0 } / prep.size}%", "i-sync", "busy")
        }
        pending > 0 -> ChipState("Waiting for ${count(pending, "1 file", "files")}", "i-clock", "")
        all.any { it.phase == "syncing" } -> ChipState("Syncing…", "i-sync", "busy")
        peers.isNotEmpty() && online == 0 -> ChipState("Up to date · devices offline", "i-cloud-off", "")
        else -> ChipState("Up to date", "i-cloud-ok", "ok")
    }
}

@Composable
fun chipTint(s: ChipState) = when (s.tint) { "ok" -> colors.ok; "busy" -> colors.accent; "bad" -> colors.bad; else -> colors.muted }

@Composable
fun Dot(on: Boolean, modifier: Modifier = Modifier) =
    Box(modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(if (on) colors.ok else colors.faint).border(2.dp, colors.surface, RoundedCornerShape(5.dp)))
