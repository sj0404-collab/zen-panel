package eu.kanade.presentation.more.settings.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import mihon.data.ocr.OcrHistoryStore
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Экран истории в двух вкладках (запрос пользователя):
 *  1. Авточтение — все события озвучки, включая сбои TTS.
 *  2. Сканирование — успех/неудача по страницам и какие словари сработали.
 *
 * Открыт как полноэкранный диалог из настроек распознавания, чтобы не
 * заводить новую навигационную маршрутизацию.
 */
@Composable
fun OcrHistoryDialog(onDismiss: () -> Unit) {
    val scans by OcrHistoryStore.scans.collectAsState()
    val reads by OcrHistoryStore.reads.collectAsState()
    var tab by remember { mutableIntStateOf(0) }
    val timeFormat = remember { SimpleDateFormat("HH:mm:ss", Locale.getDefault()) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.fillMaxSize()) {
                TabRow(selectedTabIndex = tab) {
                    Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Авточтение") })
                    Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Сканирование") })
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 8.dp),
                    horizontalArrangement = Arrangement.End,
                ) {
                    TextButton(onClick = onDismiss) { Text("Закрыть") }
                }
                HorizontalDivider()
                if (tab == 0) {
                    if (reads.isEmpty()) {
                        EmptyHint("Пусто: журнал заполнится, как только авточтение озвучит или попытается озвучить текст.")
                    } else {
                        LazyColumn(modifier = Modifier.fillMaxSize()) {
                            items(reads) { entry ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 12.dp, vertical = 6.dp),
                                    verticalAlignment = Alignment.Top,
                                ) {
                                    Text(
                                        text = timeFormat.format(Date(entry.time)),
                                        style = MaterialTheme.typography.labelMedium,
                                        modifier = Modifier.padding(end = 8.dp),
                                    )
                                    Text(
                                        text = (if (entry.ok) "✔ " else "✖ ") + entry.event +
                                            if (entry.detail.isNotBlank()) " — ${entry.detail}" else "",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = if (entry.ok) {
                                            MaterialTheme.colorScheme.onSurface
                                        } else {
                                            MaterialTheme.colorScheme.error
                                        },
                                    )
                                }
                                HorizontalDivider()
                            }
                        }
                    }
                } else {
                    if (scans.isEmpty()) {
                        EmptyHint("Пусто: журнал заполнится после первого сканирования/распознавания страницы.")
                    } else {
                        LazyColumn(modifier = Modifier.fillMaxSize()) {
                            items(scans) { entry ->
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 12.dp, vertical = 6.dp),
                                ) {
                                    Row(verticalAlignment = Alignment.Top) {
                                        Text(
                                            text = timeFormat.format(Date(entry.time)),
                                            style = MaterialTheme.typography.labelMedium,
                                            modifier = Modifier.padding(end = 8.dp),
                                        )
                                        Text(
                                            text = (if (entry.ok) "✔ успех" else "✖ неудача") +
                                                if (entry.detail.isNotBlank()) " — ${entry.detail}" else "",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = if (entry.ok) {
                                                MaterialTheme.colorScheme.onSurface
                                            } else {
                                                MaterialTheme.colorScheme.error
                                            },
                                        )
                                    }
                                    // Флаги словарей за проход: слова и пунктуация — реальные
                                    // срабатывания; морфология/интонации придут со словарём RU.
                                    Text(
                                        text = "словари: слова=${entry.wordDictHits}, пунктуация=${entry.punctFixes}, " +
                                            "разбиение=${entry.splitFixes}; морфология=пол говорящего, " +
                                            "интонации=ударения RHVoice + паузы/питч по знакам",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                HorizontalDivider()
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyHint(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(16.dp),
    )
}
