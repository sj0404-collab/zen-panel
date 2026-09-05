package eu.kanade.presentation.reader.components

import android.media.AudioManager
import android.media.ToneGenerator
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.AutoMode
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DocumentScanner
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import eu.kanade.tachiyomi.util.system.toast
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import mihon.domain.ocr.service.ScanRegion

/**
 * SAO-стиль: единственная перемещаемая плавающая кнопка. Тап (со звуком)
 * раскрывает вертикальное меню со всеми действиями: OCR (с выбором области),
 * автопрокрутка со скоростью, настройки озвучки. Кнопку можно перетащить
 * в любое место экрана — позиция сохраняется, пока открыта читалка.
 */
@Composable
fun ReaderFloatingControls(
    visible: Boolean,
    onTriggerOcr: () -> Unit,
    onOpenOcrSettings: () -> Unit,
    onOpenAiChat: () -> Unit = {},
    onScanRegionChange: (ScanRegion) -> Unit,
    onAutoscrollToggle: (Boolean, Float) -> Unit,
    onAutoSpeakPage: () -> Unit = {},
    onStopSpeak: () -> Unit = {},
    onReadingOrderChange: (String) -> Unit = {},
    readingOrder: String = "rtl",
    onExportChapter: () -> Unit = {},
    /** true — голос выбирает читатель, false — определяется автоматически. */
    manualVoiceMode: Boolean = false,
    /** Голос в ручном режиме: "female" | "male". */
    manualVoiceGender: String = "female",
    onVoiceModeChange: (Boolean) -> Unit = {},
    onVoiceGenderChange: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var manualVoice by remember(manualVoiceMode) { mutableStateOf(manualVoiceMode) }
    var voiceGender by remember(manualVoiceGender) { mutableStateOf(manualVoiceGender) }
    var menuOpen by remember { mutableStateOf(false) }
    val ctorContext = androidx.compose.ui.platform.LocalContext.current
    val ctorVersion by eu.kanade.tachiyomi.data.ui.UiConstructorStore.version.collectAsState()
    val hiddenM = remember(ctorVersion) { eu.kanade.tachiyomi.data.ui.UiConstructorStore.moduleHidden(ctorContext) }
    var isAutoscrollActive by remember { mutableStateOf(false) }
    var autoscrollSpeed by remember { mutableFloatStateOf(2f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }

    // Короткий SAO-подобный "бип" на открытие/закрытие меню и действия
    val tone = remember { runCatching { ToneGenerator(AudioManager.STREAM_SYSTEM, 55) }.getOrNull() }
    DisposableEffect(Unit) {
        onDispose { runCatching { tone?.release() } }
    }
    fun beepOpen() = runCatching { tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 60) }
    fun beepAction() = runCatching { tone?.startTone(ToneGenerator.TONE_PROP_ACK, 70) }

    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.BottomEnd,
    ) {
    // Индикация сканирования/распознавания: пользователь видит, что приложение
    // работает, ещё до появления текста (и заметку о словарях после).
    val ocrStage by mihon.data.ocr.OcrStageBus.event.collectAsState()
    if (
        ocrStage.stage == mihon.data.ocr.OcrStageBus.Stage.DETECTING ||
        ocrStage.stage == mihon.data.ocr.OcrStageBus.Stage.RECOGNIZING
    ) {
        eu.kanade.presentation.reader.OcrLoadingIndicator(
            visible = true,
            // Индикатор — в центре читалки (над страницей), а не у верхней
            // кромки экрана телефона (жалоба пользователя).
            modifier = Modifier
                .align(Alignment.Center)
                .padding(horizontal = 24.dp),
        )
        androidx.compose.material3.Text(
            text = if (ocrStage.stage == mihon.data.ocr.OcrStageBus.Stage.DETECTING) {
                "Сканирую облачка…"
            } else {
                "Распознаю текст… ${ocrStage.note}"
            },
            style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
            color = androidx.compose.material3.MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .align(Alignment.Center)
                .padding(top = 56.dp, start = 16.dp, end = 16.dp),
        )
    }
    // Заметка о готовности видна 5 секунд в центре и гаснет сама.
    var showDoneNote by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(ocrStage) {
        showDoneNote = ocrStage.stage == mihon.data.ocr.OcrStageBus.Stage.DONE && ocrStage.note.isNotBlank()
        if (showDoneNote) {
            kotlinx.coroutines.delay(5000)
            showDoneNote = false
        }
    }
    if (showDoneNote) {
        androidx.compose.material3.Text(
            text = "Текст готов: ${ocrStage.note}",
            style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
            color = androidx.compose.material3.MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .align(Alignment.Center)
                .padding(top = 96.dp, start = 16.dp, end = 16.dp),
        )
    }

        AnimatedVisibility(
            visible = visible,
            enter = fadeIn(),
            exit = fadeOut(),
        ) {
            Column(
                modifier = Modifier
                    .offset { IntOffset(offsetX.roundToInt(), offsetY.roundToInt()) }
                    // Держим кнопку НАД нижней панелью читалки, чтобы не
                    // перекрывать шестерёнку настроек и прочие кнопки меню.
                    .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 120.dp),
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Раскрывающееся меню (SAO): столбец пунктов над кнопкой
                AnimatedVisibility(
                    visible = menuOpen,
                    enter = fadeIn() + scaleIn(initialScale = 0.8f),
                    exit = fadeOut() + scaleOut(targetScale = 0.8f),
                ) {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.96f),
                        ),
                    ) {
                        Column(
                            modifier = Modifier.padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                            horizontalAlignment = Alignment.End,
                        ) {
                                if (!hiddenM.contains("r_scan")) {

                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("OCR скан  ", style = MaterialTheme.typography.labelMedium)
                                    SmallFloatingActionButton(onClick = {
                                        beepAction()
                                        // Сразу режим выделения области: промежуточные
                                        // кнопки «100%/верх/низ» убраны как лишние — область
                                        // пользователь выбирает перетаскиванием.
                                        onTriggerOcr()
                                    }) {
                                        Icon(Icons.Outlined.DocumentScanner, contentDescription = "OCR")
                                    }
                                }

                                }
                                if (!hiddenM.contains("r_autoscroll")) {

                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        if (isAutoscrollActive) "Стоп прокрутки  " else "Автопрокрутка  ",
                                        style = MaterialTheme.typography.labelMedium,
                                    )
                                    SmallFloatingActionButton(onClick = {
                                        beepAction()
                                        isAutoscrollActive = !isAutoscrollActive
                                        onAutoscrollToggle(isAutoscrollActive, autoscrollSpeed)
                                    }) {
                                        Icon(
                                            if (isAutoscrollActive) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                                            contentDescription = "Автопрокрутка",
                                            tint = if (isAutoscrollActive) {
                                                MaterialTheme.colorScheme.primary
                                            } else {
                                                MaterialTheme.colorScheme.onSurface
                                            },
                                        )
                                    }
                                }

                                }
                                if (isAutoscrollActive) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Icon(Icons.Outlined.Speed, contentDescription = null)
                                        Slider(
                                            value = autoscrollSpeed,
                                            onValueChange = {
                                                autoscrollSpeed = it
                                                onAutoscrollToggle(true, autoscrollSpeed)
                                            },
                                            valueRange = 1f..10f,
                                            modifier = Modifier.width(140.dp),
                                        )
                                        Text("×${autoscrollSpeed.roundToInt()}")
                                    }
                                }
                                if (!hiddenM.contains("r_autoread")) {

                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("Прочитать страницу  ", style = MaterialTheme.typography.labelMedium)
                                    SmallFloatingActionButton(onClick = {
                                        beepAction()
                                        menuOpen = false
                                        onAutoSpeakPage()
                                    }) {
                                        Icon(Icons.Outlined.PlayArrow, contentDescription = "Прочитать страницу")
                                    }
                                }

                                }
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("Стоп чтения  ", style = MaterialTheme.typography.labelMedium)
                                    SmallFloatingActionButton(onClick = {
                                        beepAction()
                                        onStopSpeak()
                                    }) {
                                        Icon(Icons.Outlined.Pause, contentDescription = "Стоп чтения")
                                    }
                                }
                                if (!hiddenM.contains("r_export")) {

                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("Сохранить главу в папку  ", style = MaterialTheme.typography.labelMedium)
                                    SmallFloatingActionButton(onClick = {
                                        beepAction()
                                        onExportChapter()
                                    }) {
                                        Icon(Icons.Outlined.Download, contentDescription = "Оффлайн")
                                    }
                                }

                                }
                                if (!hiddenM.contains("r_order")) {

                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    val orderLabel = when (readingOrder) {
                                        "ltr" -> "→ Слева направо"
                                        "vertical" -> "↓ Сверху вниз"
                                        else -> "← Справа налево"
                                    }
                                    Text("$orderLabel  ", style = MaterialTheme.typography.labelMedium)
                                    SmallFloatingActionButton(onClick = {
                                        beepAction()
                                        val next = when (readingOrder) {
                                            "rtl" -> "ltr"
                                            "ltr" -> "vertical"
                                            else -> "rtl"
                                        }
                                        onReadingOrderChange(next)
                                    }) {
                                        Icon(Icons.Outlined.DocumentScanner, contentDescription = "Порядок чтения")
                                    }
                                }

                                }
                                // AI-чат убран из читалки: теперь он —
                                // отдельная вкладка «AI» в нижней навигации.
                                // Голос: режим (авто/ручной) и, в ручном,
                                // выбор пола. Две кнопки рядом — чтобы не
                                // уходить в настройки посреди главы.
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        if (manualVoice) "Голос: вручную  " else "Голос: авто  ",
                                        style = MaterialTheme.typography.labelMedium,
                                    )
                                    SmallFloatingActionButton(onClick = {
                                        beepAction()
                                        manualVoice = !manualVoice
                                        onVoiceModeChange(manualVoice)
                                    }) {
                                        Icon(
                                            if (manualVoice) Icons.Outlined.TouchApp else Icons.Outlined.AutoMode,
                                            contentDescription = "Режим выбора голоса",
                                        )
                                    }

                                    Spacer(Modifier.width(8.dp))

                                    SmallFloatingActionButton(
                                        onClick = {
                                            if (!manualVoice) return@SmallFloatingActionButton
                                            beepAction()
                                            voiceGender = if (voiceGender == "male") "female" else "male"
                                            onVoiceGenderChange(voiceGender)
                                        },
                                        containerColor = if (manualVoice) {
                                            MaterialTheme.colorScheme.primaryContainer
                                        } else {
                                            MaterialTheme.colorScheme.surfaceVariant
                                        },
                                    ) {
                                        Text(if (voiceGender == "male") "♂" else "♀")
                                    }
                                }

                                if (!hiddenM.contains("r_tts")) {

                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("Озвучка (TTS)  ", style = MaterialTheme.typography.labelMedium)
                                    SmallFloatingActionButton(onClick = {
                                        beepAction()
                                        menuOpen = false
                                        onOpenOcrSettings()
                                    }) {
                                        Icon(Icons.Outlined.RecordVoiceOver, contentDescription = "Озвучка")
                                    }
                                }

                                }
                            }
                        }
                    }
                }

                val userActs = remember(ctorVersion) {
                    eu.kanade.tachiyomi.data.ui.UiActionRegistry.forPlacement(ctorContext, mihon.data.ui.UiPlacement.FLOATING_MENU)
                }
                userActs.forEach { act ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(act.title + "  ", style = MaterialTheme.typography.labelMedium)
                        SmallFloatingActionButton(onClick = {
                            beepAction()
                            ctorContext.toast(eu.kanade.tachiyomi.data.ui.UiActionRegistry.apply(ctorContext, act))
                        }) {
                            Icon(Icons.Outlined.Tune, contentDescription = act.title)
                        }
                    }
                }

                // Главная кнопка: тап — меню; перетаскивание — отдельная
                // обёртка Box поверх FAB, чтобы клик и drag не конфликтовали.
                Box(
                    modifier = Modifier.pointerInput(Unit) {
                        detectDragGestures { change, dragAmount ->
                            change.consume()
                            offsetX = (offsetX + dragAmount.x).coerceIn(-4000f, 0f)
                            offsetY = (offsetY + dragAmount.y).coerceIn(-4000f, 400f)
                        }
                    },
                ) {
                    FloatingActionButton(
                        onClick = {
                            beepOpen()
                            menuOpen = !menuOpen
                        },
                        containerColor = MaterialTheme.colorScheme.primary,
                    ) {
                        Icon(
                            if (menuOpen) Icons.Outlined.Close else Icons.Outlined.Menu,
                            contentDescription = "Меню читалки",
                        )
                    }
                }
            }
        }
    }