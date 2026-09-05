package eu.kanade.presentation.reader.appbars

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bookmark
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.DocumentScanner
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import eu.kanade.presentation.components.AppBar
import eu.kanade.presentation.components.AppBarActions
import eu.kanade.tachiyomi.data.ui.UiActionRegistry
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mihon.data.ui.UiActionSpec
import mihon.data.ui.UiPlacement
import mihon.domain.ocr.model.OcrModel
import mihon.domain.ocr.service.OcrPreferences
import mihon.feature.ocr.titleRes
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.i18n.stringResource
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

@Composable
fun ReaderTopBar(
    mangaTitle: String?,
    chapterTitle: String?,
    navigateUp: () -> Unit,
    bookmarked: Boolean,
    onToggleBookmarked: () -> Unit,
    onOpenOcrSettings: (() -> Unit)? = null,
    onOpenInWebView: (() -> Unit)? = null,
    onOpenInBrowser: (() -> Unit)? = null,
    onShare: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    // Пользовательские действия реестра UiActions для верхней панели. Список
    // читается не в композиции, а в LaunchedEffect на IO: это файлы на общем
    // хранилище. Ошибка чтения даёт пустой список, а не падение.
    val context = androidx.compose.ui.platform.LocalContext.current
    var userActions by remember { mutableStateOf<List<UiActionSpec>>(emptyList()) }
    LaunchedEffect(Unit) {
        userActions = withContext(Dispatchers.IO) {
            UiActionRegistry.list(context).filter { it.placement == UiPlacement.READER_TOP_BAR }
        }
    }

    AppBar(
        modifier = modifier,
        backgroundColor = Color.Transparent,
        title = mangaTitle,
        subtitle = chapterTitle,
        navigateUp = navigateUp,
        actions = {
            // Быстрая смена OCR-движка прямо в читалке (по требованию
            // пользователя): иконка сканера → выпадающий список всех моделей,
            // включая локальные. Выбор сохраняется в те же преференсы, что
            // и настройки Text Recognition.
            OcrModelQuickSwitcher()
            AppBarActions(
                actions = buildList {
                    onOpenOcrSettings?.let {
                        add(
                            AppBar.Action(
                                title = stringResource(MR.strings.pref_category_ocr),
                                icon = Icons.Outlined.Psychology,
                                onClick = it,
                            ),
                        )
                    }
                    add(
                        AppBar.Action(
                            title = stringResource(
                                if (bookmarked) {
                                    MR.strings.action_remove_bookmark
                                } else {
                                    MR.strings.action_bookmark
                                },
                            ),
                            icon = if (bookmarked) {
                                Icons.Outlined.Bookmark
                            } else {
                                Icons.Outlined.BookmarkBorder
                            },
                            onClick = onToggleBookmarked,
                        ),
                    )
                    onOpenInWebView?.let {
                        add(
                            AppBar.OverflowAction(
                                title = stringResource(MR.strings.action_open_in_web_view),
                                onClick = it,
                            ),
                        )
                    }
                    onOpenInBrowser?.let {
                        add(
                            AppBar.OverflowAction(
                                title = stringResource(MR.strings.action_open_in_browser),
                                onClick = it,
                            ),
                        )
                    }
                    onShare?.let {
                        add(
                            AppBar.OverflowAction(
                                title = stringResource(MR.strings.action_share),
                                onClick = it,
                            ),
                        )
                    }
                    // Свои действия пользователя — в overflow, чтобы не
                    // распухала строка иконок. Эффект ограничен переключением
                    // настроек, поэтому пункт не может уронить читалку.
                    userActions.forEach { action ->
                        add(
                            AppBar.OverflowAction(
                                title = action.title,
                                onClick = { context.toast(UiActionRegistry.apply(context, action)) },
                            ),
                        )
                    }
                },
            )
        },
    )
}

@Composable
private fun OcrModelQuickSwitcher() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { Injekt.get<OcrPreferences>() }
    val modelPref = remember { prefs.ocrModel() }
    val current by modelPref.changes().collectAsState(initial = modelPref.get())
    var open by remember { mutableStateOf(false) }
    val progressMap by eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.progress.collectAsState()
    // Ключ перерисовки статусов установки после скачивания/удаления
    var refresh by remember { mutableStateOf(0) }

    /** Пак моделей, который нужен движку (null = скачивать нечего). */
    fun packOf(model: OcrModel): String? = when (model) {
        OcrModel.CYRILLIC -> "cyrillic_ocr"
        OcrModel.FAST -> "manga_ocr_fast"
        OcrModel.LEGACY -> "manga_ocr"
        else -> null
    }

    IconButton(onClick = { open = true }) {
        Icon(
            Icons.Outlined.DocumentScanner,
            contentDescription = "OCR-движок",
        )
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        listOf(
            // The only offline option is the Russian/Cyrillic PP-OCR pack.
            OcrModel.CYRILLIC,
            OcrModel.ZEN_FREE,
            OcrModel.GLENS,
            OcrModel.OWOCR,
            OcrModel.OPENROUTER,
            OcrModel.GOOGLE,
        ).forEach { model ->
            val pack = packOf(model)
            val installed = remember(model, refresh) {
                pack == null || eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.isPackInstalled(context, pack)
            }
            val downloading = pack != null && progressMap.containsKey(pack)
            val subtitle = when {
                downloading -> "загрузка ${(progressMap[pack]!! * 100).toInt()}%"
                model == OcrModel.CYRILLIC && !installed -> "офлайн • скачать ~21 МБ"
                model == OcrModel.CYRILLIC -> "офлайн • русский PP-OCR ✅"
                pack != null && !installed -> "локальная • нажмите, чтобы скачать"
                pack != null -> "локальная • скачана ✅"
                model == OcrModel.OWOCR -> "внешний сервер OwOCR (ПК, WebSocket)"
                model == OcrModel.OPENROUTER || model == OcrModel.GOOGLE -> "онлайн • нужен API-ключ"
                else -> "онлайн • без ключа"
            }
            DropdownMenuItem(
                text = {
                    androidx.compose.foundation.layout.Column {
                        Text(stringResource(model.titleRes))
                        if (subtitle != null) {
                            Text(
                                subtitle,
                                style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                                color = androidx.compose.material3.MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                leadingIcon = {
                    if (downloading) {
                        androidx.compose.material3.CircularProgressIndicator(
                            progress = { progressMap[pack]!! },
                            modifier = Modifier.size(22.dp),
                        )
                    } else {
                        RadioButton(selected = current == model, onClick = null)
                    }
                },
                onClick = {
                    when {
                        downloading -> Unit // уже качается — ждём
                        !installed && pack != null -> {
                            // Локальной модели нет: запускаем скачивание,
                            // по успеху движок включается автоматически
                            eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.downloadPack(context, pack) { ok ->
                                refresh++
                                if (ok) modelPref.set(model)
                            }
                        }
                        else -> {
                            modelPref.set(model)
                            open = false
                        }
                    }
                },
            )
        }
    }
}
