package eu.kanade.tachiyomi.ui.aichat

import android.content.Intent
import android.graphics.BitmapFactory
import android.webkit.HttpAuthHandler
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Image as ImageIcon
import androidx.compose.material.icons.outlined.LibraryAddCheck
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import eu.kanade.presentation.util.Tab
import cafe.adriel.voyager.navigator.tab.TabOptions
import eu.kanade.tachiyomi.data.ai.AiAgent
import eu.kanade.tachiyomi.data.ai.AiBackends
import eu.kanade.tachiyomi.data.ai.AiWorkspace
import eu.kanade.tachiyomi.data.tts.TtsSpeaker
import eu.kanade.tachiyomi.util.storage.getUriCompat
import eu.kanade.tachiyomi.util.system.copyToClipboard
import eu.kanade.tachiyomi.util.system.toast
import mihon.domain.ocr.service.OcrPreferences
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Вкладка «AI» — встроенный агент приложения (вместо AI-чата в читалке).
 *
 * Возможности (все реальные, без заглушек):
 * • чат с Zen/OpenRouter моделями (те же, что в озвучке);
 * • вложения: картинки (прогоняются через текущий OCR-движок, текст идёт
 *   модели) и любые файлы (текстовые читаются, бинарные сохраняются в
 *   workspace/inbox);
 * • инструменты агента: генерация картинок (Pollinations), запись файлов
 *   в workspace, проверка сайтов, фильтрация расширений, поиск манги по
 *   источникам, zip-архив workspace;
 * • под каждым сообщением: ▶ озвучить, ⏹ стоп, копировать; режим
 *   «выбрать несколько» — копирование пачки сообщений разом;
 * • вкладка Workspace: файлы/папки/архивы агента (/sdcard/Yomikai/AI),
 *   превью картинок, «Поделиться» (скачать наружу), удаление.
 */
data object AiChatTab : Tab {

    override val options: TabOptions
        @Composable
        get() = TabOptions(
            index = 9u,
            title = "AI",
            icon = rememberVectorPainter(Icons.Outlined.SmartToy),
        )

    private data class ToolCard(
        val name: String,
        val args: String,
        val output: String,
        val round: Int,
        val tookMs: Long,
        val status: String, // ok | error
    )

    private data class Msg(
        val role: String, // user | ai
        val text: String,
        val images: List<File> = emptyList(),
        val toolLog: String = "",
        val toolCards: List<ToolCard> = emptyList(),
        val reasoning: String? = null,
        val model: String = "",
        val tokens: Int = 0,
        val tookMs: Long = 0,
        val rounds: Int = 0,
        val time: Long = System.currentTimeMillis(),
        val choices: List<String> = emptyList(),
        /** Текст запроса пользователя, породившего этот ответ (для «Повторить»). */
        val sourcePrompt: String = "",
    )

