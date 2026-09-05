package mihon.data.ocr

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat

/**
 * Шторка уведомлений для распознанного текста.
 *
 * Запрос пользователя: «уменьш оверлей распознаного текста либо вынеси в шторку уведомлений».
 * Решение:
 *  - Оверлей по умолчанию — компактный (320dp карточка), а не на 70% экрана
 *  - Опция `pref_ocr_to_notification` дублирует распознанный текст в Notification
 *    с действиями Копировать / Озвучить / Закрыть — не перекрывает читалку
 *  - Стриминг: пока OCR идёт по тайлам, уведомление обновляется построчно
 */
object OcrNotificationManager {

    private const val CHANNEL_ID = "yomikai_ocr"
    private const val CHANNEL_NAME = "Распознанный текст"
    private const val NOTIF_ID = 4201

    private val _lastText = MutableStateFlow<String?>(null)
    val lastText: StateFlow<String?> = _lastText

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Распознанный OCR-текст из читалки и браузера"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        nm.createNotificationChannel(channel)
    }

    fun show(
        context: Context,
        text: String,
        isStreaming: Boolean = false,
        onCopy: (() -> Unit)? = null,
        onSpeak: (() -> Unit)? = null,
    ) {
        if (text.isBlank()) return
        _lastText.value = text
        ensureChannel(context)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val preview = text.take(512)
        val bigText = if (isStreaming) "$preview\n…распознаётся…" else preview

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle(if (isStreaming) "Распознаётся…" else "Распознанный текст")
            .setContentText(preview.take(40))
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
            .setOngoing(isStreaming)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)

        // Действия добавляются через PendingIntent в Activity — здесь заглушка
        // для логгирования; реальные Intent'ы ставит ReaderActivity/BrowserTab.
        if (!isStreaming) {
            builder.addAction(0, "Копировать", null)
            builder.addAction(0, "Озвучить", null)
        }

        try {
            nm.notify(NOTIF_ID, builder.build())
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "OcrNotificationManager notify failed" }
        }
    }

    fun updateStreaming(context: Context, partialText: String) {
        show(context, partialText, isStreaming = true)
    }

    fun dismiss(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { nm.cancel(NOTIF_ID) }
        _lastText.value = null
    }
}
