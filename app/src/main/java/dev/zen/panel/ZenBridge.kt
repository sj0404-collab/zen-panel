package dev.zen.panel

import android.content.Intent
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.ByteArrayOutputStream

/**
 * JS → Android. The panel page calls these when a session publishes an
 * address, so the phone can show a system notification with «Открыть чат»
 * even if the WebView is in the background, and the «Приложения» tab lists
 * what is installed here so an app can be opened from inside the panel.
 */
class ZenBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun notifyReady(title: String, body: String, slot: String, url: String) {
        activity.runOnUiThread {
            activity.showSessionNotification(title, body, slot, url)
        }
    }

    @JavascriptInterface
    fun requestNotifications() {
        activity.runOnUiThread { activity.ensureNotificationPermission() }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        activity.runOnUiThread { activity.openInSystemBrowser(url) }
    }

    /**
     * Everything launchable on this phone, as JSON: `[{label, pkg, icon}]`.
     * A JS interface can only return strings, so the page parses this itself.
     *
     * Reading another package's label and icon is what the launcher tab needs;
     * the manifest's <queries> block is what lets it happen at all on
     * Android 11+. The icon is a small PNG in base64 - a 48px one is a few
     * hundred bytes, so the whole list still fits in one bridge call.
     */
    @JavascriptInterface
    fun listApps(): String {
        val pm = activity.packageManager
        val want = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val found: List<ResolveInfo> = try {
            pm.queryIntentActivities(want, 0)
        } catch (e: Exception) {
            emptyList()
        }
        val out = StringBuilder("[")
        var first = true
        // One app can answer several activities (a launcher icon and a
        // shortcut, say). Same package twice is noise in a launcher list.
        val seen = HashSet<String>()
        for (ri in found.sortedBy { it.loadLabel(pm).toString().lowercase() }) {
            val pkg = ri.activityInfo?.packageName ?: continue
            if (!seen.add(pkg)) continue
            val label = try { ri.loadLabel(pm).toString() } catch (e: Exception) { continue }
            if (label.isBlank()) continue
            if (!first) out.append(',')
            first = false
            out.append("{\"label\":").append(json(label))
            out.append(",\"pkg\":").append(json(pkg))
            val icon = iconBase64(ri.loadIcon(pm))
            if (icon != null) out.append(",\"icon\":").append(json(icon))
            out.append('}')
        }
        return out.append(']').toString()
    }

    /** Open a package the same way tapping its home icon would. */
    @JavascriptInterface
    fun launchApp(pkg: String) {
        activity.runOnUiThread {
            try {
                val launch = activity.packageManager
                    .getLaunchIntentForPackage(pkg)
                    ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (launch != null) activity.startActivity(launch)
                else toast("Нечем открыть: $pkg")
            } catch (e: Exception) {
                toast("Не открылось: $pkg")
            }
        }
    }

    private fun toast(msg: String) {
        Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()
    }

    private fun json(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' || c == '\\' -> b.append('\\').append(c)
                c == '\n' -> b.append("\\n")
                c == '\r' -> b.append("\\r")
                c == '\t' -> b.append("\\t")
                c < ' ' || c > '~' -> b.append(String.format("\\u%04x", c.code))
                else -> b.append(c)
            }
        }
        return b.append('"').toString()
    }

    private fun iconBase64(src: Drawable?): String? {
        if (src == null) return null
        val bmp = (src as? BitmapDrawable)?.bitmap ?: try {
            val size = ICON_PX
            Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).also { b ->
                val canvas = Canvas(b)
                src.setBounds(0, 0, size, size)
                src.draw(canvas)
            }
        } catch (e: Exception) {
            null
        } ?: return null
        return try {
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }
    }

    private companion object {
        const val ICON_PX = 96
    }
}