package eu.kanade.presentation.reader

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.speech.tts.TextToSpeech
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoMode
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.GTranslate
import androidx.compose.material.icons.outlined.Spellcheck
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material.icons.outlined.VolumeUp
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationCompat
import eu.kanade.tachiyomi.data.tts.TtsSpeaker
import eu.kanade.tachiyomi.util.system.toast
import mihon.data.ocr.CyrillicTranslitFixer
import mihon.data.ocr.MangaTranslatorService
import mihon.domain.ocr.service.OcrPreferences
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.util.Locale

@Composable
fun TranslationCard(
    originalText: String,
    targetLanguage: String = "ru",
    modifier: Modifier = Modifier,
) {
    if (originalText.isBlank()) return

    var translationText by remember(originalText) { mutableStateOf<String?>(null) }
    var restoredCyrillic by remember(originalText) { mutableStateOf<String?>(null) }
    var isTranslating by remember(originalText) { mutableStateOf(true) }
    var isSpeaking by remember(originalText) { mutableStateOf(false) }
    val context = LocalContext.current

    // Выбор голоса прямо в карточке: авто/вручную и женский/мужской.
    // Пользователь просил, чтобы в рамке с текстом рядом с кнопками «голос»
    // и «копировать» был выбор голоса, а не только озвучка и копирование.
    val ocrPrefs = remember { Injekt.get<OcrPreferences>() }
    var manualVoice by remember { mutableStateOf(ocrPrefs.manualVoiceMode().get()) }
    var voiceGender by remember { mutableStateOf(ocrPrefs.manualVoiceGender().get()) }

    DisposableEffect(Unit) {
        onDispose { TtsSpeaker.stop() }
    }

    LaunchedEffect(originalText, targetLanguage) {
        isTranslating = true
        val fixedText = CyrillicTranslitFixer.autoFixCyrillic(originalText)
        if (fixedText != originalText) {
            restoredCyrillic = fixedText
        } else {
            restoredCyrillic = null
        }

        val translated = MangaTranslatorService.translate(fixedText, targetLanguage)
        translationText = translated
        isTranslating = false

        // Post translation to system notifications
        showTranslationNotification(context, translated)
    }

    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.85f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Блок кириллицы показываем ТОЛЬКО если он отличается от перевода —
            // раньше при русской манге текст дублировался дважды.
            restoredCyrillic?.takeIf { fixed ->
                val tr = translationText
                tr == null || !fixed.trim().equals(tr.trim(), ignoreCase = true)
            }?.let { cyrillic ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Spellcheck,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            text = "Восстановленный русский текст (Кириллица):",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                }
                Text(
                    text = cyrillic,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
                HorizontalDivider()
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Outlined.GTranslate,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    Text(
                        text = "Перевод OCR на русский (ИИ):",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
                Row {
                    IconButton(
                        onClick = {
                            manualVoice = !manualVoice
                            ocrPrefs.manualVoiceMode().set(manualVoice)
                            context.toast(
                                if (manualVoice) {
                                    "Голос выбирается вручную"
                                } else {
                                    "Голос определяется автоматически"
                                },
                            )
                        },
                    ) {
                        Icon(
                            imageVector = if (manualVoice) Icons.Outlined.TouchApp else Icons.Outlined.AutoMode,
                            contentDescription = "Выбор голоса: автоматически или вручную",
                        )
                    }
                    IconButton(
                        onClick = {
                            voiceGender = if (voiceGender == "male") "female" else "male"
                            ocrPrefs.manualVoiceGender().set(voiceGender)
                            context.toast(if (voiceGender == "male") "Мужской голос" else "Женский голос")
                        },
                    ) {
                        Text(
                            text = if (voiceGender == "male") "♂" else "♀",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                    IconButton(
                        onClick = {
                            val textToSpeak = translationText ?: restoredCyrillic ?: originalText
                            if (isSpeaking) {
                                TtsSpeaker.stop()
                                isSpeaking = false
                            } else {
                                TtsSpeaker.speak(context, textToSpeak) { speaking ->
                                    isSpeaking = speaking
                                }
                            }
                        },
                    ) {
                        Icon(
                            imageVector = if (isSpeaking) Icons.Outlined.Stop else Icons.Outlined.VolumeUp,
                            contentDescription = "Озвучить / Остановить",
                        )
                    }
                    IconButton(
                        onClick = {
                            val textToCopy = restoredCyrillic ?: translationText
                            textToCopy?.let { text ->
                                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                val clip = android.content.ClipData.newPlainText("Translation", text)
                                clipboard.setPrimaryClip(clip)
                                context.toast("Текст скопирован")
                            }
                        },
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.ContentCopy,
                            contentDescription = "Копировать текст",
                        )
                    }
                }
            }

            if (isTranslating) {
                Text(
                    text = "Переводим кадр...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f),
                )
            } else {
                Text(
                    text = translationText ?: originalText,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
        }
    }
}

private fun showTranslationNotification(context: Context, text: String) {
    if (text.isBlank()) return
    try {
        val channelId = "yomihon_translation_channel"
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                "Перевод OCR Yomihon",
                NotificationManager.IMPORTANCE_LOW,
            )
            notificationManager.createNotificationChannel(channel)
        }

        // Полная страница OCR даёт тысячи символов: Notification такого
        // размера отклоняется системой (TransactionTooLargeException).
        val safeText = text.take(800)
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.ic_menu_search)
            .setContentTitle("Yomikai: Перевод OCR")
            .setContentText(safeText.take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(safeText))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setAutoCancel(true)
            .build()

        notificationManager.notify(7001, notification)
    } catch (e: Exception) {
        // Handle notification permission or service absence gracefully
    }
}
