package dev.zen.panel

import android.webkit.JavascriptInterface

/**
 * JS → Android. The panel page calls these when a session publishes an
 * address, so the phone can show a system notification with «Открыть чат»
 * even if the WebView is in the background.
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
}
