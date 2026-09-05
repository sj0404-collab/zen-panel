package eu.kanade.presentation.reader

import android.graphics.RectF
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import eu.kanade.domain.dictionary.OcrResultPresentation
import eu.kanade.tachiyomi.ui.dictionary.DictionarySearchScreenModel
import mihon.domain.dictionary.model.DictionaryTerm

data class OcrResultPopupSettings(
    val widthDp: Int,
    val heightDp: Int,
    val contentScale: Float,
)

@Composable
fun OcrResultOverlay(
    onDismissRequest: () -> Unit,
    presentation: OcrResultPresentation,
    popupSettings: OcrResultPopupSettings,
    dimBackground: Boolean,
    queryText: String,
    initialSearchText: String = queryText,
    anchorRect: RectF?,
    onCopyText: () -> Unit,
    searchState: DictionarySearchScreenModel.State,
    onQueryChange: (String) -> Unit,
    onSearch: (String) -> Unit,
    onTermGroupClick: (List<DictionaryTerm>) -> Unit,
    onPlayAudioClick: (List<DictionaryTerm>) -> Unit,
    onSpeak: () -> Unit = {},
    onChooseVoice: () -> Unit = {},
) {
    BackHandler(onBack = onDismissRequest)
    // Словарей нет — не дёргаем поиск и не показываем «No Dictionaries
    // Enabled»: пользователю нужен сам распознанный текст.
    val noDictionaries = searchState.dictionaries.isEmpty()
    LaunchedEffect(queryText, initialSearchText, noDictionaries) {
        if (queryText.isNotBlank() && !noDictionaries) {
            onQueryChange(queryText)
            onSearch(initialSearchText)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        if (false) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f)),
            )
        }

        when {
            noDictionaries -> {
                OcrPlainTextCard(
                    text = queryText,
                    onCopyText = onCopyText,
                    onDismissRequest = onDismissRequest,
                    onSpeak = onSpeak,
                    onChooseVoice = onChooseVoice,
                )
            }
            presentation == OcrResultPresentation.POPUP && anchorRect != null -> {
                OcrResultPopup(
                    onDismissRequest = onDismissRequest,
                    anchorRect = anchorRect,
                    settings = popupSettings,
                    onCopyText = onCopyText,
                    searchState = searchState,
                    onQueryChange = onQueryChange,
                    onSearch = onSearch,
                    onTermGroupClick = onTermGroupClick,
                    onPlayAudioClick = onPlayAudioClick,
                )
            }
            else -> {
                OcrResultBottomSheet(
                    onDismissRequest = onDismissRequest,
                    onCopyText = onCopyText,
                    searchState = searchState,
                    onQueryChange = onQueryChange,
                    onSearch = onSearch,
                    onTermGroupClick = onTermGroupClick,
                    onPlayAudioClick = onPlayAudioClick,
                )
            }
        }
    }
}

/**
 * Карточка распознанного текста без словарной части: текст можно выделить
 * и скопировать, лишних сообщений «словари не найдены» нет.
 */
@Composable
private fun OcrPlainTextCard(
    text: String,
    onCopyText: () -> Unit,
    onDismissRequest: () -> Unit,
    onSpeak: () -> Unit = {},
    onChooseVoice: () -> Unit = {},
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = androidx.compose.ui.Alignment.Center,
    ) {
        androidx.compose.material3.Surface(
            shape = androidx.compose.foundation.shape.RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            tonalElevation = 6.dp,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 520.dp)
                .padding(24.dp),
        ) {
            androidx.compose.foundation.layout.Column(
                modifier = Modifier.padding(16.dp),
            ) {
                androidx.compose.material3.Text(
                    text = text,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier
                        .verticalScroll(androidx.compose.foundation.rememberScrollState())
                        .heightIn(max = 380.dp),
                )
                androidx.compose.foundation.layout.Spacer(
                    modifier = Modifier.height(12.dp),
                )
                androidx.compose.foundation.layout.Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = androidx.compose.foundation.layout.Arrangement.End,
                ) {
                    androidx.compose.material3.TextButton(onClick = onSpeak) {
                        androidx.compose.material3.Text("Голос")
                    }
                    androidx.compose.material3.TextButton(onClick = onChooseVoice) {
                        androidx.compose.material3.Text("Выбрать голос")
                    }
                    androidx.compose.material3.TextButton(onClick = onCopyText) {
                        androidx.compose.material3.Text("Копировать")
                    }
                    androidx.compose.material3.TextButton(onClick = onDismissRequest) {
                        androidx.compose.material3.Text("Закрыть")
                    }
                }
            }
        }
    }
}
