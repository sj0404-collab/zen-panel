package eu.kanade.presentation.reader

import android.speech.tts.TextToSpeech
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import eu.kanade.tachiyomi.data.tts.TtsSpeaker
import eu.kanade.tachiyomi.util.system.toast
import mihon.domain.ocr.service.OcrPreferences
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Настройки озвучки: три источника голосов.
 * • Системные — все голоса Android TTS (локальные и сетевые)
 * • Веб (без ключа) — Google Translate TTS прямо с сайта
 * • ElevenLabs — нейроголоса по API-ключу
 */
@Composable
fun TtsSettingsDialog(
    onDismissRequest: () -> Unit,
    onOpenFullSettings: () -> Unit,
) {
    val context = LocalContext.current
    val prefs = remember { Injekt.get<OcrPreferences>() }

    var engine by remember { mutableStateOf(prefs.voiceEngine().get()) }
    var selectedVoice by remember { mutableStateOf(prefs.voiceName().get()) }
    var rate by remember { mutableFloatStateOf(prefs.speechRate().get()) }
    var webLang by remember { mutableStateOf(prefs.ttsWebLanguage().get()) }
    var elevenKey by remember { mutableStateOf(prefs.elevenApiKey().get()) }
    var elevenVoice by remember { mutableStateOf(prefs.elevenVoiceId().get()) }

    var voiceFemale by remember { mutableStateOf(prefs.voiceFemale().get()) }
    var voiceMale by remember { mutableStateOf(prefs.voiceMale().get()) }
    var aiGender by remember { mutableStateOf(prefs.aiGenderVoices().get()) }
    var aiProvider by remember { mutableStateOf(prefs.aiProvider().get()) }
    var zenModel by remember { mutableStateOf(prefs.zenModel().get()) }
    var orFreeModel by remember { mutableStateOf(prefs.openrouterFreeModel().get()) }
    var orKey by remember { mutableStateOf(prefs.openrouterApiKey().get()) }
    var orModels by remember { mutableStateOf<List<String>>(emptyList()) }
    var showAiLog by remember { mutableStateOf(false) }

    // Живой список :free моделей OpenRouter (фолбэк при оффлайне)
    androidx.compose.runtime.LaunchedEffect(aiProvider) {
        if (aiProvider == eu.kanade.tachiyomi.data.ai.AiAssistant.PROVIDER_OPENROUTER && orModels.isEmpty()) {
            orModels = eu.kanade.tachiyomi.data.ai.AiAssistant.fetchOpenRouterFreeModels()
        }
    }
    var assignMode by remember { mutableStateOf(0) } // 0=основной, 1=женский, 2=мужской

    var voices by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    var sysReady by remember { mutableStateOf(false) }
    val systemEnginePkg = remember { prefs.systemTtsEngine().get() }
    var probe by remember { mutableStateOf<TextToSpeech?>(null) }
    var probeInitStatus by remember { mutableStateOf(Int.MIN_VALUE) }

    DisposableEffect(systemEnginePkg) {
        voices = emptyList()
        sysReady = false
        probe = null
        probeInitStatus = Int.MIN_VALUE
        var tts: TextToSpeech? = null
        var disposed = false
        val listener = TextToSpeech.OnInitListener { status ->
            // OEM implementations may invoke OnInit before the constructor
            // assignment above completes. Posting also lets lazy engines bind.
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
            runCatching { tts?.stop() }
            runCatching { tts?.shutdown() }
        }
    }

    androidx.compose.runtime.LaunchedEffect(probe, probeInitStatus, systemEnginePkg) {
        val activeProbe = probe
        if (probeInitStatus != TextToSpeech.SUCCESS || activeProbe == null) {
            sysReady = probeInitStatus != Int.MIN_VALUE
            return@LaunchedEffect
        }
        sysReady = false
        eu.kanade.tachiyomi.data.tts.VoiceHelper.prepareForLanguage(activeProbe, "ru")
        var found = emptyList<android.speech.tts.Voice>()
        for (attempt in 0 until 6) {
            found = eu.kanade.tachiyomi.data.tts.VoiceHelper
                .russianVoices(activeProbe, systemEnginePkg)
            if (found.isNotEmpty()) break
            kotlinx.coroutines.delay(250L + attempt * 150L)
        }
        voices = found
            .sortedWith(
                compareBy(
                    {
                        when (eu.kanade.tachiyomi.data.tts.VoiceHelper.classify(it)) {
                            eu.kanade.tachiyomi.data.tts.VoiceKind.FEMALE -> 0
                            eu.kanade.tachiyomi.data.tts.VoiceKind.MALE -> 1
                            eu.kanade.tachiyomi.data.tts.VoiceKind.TEEN -> 2
                            else -> 3
                        }
                    },
                    { it.isNetworkConnectionRequired },
                    { it.name },
                ),
            )
            .map { voice ->
                val kind = when (eu.kanade.tachiyomi.data.tts.VoiceHelper.classify(voice)) {
                    eu.kanade.tachiyomi.data.tts.VoiceKind.FEMALE -> "♀ Женский"
                    eu.kanade.tachiyomi.data.tts.VoiceKind.MALE -> "♂ Мужской"
                    eu.kanade.tachiyomi.data.tts.VoiceKind.TEEN -> "👦 Подросток"
                    else -> "Другой"
                }
                val net = if (voice.isNetworkConnectionRequired) "☁ сеть" else "📱 локальный"
                voice.name to "$kind • $net • ${voice.name.substringAfterLast(':')}"
            }

        // Автовыбор выполняется по тому же выбранному пакету движка, включая
        // RHVoice fallback для прошивок с пустым getVoices().
        val names = voices.map { it.first }.toSet()
        if (selectedVoice.isBlank() || selectedVoice !in names) {
            eu.kanade.tachiyomi.data.tts.VoiceHelper
                .pick(
                    activeProbe,
                    eu.kanade.tachiyomi.data.tts.VoiceKind.FEMALE,
                    null,
                    systemEnginePkg,
                )
                ?.let { selectedVoice = it.name }
        }
        if (voiceFemale.isBlank() || voiceFemale !in names) {
            eu.kanade.tachiyomi.data.tts.VoiceHelper
                .pick(
                    activeProbe,
                    eu.kanade.tachiyomi.data.tts.VoiceKind.FEMALE,
                    null,
                    systemEnginePkg,
                )
                ?.let { voiceFemale = it.name }
        }
        if (voiceMale.isBlank() || voiceMale !in names) {
            eu.kanade.tachiyomi.data.tts.VoiceHelper
                .pick(
                    activeProbe,
                    eu.kanade.tachiyomi.data.tts.VoiceKind.MALE,
                    null,
                    systemEnginePkg,
                )
                ?.let { voiceMale = it.name }
        }
        sysReady = true
    }

    AlertDialog(
        onDismissRequest = onDismissRequest,
        icon = { Icon(Icons.Outlined.RecordVoiceOver, contentDescription = null) },
        title = { Text("Озвучка (TTS)") },
        text = {
            Column {
                Row {
                    FilterChip(
                        selected = engine == TtsSpeaker.ENGINE_SYSTEM,
                        onClick = { engine = TtsSpeaker.ENGINE_SYSTEM },
                        label = { Text("Системные") },
                        modifier = Modifier.padding(end = 6.dp),
                    )
                    FilterChip(
                        selected = engine == TtsSpeaker.ENGINE_REMOTE,
                        onClick = { engine = TtsSpeaker.ENGINE_REMOTE },
                        label = { Text("🖥 Сервер") },
                        modifier = Modifier.padding(end = 6.dp),
                    )
                    FilterChip(
                        selected = engine == TtsSpeaker.ENGINE_GOOGLE_WEB,
                        onClick = { engine = TtsSpeaker.ENGINE_GOOGLE_WEB },
                        label = { Text("Веб") },
                        modifier = Modifier.padding(end = 6.dp),
                    )
                    FilterChip(
                        selected = engine == TtsSpeaker.ENGINE_ELEVENLABS,
                        onClick = { engine = TtsSpeaker.ENGINE_ELEVENLABS },
                        label = { Text("ElevenLabs") },
                    )
                }
                if (engine == TtsSpeaker.ENGINE_REMOTE) {
                    androidx.compose.material3.OutlinedTextField(
                        value = prefs.remoteTtsUrl().get(),
                        onValueChange = { prefs.remoteTtsUrl().set(it.trim()) },
                        label = { Text("Адрес сервера: http://192.168.1.10:8788") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    Text(
                        "Нейроголоса (sherpa-onnx/Piper) работают на вашем ПК или ранере: " +
                            "запустите tools/remote_tts_server.py и укажите адрес. " +
                            "Приложение шлёт текст и проигрывает готовый wav.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 6.dp)
                        .clickable { aiGender = !aiGender },
                ) {
                    androidx.compose.material3.Checkbox(
                        checked = aiGender,
                        onCheckedChange = { aiGender = it },
                    )
                    Column {
                        Text("AI-голоса по полу говорящего", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            "Встроенная морфология + онлайн-ассистент (Zen — без ключа) определяют, кто говорит: реплики озвучиваются голосом ♀/♂.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                if (aiGender) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { showAiLog = !showAiLog }
                            .padding(top = 4.dp),
                    ) {
                        Text(
                            "⚙ Скрытый чат ассистента (журнал)",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            if (showAiLog) "  ▲" else "  ▼",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                    if (showAiLog) {
                        val entries = eu.kanade.tachiyomi.data.ai.AiAssistant.log().asReversed()
                        if (entries.isEmpty()) {
                            Text(
                                "Пока пусто: журнал наполняется при авточтении.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            LazyColumn(modifier = Modifier.heightIn(max = 180.dp)) {
                                items(entries.size) { idx ->
                                    val e = entries[idx]
                                    Column(modifier = Modifier.padding(vertical = 3.dp)) {
                                        Text(
                                            "${e.model} • ${e.tookMs}мс",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.primary,
                                        )
                                        Text(
                                            "→ ${e.prompt}",
                                            style = MaterialTheme.typography.bodySmall,
                                            maxLines = 2,
                                        )
                                        Text(
                                            "← ${e.answer}",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 2,
                                        )
                                    }
                                }
                            }
                        }
                    }
                    Row(modifier = Modifier.padding(top = 4.dp)) {
                        FilterChip(
                            selected = aiProvider == eu.kanade.tachiyomi.data.ai.AiAssistant.PROVIDER_ZEN,
                            onClick = { aiProvider = eu.kanade.tachiyomi.data.ai.AiAssistant.PROVIDER_ZEN },
                            label = { Text("Zen (без ключа)") },
                            modifier = Modifier.padding(end = 6.dp),
                        )
                        FilterChip(
                            selected = aiProvider == eu.kanade.tachiyomi.data.ai.AiAssistant.PROVIDER_OPENROUTER,
                            onClick = { aiProvider = eu.kanade.tachiyomi.data.ai.AiAssistant.PROVIDER_OPENROUTER },
                            label = { Text("OpenRouter") },
                        )
                    }
                    // Провайдеры пользователя из реестра AiProviders: свой
                    // endpoint (Ollama, LM Studio, прокси). Создаются файлом в
                    // workspace/providers или через AI-чат (provider_create).
                    val userProviders = remember(context) {
                        eu.kanade.tachiyomi.data.ai.AiProviders.list(context)
                    }
                    if (userProviders.isNotEmpty()) {
                        Text(
                            "Свои провайдеры:",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                        userProviders.forEach { spec ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(top = 2.dp),
                            ) {
                                FilterChip(
                                    selected = aiProvider == spec.id,
                                    onClick = { aiProvider = spec.id },
                                    label = { Text(spec.title.ifBlank { spec.id }) },
                                )
                            }
                            Text(
                                "${spec.model} • ${spec.baseUrl}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                    if (aiProvider == eu.kanade.tachiyomi.data.ai.AiAssistant.PROVIDER_ZEN) {
                        Text(
                            "Модель Zen (бесплатно, без регистрации):",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                        LazyColumn(modifier = Modifier.heightIn(max = 150.dp)) {
                            items(
                                eu.kanade.tachiyomi.data.ai.AiAssistant.ZEN_MODELS,
                                key = { it },
                            ) { m ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable { zenModel = m },
                                ) {
                                    RadioButton(selected = zenModel == m, onClick = { zenModel = m })
                                    Text(m, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                    } else {
                        OutlinedTextField(
                            value = orKey,
                            onValueChange = { orKey = it },
                            label = { Text("OpenRouter API-ключ") },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 6.dp),
                        )
                        Text(
                            if (orModels.isEmpty()) "Загрузка списка :free моделей…"
                            else "Бесплатные модели (:free):",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                        LazyColumn(modifier = Modifier.heightIn(max = 150.dp)) {
                            items(orModels, key = { it }) { m ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable { orFreeModel = m },
                                ) {
                                    RadioButton(selected = orFreeModel == m, onClick = { orFreeModel = m })
                                    Text(m, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                                }
                            }
                        }
                    }
                }

                Text(
                    text = "Скорость: ${"%.1f".format(rate)}× (для системных голосов)",
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Slider(
                    value = rate,
                    onValueChange = { rate = it },
                    valueRange = 0.5f..2f,
                )

                when (engine) {
                    TtsSpeaker.ENGINE_SYSTEM -> {
                        Row(modifier = Modifier.padding(bottom = 4.dp)) {
                            FilterChip(
                                selected = assignMode == 0,
                                onClick = { assignMode = 0 },
                                label = { Text("Основной") },
                                modifier = Modifier.padding(end = 4.dp),
                            )
                            FilterChip(
                                selected = assignMode == 1,
                                onClick = { assignMode = 1 },
                                label = { Text("♀ Женский") },
                                modifier = Modifier.padding(end = 4.dp),
                            )
                            FilterChip(
                                selected = assignMode == 2,
                                onClick = { assignMode = 2 },
                                label = { Text("♂ Мужской") },
                            )
                        }
                        Text(
                            when (assignMode) {
                                1 -> "Голос для женских реплик: " + (voiceFemale.ifBlank { "не задан" })
                                2 -> "Голос для мужских реплик: " + (voiceMale.ifBlank { "не задан" })
                                else -> "Основной голос озвучки"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        when {
                            !sysReady -> Text("Инициализация системного TTS…")
                            voices.isEmpty() -> Text(
                                "Голосов не найдено. Установите TTS-движок " +
                                    "(Speech Services by Google, RHVoice) в настройках системы.",
                            )
                            else -> LazyColumn(modifier = Modifier.heightIn(max = 260.dp)) {
                                items(voices, key = { it.first }) { (name, label) ->
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable {
                                                when (assignMode) {
                                                    1 -> voiceFemale = name
                                                    2 -> voiceMale = name
                                                    else -> selectedVoice = name
                                                }
                                            },
                                    ) {
                                        RadioButton(
                                            selected = when (assignMode) {
                                                1 -> voiceFemale == name
                                                2 -> voiceMale == name
                                                else -> selectedVoice == name
                                            },
                                            onClick = {
                                                when (assignMode) {
                                                    1 -> voiceFemale = name
                                                    2 -> voiceMale = name
                                                    else -> selectedVoice = name
                                                }
                                            },
                                        )
                                        Column {
                                            Text(label, style = MaterialTheme.typography.bodyMedium)
                                            Text(
                                                name,
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                    TtsSpeaker.ENGINE_GOOGLE_WEB -> {
                        Text(
                            "Озвучка с сайта Google Translate — без API-ключа, нужен интернет.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedTextField(
                            value = webLang,
                            onValueChange = { webLang = it },
                            label = { Text("Язык (ru, en, ja…)") },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 8.dp),
                        )
                    }
                    TtsSpeaker.ENGINE_ELEVENLABS -> {
                        Text(
                            "Нейроголоса ElevenLabs. Нужен API-ключ с elevenlabs.io. " +
                                "Без ключа автоматически используется веб-озвучка.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedTextField(
                            value = elevenKey,
                            onValueChange = { elevenKey = it },
                            label = { Text("API-ключ") },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 8.dp),
                        )
                        OutlinedTextField(
                            value = elevenVoice,
                            onValueChange = { elevenVoice = it },
                            label = { Text("Voice ID (пусто = Rachel)") },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 8.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    prefs.voiceEngine().set(engine)
                    prefs.voiceName().set(selectedVoice)
                    prefs.voiceFemale().set(voiceFemale)
                    prefs.voiceMale().set(voiceMale)
                    prefs.aiGenderVoices().set(aiGender)
                    prefs.aiProvider().set(aiProvider)
                    prefs.zenModel().set(zenModel)
                    prefs.openrouterFreeModel().set(orFreeModel)
                    prefs.openrouterApiKey().set(orKey.trim())
                    prefs.speechRate().set(rate.coerceIn(0.5f, 2f))
                    prefs.ttsWebLanguage().set(webLang.trim().ifBlank { "ru" })
                    prefs.elevenApiKey().set(elevenKey.trim())
                    prefs.elevenVoiceId().set(elevenVoice.trim())
                    context.toast("Настройки озвучки сохранены")
                    onDismissRequest()
                },
            ) { Text("Сохранить") }
        },
        dismissButton = {
            Row {
                TextButton(
                    onClick = {
                        // Проба ТЕКУЩЕГО выбора без сохранения
                        prefs.voiceEngine().set(engine)
                        prefs.voiceName().set(selectedVoice)
                        prefs.speechRate().set(rate.coerceIn(0.5f, 2f))
                        prefs.ttsWebLanguage().set(webLang.trim().ifBlank { "ru" })
                        prefs.elevenApiKey().set(elevenKey.trim())
                        prefs.elevenVoiceId().set(elevenVoice.trim())
                        TtsSpeaker.speak(context, "Проверка выбранного голоса Ёмикай.")
                    },
                ) { Text("Проба") }
                TextButton(onClick = onOpenFullSettings) { Text("Ещё") }
            }
        },
    )
}
