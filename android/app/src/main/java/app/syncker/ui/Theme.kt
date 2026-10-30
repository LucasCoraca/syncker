package app.syncker.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// The web UI's palette (lib/ui.html :root), so the app and the web UI look alike.
@Immutable
class Palette(
    val bg: Color,
    val surface: Color,
    val surface2: Color,
    val hover: Color,
    val selected: Color,
    val text: Color,
    val muted: Color,
    val faint: Color,
    val line: Color,
    val accent: Color,
    val accentSoft: Color,
    val onAccent: Color,
    val ok: Color,
    val bad: Color,
    val warnBg: Color,
    val warnText: Color,
    val files: Map<String, Color>
)

private val light = Palette(
    bg = Color(0xFFF8FAFD), surface = Color(0xFFFFFFFF), surface2 = Color(0xFFF0F4F9), hover = Color(0xFFE9EEF6),
    selected = Color(0xFFC2E7FF), text = Color(0xFF1F1F1F), muted = Color(0xFF5F6368), faint = Color(0xFF80868B),
    line = Color(0xFFE0E3E7), accent = Color(0xFF0B57D0), accentSoft = Color(0xFFD3E3FD), onAccent = Color.White,
    ok = Color(0xFF188038), bad = Color(0xFFB3261E), warnBg = Color(0xFFFEF7E0), warnText = Color(0xFF7A4F00),
    files = mapOf(
        "folder" to Color(0xFF5F6368), "image" to Color(0xFFD93025), "video" to Color(0xFFD93025), "audio" to Color(0xFF8430CE),
        "pdf" to Color(0xFFEA4335), "doc" to Color(0xFF4285F4), "sheet" to Color(0xFF0F9D58), "slide" to Color(0xFFF4B400),
        "zip" to Color(0xFF5F6368), "code" to Color(0xFF1A73E8), "file" to Color(0xFF5F6368)
    )
)

private val dark = Palette(
    bg = Color(0xFF1B1B1F), surface = Color(0xFF232327), surface2 = Color(0xFF2B2C31), hover = Color(0xFF33353B),
    selected = Color(0xFF004A77), text = Color(0xFFE3E3E3), muted = Color(0xFFA8ABB0), faint = Color(0xFF8E9196),
    line = Color(0xFF3A3C42), accent = Color(0xFFA8C7FA), accentSoft = Color(0xFF0842A0), onAccent = Color(0xFF062E6F),
    ok = Color(0xFF6DD58C), bad = Color(0xFFF2B8B5), warnBg = Color(0xFF4A3800), warnText = Color(0xFFFFDF99),
    files = light.files + mapOf(
        "folder" to Color(0xFFA8ABB0), "zip" to Color(0xFFA8ABB0), "file" to Color(0xFFA8ABB0), "code" to Color(0xFF8AB4F8)
    )
)

val LocalPalette = staticCompositionLocalOf { light }
val colors: Palette @Composable get() = LocalPalette.current

@Composable
fun SynckerTheme(content: @Composable () -> Unit) {
    val p = if (isSystemInDarkTheme()) dark else light
    val scheme = (if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()).copy(
        primary = p.accent, onPrimary = p.onAccent, primaryContainer = p.accentSoft, onPrimaryContainer = p.text,
        secondaryContainer = p.accentSoft, onSecondaryContainer = p.text,
        background = p.bg, onBackground = p.text, surface = p.surface, onSurface = p.text,
        surfaceVariant = p.surface2, onSurfaceVariant = p.muted, outline = p.faint, outlineVariant = p.line,
        surfaceContainer = p.surface2, surfaceContainerHigh = p.surface, surfaceContainerHighest = p.surface2,
        surfaceContainerLow = p.bg, surfaceContainerLowest = p.surface, error = p.bad
    )
    androidx.compose.runtime.CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

private val vectors = HashMap<String, ImageVector>()

/** One of the web UI's icons (see Icons.kt), by its id there: "i-sync", "f-folder", … */
fun icon(id: String): ImageVector = vectors.getOrPut(id) {
    val data = ICON_DATA[id] ?: ICON_DATA.getValue("f-file")
    ImageVector.Builder(id, 24.dp, 24.dp, data.w, data.h).apply {
        for (p in data.paths) addPath(addPathNodes(p.d), fill = SolidColor(p.fill ?: Color.Black))
    }.build()
}

/** An icon in the current text color (or [tint]); multi-color icons keep their colors with Color.Unspecified. */
@Composable
fun Ico(id: String, modifier: Modifier = Modifier, tint: Color = LocalContentColor.current, size: Dp = 24.dp) {
    Icon(icon(id), contentDescription = null, modifier = modifier.size(size), tint = tint)
}
