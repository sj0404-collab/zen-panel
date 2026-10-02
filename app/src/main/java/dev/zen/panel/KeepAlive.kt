package dev.zen.panel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the panel alive while the user is inside another app.
 *
 * Android does not stop a WebView when its activity goes to the background -
 * the timers keep running - but it will happily reclaim the whole process once
 * the app leaves the recents screen and nothing is holding it. Then the panel
 * comes back from the dead: the socket is gone, the page falls back on its
 * reconnect path, and the user watches a countdown instead of their hub.
 *
 * A foreground service is exactly the thing that says "this process still
 * matters": the system will not kill it, and because the WebView is not being
 * destroyed, the hub connection survives the trip through another app. The
 * wake lock covers the other half - the CPU going to sleep with the screen off
 * is what stalls a socket that is otherwise perfectly alive.
 *
 * It starts with the activity and stops when the activity is destroyed, so
 * there is nothing to switch on and nothing to remember to switch off.
 */
class KeepAlive : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startInForeground()
        return START_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun startInForeground() {
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val tap = PendingIntent.getActivity(
            this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        ensureChannel()
        @Suppress("DEPRECATION")
        val n = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID)
        else
            Notification.Builder(this)
        val notification = n
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Панель на связи")
            .setContentText("Хаб держится, пока ты в других приложениях")
            .setOngoing(true)
            .setContentIntent(tap)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        acquireWakeLock()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG).apply {
                setReferenceCounted(false)
                // No timeout: the service owns it, and onDestroy() releases it.
                acquire()
            }
        } catch (e: Exception) {
            wakeLock = null   // a missing lock costs battery, not correctness
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.takeIf { it.isHeld }?.release()
        } catch (e: Exception) {
            // already released by the system
        }
        wakeLock = null
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID, "Панель на связи", NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Панель держит соединение с хабом, пока открыты другие приложения"
                setShowBadge(false)
            }
        )
    }

    companion object {
        private const val CHANNEL_ID = "panel-keepalive"
        private const val NOTIFICATION_ID = 7
        private const val WAKE_TAG = "dev.zen.panel:keepalive"

        fun start(activity: android.app.Activity) {
            try {
                val i = Intent(activity, KeepAlive::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    activity.startForegroundService(i)
                else
                    activity.startService(i)
            } catch (e: Exception) {
                // A refused foreground start must not take the panel down with it.
            }
        }

        fun stop(activity: android.app.Activity) {
            try {
                activity.stopService(Intent(activity, KeepAlive::class.java))
            } catch (e: Exception) {
                // nothing to stop
            }
        }
    }
}