package eu.kanade.tachiyomi.ui.download

import android.speech.tts.TextToSpeech
import android.view.LayoutInflater
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.ViewCompat
import androidx.recyclerview.widget.LinearLayoutManager
import cafe.adriel.voyager.core.model.rememberScreenModel
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.currentOrThrow
import eu.kanade.presentation.components.AppBar
import eu.kanade.presentation.components.AppBarActions
import eu.kanade.presentation.more.settings.widget.EditTextPreferenceWidget
import eu.kanade.presentation.more.settings.widget.InfoWidget
import eu.kanade.presentation.more.settings.widget.ListPreferenceWidget
import eu.kanade.presentation.more.settings.widget.PreferenceGroupHeader
import eu.kanade.presentation.more.settings.widget.SwitchPreferenceWidget
import eu.kanade.presentation.util.Screen
import eu.kanade.tachiyomi.data.tts.TtsSpeaker
import eu.kanade.tachiyomi.util.system.toast
import eu.kanade.tachiyomi.data.tts.VoiceHelper
import eu.kanade.tachiyomi.data.tts.VoiceKind
import eu.kanade.tachiyomi.databinding.DownloadListBinding
import kotlinx.collections.immutable.toPersistentList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import mihon.domain.ocr.model.OcrModel
import mihon.domain.ocr.service.OcrPreferences
import mihon.domain.ocr.service.ScanRegion
import mihon.feature.ocr.titleRes
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.components.Pill
import tachiyomi.presentation.core.components.SliderItem
import tachiyomi.presentation.core.i18n.stringResource
import tachiyomi.presentation.core.screens.EmptyScreen
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

object OcrQueueScreen : Screen() {

    @Composable
    override fun Content() {
        val context = androidx.compose.ui.platform.LocalContext.current
        val navigator = LocalNavigator.currentOrThrow
        val screenModel = rememberScreenModel { OcrQueueScreenModel() }
        val state by screenModel.state.collectAsState()
        val isQueueRunning by screenModel.isQueueRunning.collectAsState()
        val hasQueue = state.totalCount > 0
        val ocrPreferences = remember { Injekt.get<OcrPreferences>() }

        val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior(rememberTopAppBarState())
        var fabExpanded by remember { mutableStateOf(true) }
        val nestedScrollConnection = remember {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    fabExpanded = available.y >= 0
                    return scrollBehavior.nestedScrollConnection.onPreScroll(available, source)
                }

                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    return scrollBehavior.nestedScrollConnection.onPostScroll(consumed, available, source)
                }

                override suspend fun onPreFling(available: Velocity): Velocity {
                    return scrollBehavior.nestedScrollConnection.onPreFling(available)
                }

