package app.syncker.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** First start: create a shared drive, or join one with an invite. */
@Composable
fun SetupScreen(m: AppModel) {
    val s = m.status ?: return
    var join by remember { mutableStateOf(m.pendingInvite != null) }
    var invite by remember { mutableStateOf(m.pendingInvite ?: "") }
    var drive by remember { mutableStateOf(if (m.pendingInvite != null) inviteName(m.pendingInvite!!) else "My drive") }
    var device by remember { mutableStateOf(s.defaultName) }
    var folder by remember { mutableStateOf(s.defaultFolder) }
    var edited by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(s.defaultFolder) { if (!edited) folder = s.defaultFolder }
    LaunchedEffect(m.pendingInvite) { m.pendingInvite?.let { join = true; invite = it; drive = inviteName(it) } }

    Scaffold(containerColor = colors.bg, snackbarHost = { SnackbarHost(m.snackbar) }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(Modifier.widthIn(max = 560.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(colors.surface).padding(24.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) { Logo(36.dp); Text("Syncker", fontSize = 22.sp) }
                Gap(20.dp)
                Text("Set up this device", fontSize = 24.sp)
                Small("Create a shared drive for your files, or join one from another device with its invite.", Modifier.padding(top = 4.dp))
                Gap(16.dp)
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(99.dp)).background(colors.surface2)) {
                    for ((j, label) in listOf(false to "New shared drive", true to "Join with invite")) {
                        Box(
                            Modifier.weight(1f).clip(RoundedCornerShape(99.dp)).background(if (join == j) colors.accentSoft else colors.surface2)
                                .clickable { join = j; drive = if (j) inviteName(invite) else drive.ifEmpty { "My drive" } }.padding(vertical = 10.dp),
                            contentAlignment = Alignment.Center
                        ) { Text(label, fontWeight = FontWeight.Medium, fontSize = 14.sp) }
                    }
                }
                if (join) {
                    OutlinedTextField(invite, { v -> invite = v; inviteName(v).takeIf { it.isNotEmpty() }?.let { drive = it } }, Modifier.fillMaxWidth().padding(top = 16.dp),
                        label = { Text("Invite from your other device") }, placeholder = { Text("syncker:…") }, minLines = 2,
                        textStyle = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp))
                    Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedButton({ m.host.scanQr { t -> if (t != null) { invite = t; drive = inviteName(t); m.toast("Invite scanned") } } }) { Ico("i-qr", size = 18.dp); Text("  Scan QR code") }
                        Small("  shown on your other device")
                    }
                }
                OutlinedTextField(drive, { drive = it }, Modifier.fillMaxWidth().padding(top = 16.dp), label = { Text("Shared drive name") }, singleLine = true)
                OutlinedTextField(device, { device = it }, Modifier.fillMaxWidth().padding(top = 8.dp), label = { Text("Device name") }, singleLine = true)
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(folder, { folder = it; edited = true }, Modifier.weight(1f), label = { Text("Folder to sync") }, singleLine = true)
                    TextButton({ m.show(Dialog.Browse(folder) { p -> folder = p; edited = true }) }) { Text("Browse") }
                }
                Gap(24.dp)
                Button({
                    if (join && invite.isBlank()) return@Button m.toast("Paste the invite first")
                    busy = true
                    m.addDrive(join, invite.trim(), drive.trim(), folder.trim(), setup = true, deviceName = device.trim()) { m.pendingInvite = null }.invokeOnCompletion { busy = false }
                }, Modifier.align(Alignment.End), enabled = !busy) { Text(if (join) "Join shared drive" else "Create shared drive") }
            }
        }
    }
}

/** The whole app: setup the first time, then the files. */
@Composable
fun SynckerApp(m: AppModel) {
    SynckerTheme {
        val s = m.status
        when {
            s == null -> Box(Modifier.fillMaxSize().background(colors.bg), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) { Logo(56.dp); Gap(12.dp); Small("Starting Syncker…") }
            }
            !s.configured -> SetupScreen(m)
            else -> MainScreen(m)
        }
        Dialogs(m)
    }
}