    // ===== ФИКС потери истории и «сброса модели» (жалоба пользователя) =====
    // Раньше: messages жили в remember{} КОМПОЗИЦИИ, а ответ пушился через
    // rememberCoroutineScope. Уход со вкладки (или сворачивание приложения)
    // отменял scope и УБИВАЛ корутину с ответом — в истории оставался только
    // текст пользователя, как будто агент и не отвечал. Теперь:
    //  • история — StateFlow в object (живёт, пока жив процесс);
    //  • отправка — в GlobalScope-подобном SupervisorJob скоупе объекта:
    //    ответ ДОЙДЁТ и запишется, даже если вкладку покинули;
    //  • busy — тоже в object: вернулся на вкладку — видно, что агент ещё думает.
    private val chatScope = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + Dispatchers.IO,
    )
    private val historyFlow = kotlinx.coroutines.flow.MutableStateFlow<List<Msg>>(emptyList())
    private val busyFlow = kotlinx.coroutines.flow.MutableStateFlow(false)

    private fun pushMsg(m: Msg) {
        historyFlow.value = historyFlow.value + m
    }

    // Статус запуска ранера — тоже в object: переход по вкладкам или
    // сворачивание приложения НЕ убивает запуск (жалоба пользователя
    // «ранер отваливается при переходах»)
    private val runnerStatusFlow = kotlinx.coroutines.flow.MutableStateFlow("")
    private val runnerStartingFlow = kotlinx.coroutines.flow.MutableStateFlow(false)

    @Composable
    override fun Content() {
        val context = LocalContext.current
        val scope = rememberCoroutineScope()

        var tab by rememberSaveable { mutableStateOf(0) } // 0=чат, 1=workspace, 2=настройки
        var terminalSession by remember {
            mutableStateOf<eu.kanade.tachiyomi.data.ai.RunnerLlm.Session?>(null)
        }
        val messages by historyFlow.collectAsState()
        var input by rememberSaveable { mutableStateOf("") }
        val busy by busyFlow.collectAsState()
        var selectMode by remember { mutableStateOf(false) }
        val selected = remember { mutableStateOf(setOf<Int>()) }
        val attachments = remember { mutableStateOf(listOf<File>()) }
        val listState = rememberLazyListState()

        val pickFile = rememberLauncherForActivityResult(
            ActivityResultContracts.GetMultipleContents(),
        ) { uris ->
            scope.launch(Dispatchers.IO) {
                val added = uris.mapNotNull { uri ->
                    runCatching {
                        val name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
                        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                            ?: return@runCatching null
                        if (bytes.size > 20 * 1024 * 1024) return@runCatching null // 20МБ лимит
                        AiWorkspace.importAttachment(context, name, bytes)
                    }.getOrNull()
                }
                withContext(Dispatchers.Main) {
                    attachments.value = attachments.value + added
                    if (added.size < uris.size) context.toast("Часть файлов не добавлена (лимит 20МБ)")
                }
            }
        }

        fun send() {
            val text = input.trim()
            if (text.isEmpty() && attachments.value.isEmpty()) return
            val atts = attachments.value
            attachments.value = emptyList()
            input = ""
            pushMsg(Msg("user", text, images = atts.filter { isImage(it) }))
            busyFlow.value = true
            chatScope.launch {
                try {
                    // Готовим описание вложений для модели: картинки — через OCR,
                // текстовые файлы — содержимое, бинарные — только метаданные.
                val attInfo = if (atts.isEmpty()) {
                    null
                } else {
                    val parts = mutableListOf<String>()
                    for (f in atts) {
                        parts += when {
                            isImage(f) -> {
                                val ocr = AiAgent.ocrAttachment(f)
                                "Картинка ${f.name}: " + (ocr?.let { "распознанный текст: ${it.take(600)}" }
                                    ?: "текст не распознан")
                            }
                            isTextFile(f) -> "Файл ${f.name}:\n" + runCatching { f.readText().take(2000) }
                                .getOrDefault("(не читается)")
                            else -> "Бинарный файл ${f.name} (${f.length() / 1024} КБ) — сохранён в workspace/inbox"
                        }
                    }
                    parts.joinToString("\n")
                }
                // Роутинг бэкенда — через реестр AiBackends (одна проверка
                // готовности на чат и на экран настроек). ВАЖНО (жалоба
                // пользователя «почему для локальной АИ недоступны
                // инструменты»): агентский цикл с @tool-инструментами ОБЩИЙ —
                // инструменты исполняет само приложение, а модель
                // (онлайн/локальная/ранер) только пишет текст. Поэтому у
                // локальной модели ЕСТЬ файлы, картинки, проверка сайтов,
                // reader_status и ocr_preset.
                val prefsBk = Injekt.get<OcrPreferences>()
                val resolution = AiBackends.resolve(
                    context = context,
                    backendId = prefsBk.aiBackend().get(),
                )
                val backendKey = resolution.backendId
                val chatFn = resolution.chat
                if (chatFn == null) {
                    withContext(Dispatchers.Main) {
                        pushMsg(
                            Msg(
                                "ai",
                                // Текст объяснения даёт реестр — он же показывается
                                // в настройках, поэтому формулировки не расходятся.
                                resolution.message
                                    ?: "Бэкенд «$backendKey» не готов к запросу",
                                model = backendKey,
                            ),
                        )
                        busyFlow.value = false
                    }
                    return@launch
                }
                val reply = AiAgent.run(
                    context,
                    text.ifBlank { "Опиши вложения" },
                    attInfo,
                    historyFlow.value.map { it.role to it.text },
                    chatFn = chatFn,
                )
                withContext(Dispatchers.Main) {
                    pushMsg(
                        Msg(
                            "ai",
                            reply.text,
                            images = reply.images,
                            toolCards = reply.toolResults.map {
                                ToolCard(it.name, it.args, it.output, it.round, it.tookMs, it.status)
                            },
                            reasoning = reply.reasoning,
                            model = reply.model,
                            tokens = reply.tokens,
                            tookMs = reply.tookMs,
                            rounds = reply.rounds,
                            choices = reply.choices,
                            sourcePrompt = text,
                        ),
                    )
                    busyFlow.value = false
                }
                } catch (error: Exception) {
                    withContext(Dispatchers.Main) {
                        pushMsg(
                            Msg(
                                role = "ai",
                                text = "Сбой AI-хода: ${error.message?.take(180) ?: "неизвестная ошибка"}. " +
                                    "Выполненные инструменты сохранены; запрос можно повторить.",
                                model = "error",
                                sourcePrompt = text,
                            ),
                        )
                    }
                } finally {
                    busyFlow.value = false
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .imePadding(),
        ) {
            // Верхние чипы: Чат / Workspace / настройки / выбор нескольких.
            // Ряд горизонтально скроллится, чтобы чипы не уезжали за экран.
            Row(
                modifier = Modifier
                    .padding(horizontal = 12.dp, vertical = 6.dp)
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(selected = tab == 0, onClick = { tab = 0 }, label = { Text("Чат") })
                FilterChip(selected = tab == 1, onClick = { tab = 1 }, label = { Text("Workspace") })
                FilterChip(selected = tab == 2, onClick = { tab = 2 }, label = { Text("⚙") })
                FilterChip(selected = tab == 3, onClick = { tab = 3 }, label = { Text("🔌 Плагины") })
                terminalSession?.let { session ->
                    FilterChip(
                        selected = tab == 4,
                        onClick = { tab = 4 },
                        label = { Text("🖥 Терминал ${session.os}") },
                    )
                }
                if (tab == 0) {
                    ModelChip()
                    FilterChip(
                        selected = selectMode,
                        onClick = {
                            selectMode = !selectMode
                            if (!selectMode) selected.value = emptySet()
                        },
                        label = { Icon(Icons.Outlined.LibraryAddCheck, null, Modifier.size(16.dp)) },
                    )
                    if (selectMode && selected.value.isNotEmpty()) {
                        FilterChip(
                            selected = false,
                            onClick = {
                                val textAll = selected.value.sorted()
                                    .mapNotNull { messages.getOrNull(it)?.text }
                                    .joinToString("\n\n")
                                context.copyToClipboard("AI чат", textAll)
                                selected.value = emptySet()
                                selectMode = false
                            },
                            label = { Text("Копировать ${selected.value.size}") },
                        )
                        // Отправить выделенные сообщения повторно — одним документом
                        FilterChip(
                            selected = false,
                            onClick = {
                                val textAll = selected.value.sorted()
                                    .mapNotNull { messages.getOrNull(it)?.text }
                                    .joinToString("\n\n")
                                input = textAll
                                selected.value = emptySet()
                                selectMode = false
                            },
                            label = { Text("↻ Повторно") },
                        )
                        // Экспорт: PDF всегда; DOCX — если есть картинка (или тоже всегда)
                        val hasImage = selected.value.any { messages.getOrNull(it)?.images?.isNotEmpty() == true }
                        FilterChip(
                            selected = false,
                            onClick = {
                                scope.launch(Dispatchers.IO) {
                                    val items = selected.value.sorted().mapNotNull { idx ->
                                        val m = messages.getOrNull(idx) ?: return@mapNotNull null
                                        eu.kanade.tachiyomi.data.ai.DocExporter.Item(
                                            title = if (m.role == "user") "Вы" else "Агент",
                                            text = m.text,
                                            imagePath = m.images.firstOrNull()?.absolutePath,
                                        )
                                    }
                                    val f = eu.kanade.tachiyomi.data.ai.DocExporter.exportPdf(
                                        context, items, "chat_${System.currentTimeMillis() / 1000}.pdf",
                                    )
                                    withContext(Dispatchers.Main) {
                                        context.toast("PDF: ${f.name} (в Workspace/export)")
                                        selected.value = emptySet()
                                        selectMode = false
                                    }
                                }
                            },
                            label = { Text("📄 PDF") },
                        )
                        FilterChip(
                            selected = false,
                            onClick = {
                                scope.launch(Dispatchers.IO) {
                                    val items = selected.value.sorted().mapNotNull { idx ->
                                        val m = messages.getOrNull(idx) ?: return@mapNotNull null
                                        eu.kanade.tachiyomi.data.ai.DocExporter.Item(
                                            title = if (m.role == "user") "Вы" else "Агент",
                                            text = m.text,
                                            imagePath = m.images.firstOrNull()?.absolutePath,
                                        )
                                    }
                                    val f = eu.kanade.tachiyomi.data.ai.DocExporter.exportDocx(
                                        context, items, "chat_${System.currentTimeMillis() / 1000}.docx",
                                    )
                                    withContext(Dispatchers.Main) {
                                        context.toast("DOCX: ${f.name} (в Workspace/export)")
                                        selected.value = emptySet()
                                        selectMode = false
                                    }
                                }
                            },
                            label = { Text(if (hasImage) "📝 DOCX (с картинкой)" else "📝 DOCX") },
                        )
                    }
                }
            }

            when (tab) {
                0 -> ChatBody(
                    messages = messages,
                    busy = busy,
                    listState = listState,
                    selectMode = selectMode,
                    selected = selected.value,
                    onToggleSelect = { idx ->
                        selected.value = if (idx in selected.value) selected.value - idx else selected.value + idx
                    },
                    input = input,
                    onInput = { input = it },
                    attachments = attachments.value,
                    onRemoveAttachment = { f -> attachments.value = attachments.value - f },
                    onAttach = { pickFile.launch("*/*") },
                    onSend = ::send,
                    onQuickSend = { quick ->
                        // Кнопка-вариант или «повторить»: подставляем текст и шлём
                        input = quick
                        send()
                    },
                    modifier = Modifier.weight(1f),
                )
                1 -> WorkspaceBody(modifier = Modifier.weight(1f))
                2 -> SettingsBody(
                    modifier = Modifier.weight(1f),
                    onOpenTerminal = { session ->
                        terminalSession = session
                        tab = 4
                    },
                )
                3 -> PluginsBody(modifier = Modifier.weight(1f))
                4 -> terminalSession?.let { session ->
                    RunnerTerminalBody(
                        session = session,
                        modifier = Modifier.weight(1f),
                        onClose = {
                            terminalSession = null
                            tab = 2
                        },
                    )
                }
                else -> Unit
            }
        }
    }

    /**
     * Чип текущей модели над чатом: тап — выпадающий список всех моделей
     * (Zen без ключа + OpenRouter :free при ключе) с переключением на лету,
     * плюс тумблеры «Автосмена» и «Размышления».
     */
    @Composable
    private fun ModelChip() {
        val prefs = remember { Injekt.get<OcrPreferences>() }
        val zenModelPref = remember { prefs.zenModel() }
        val zenModel by zenModelPref.changes()
            .collectAsState(initial = zenModelPref.get())
        val autoRotatePref = remember { prefs.aiAutoRotate() }
        val autoRotate by autoRotatePref.changes()
            .collectAsState(initial = autoRotatePref.get())
        val showReasoningPref = remember { prefs.aiShowReasoning() }
        val showReasoning by showReasoningPref.changes()
            .collectAsState(initial = showReasoningPref.get())
        var open by remember { mutableStateOf(false) }

        androidx.compose.foundation.layout.Box {
            FilterChip(
                selected = false,
                onClick = { open = true },
                label = { Text("🧠 " + zenModel.removeSuffix("-free").take(18)) },
            )
            androidx.compose.material3.DropdownMenu(
                expanded = open,
                onDismissRequest = { open = false },
            ) {
                eu.kanade.tachiyomi.data.ai.AiAssistant.ZEN_MODELS.forEach { m ->
                    androidx.compose.material3.DropdownMenuItem(
                        text = { Text(m) },
                        leadingIcon = {
                            androidx.compose.material3.RadioButton(
                                selected = zenModel == m,
                                onClick = null,
                            )
                        },
                        onClick = {
                            zenModelPref.set(m)
                            open = false
                        },
                    )
                }
                androidx.compose.material3.HorizontalDivider()
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(if (autoRotate) "✓ Автосмена при лимите" else "Автосмена при лимите") },
                    onClick = { autoRotatePref.set(!autoRotate) },
                )
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(if (showReasoning) "✓ Показывать размышления" else "Показывать размышления") },
                    onClick = { showReasoningPref.set(!showReasoning) },
                )
            }
        }
    }

    /** Embedded ttyd console: it is an AI sub-tab, not a full-screen Activity. */
    @Composable
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private fun RunnerTerminalBody(
        session: eu.kanade.tachiyomi.data.ai.RunnerLlm.Session,
        modifier: Modifier = Modifier,
        onClose: () -> Unit,
    ) {
        val context = LocalContext.current
        val url = session.terminalUrl.orEmpty()
        var loading by remember(session.id) { mutableStateOf(true) }
        val webView = remember(session.id, url) {
            WebView(context).apply {
                setBackgroundColor(android.graphics.Color.BLACK)
                isFocusable = true
                isFocusableInTouchMode = true
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.loadWithOverviewMode = false
                settings.useWideViewPort = false
                settings.builtInZoomControls = false
                settings.displayZoomControls = false
                webViewClient = object : WebViewClient() {
                    override fun onReceivedHttpAuthRequest(
                        view: WebView?,
                        handler: HttpAuthHandler,
                        host: String?,
                        realm: String?,
                    ) {
                        handler.proceed("yomikai", session.apiKey.orEmpty())
                    }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        loading = false
                        view?.requestFocus()
                    }
                }
                if (url.isNotBlank()) loadUrl(url)
            }
        }
        DisposableEffect(webView) {
            onDispose {
                (webView.parent as? android.view.ViewGroup)?.removeView(webView)
                webView.stopLoading()
                webView.destroy()
            }
        }

        Column(modifier = modifier.fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "${if (session.os == "windows") "Windows" else "Linux"} • ${session.model}" +
                        if (loading) " • подключение…" else " • терминал",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                IconButton(
                    onClick = {
                        loading = true
                        webView.reload()
                    },
                ) {
                    Icon(Icons.Outlined.Refresh, contentDescription = "Перезагрузить терминал")
                }
                androidx.compose.material3.TextButton(onClick = onClose) { Text("Закрыть") }
            }
            AndroidView(
                factory = { webView },
                modifier = Modifier.fillMaxSize(),
            )
        }
    }

    @Composable
    private fun SettingsBody(
        modifier: Modifier = Modifier,
        onOpenTerminal: (eu.kanade.tachiyomi.data.ai.RunnerLlm.Session) -> Unit,
    ) {
        val context = LocalContext.current
        val prefs = remember { Injekt.get<OcrPreferences>() }
        val networkPrefs = remember { Injekt.get<eu.kanade.tachiyomi.network.NetworkPreferences>() }
        val proxyEnabled by networkPrefs.enableProxy.changes().collectAsState(initial = networkPrefs.enableProxy.get())
        val proxyType by networkPrefs.proxyType.changes().collectAsState(initial = networkPrefs.proxyType.get())
        val proxyHost by networkPrefs.proxyHost.changes().collectAsState(initial = networkPrefs.proxyHost.get())
        val proxyUser by networkPrefs.proxyUser.changes().collectAsState(initial = networkPrefs.proxyUser.get())
        val proxyPassword by networkPrefs.proxyPassword.changes()
            .collectAsState(initial = networkPrefs.proxyPassword.get())
        var proxyPortText by rememberSaveable { mutableStateOf(networkPrefs.proxyPort.get().toString()) }
        val tabVisiblePref = remember { prefs.aiTabVisible() }
        val serverPref = remember { prefs.aiHttpServer() }
        var serverOn by remember { mutableStateOf(eu.kanade.tachiyomi.data.ai.AiHttpServer.isRunning) }

        val backendPref = remember { prefs.aiBackend() }
        val backend by backendPref.changes().collectAsState(initial = backendPref.get())
        val localModelPref = remember { prefs.localLlmModel() }
        val localModelId by localModelPref.changes().collectAsState(initial = localModelPref.get())
        val patPref = remember { prefs.githubPat() }
        val pat by patPref.changes().collectAsState(initial = patPref.get())
        val llmProgress by eu.kanade.tachiyomi.data.ai.LocalLlm.progress.collectAsState()
        val probeState by eu.kanade.tachiyomi.data.ai.LocalLlm.probeState.collectAsState()
        var probeMessage by remember { mutableStateOf("") }
        val runnerStatus by runnerStatusFlow.collectAsState()
        var sessions by remember { mutableStateOf(eu.kanade.tachiyomi.data.ai.RunnerLlm.listSessions(context)) }
        val scope = rememberCoroutineScope()
        val ramGb = remember { eu.kanade.tachiyomi.data.ai.LocalLlm.deviceRamGb(context) }

        Column(
            modifier = modifier
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Настройки AI-агента", style = MaterialTheme.typography.titleMedium)

            // ---- Бэкенд чата ----
            Text("Бэкенд чата", style = MaterialTheme.typography.titleSmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = backend == "online",
                    onClick = { backendPref.set("online") },
                    label = { Text("☁ Онлайн") },
                )
                FilterChip(
                    selected = backend == "local",
                    onClick = { backendPref.set("local") },
                    label = { Text("📱 Локально") },
                )
                FilterChip(
                    selected = backend == "runner",
                    onClick = { backendPref.set("runner") },
                    label = { Text("🖥 Ранер") },
                )
            }
            Text(
                when (backend) {
                    "local" -> "Чат работает полностью офлайн на модели с телефона (инструменты агента недоступны)"
                    "runner" -> "Чат идёт через GGUF-модель на GitHub-ранере (сессия до ~5.5 ч)"
                    else -> "Полный агент: Zen/OpenRouter + инструменты (файлы, картинки, поиск манги)"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Text("Прокси онлайн-AI", style = MaterialTheme.typography.titleSmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Использовать прокси для Zen/OpenRouter")
                    Text(
                        "Используются те же параметры, что в Настройки → Дополнительно → Прокси.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                androidx.compose.material3.Switch(
                    checked = proxyEnabled,
                    onCheckedChange = networkPrefs.enableProxy::set,
                )
            }
            if (proxyEnabled) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = proxyType == 0,
                        onClick = { networkPrefs.proxyType.set(0) },
                        label = { Text("HTTP") },
                    )
                    FilterChip(
                        selected = proxyType == 1,
                        onClick = { networkPrefs.proxyType.set(1) },
                        label = { Text("SOCKS5") },
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = proxyHost,
                        onValueChange = networkPrefs.proxyHost::set,
                        label = { Text("Хост прокси") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = proxyPortText,
                        onValueChange = { value ->
                            proxyPortText = value.filter(Char::isDigit).take(5)
                            proxyPortText.toIntOrNull()?.takeIf { it in 1..65_535 }
                                ?.let(networkPrefs.proxyPort::set)
                        },
                        label = { Text("Порт") },
                        singleLine = true,
                        modifier = Modifier.width(112.dp),
                    )
                }
                OutlinedTextField(
                    value = proxyUser,
                    onValueChange = networkPrefs.proxyUser::set,
                    label = { Text("Логин прокси (необязательно)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = proxyPassword,
                    onValueChange = networkPrefs.proxyPassword::set,
                    label = { Text("Пароль прокси (необязательно)") },
                    singleLine = true,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            // ---- Локальные LLM (по ОЗУ, с тестом) ----
            Text(
                "Локальные LLM • у устройства $ramGb ГБ ОЗУ",
                style = MaterialTheme.typography.titleSmall,
            )
            // Свои модели: /sdcard/Yomikai/LLM (закинь .task — появится тут)
            var customRefresh by remember { mutableStateOf(0) }
            val customModels = remember(customRefresh) {
                eu.kanade.tachiyomi.data.ai.LocalLlm.customModels(context)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Свои модели: положите .task в /sdcard/Yomikai/LLM (найдено: ${customModels.size})",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                androidx.compose.material3.TextButton(onClick = { customRefresh++ }) { Text("Обновить") }
            }
            // Модель по прямой ссылке (.task)
            var customTaskUrl by remember { mutableStateOf("") }
            OutlinedTextField(
                value = customTaskUrl,
                onValueChange = { customTaskUrl = it },
                label = { Text("Скачать модель по ссылке (.task)") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 2,
            )
            androidx.compose.material3.FilledTonalButton(
                enabled = customTaskUrl.trim().startsWith("http") && customTaskUrl.contains(".task"),
                onClick = {
                    val m = eu.kanade.tachiyomi.data.ai.LocalLlm.modelFromUrl(customTaskUrl.trim())
                    if (m == null) {
                        context.toast("Ссылка должна вести на .task файл")
                    } else {
                        context.toast("Скачивание ${m.name} началось")
                        scope.launch(Dispatchers.IO) {
                            val ok = eu.kanade.tachiyomi.data.ai.LocalLlm.download(context, m)
                            withContext(Dispatchers.Main) {
                                context.toast(if (ok) "Модель скачана: ${m.name}" else "Не удалось скачать")
                                customRefresh++
                            }
                        }
                    }
                },
            ) { Text("⬇ Скачать по ссылке") }

            (eu.kanade.tachiyomi.data.ai.LocalLlm.CATALOG + customModels).forEach { m ->
                val fits = m.tier.minRamGb <= ramGb
                val installed = eu.kanade.tachiyomi.data.ai.LocalLlm.isInstalled(context, m)
                val prog = llmProgress[m.id]
                val probed = probeState[m.id]
                androidx.compose.material3.Surface(
                    shape = androidx.compose.foundation.shape.RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Column(Modifier.fillMaxWidth().padding(10.dp)) {
                        Text(
                            "${m.name} • ${m.tier.label}" + if (!fits) " ⛔ не влезет в ОЗУ" else "",
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        Text(
                            m.specs + " • ${m.sizeMb} МБ",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (prog != null) {
                            androidx.compose.material3.LinearProgressIndicator(
                                progress = { prog },
                                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            )
                            Text("Загрузка ${(prog * 100).toInt()}%", style = MaterialTheme.typography.bodySmall)
                        }
                        when (probed) {
                            "ok" -> Text("✅ Тест пройден", style = MaterialTheme.typography.bodySmall)
                            "fail" -> Text("❌ Тест провален", style = MaterialTheme.typography.bodySmall)
                            "testing" -> Text("⏳ Тестирование…", style = MaterialTheme.typography.bodySmall)
                        }
                        // НАСТОЯЩИЕ КНОПКИ вместо чипов (по скриншоту: чипы
                        // выглядели как текст, «Удалить» сплющивалась в
                        // вертикальный столбик). FlowRow переносит кнопки на
                        // следующую строку вместо сжатия.
                        var busyAction by remember(m.id) { mutableStateOf(false) }
                        androidx.compose.foundation.layout.FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            when {
                                prog != null -> {}
                                !installed -> androidx.compose.material3.FilledTonalButton(
                                    enabled = fits && !busyAction,
                                    onClick = {
                                        busyAction = true
                                        scope.launch(Dispatchers.IO) {
                                            eu.kanade.tachiyomi.data.ai.LocalLlm.download(context, m)
                                            withContext(Dispatchers.Main) { busyAction = false }
                                        }
                                    },
                                ) { Text("⬇ Скачать") }
                                else -> {
                                    androidx.compose.material3.FilledTonalButton(
                                        enabled = !busyAction,
                                        onClick = {
                                            busyAction = true
                                            probeMessage = "${m.name}: тест запущен, первая загрузка модели " +
                                                "в память может занять до минуты…"
                                            scope.launch(Dispatchers.IO) {
                                                val (ok, msg) = eu.kanade.tachiyomi.data.ai.LocalLlm.probe(context, m)
                                                withContext(Dispatchers.Main) {
                                                    probeMessage = "${m.name}: $msg"
                                                    if (ok) localModelPref.set(m.id)
                                                    busyAction = false
                                                }
                                            }
                                        },
                                    ) { Text("▶ Тест") }
                                    androidx.compose.material3.Button(
                                        enabled = !busyAction,
                                        onClick = { localModelPref.set(m.id) },
                                    ) { Text(if (localModelId == m.id) "✓ Активна" else "Выбрать") }
                                    androidx.compose.material3.OutlinedButton(
                                        enabled = !busyAction,
                                        onClick = {
                                            busyAction = true
                                            context.toast("Упаковка в tar.xz началась (займёт минуты)…")
                                            scope.launch(Dispatchers.IO) {
                                                val f = eu.kanade.tachiyomi.data.ai.LocalLlm.exportTarXz(context, m)
                                                withContext(Dispatchers.Main) {
                                                    context.toast(
                                                        if (f != null) {
                                                            "Экспорт: ${f.name} (${f.length() / 1048576} МБ, было ${m.sizeMb} МБ)"
                                                        } else "Экспорт не удался",
                                                    )
                                                    busyAction = false
                                                }
                                            }
                                        },
                                    ) { Text("→ tar.xz") }
                                    androidx.compose.material3.OutlinedButton(
                                        enabled = !busyAction,
                                        onClick = {
                                            eu.kanade.tachiyomi.data.ai.LocalLlm.delete(context, m)
                                            if (localModelId == m.id) localModelPref.set("")
                                        },
                                    ) { Text("🗑 Удалить") }
                                }
                            }
                        }
                    }
                }
            }
            if (probeMessage.isNotBlank()) {
                Text(probeMessage, style = MaterialTheme.typography.bodySmall)
            }

            // ---- Полу-онлайн LLM (GitHub-ранер, GGUF) ----
            Text("Полу-онлайн LLM (GitHub-ранер, GGUF)", style = MaterialTheme.typography.titleSmall)
            Text(
                "Модель скачивается в ранер GitHub Actions, телефон подключается к ней по токену. " +
                    "Нужен PAT с правом actions:write на репозиторий.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = pat,
                onValueChange = { patPref.set(it) },
                label = { Text("GitHub PAT") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 1,
            )
            // ДОСТУП ЛЮБОЙ AI-МОДЕЛИ к ранеру и GitHub (по запросу
            // пользователя — «с уточнением с настроек»): выключено по
            // умолчанию, агент честно сообщает о запрете при попытке.
            run {
                val allowRunnerPref = remember { prefs.aiAllowRunner() }
                val allowRunner by allowRunnerPref.changes().collectAsState(initial = allowRunnerPref.get())
                val allowGithubPref = remember { prefs.aiAllowGithub() }
                val allowGithub by allowGithubPref.changes().collectAsState(initial = allowGithubPref.get())
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Доступ агента к ранеру", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "Любая модель чата сможет запускать сессии (runner_start) и спрашивать LLM на ранере (runner_chat)",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    androidx.compose.material3.Switch(
                        checked = allowRunner,
                        onCheckedChange = allowRunnerPref::set,
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Доступ агента к GitHub", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "Инструмент github_api: GET-запросы привязанным токеном (статусы сборок, воркфлоу)",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    androidx.compose.material3.Switch(
                        checked = allowGithub,
                        onCheckedChange = allowGithubPref::set,
                    )
                }
            }
            // Неотзывчивость кнопок (жалоба): FilterChip не давал никакого
            // фидбека до первого сетевого статуса (секунды). Теперь —
            // настоящие кнопки, мгновенный статус и блокировка на время
            // запуска (заодно защита от даблтапа).
            val runnerStarting by runnerStartingFlow.collectAsState()
            // ОС ранера: linux (быстрее старт) или windows (по запросу)
            var runnerOs by rememberSaveable { mutableStateOf("linux") }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = runnerOs == "linux",
                    onClick = { runnerOs = "linux" },
                    label = { Text("🐧 Linux") },
                )
                FilterChip(
                    selected = runnerOs == "windows",
                    onClick = { runnerOs = "windows" },
                    label = { Text("🪟 Windows") },
                )
            }
            eu.kanade.tachiyomi.data.ai.RunnerLlm.GGUF_MODELS.forEach { (key, label, sizeMb) ->
                androidx.compose.material3.FilledTonalButton(
                    enabled = !runnerStarting,
                    onClick = {
                        runnerStartingFlow.value = true
                        runnerStatusFlow.value = "⏳ Запуск $label…" // мгновенный фидбек
                        val appCtx = context.applicationContext
                        chatScope.launch {
                            val s = eu.kanade.tachiyomi.data.ai.RunnerLlm.startSession(appCtx, key, { st ->
                                runnerStatusFlow.value = st
                            }, runnerOs)
                            withContext(Dispatchers.Main) {
                                runnerStartingFlow.value = false
                                if (s != null) {
                                    sessions = eu.kanade.tachiyomi.data.ai.RunnerLlm.listSessions(context)
                                    backendPref.set("runner")
                                }
                            }
                        }
                    },
                ) { Text("▶ $label • $sizeMb МБ") }
            }
            // Своя GGUF-модель по прямой ссылке
            var customGguf by remember { mutableStateOf("") }
            OutlinedTextField(
                value = customGguf,
                onValueChange = { customGguf = it },
                label = { Text("Своя GGUF-модель: прямая ссылка (.gguf)") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 2,
            )
            androidx.compose.material3.FilledTonalButton(
                enabled = !runnerStarting && customGguf.trim().startsWith("http") && customGguf.contains(".gguf"),
                onClick = {
                    val url = customGguf.trim()
                    runnerStartingFlow.value = true
                    runnerStatusFlow.value = "⏳ Запуск своей модели…"
                    val appCtx = context.applicationContext
                    chatScope.launch {
                        val s = eu.kanade.tachiyomi.data.ai.RunnerLlm.startSessionWithUrl(appCtx, url, { st ->
                            runnerStatusFlow.value = st
                        }, runnerOs)
                        withContext(Dispatchers.Main) {
                            runnerStartingFlow.value = false
                            if (s != null) {
                                sessions = eu.kanade.tachiyomi.data.ai.RunnerLlm.listSessions(context)
                                backendPref.set("runner")
                            }
                        }
                    }
                },
            ) { Text("▶ Запустить свою модель в ранере") }
            if (runnerStatus.isNotBlank()) {
                // «Время рывками» (жалоба): статус обновлялся раз в 15с.
                // Теперь рядом ПЛАВНЫЙ секундомер — тикает каждую секунду.
                var elapsed by remember { mutableStateOf(0L) }
                LaunchedEffect(runnerStarting) {
                    elapsed = 0
                    while (runnerStarting) {
                        kotlinx.coroutines.delay(1000)
                        elapsed++
                    }
                }
                Text(
                    if (runnerStarting) "$runnerStatus • ${elapsed / 60}:${"%02d".format(elapsed % 60)}"
                    else runnerStatus,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (sessions.isNotEmpty()) {
                Text("Сессии (сохранены на телефоне):", style = MaterialTheme.typography.bodySmall)
                // ИНДИКАЦИЯ РАНЕРА: живой /health-пинг каждые 30с, аптайм и
                // остаток 5.5-часового лимита — видно, что ранер работает
                var statuses by remember {
                    mutableStateOf<Map<String, eu.kanade.tachiyomi.data.ai.RunnerLlm.RunnerStatus>>(emptyMap())
                }
                LaunchedEffect(sessions) {
                    while (true) {
                        val map = mutableMapOf<String, eu.kanade.tachiyomi.data.ai.RunnerLlm.RunnerStatus>()
                        sessions.forEach { ses ->
                            map[ses.id] = eu.kanade.tachiyomi.data.ai.RunnerLlm.status(ses)
                        }
                        statuses = map
                        kotlinx.coroutines.delay(30_000)
                    }
                }
                sessions.forEach { s ->
                    val st = statuses[s.id]
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            buildString {
                                append(if (st?.alive == true) "🟢 " else if (st != null) "🔴 " else "⏳ ")
                                append("${s.model} • ${s.messages.size} сообщ.")
                                if (st != null && st.alive) {
                                    append(" • аптайм ${st.uptimeMs / 60000}м")
                                    append(" • осталось ~${st.remainingMs / 60000}м")
                                } else if (st != null) {
                                    append(" • НЕ ОТВЕЧАЕТ (ранер погас?)")
                                }
                            },
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f),
                        )
                        if (s.terminalUrl != null) {
                            FilterChip(
                                selected = false,
                                onClick = { onOpenTerminal(s) },
                                label = { Text("🖥 Терминал (${s.os})") },
                            )
                        }
                        FilterChip(
                            selected = false,
                            onClick = {
                                eu.kanade.tachiyomi.data.ai.RunnerLlm.deleteSession(context, s)
                                sessions = eu.kanade.tachiyomi.data.ai.RunnerLlm.listSessions(context)
                            },
                            label = { Text("✕") },
                        )
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Доступ из внешнего браузера", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        if (serverOn) {
                            val httpKey = eu.kanade.tachiyomi.data.ai.AiHttpServer.tokenFor(context)
                            "Работает: http://127.0.0.1:${eu.kanade.tachiyomi.data.ai.AiHttpServer.PORT}/?key=$httpKey " +
                                "(с других устройств Wi-Fi — http://IP-телефона:${eu.kanade.tachiyomi.data.ai.AiHttpServer.PORT}/?key=$httpKey)"
                        } else {
                            "Выключен. Включите — чат и workspace откроются в любом браузере."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                androidx.compose.material3.Switch(
                    checked = serverOn,
                    onCheckedChange = { on ->
                        if (on) {
                            runCatching { eu.kanade.tachiyomi.data.ai.AiHttpServer.start(context) }
                                .onFailure { context.toast("Не удалось запустить сервер: ${it.message}") }
                        } else {
                            eu.kanade.tachiyomi.data.ai.AiHttpServer.stop()
                        }
                        serverOn = eu.kanade.tachiyomi.data.ai.AiHttpServer.isRunning
                        serverPref.set(serverOn)
                    },
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Скрыть вкладку AI из нижней панели", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Вкладка исчезнет из навигации. Вернуть: Ещё → Настройки, либо через внешний браузер.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                androidx.compose.material3.Switch(
                    checked = false,
                    onCheckedChange = {
                        if (!serverOn) {
                            runCatching { eu.kanade.tachiyomi.data.ai.AiHttpServer.start(context) }
                            serverPref.set(true)
                        }
                        tabVisiblePref.set(false)
                        context.toast("Вкладка скрыта. Агент доступен на http://127.0.0.1:8765")
                    },
                )
            }
            Text(
                "Модель агента настраивается там же, где модель озвучки: " +
                    "читалка → SAO-меню → Озвучка → AI-провайдер (Zen без ключа / OpenRouter).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    @Composable
    private fun ChatBody(
        messages: List<Msg>,
        busy: Boolean,
        listState: androidx.compose.foundation.lazy.LazyListState,
        selectMode: Boolean,
        selected: Set<Int>,
        onToggleSelect: (Int) -> Unit,
        input: String,
        onInput: (String) -> Unit,
        attachments: List<File>,
        onRemoveAttachment: (File) -> Unit,
        onAttach: () -> Unit,
        onSend: () -> Unit,
        onQuickSend: (String) -> Unit = {},
        modifier: Modifier = Modifier,
    ) {
        val context = LocalContext.current

        Column(modifier = modifier) {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (messages.isEmpty()) {
                    item {
                        Text(
                            "Встроенный AI-агент Yomikai.\n\nУмеет: отвечать на вопросы, рисовать картинки " +
                                "(Pollinations), сохранять файлы в workspace (/sdcard/Yomikai/AI), проверять " +
                                "сайты, скрывать/показывать расширения, искать мангу по источникам.\n\n" +
                                "Примеры:\n«скрой все английские расширения»\n«проверь, работает ли mangalib.me»\n" +
                                "«найди мангу Наруто»\n«нарисуй лису с мангой»\n«сохрани список покупок в файл»",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                items(messages.size) { idx ->
                    val m = messages[idx]
                    MessageBubble(
                        m = m,
                        index = idx,
                        selectMode = selectMode,
                        isSelected = idx in selected,
                        onToggleSelect = onToggleSelect,
                        onQuickSend = onQuickSend,
                    )
                }
                if (busy) {
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Агент думает/работает…", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }

            // Полоса вложений
            if (attachments.isNotEmpty()) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    attachments.take(4).forEach { f ->
                        FilterChip(
                            selected = true,
                            onClick = { onRemoveAttachment(f) },
                            label = { Text(f.name.take(16) + " ✕") },
                        )
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                IconButton(onClick = onAttach) {
                    Icon(Icons.Outlined.AttachFile, contentDescription = "Вложение")
                }
                OutlinedTextField(
                    value = input,
                    onValueChange = onInput,
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Сообщение агенту…") },
                    maxLines = 4,
                )
                IconButton(onClick = onSend, enabled = !busy) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "Отправить")
                }
            }
        }
    }

    @Composable
    private fun MessageBubble(
        m: Msg,
        index: Int,
        selectMode: Boolean,
        isSelected: Boolean,
        onToggleSelect: (Int) -> Unit,
        onQuickSend: (String) -> Unit = {},
    ) {
        val context = LocalContext.current
        val isUser = m.role == "user"
        Surface(
            color = when {
                isSelected -> MaterialTheme.colorScheme.tertiaryContainer
                isUser -> MaterialTheme.colorScheme.primaryContainer
                else -> MaterialTheme.colorScheme.surfaceVariant
            },
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = selectMode) { onToggleSelect(index) },
        ) {
            Column(modifier = Modifier.padding(10.dp)) {
                // Шапка: кто • модель • время • метрики хода
                val clock = remember(m.time) {
                    java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
                        .format(java.util.Date(m.time))
                }
                val meta = buildString {
                    append(if (isUser) "Вы" else "Агент")
                    if (m.model.isNotBlank()) append(" • ").append(m.model)
                    append(" • ").append(clock)
                    if (!isUser && m.tookMs > 0) append(" • ").append("%.1fс".format(m.tookMs / 1000f))
                    if (!isUser && m.tokens > 0) append(" • ").append(m.tokens).append(" ткн")
                    if (!isUser && m.rounds > 0) append(" • ").append(m.rounds).append(" раунд(а)")
                }
                Text(
                    meta,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                // Размышления reasoning-модели (если включено в меню модели)
                if (!isUser && m.reasoning != null) {
                    val prefs = remember { Injekt.get<OcrPreferences>() }
                    val show by prefs.aiShowReasoning().changes()
                        .collectAsState(initial = prefs.aiShowReasoning().get())
                    if (show) {
                        var expanded by remember { mutableStateOf(false) }
                        Text(
                            if (expanded) "🤔 ${m.reasoning}" else "🤔 Размышления… (нажмите)",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.clickable { expanded = !expanded },
                        )
                    }
                }
                if (m.text.isNotBlank()) {
                    Text(m.text, style = MaterialTheme.typography.bodyMedium)
                }
                if (m.toolLog.isNotBlank()) {
                    Text(
                        m.toolLog,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                // TODO-список хода: карточки инструментов по раундам,
                // сворачиваемые (по требованию пользователя — не текст в
                // сообщении, а отдельные структурные блоки)
                if (m.toolCards.isNotEmpty()) {
                    var toolsExpanded by remember(index) { mutableStateOf(false) }
                    val okCount = m.toolCards.count { it.status == "ok" }
                    Surface(
                        color = MaterialTheme.colorScheme.surface,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                    ) {
                        Column(Modifier.padding(8.dp)) {
                            Text(
                                (if (toolsExpanded) "▼" else "▶") +
                                    " Инструменты: $okCount/${m.toolCards.size} ✓" +
                                    (if (m.toolCards.any { it.status == "error" }) " • есть ошибки" else ""),
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.clickable { toolsExpanded = !toolsExpanded },
                            )
                            if (toolsExpanded) {
                                var lastRound = 0
                                m.toolCards.forEach { c ->
                                    if (c.round != lastRound) {
                                        lastRound = c.round
                                        Text(
                                            "— Раунд ${c.round} —",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            modifier = Modifier.padding(top = 4.dp),
                                        )
                                    }
                                    var cardOpen by remember(index, c.name, c.round) { mutableStateOf(false) }
                                    Column(
                                        Modifier
                                            .fillMaxWidth()
                                            .clickable { cardOpen = !cardOpen }
                                            .padding(vertical = 2.dp),
                                    ) {
                                        Text(
                                            (if (c.status == "ok") "✅" else "❌") +
                                                " ${c.name} • ${c.tookMs}мс" +
                                                (if (cardOpen) "" else " (развернуть)"),
                                            style = MaterialTheme.typography.bodySmall,
                                        )
                                        if (cardOpen) {
                                            if (c.args.isNotBlank() && c.args != "{}") {
                                                Text(
                                                    "аргументы: ${c.args}",
                                                    style = MaterialTheme.typography.bodySmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            }
                                            Text(
                                                c.output.take(600),
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                m.images.forEach { img ->
                    ImageThumb(img)
                }
                // КНОПКИ-ВАРИАНТЫ от агента ([[...]]) — тап отправляет выбор
                if (!isUser && m.choices.isNotEmpty()) {
                    androidx.compose.foundation.layout.FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        m.choices.forEach { c ->
                            androidx.compose.material3.FilledTonalButton(
                                onClick = { onQuickSend(c) },
                            ) { Text(c, style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
                // Кнопки: озвучить / стоп / копировать
                Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    IconButton(
                        onClick = { TtsSpeaker.speak(context, m.text) },
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(Icons.Outlined.PlayArrow, "Озвучить", Modifier.size(18.dp))
                    }
                    IconButton(
                        onClick = { TtsSpeaker.stop() },
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(Icons.Outlined.Stop, "Стоп", Modifier.size(18.dp))
                    }
                    if (!isUser && m.sourcePrompt.isNotBlank()) {
                        IconButton(
                            onClick = { onQuickSend(m.sourcePrompt) },
                            modifier = Modifier.size(32.dp),
                        ) {
                            Icon(Icons.Outlined.Refresh, "Повторить запрос", Modifier.size(18.dp))
                        }
                    }
                    IconButton(
                        onClick = { context.copyToClipboard("AI", m.text) },
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(Icons.Outlined.ContentCopy, "Копировать", Modifier.size(18.dp))
                    }
                }
            }
        }
    }

    @Composable
    private fun ImageThumb(img: File) {
        val context = LocalContext.current
        val bmp = remember(img.absolutePath) {
            runCatching {
                BitmapFactory.decodeFile(img.absolutePath)?.let { b ->
                    if (b.width > 512) {
                        val h = b.height * 512 / b.width
                        android.graphics.Bitmap.createScaledBitmap(b, 512, h, true).also { if (it !== b) b.recycle() }
                    } else b
                }
            }.getOrNull()
        }
        if (bmp != null) {
            Column {
                Image(
                    bitmap = bmp.asImageBitmap(),
                    contentDescription = img.name,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                )
                Row {
                    FilterChip(
                        selected = false,
                        onClick = {
                            val uri = img.getUriCompat(context)
                            val intent = Intent(Intent.ACTION_SEND).apply {
                                type = "image/*"
                                putExtra(Intent.EXTRA_STREAM, uri)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            context.startActivity(Intent.createChooser(intent, "Скачать/поделиться"))
                        },
                        label = { Text("⬇ Скачать") },
                    )
                }
            }
        }
    }

    @Composable
    private fun PluginsBody(modifier: Modifier = Modifier) {
        val context = LocalContext.current
        var refresh by remember { mutableStateOf(0) }
        val plugins = remember(refresh) { eu.kanade.tachiyomi.data.ai.AiPlugins.list(context) }
        var editName by remember { mutableStateOf("") }
        var editKind by remember { mutableStateOf("prompt") }
        var editDesc by remember { mutableStateOf("") }
        var editTemplate by remember { mutableStateOf("") }

        Column(
            modifier = modifier
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Плагины разработчика", style = MaterialTheme.typography.titleMedium)
            Text(
                "Самодельные инструменты агента — без ограничений по количеству. " +
                    "Создаются здесь или прямо в чате: «сделай инструмент, который …» — " +
                    "агент вызовет plugin_create и сразу проверит. Хранятся в workspace/plugins.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (plugins.isEmpty()) {
                Text("Плагинов пока нет.", style = MaterialTheme.typography.bodyMedium)
            }
            plugins.forEach { p ->
                androidx.compose.material3.Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Column(Modifier.fillMaxWidth().padding(10.dp)) {
                        Text(
                            "🔌 ${p.name} • ${if (p.kind == "http") "HTTP-запрос" else "Промпт-макрос"}",
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        if (p.description.isNotBlank()) {
                            Text(p.description, style = MaterialTheme.typography.bodySmall)
                        }
                        Text(
                            p.template.take(160),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        androidx.compose.foundation.layout.FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            androidx.compose.material3.OutlinedButton(onClick = {
                                editName = p.name
                                editKind = p.kind
                                editDesc = p.description
                                editTemplate = p.template
                            }) { Text("✏ Править") }
                            androidx.compose.material3.OutlinedButton(onClick = {
                                context.copyToClipboard("plugin", "@tool ${p.name} {\"input\":\"\"}")
                            }) { Text("📋 Вызов") }
                            androidx.compose.material3.OutlinedButton(onClick = {
                                eu.kanade.tachiyomi.data.ai.AiPlugins.delete(context, p.name)
                                refresh++
                            }) { Text("🗑 Удалить") }
                        }
                    }
                }
            }

            Text("Создать / править вручную", style = MaterialTheme.typography.titleSmall)
            OutlinedTextField(
                value = editName,
                onValueChange = { editName = it },
                label = { Text("Имя (латиницей, без пробелов)") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 1,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = editKind == "prompt",
                    onClick = { editKind = "prompt" },
                    label = { Text("Промпт-макрос") },
                )
                FilterChip(
                    selected = editKind == "http",
                    onClick = { editKind = "http" },
                    label = { Text("HTTP-запрос") },
                )
            }
            OutlinedTextField(
                value = editDesc,
                onValueChange = { editDesc = it },
                label = { Text("Описание") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 2,
            )
            OutlinedTextField(
                value = editTemplate,
                onValueChange = { editTemplate = it },
                label = {
                    Text(
                        if (editKind == "http") "URL с {query} и т.п." else "Инструкция с {input}",
                    )
                },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 5,
            )
            androidx.compose.material3.Button(
                onClick = {
                    val ok = eu.kanade.tachiyomi.data.ai.AiPlugins.save(
                        context,
                        eu.kanade.tachiyomi.data.ai.AiPlugins.Plugin(
                            name = editName,
                            kind = editKind,
                            description = editDesc,
                            template = editTemplate,
                        ),
                    )
                    context.toast(if (ok) "Плагин сохранён" else "Ошибка: имя/шаблон некорректны")
                    if (ok) {
                        editName = ""; editDesc = ""; editTemplate = ""
                        refresh++
                    }
                },
                enabled = editName.isNotBlank() && editTemplate.isNotBlank(),
            ) { Text("💾 Сохранить плагин") }
            Spacer(Modifier.height(24.dp))
        }
    }

    @Composable
    private fun WorkspaceBody(modifier: Modifier = Modifier) {
        val context = LocalContext.current
        val scope = rememberCoroutineScope()
        // Список не читается в композиции: обход общего хранилища — это
        // дисковый ввод на главном потоке. Первое состояние пустое, данные
        // приносит LaunchedEffect ниже (и он же обновляет список по кнопке).
        var files by remember { mutableStateOf(emptyList<File>()) }
        var refreshKey by remember { mutableStateOf(0) }

        androidx.compose.runtime.LaunchedEffect(refreshKey) {
            files = withContext(Dispatchers.IO) { AiWorkspace.listAll(context) }
        }

        Column(modifier = modifier.padding(horizontal = 12.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "Workspace агента: /sdcard/Yomikai/AI",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                FilterChip(
                    selected = false,
                    onClick = { refreshKey++ },
                    label = { Text("Обновить") },
                )
                FilterChip(
                    selected = false,
                    onClick = {
                        scope.launch(Dispatchers.IO) {
                            val zip = AiWorkspace.zipAll(context)
                            withContext(Dispatchers.Main) {
                                context.toast(
                                    if (zip != null) {
                                        "Архив: ${zip.name}"
                                    } else {
                                        "Не удалось собрать архив: нет места или хранилище недоступно"
                                    },
                                )
                                refreshKey++
                            }
                        }
                    },
                    label = { Text("Zip всего") },
                )
            }
            if (files.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("Workspace пуст. Попросите агента что-нибудь сохранить или нарисовать.")
                }
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(files, key = { it.absolutePath }) { f ->
                        WorkspaceRow(
                            f = f,
                            rel = AiWorkspace.relPath(context, f),
                            onDelete = {
                                AiWorkspace.delete(context, AiWorkspace.relPath(context, f))
                                refreshKey++
                            },
                        )
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }

    @Composable
    private fun WorkspaceRow(f: File, rel: String, onDelete: () -> Unit) {
        val context = LocalContext.current
        Surface(
            shape = RoundedCornerShape(10.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(8.dp),
            ) {
                Icon(
                    when {
                        f.isDirectory -> Icons.Outlined.Folder
                        isImage(f) -> Icons.Outlined.ImageIcon
                        else -> Icons.Outlined.AttachFile
                    },
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(rel, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    if (f.isFile) {
                        Text(
                            "${f.length() / 1024} КБ",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (f.isFile) {
                    IconButton(
                        onClick = {
                            val uri = f.getUriCompat(context)
                            val intent = Intent(Intent.ACTION_SEND).apply {
                                type = when {
                                    isImage(f) -> "image/*"
                                    f.extension == "zip" -> "application/zip"
                                    else -> "*/*"
                                }
                                putExtra(Intent.EXTRA_STREAM, uri)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            context.startActivity(Intent.createChooser(intent, "Поделиться"))
                        },
                        modifier = Modifier.size(34.dp),
                    ) {
                        Icon(Icons.Outlined.Share, "Поделиться", Modifier.size(18.dp))
                    }
                }
                IconButton(onClick = onDelete, modifier = Modifier.size(34.dp)) {
                    Icon(Icons.Outlined.Delete, "Удалить", Modifier.size(18.dp))
                }
            }
        }
    }

    private fun isImage(f: File) = f.extension.lowercase() in setOf("jpg", "jpeg", "png", "webp", "gif")
    private fun isTextFile(f: File) = f.extension.lowercase() in
        setOf("txt", "md", "json", "xml", "html", "csv", "log", "kt", "java", "js", "py")
}