                override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
                    return scrollBehavior.nestedScrollConnection.onPostFling(consumed, available)
                }
            }
        }

        var currentTab by remember { mutableIntStateOf(0) }

        tachiyomi.presentation.core.components.material.Scaffold(
            topBar = {
                AppBar(
                    titleContent = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = stringResource(MR.strings.label_text_recognition),
                                maxLines = 1,
                                modifier = Modifier.weight(1f, false),
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (state.totalCount > 0) {
                                val pillAlpha = if (isSystemInDarkTheme()) 0.12f else 0.08f
                                Pill(
                                    text = state.totalCount.toString(),
                                    modifier = Modifier.padding(start = 4.dp),
                                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = pillAlpha),
                                    fontSize = 14.sp,
                                )
                            }
                        }
                    },
                    navigateUp = navigator::pop,
                    actions = {
                        if (hasQueue) {
                            AppBarActions(
                                listOf(
                                    AppBar.OverflowAction(
                                        title = stringResource(MR.strings.action_cancel_all),
                                        onClick = screenModel::clearQueue,
                                    ),
                                ).toPersistentList(),
                            )
                        }
                    },
                    scrollBehavior = scrollBehavior,
                )
            },
            floatingActionButton = {
                AnimatedVisibility(
                    visible = hasQueue && currentTab == 0,
                    enter = fadeIn(),
                    exit = fadeOut(),
                ) {
                    ExtendedFloatingActionButton(
                        text = {
                            Text(
                                text = stringResource(
                                    if (isQueueRunning) MR.strings.action_pause else MR.strings.action_resume,
                                ),
                            )
                        },
                        icon = {
                            Icon(
                                imageVector = if (isQueueRunning) Icons.Outlined.Pause else Icons.Filled.PlayArrow,
                                contentDescription = null,
                            )
                        },
                        onClick = {
                            if (isQueueRunning) {
                                screenModel.pauseQueue()
                            } else {
                                screenModel.resumeQueue()
                            }
                        },
                        expanded = fabExpanded,
                    )
                }
            },
        ) { contentPadding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(contentPadding),
            ) {
                PrimaryTabRow(selectedTabIndex = currentTab) {
                    Tab(
                        selected = currentTab == 0,
                        onClick = { currentTab = 0 },
                        text = { Text("Распознавание") },
                    )
                    Tab(
                        selected = currentTab == 1,
                        onClick = { currentTab = 1 },
                        text = { Text("Голоса") },
                    )
                }
                when (currentTab) {
                    0 -> RecognitionTab(
                        screenModel = screenModel,
                        hasQueue = hasQueue,
                        stateItems = state.items,
                        ocrPreferences = ocrPreferences,
                        nestedScrollConnection = nestedScrollConnection,
                    )
                    else -> VoicesTab(ocrPreferences = ocrPreferences)
                }
            }
        }
    }

    /**
     * Строка модельного пака с ЖИВЫМ ИНДИКАТОРОМ (по требованию пользователя):
     *  • не установлен — кнопка «Скачать» с размером;
     *  • качается — LinearProgressIndicator с процентами (реальные байты);
     *  • установлен — галочка, реальный размер на диске, кнопка «Удалить».
     */
    @Composable
    private fun ModelPackRow(
        pack: String,
        title: String,
        sizeHint: String,
        installed: Boolean,
        onInstalledChange: (Boolean) -> Unit,
    ) {
        val context = androidx.compose.ui.platform.LocalContext.current
        val progressMap by eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.progress
            .collectAsState()
        val progress = progressMap[pack]
        val downloading = progress != null

        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.bodyLarge)
                    Text(
                        when {
                            downloading -> "Загрузка… ${(progress!! * 100).toInt()}%"
                            installed -> {
                                val bytes = eu.kanade.tachiyomi.data.ocr.OcrModelDownloader
                                    .installedSize(context, pack)
                                val mb = if (bytes > 0) "${bytes / 1048576} МБ на диске" else sizeHint
                                "✅ Установлена • $mb"
                            }
                            else -> "$sizeHint • не установлена"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                when {
                    downloading -> androidx.compose.material3.CircularProgressIndicator(
                        progress = { progress!! },
                        modifier = Modifier.padding(8.dp).size(28.dp),
                    )
                    installed -> androidx.compose.material3.TextButton(
                        onClick = {
                            eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.deletePack(context, pack)
                            onInstalledChange(false)
                        },
                    ) { Text("Удалить") }
                    else -> androidx.compose.material3.FilledTonalButton(
                        onClick = {
                            eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.downloadPack(context, pack) { ok ->
                                onInstalledChange(ok)
                            }
                        },
                    ) { Text("Скачать") }
                }
            }
            if (downloading) {
                androidx.compose.material3.LinearProgressIndicator(
                    progress = { progress!! },
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
            }
        }
    }

    // region Вкладка «Распознавание» (OCR + офлайн-модели + очередь)

    @Composable
    private fun RecognitionTab(
        screenModel: OcrQueueScreenModel,
        hasQueue: Boolean,
        stateItems: List<OcrItem>,
        ocrPreferences: OcrPreferences,
        nestedScrollConnection: NestedScrollConnection,
    ) {
        val context = androidx.compose.ui.platform.LocalContext.current

        val ocrModelPreference = remember { ocrPreferences.ocrModel() }
        val ocrModel by ocrModelPreference.changes().collectAsState(initial = ocrModelPreference.get())
        val autoOcrOnDownloadPreference = remember { ocrPreferences.autoOcrOnDownload() }
        val autoOcrOnDownload by autoOcrOnDownloadPreference
            .changes()
            .collectAsState(initial = autoOcrOnDownloadPreference.get())
        val owocrAddressPreference = remember { ocrPreferences.owocrAddress() }
        val owocrAddress by owocrAddressPreference
            .changes()
            .collectAsState(initial = owocrAddressPreference.get())
        val useFallbackModelsPreference = remember { ocrPreferences.useFallbackModels() }
        val useFallbackModels by useFallbackModelsPreference
            .changes()
            .collectAsState(initial = useFallbackModelsPreference.get())
        val openrouterKeyPref = remember { ocrPreferences.openrouterApiKey() }
        val openrouterKey by openrouterKeyPref.changes().collectAsState(initial = openrouterKeyPref.get())
        val googleKeyPref = remember { ocrPreferences.googleApiKey() }
        val googleKey by googleKeyPref.changes().collectAsState(initial = googleKeyPref.get())
        val tokenCountPref = remember { ocrPreferences.tokenUsageCount() }
        val tokenCount by tokenCountPref.changes().collectAsState(initial = tokenCountPref.get())
        val scanRegionPref = remember { ocrPreferences.scanRegion() }
        val scanRegion by scanRegionPref.changes().collectAsState(initial = scanRegionPref.get())
        val isMangaOcrDownPref = remember { ocrPreferences.isMangaOcrDownloaded() }
        val isMangaOcrDown by isMangaOcrDownPref.changes().collectAsState(initial = isMangaOcrDownPref.get())
        val isFastOcrDownPref = remember { ocrPreferences.isFastOcrDownloaded() }
        val isFastOcrDown by isFastOcrDownPref.changes().collectAsState(initial = isFastOcrDownPref.get())
        val isPanelDetectorDownPref = remember { ocrPreferences.isPanelDetectorDownloaded() }
        val isPanelDetectorDown by isPanelDetectorDownPref.changes()
            .collectAsState(initial = isPanelDetectorDownPref.get())

        // Migrate every old offline choice to the new canonical Cyrillic OCR.
        LaunchedEffect(Unit) {
            if (ocrModelPreference.get() in setOf(OcrModel.LEGACY, OcrModel.FAST, OcrModel.TESSERACT)) {
                ocrModelPreference.set(OcrModel.CYRILLIC)
            }
            isMangaOcrDownPref.set(
                eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.isPackInstalled(context, "manga_ocr"),
            )
            isFastOcrDownPref.set(
                eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.isPackInstalled(context, "manga_ocr_fast"),
            )
            isPanelDetectorDownPref.set(
                eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.isPackInstalled(context, "panel_detector"),
            )
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .nestedScroll(nestedScrollConnection)
                .verticalScroll(rememberScrollState()),
        ) {
            PreferenceGroupHeader(title = stringResource(MR.strings.label_settings))
            ListPreferenceWidget(
                value = scanRegion,
                title = "Область сканирования страницы",
                subtitle = when (scanRegion) {
                    ScanRegion.FULL_PAGE -> "Сканировать всю страницу целиком (100%)"
                    ScanRegion.TOP_HALF -> "Сканировать верхнюю часть страницы (Top 50%)"
                    ScanRegion.BOTTOM_HALF -> "Сканировать нижнюю часть страницы (Bottom 50%)"
                },
                icon = null,
                entries = mapOf(
                    ScanRegion.FULL_PAGE to "1. Вся страница целиком (100%)",
                    ScanRegion.TOP_HALF to "2. Верхняя часть страницы (50%)",
                    ScanRegion.BOTTOM_HALF to "3. Нижняя часть страницы (50%)",
                ),
                onValueChange = scanRegionPref::set,
            )

            ListPreferenceWidget(
                value = ocrModel,
                title = stringResource(MR.strings.pref_ocr_model),
                subtitle = stringResource(ocrModel.titleRes),
                icon = null,
                entries = mapOf(
                    // One canonical offline engine; old Japanese/Tesseract
                    // engines are migration-only and hidden from new choices.
                    OcrModel.CYRILLIC to stringResource(OcrModel.CYRILLIC.titleRes),
                    OcrModel.GLENS to stringResource(OcrModel.GLENS.titleRes),
                    OcrModel.OWOCR to stringResource(OcrModel.OWOCR.titleRes),
                    OcrModel.OPENROUTER to stringResource(OcrModel.OPENROUTER.titleRes),
                    OcrModel.GOOGLE to stringResource(OcrModel.GOOGLE.titleRes),
                    OcrModel.ZEN_FREE to stringResource(OcrModel.ZEN_FREE.titleRes),
                ),
                onValueChange = ocrModelPreference::set,
            )

            run {
                val fallbackPresetPref = remember { ocrPreferences.fallbackPreset() }
                val fallbackPreset by fallbackPresetPref.changes()
                    .collectAsState(initial = fallbackPresetPref.get())
                ListPreferenceWidget(
                    value = fallbackPreset,
                    title = "Фолбэк при сбое движка",
                    subtitle = when (fallbackPreset) {
                        "online" -> "Только онлайн: Lens → Zen → Gemini"
                        "offline" -> "Только локальные: русский Cyrillic PP-OCR"
                        "single" -> "Без фолбэков — только выбранный движок"
                        else -> "Авто: при сети — онлайн, без сети — локальные"
                    },
                    icon = null,
                    entries = mapOf(
                        "auto" to "Авто (умный выбор по сети)",
                        "online" to "Только онлайн-движки",
                        "offline" to "Только локальные движки",
                        "single" to "Один движок, без фолбэков",
                    ),
                    onValueChange = fallbackPresetPref::set,
                )
            }

            PreferenceGroupHeader(title = "Офлайн-распознавание — русский Cyrillic OCR")
            InfoWidget(
                text = "Новый движок по умолчанию: PP-OCRv4 detector + PP-OCRv3 recognizer " +
                    "+ PP-OCRv5 verifier. Работает полностью без сети после загрузки; " +
                    "модели (~21 МБ) хранятся отдельно и не увеличивают APK.",
            )
            var cyrillicInstalled by remember {
                mutableStateOf(
                    eu.kanade.tachiyomi.data.ocr.OcrModelDownloader.isPackInstalled(
                        context,
                        "cyrillic_ocr",
                    ),
                )
            }
            ModelPackRow(
                pack = "cyrillic_ocr",
                title = "Русский/Cyrillic PP-OCR",
                sizeHint = "~21 МБ • офлайн • рекомендуется",
                installed = cyrillicInstalled,
                onInstalledChange = { installed ->
                    cyrillicInstalled = installed
                    if (installed) ocrModelPreference.set(OcrModel.CYRILLIC)
                },
            )

            PreferenceGroupHeader(title = "Управление локальными OCR-моделями")
            InfoWidget(
                text = "Все локальные модели хранятся вне APK в Android/data/…/files/ocr_models " +
                    "или Yomihon/OCR и скачиваются только по запросу.",
            )
            // Manga OCR (Legacy) и Fast Manga OCR удалены из UI: это
            // ЯПОНСКИЕ модели (bluolightning/manga-ocr), кириллицу не читают —
            // пользователю с русской мангой они только мешали.
            ModelPackRow(
                pack = "panel_detector",
                title = "Panel Detector — YOLO-детектор панелей",
                sizeHint = "~6 МБ",
                installed = isPanelDetectorDown,
                onInstalledChange = { isPanelDetectorDownPref.set(it) },
            )
            if (ocrModel == OcrModel.OWOCR) {
                EditTextPreferenceWidget(
                    title = stringResource(MR.strings.pref_owocr_address),
                    subtitle = stringResource(MR.strings.pref_owocr_address_summary),
                    icon = null,
                    value = owocrAddress,
                    onConfirm = {
                        owocrAddressPreference.set(it)
                        true
                    },
                )
                InfoWidget(text = stringResource(MR.strings.pref_owocr_address_note))
            }
            if (ocrModel == OcrModel.OPENROUTER) {
                EditTextPreferenceWidget(
                    title = "OpenRouter API Key",
                    subtitle = "Key for OpenRouter vision model access",
                    icon = null,
                    value = openrouterKey,
                    onConfirm = {
                        openrouterKeyPref.set(it)
                        true
                    },
                )
            }
            if (ocrModel == OcrModel.GOOGLE) {
                EditTextPreferenceWidget(
                    title = "Google AI API Key",
                    subtitle = "Key for Gemini Vision model access",
                    icon = null,
                    value = googleKey,
                    onConfirm = {
                        googleKeyPref.set(it)
                        true
                    },
                )
            }
            if (ocrModel == OcrModel.ZEN_FREE) {
                InfoWidget(text = stringResource(MR.strings.zen_free_status_label))
            }

            run {
                val aiTabPref = remember { ocrPreferences.aiTabVisible() }
                val aiTabVisible by aiTabPref.changes().collectAsState(initial = aiTabPref.get())
                SwitchPreferenceWidget(
                    checked = aiTabVisible,
                    title = "Вкладка «AI» в нижней панели",
                    subtitle = if (aiTabVisible) {
                        "Встроенный AI-агент виден в навигации"
                    } else {
                        "Скрыта — агент доступен через внешний браузер (порт 8765)"
                    },
                    onCheckedChanged = aiTabPref::set,
                )
            }

            PreferenceGroupHeader(title = stringResource(MR.strings.pref_token_usage))
            InfoWidget(text = stringResource(MR.strings.token_indicator_label, tokenCount))
            SwitchPreferenceWidget(
                checked = autoOcrOnDownload,
                title = stringResource(MR.strings.pref_auto_ocr_on_download),
                onCheckedChanged = autoOcrOnDownloadPreference::set,
            )
            SwitchPreferenceWidget(
                checked = useFallbackModels,
                title = stringResource(MR.strings.pref_use_fallback_models),
                subtitle = stringResource(MR.strings.pref_use_fallback_models_summary),
                onCheckedChanged = useFallbackModelsPreference::set,
            )

            PreferenceGroupHeader(title = stringResource(MR.strings.ocr_queue_header))

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(if (hasQueue) 420.dp else 160.dp),
            ) {
                if (!hasQueue) {
                    EmptyScreen(
                        message = stringResource(MR.strings.ocr_queue_empty),
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    AndroidView(
                        modifier = Modifier.fillMaxSize(),
                        factory = { ctx ->
                            screenModel.controllerBinding =
                                DownloadListBinding.inflate(LayoutInflater.from(ctx))
                            screenModel.adapter = OcrAdapter(screenModel.listener)
                            screenModel.controllerBinding.root.adapter = screenModel.adapter
                            screenModel.adapter?.isHandleDragEnabled = true
                            screenModel.controllerBinding.root.layoutManager = LinearLayoutManager(ctx)

                            ViewCompat.setNestedScrollingEnabled(screenModel.controllerBinding.root, true)

                            screenModel.controllerBinding.root
                        },
                        update = {
                            screenModel.adapter?.updateDataSet(stateItems)
                        },
                    )
                }
            }
        }
    }

    // endregion

    // region Вкладка «Голоса» (офлайн и онлайн, реальные данные)

    private data class VoiceRow(
        val name: String,
        val kindLabel: String,
        val isOffline: Boolean,
    )

    @Composable
    private fun VoicesTab(ocrPreferences: OcrPreferences) {
        val context = androidx.compose.ui.platform.LocalContext.current
        val scope2 = androidx.compose.runtime.rememberCoroutineScope()

        val voiceEnginePref = remember { ocrPreferences.voiceEngine() }
        val voiceEngine by voiceEnginePref.changes().collectAsState(initial = voiceEnginePref.get())
        val voiceNamePref = remember { ocrPreferences.voiceName() }
        val voiceName by voiceNamePref.changes().collectAsState(initial = voiceNamePref.get())
        val voiceFemalePref = remember { ocrPreferences.voiceFemale() }
        val voiceFemale by voiceFemalePref.changes().collectAsState(initial = voiceFemalePref.get())
        val voiceMalePref = remember { ocrPreferences.voiceMale() }
        val voiceMale by voiceMalePref.changes().collectAsState(initial = voiceMalePref.get())
        val speechRatePref = remember { ocrPreferences.speechRate() }
        val speechRate by speechRatePref.changes().collectAsState(initial = speechRatePref.get())
        val speechPitchPref = remember { ocrPreferences.speechPitch() }
        val speechPitch by speechPitchPref.changes().collectAsState(initial = speechPitchPref.get())
        val webLangPref = remember { ocrPreferences.ttsWebLanguage() }
        val webLang by webLangPref.changes().collectAsState(initial = webLangPref.get())
        val elevenKeyPref = remember { ocrPreferences.elevenApiKey() }
        val elevenKey by elevenKeyPref.changes().collectAsState(initial = elevenKeyPref.get())
        val elevenVoiceIdPref = remember { ocrPreferences.elevenVoiceId() }
        val elevenVoiceId by elevenVoiceIdPref.changes().collectAsState(initial = elevenVoiceIdPref.get())
        val systemEnginePkgPref = remember { ocrPreferences.systemTtsEngine() }
        val systemEnginePkg by systemEnginePkgPref.changes().collectAsState(initial = systemEnginePkgPref.get())

        var langFilter by remember { mutableStateOf("ru") }
        var assignMode by remember { mutableIntStateOf(0) } // 0=основной, 1=♀, 2=♂

        // Живой probe выбранного TTS-движка. Некоторые OEM-прошивки вызывают
        // OnInit до возврата конструктора, а RHVoice/Acapela могут публиковать
        // голоса с задержкой. Поэтому callback переносится в main queue, после
        // чего язык загружается явно и список опрашивается несколько раз.
        var probe by remember { mutableStateOf<TextToSpeech?>(null) }
        var probeReady by remember { mutableStateOf(false) }
        var probeInitStatus by remember { mutableIntStateOf(Int.MIN_VALUE) }
        var voiceRevision by remember { mutableIntStateOf(0) }
        var voiceRefresh by remember { mutableIntStateOf(0) }
        DisposableEffect(systemEnginePkg) {
            probe = null
            probeReady = false
            probeInitStatus = Int.MIN_VALUE
            var tts: TextToSpeech? = null
            var disposed = false
            val listener = TextToSpeech.OnInitListener { status ->
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    if (!disposed) {
                        probe = tts.takeIf { status == TextToSpeech.SUCCESS }
                        probeInitStatus = status
                    }
                }
            }
            tts = if (systemEnginePkg.isBlank()) {
                TextToSpeech(context.applicationContext, listener)
            } else {
                TextToSpeech(context.applicationContext, listener, systemEnginePkg)
            }
            onDispose {
                disposed = true
                if (probe === tts) probe = null
                runCatching { tts?.stop() }
                runCatching { tts?.shutdown() }
            }
        }
        LaunchedEffect(probe, probeInitStatus, langFilter, systemEnginePkg, voiceRefresh) {
            val activeProbe = probe
            if (probeInitStatus != TextToSpeech.SUCCESS || activeProbe == null) {
                probeReady = probeInitStatus != Int.MIN_VALUE
                return@LaunchedEffect
            }
            probeReady = false
            VoiceHelper.prepareForLanguage(activeProbe, langFilter)
            for (attempt in 0 until 6) {
                voiceRevision++
                if (VoiceHelper.voicesFor(activeProbe, langFilter, systemEnginePkg).isNotEmpty()) break
                kotlinx.coroutines.delay(250L + attempt * 150L)
            }
            probeReady = true
        }

        // Реальный список голосов из системного движка, офлайн/онлайн раздельно
        val allVoices = remember(probe, probeReady, langFilter, systemEnginePkg, voiceRevision) {
            runCatching {
                VoiceHelper.voicesFor(probe, langFilter, systemEnginePkg)
                    .sortedWith(
                        compareBy(
                            { it.isNetworkConnectionRequired }, // офлайн вверх
                            {
                                when (VoiceHelper.classify(it)) {
                                    VoiceKind.FEMALE -> 0
                                    VoiceKind.MALE -> 1
                                    VoiceKind.TEEN -> 2
                                    else -> 3
                                }
                            },
                            { it.name },
                        ),
                    )
                    .map { v ->
                        val kind = when (VoiceHelper.classify(v)) {
                            VoiceKind.FEMALE -> "♀ Женский"
                            VoiceKind.MALE -> "♂ Мужской"
                            VoiceKind.TEEN -> "👦 Подросток"
                            else -> "Другой"
                        }
                        VoiceRow(
                            name = v.name,
                            kindLabel = kind,
                            isOffline = !v.isNetworkConnectionRequired,
                        )
                    }
            }.getOrDefault(emptyList())
        }
        val offlineVoices = allVoices.filter { it.isOffline }
        val onlineVoices = allVoices.filter { !it.isOffline }
        LaunchedEffect(allVoices, systemEnginePkg) {
            if (allVoices.isEmpty()) return@LaunchedEffect
            val names = allVoices.map { it.name }.toSet()
            val female = allVoices.firstOrNull { it.kindLabel.contains("Женский") } ?: allVoices.first()
            val male = allVoices.firstOrNull { it.kindLabel.contains("Мужской") }
                ?: allVoices.getOrElse(1) { allVoices.first() }
            if (voiceName !in names) voiceNamePref.set(female.name)
            if (voiceFemale !in names) voiceFemalePref.set(female.name)
            if (voiceMale !in names) voiceMalePref.set(male.name)
        }

        // Живой список голосов ElevenLabs по ключу (реальный API, без фейков)
        var elevenVoices by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
        var elevenLoading by remember { mutableStateOf(false) }
        LaunchedEffect(elevenKey, voiceEngine) {
            if (voiceEngine == TtsSpeaker.ENGINE_ELEVENLABS && elevenKey.isNotBlank()) {
                elevenLoading = true
                elevenVoices = TtsSpeaker.fetchElevenVoices(elevenKey)
                elevenLoading = false
            }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        ) {
            PreferenceGroupHeader(title = "Движок озвучки")
            ListPreferenceWidget(
                value = voiceEngine,
                title = "Источник голоса",
                subtitle = when (voiceEngine) {
                    TtsSpeaker.ENGINE_GOOGLE_WEB -> "Онлайн: Google Translate, без API-ключа"
                    TtsSpeaker.ENGINE_ELEVENLABS -> "Онлайн: ElevenLabs, нужен API-ключ"
                    TtsSpeaker.ENGINE_REMOTE -> "Сервер: sherpa-onnx/Piper на вашем ПК или ранере"
                    else -> "Системный TTS: офлайн- и онлайн-голоса устройства"
                },
                icon = null,
                entries = mapOf(
                    TtsSpeaker.ENGINE_SYSTEM to "📱 Системный TTS (офлайн + онлайн)",
                    TtsSpeaker.ENGINE_REMOTE to "🖥 TTS-сервер (нейроголоса на ПК/ранере)",
                    TtsSpeaker.ENGINE_GOOGLE_WEB to "☁ Google Web (онлайн, без ключа)",
                    TtsSpeaker.ENGINE_ELEVENLABS to "☁ ElevenLabs (онлайн, по ключу)",
                ),
                onValueChange = voiceEnginePref::set,
            )
            SliderItem(
                value = (speechRate * 100).toInt().coerceIn(50, 200),
                valueRange = 50..200,
                steps = 29,
                label = "Скорость речи",
                valueString = "×%.2f".format(speechRate),
                onChange = { speechRatePref.set(it / 100f) },
            )
            SliderItem(
                value = (speechPitch * 100).toInt().coerceIn(50, 200),
                valueRange = 50..200,
                steps = 29,
                label = "Высота голоса",
                valueString = "×%.2f".format(speechPitch),
                onChange = { speechPitchPref.set(it / 100f) },
            )

            if (voiceEngine == TtsSpeaker.ENGINE_REMOTE) {
                PreferenceGroupHeader(title = "TTS-сервер (ПК/ранер)")
                InfoWidget(
                    text = "Нейроголоса sherpa-onnx/Piper работают на вашей машине: запустите " +
                        "tools/remote_tts_server.py на ПК и укажите адрес ниже. Приложение " +
                        "шлёт текст и проигрывает готовый wav; сервер недоступен — дочитывает " +
                        "системный голос.",
                )
                androidx.compose.material3.OutlinedTextField(
                    value = ocrPreferences.remoteTtsUrl().get(),
                    onValueChange = { ocrPreferences.remoteTtsUrl().set(it.trim()) },
                    label = { Text("http://192.168.1.10:8788") },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                    singleLine = true,
                )
            }

            if (voiceEngine == TtsSpeaker.ENGINE_SYSTEM) {
                PreferenceGroupHeader(title = "TTS-движок системы")
                // Выбор движка (как в Zueira's Voice): Google / RHVoice /
                // Acapela / любой установленный. Список — РЕАЛЬНЫЙ, из
                // TextToSpeech.engines устройства.
                run {
                    // installedEngines() дожидается onInit движка, поэтому
                    // считаем список в фоне: в главном потоке это подвесило бы
                    // экран настроек на пару секунд.
                    var engines by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
                    var enginesLoaded by remember { mutableStateOf(false) }
                    LaunchedEffect(Unit) {
                        engines = withContext(Dispatchers.IO) { TtsSpeaker.installedEngines(context) }
                        enginesLoaded = true
                    }
                    if (engines.isEmpty()) {
                        InfoWidget(
                            text = if (enginesLoaded) {
                                "TTS-движки не найдены. Установите Speech Services by Google или RHVoice."
                            } else {
                                "Ищем установленные TTS-движки…"
                            },
                        )
                    } else {
                        ListPreferenceWidget(
                            value = systemEnginePkg,
                            title = "Движок синтеза",
                            subtitle = engines.firstOrNull { it.first == systemEnginePkg }?.second
                                ?: "Системный по умолчанию",
                            icon = null,
                            entries = buildMap {
                                put("", "Системный по умолчанию")
                                engines.forEach { (pkg, label) -> put(pkg, label) }
                            },
                            onValueChange = { packageName ->
                                systemEnginePkgPref.set(packageName)
                                // Voice names are engine-specific. Keeping a
                                // Google id after switching to RHVoice made the
                                // UI claim that Google was still selected.
                                voiceNamePref.set("")
                                voiceFemalePref.set("")
                                voiceMalePref.set("")
                            },
                        )
                        InfoWidget(
                            text = "После смены движка список ниже обновится автоматически. " +
                                "Голоса RHVoice/Acapela появятся в общем списке.",
                        )
                        androidx.compose.material3.TextButton(
                            onClick = { voiceRefresh++ },
                            modifier = Modifier.padding(horizontal = 8.dp),
                        ) {
                            Text("↻ Перечитать голоса движка")
                        }
                    }
                }
                PreferenceGroupHeader(title = "Голоса устройства")
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp),
                    horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
                ) {
                    listOf("ru" to "Рус", "en" to "Eng", "ja" to "日本", "ko" to "한국", "zh" to "中文").forEach { (code, label) ->
                        FilterChip(
                            selected = langFilter == code,
                            onClick = { langFilter = code },
                            label = { Text(label) },
                        )
                    }
                }
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = assignMode == 0,
                        onClick = { assignMode = 0 },
                        label = { Text("Основной") },
                    )
                    FilterChip(
                        selected = assignMode == 1,
                        onClick = { assignMode = 1 },
                        label = { Text("♀ Женский") },
                    )
                    FilterChip(
                        selected = assignMode == 2,
                        onClick = { assignMode = 2 },
                        label = { Text("♂ Мужской") },
                    )
                }
                InfoWidget(
                    text = when (assignMode) {
                        1 -> "Выберите голос для женских реплик: " + voiceFemale.ifBlank { "не задан" }
                        2 -> "Выберите голос для мужских реплик: " + voiceMale.ifBlank { "не задан" }
                        else -> "Основной голос озвучки: " + voiceName.ifBlank { "автоподбор" }
                    },
                )

                when {
                    !probeReady -> InfoWidget(text = "Инициализация системного TTS…")
                    allVoices.isEmpty() -> InfoWidget(
                        text = "Голосов для этого языка не найдено. Установите TTS-движок " +
                            "(Speech Services by Google, RHVoice) в настройках системы.",
                    )
                    else -> {
                        if (offlineVoices.isNotEmpty()) {
                            PreferenceGroupHeader(title = "📱 Офлайн (${offlineVoices.size}) — работают без сети")
                            offlineVoices.forEach { row ->
                                SystemVoiceRow(
                                    row = row,
                                    selected = when (assignMode) {
                                        1 -> voiceFemale == row.name
                                        2 -> voiceMale == row.name
                                        else -> voiceName == row.name
                                    },
                                    onSelect = {
                                        when (assignMode) {
                                            1 -> voiceFemalePref.set(row.name)
                                            2 -> voiceMalePref.set(row.name)
                                            else -> voiceNamePref.set(row.name)
                                        }
                                    },
                                )
                            }
                        }
                        if (onlineVoices.isNotEmpty()) {
                            PreferenceGroupHeader(title = "☁ Онлайн (${onlineVoices.size}) — качественнее, нужна сеть")
                            onlineVoices.forEach { row ->
                                SystemVoiceRow(
                                    row = row,
                                    selected = when (assignMode) {
                                        1 -> voiceFemale == row.name
                                        2 -> voiceMale == row.name
                                        else -> voiceName == row.name
                                    },
                                    onSelect = {
                                        when (assignMode) {
                                            1 -> voiceFemalePref.set(row.name)
                                            2 -> voiceMalePref.set(row.name)
                                            else -> voiceNamePref.set(row.name)
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
            }

            if (voiceEngine == TtsSpeaker.ENGINE_GOOGLE_WEB) {
                PreferenceGroupHeader(title = "Google Web TTS")
                InfoWidget(
                    text = "Голос берётся с сайта Google Translate без API-ключа. " +
                        "У этого источника один голос на язык — выбирается только язык.",
                )
                ListPreferenceWidget(
                    value = webLang,
                    title = "Язык озвучки",
                    subtitle = webLang,
                    icon = null,
                    entries = mapOf(
                        "ru" to "Русский",
                        "en" to "English",
                        "ja" to "日本語",
                        "ko" to "한국어",
                        "zh-CN" to "中文",
                        "uk" to "Українська",
                    ),
                    onValueChange = webLangPref::set,
                )
            }

            if (voiceEngine == TtsSpeaker.ENGINE_ELEVENLABS) {
                PreferenceGroupHeader(title = "ElevenLabs")
                EditTextPreferenceWidget(
                    title = "API-ключ ElevenLabs",
                    subtitle = if (elevenKey.isBlank()) "Не задан — без ключа сработает фолбэк на Google Web" else "Задан",
                    icon = null,
                    value = elevenKey,
                    onConfirm = {
                        elevenKeyPref.set(it)
                        true
                    },
                )
                when {
                    elevenKey.isBlank() -> InfoWidget(
                        text = "Введите ключ с elevenlabs.io — список голосов вашего аккаунта загрузится автоматически.",
                    )
                    elevenLoading -> InfoWidget(text = "Загрузка голосов из вашего аккаунта…")
                    elevenVoices.isEmpty() -> InfoWidget(
                        text = "Голоса не загрузились: проверьте ключ и подключение к сети.",
                    )
                    else -> {
                        PreferenceGroupHeader(title = "☁ Голоса аккаунта (${elevenVoices.size})")
                        elevenVoices.forEach { (id, label) ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { elevenVoiceIdPref.set(id) }
                                    .padding(horizontal = 8.dp, vertical = 2.dp),
                            ) {
                                RadioButton(
                                    selected = elevenVoiceId == id,
                                    onClick = { elevenVoiceIdPref.set(id) },
                                )
                                Column {
                                    Text(label, style = MaterialTheme.typography.bodyMedium)
                                    Text(
                                        id,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Проба голоса — реальная озвучка текущими настройками
            PreferenceGroupHeader(title = "Проверка")
            Row(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(
                    selected = false,
                    onClick = {
                        TtsSpeaker.speak(context, "Проверка голоса. Так будет звучать озвучка Ёмикай.")
                    },
                    label = { Text("▶ Прослушать") },
                )
                FilterChip(
                    selected = false,
                    onClick = { TtsSpeaker.stop() },
                    label = { Text("⏹ Стоп") },
                )
            }
        }
    }

    @Composable
    private fun SystemVoiceRow(
        row: VoiceRow,
        selected: Boolean,
        onSelect: () -> Unit,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onSelect)
                .padding(horizontal = 8.dp, vertical = 2.dp),
        ) {
            RadioButton(
                selected = selected,
                onClick = onSelect,
            )
            Column {
                Text(
                    "${row.kindLabel} • ${row.name.substringAfterLast(':')}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    row.name,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    // endregion
}
