package app.syncker.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val REASONS = mapOf(
    "ENAMETOOLONG" to "name too long for this device", "EISDIR" to "a folder here has the same name",
    "ENOTDIR" to "a file here has the same name as a folder", "ESYMLINK" to "goes through a symbolic link",
    "EACCES" to "permission denied", "EINVAL" to "name not allowed on this device", "ENOSPC" to "disk full"
)

/** A drive's devices, its invite and what this device keeps of it. */
@Composable
fun ManageScreen(m: AppModel) {
    val d = m.cur ?: return
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 120.dp)) {
        Row(Modifier.padding(top = 12.dp).horizontalScroll(rememberScrollState(Int.MAX_VALUE)), verticalAlignment = Alignment.CenterVertically) {
            Text(d.name, Modifier.clip(RoundedCornerShape(99.dp)).clickable { m.go("/") }.padding(horizontal = 8.dp, vertical = 4.dp), fontSize = 20.sp, maxLines = 1, softWrap = false)
            Ico("i-chev", tint = colors.muted, size = 20.dp)
            Text("Manage", Modifier.padding(horizontal = 8.dp), fontSize = 20.sp, maxLines = 1, softWrap = false)
        }

        SectionTitle("Devices in this drive")
        val stores = { key: String ->
            val r = d.selections[key]
            val ex = r?.excluded ?: emptyList()
            (if ("/" in ex) "Stores nothing (online only)" else if (ex.isNotEmpty()) "Stores everything except ${count(ex.size, "1 item", "items")}" else "Stores everything") +
                (if (r?.allowRemote == false) " · only it can change this" else "")
        }
        Device(m.status?.device ?: "", "${count(d.files, "1 file", "files")} stored here · ${size(d.bytes)}", stores(d.key), true, true, "i-phone") { m.show(Dialog.Choose(d.id)) }
        for (p in d.peers) {
            val x = m.allTransfers().filter { it.moving && it.space == d.id && it.device == p.name }
            val sub = if (p.online) "Online" + (if (x.isNotEmpty()) " · ${if (x.any { it.dir == "down" }) "sending you" else "receiving"} ${count(x.size, "1 file", "files")}" else "")
            else p.lastSeen?.let { "Last seen ${ago(it)}" } ?: "Never connected"
            Device(p.name, sub, stores(p.key), p.online, false, deviceIcon(p.name)) { m.show(Dialog.Choose(d.id, p.key)) }
        }
        if (d.peers.isEmpty()) Small("No other devices yet. Add one below.", Modifier.padding(top = 4.dp))

        SectionTitle("Add a device")
        var rows by remember(d.id, d.invite) { mutableStateOf<List<String>>(emptyList()) }
        LaunchedEffect(d.id, d.invite) { rows = try { m.api.inviteQr(d.id) } catch (_: Exception) { emptyList() } }
        Column(Modifier.fillMaxWidth().border(1.dp, colors.line, RoundedCornerShape(12.dp)).padding(16.dp)) {
            QrCode(rows, Modifier.size(200.dp).align(Alignment.CenterHorizontally))
            Gap(12.dp)
            Text("On your computer, open Syncker, choose Join with invite and paste this invite" + (if (d.camera) " to get the photos from this phone" else "") +
                ". On another phone, scan this code with the camera.", fontSize = 14.sp)
            Gap(8.dp)
            Text(d.invite, Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(colors.surface2).padding(10.dp), fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({ m.host.copy("Syncker invite", d.invite); m.toast("Invite copied") }) { Ico("i-copy", size = 18.dp); Text("  Copy invite") }
                OutlinedButton({ m.host.share(d.invite) }) { Text("Share") }
            }
            Small("Each invite is one shared drive. Anyone with it can read and change every file in this drive, and nothing else.", Modifier.padding(top = 8.dp))
        }

        SectionTitle("On this device")
        val ex = d.excluded
        Info("Stored here", if ("/" in ex) "Nothing: the whole drive is online only"
            else if (ex.isNotEmpty()) "Everything except ${count(ex.size, "1 online-only item", "online-only items")} (${ex.take(3).joinToString(", ") { it.drop(1) }}${if (ex.size > 3) ", …" else ""})"
            else "Everything")
        Info("Folder", d.folder)
        Info("Copies", if (d.direct) "Files are sent straight from the folder: no second copy in the sync data. Only the latest version of each file can be downloaded, from a device that has it."
            else "Each device keeps a copy of what it shares in its sync data, so older versions stay downloadable.")
        if (d.ignore.isNotEmpty()) Info("Not synced", d.ignore.joinToString(", ") + " (on this device)")
        Info("Last sync", d.lastSync?.let(::ago) ?: "never")
        d.network?.let { n ->
            Info("Network", if (!n.optBoolean("online")) "Offline: no connection to the peer network"
                else "Online · ${count(n.optInt("connections"), "1 connection", "connections")}" + if (n.optBoolean("firewalled")) " · behind a firewall/NAT (connects by hole punching)" else " · directly reachable")
        }
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ m.show(Dialog.Choose(d.id)) }) { Ico("i-tune", size = 18.dp); Text("  Choose what to sync") }
            OutlinedButton({ m.syncNow() }) { Ico("i-sync", size = 18.dp); Text("  Sync now") }
        }
        Row(Modifier.padding(top = 12.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Allow other devices in this drive to choose what this device syncs", Modifier.weight(1f), fontSize = 14.sp)
            Switch(d.allowRemote, { on -> m.run { m.api.allowRemote(d.id, on) } })
        }
        if (d.failed.isNotEmpty()) {
            SectionTitle("Couldn't sync")
            for ((p, e) in d.failed.take(50)) Small("$p — ${REASONS[e] ?: e}", Modifier.padding(vertical = 2.dp), colors.bad)
        }

        SectionTitle("Drive")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ m.renameDrive() }) { Ico("i-edit", size = 18.dp); Text("  Rename") }
            OutlinedButton({ m.leaveDrive() }) { Ico("i-logout", size = 18.dp, tint = colors.bad); Text("  Leave on this device", color = colors.bad) }
        }
        Small("Leaving stops syncing this drive here. Files already in its folder stay, and other devices keep the drive.", Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun Device(name: String, sub: String, stores: String, online: Boolean, me: Boolean, icon: String, choose: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).border(1.dp, colors.line, RoundedCornerShape(12.dp)).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).background(colors.accentSoft), contentAlignment = Alignment.Center) { Ico(icon, tint = colors.accent) }
            Dot(online, Modifier.align(Alignment.BottomEnd))
        }
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Text(name, fontWeight = FontWeight.Medium, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            if (me) Small("This device")
            Small(sub)
            Small(stores)
        }
        IconButton(choose) { Ico("i-tune", tint = colors.muted) }
    }
}

@Composable
private fun Info(k: String, v: String) {
    Column(Modifier.padding(vertical = 4.dp)) {
        Small(k)
        Text(v, fontSize = 14.sp)
    }
}
