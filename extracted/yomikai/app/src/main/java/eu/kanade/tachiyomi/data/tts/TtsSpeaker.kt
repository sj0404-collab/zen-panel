package eu.kanade.tachiyomi.data.tts

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.media.MediaPlayer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import logcat.LogPriority
import mihon.data.ocr.RuStress
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.core.common.util.system.logcat
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Единый TTS-движок приложения. Три источника голосов:
 *
 * 1. SYSTEM  — системные и локальные голоса Android TTS (Google Speech
 *    Services, RHVoice и любые установленные движки; включая офлайн-голоса).
 * 2. GOOGLE_WEB — озвучка с сайта Google Translate: БЕЗ API-ключа, берётся
 *    напрямую с их публичного endpoint. Работает всегда при интернете.
 * 3. ELEVENLABS — премиальные нейроголосые через API-ключ (elevenlabs.io).
 *
 * Выбор движка/голоса хранится в OcrPreferences и применяется везде:
 * читалка, карточка перевода, диалог настроек.
 */
object TtsSpeaker {

    /**
     * Предел одной utterance. TextToSpeech.getMaxSpeechInputLength() почти
     * везде равен 4000; берём с запасом, чтобы не зависеть от прошивки.
     */
    private const val HARD_UTTERANCE_LIMIT = 3500

    /** Сколько ждать onInit при перечислении движков. */
    private const val ENGINE_QUERY_TIMEOUT_MS = 3000L

    const val ENGINE_SYSTEM = "system_tts"
    const val ENGINE_GOOGLE_WEB = "google_web"
    const val ENGINE_ELEVENLABS = "eleven_api"
    const val ENGINE_REMOTE = "remote_tts"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var currentJob: Job? = null

    private var systemTts: TextToSpeech? = null
    private var systemReady = false

    /** Инициализация системного TTS в процессе — повторные speak() ждут listener'а. */
    @Volatile
    private var initInProgress = false
    private var mediaPlayer: MediaPlayer? = null

    @Volatile
    var isSpeaking: Boolean = false
        private set

    private var onStateChange: ((Boolean) -> Unit)? = null

    private fun prefs(): OcrPreferences = Injekt.get()

    /** Пакет движка, которым инициализирован systemTts (для реинита при смене). */
    private var systemEnginePkg: String? = null

    /**
     * Ленивая инициализация системного движка. Поддерживает ВЫБОР ДВИЖКА
     * (по запросу пользователя — как в Zueira's Voice): Google TTS,
     * RHVoice, Acapela и любой другой установленный. Пустая настройка =
     * движок по умолчанию системы. При смене движка — переинициализация.
     */
    private fun ensureSystem(context: Context, onReady: (TextToSpeech?) -> Unit) {
        val wantEngine = prefs().systemTtsEngine().get().ifBlank { null }
        if (systemTts != null && systemEnginePkg != wantEngine) {
            // Пользователь сменил движок — пересоздаём
            runCatching { systemTts?.shutdown() }
            systemTts = null
            systemReady = false
            initInProgress = false
        }
        systemTts?.let {
            if (systemReady) { onReady(it); return }
        }
        if (systemTts == null) {
            // Прошлая попытка инициализации провалилась и объект остался
            // «вечным null» — все последующие вызовы молча получали onReady(null),
            // и офлайн-TTS выглядел мёртвым до перезапуска приложения.
            // Теперь упавший движок честно пересоздаётся.
            systemEnginePkg = wantEngine
            val listener = TextToSpeech.OnInitListener { status ->
                systemReady = status == TextToSpeech.SUCCESS
                initInProgress = false
                onReady(if (systemReady) systemTts else null)
            }
            initInProgress = true
            systemTts = if (wantEngine != null) {
                TextToSpeech(context.applicationContext, listener, wantEngine)
            } else {
                TextToSpeech(context.applicationContext, listener)
            }
        } else if (!initInProgress && !systemReady) {
            // Зависший полуинициализированный экземпляр: убираем и пробуем заново.
            runCatching { systemTts?.shutdown() }
            systemTts = null
            onReady(null)
        } else {
            // Инициализация уже идёт — не дёргаем движок, ответ придёт из listener'а.
            onReady(null)
        }
    }

    /**
     * Установленные TTS-движки устройства: (пакет, читаемое имя).
     *
     * Список берётся ДВУМЯ способами и объединяется:
     *
     * 1. PackageManager — движки объявляют сервис с интентом
     *    `android.intent.action.TTS_SERVICE`. Работает сразу, без ожидания.
     * 2. TextToSpeech.engines — но только ПОСЛЕ onInit: раньше здесь стоял
     *    мгновенный вызов, и до инициализации сервис не подключён, поэтому
     *    сторонние движки (RHVoice, Vocalizer, Acapela) в настройки не
     *    попадали вовсе.
     *
     * Метод блокирующий (до [ENGINE_QUERY_TIMEOUT_MS]), поэтому вызывать его
     * следует вне главного потока.
     */
    fun installedEngines(context: Context): List<Pair<String, String>> {
        val app = context.applicationContext
        val found = LinkedHashMap<String, String>()

        // 1) Через PackageManager — не требует инициализации движка.
        runCatching {
            val pm = app.packageManager
            val intent = Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE)
            val services = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.queryIntentServices(intent, PackageManager.ResolveInfoFlags.of(0L))
            } else {
                @Suppress("DEPRECATION")
                pm.queryIntentServices(intent, 0)
            }
            services.forEach { info ->
                val pkg = info.serviceInfo?.packageName ?: return@forEach
                val label = runCatching {
                    info.serviceInfo.loadLabel(pm).toString()
                }.getOrNull()?.takeIf { it.isNotBlank() } ?: pkg
                found.putIfAbsent(pkg, label)
            }
        }.onFailure { error ->
            logcat(LogPriority.WARN, error) { "queryIntentServices for TTS failed" }
        }

        // 2) Через сам TextToSpeech — дожидаемся onInit.
        runCatching {
            val ready = CountDownLatch(1)
            var probe: TextToSpeech? = null
            probe = TextToSpeech(app) { ready.countDown() }
            ready.await(ENGINE_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            probe?.engines?.forEach { engine ->
                val label = engine.label?.takeIf { it.isNotBlank() } ?: engine.name
                found[engine.name] = label
            }
            runCatching { probe?.shutdown() }
        }.onFailure { error ->
            logcat(LogPriority.WARN, error) { "TextToSpeech.engines failed" }
        }

        if (found.isEmpty()) {
            logcat(LogPriority.WARN) { "No TTS engines found on this device" }
        }
        return found.map { it.key to it.value }
    }

    /**
     * Озвучивает текст выбранным в настройках движком.
     * [onState] — колбэк true=началось / false=закончилось|ошибка.
     */
    fun speak(context: Context, text: String, onState: (Boolean) -> Unit = {}) {
        speakAs(context, text, gender = null, onState = onState)
    }

    /**
     * Озвучка с учётом пола говорящего: gender = "female" | "male" | null.
     * Для системного движка используется соответствующий голос из пресетов
     * (Настройки озвучки → Женский голос / Мужской голос). Для веб-движка
     * пол недоступен (у Google Translate один голос на язык).
     */
    @JvmOverloads
    fun speakAs(
        context: Context,
        text: String,
        gender: String?,
        speakerSlot: Int = 0,
        onState: (Boolean) -> Unit = {},
    ) {
        stop()
        onStateChange = onState
        // Служебная разметка ({1}{ж}, ÷) не должна попасть в синтез, даже
        // если вызывающий код забыл её снять.
        val spoken = SpeechMarkup.strip(text)
        if (spoken.isBlank()) {
            setSpeaking(false)
            return
        }
        // Ручной режим перекрывает и явно переданный пол, и разметку:
        // читатель нажал кнопку и ждёт выбранный голос везде.
        val manual = runCatching {
            prefs().takeIf { it.manualVoiceMode().get() }
                ?.manualVoiceGender()?.get()?.takeIf { g -> g.isNotBlank() }
        }.getOrNull()
        val effectiveGender = manual ?: gender ?: SpeechMarkup.genderOf(text)
        val slot = if (speakerSlot != 0) speakerSlot else SpeechMarkup.speakerSlot(text)
        when (prefs().voiceEngine().get()) {
            ENGINE_GOOGLE_WEB -> speakGoogleWeb(context, spoken)
            ENGINE_ELEVENLABS -> speakElevenLabs(context, spoken)
            // legacy-значения pref_voice_engine со сборок с ONNX:
            // нейроголоса теперь живут на сервере, маршрутизируем туда же.
            ENGINE_REMOTE, "onnx_tts", "onnx" -> speakRemote(context, spoken, effectiveGender)
            else -> speakSystem(context, spoken, effectiveGender, slot)
        }
    }

    fun stop() {
        currentJob?.cancel()
        currentJob = null
        runCatching { systemTts?.stop() }
        runCatching {
            mediaPlayer?.stop()
            mediaPlayer?.release()
        }
        mediaPlayer = null
        setSpeaking(false)
    }

    private fun setSpeaking(value: Boolean) {
        isSpeaking = value
        onStateChange?.invoke(value)
    }

    // region SYSTEM

    private fun speakSystem(
        context: Context,
        text: String,
        gender: String? = null,
        speakerSlot: Int = 0,
    ) {
        ensureSystem(context) { engine ->
            if (engine == null) {
                setSpeaking(false)
                return@ensureSystem
            }
            val p = prefs()
            // Пресет голоса пол/возраст: модификаторы питча и темпа.
            val presetAge = VoicePreset.Age.fromId(p.voicePresetAge().get())
            val presetGender = VoicePreset.Gender3.fromId(p.voicePresetGender().get())
            engine.setSpeechRate((p.speechRate().get() * presetAge.rate).coerceIn(0.5f, 2f))
            engine.setPitch(p.speechPitch().get().coerceIn(0.5f, 2f))
            // Пол говорящего (логика из overlay-translator):
            // 1) явный пресет пользователя для пола; 2) VoiceHelper.pick —
            // автоподбор по классификации имён (Svetlana/Dmitry/детские);
            // 3) общий голос; 4) язык ru-RU как последний рубеж.
            // Совет локального JSON-помощника (правила пользователя/агента)
            val advisorVoice = LocalVoiceAdvisor.recommend(text, gender).voiceName
            val presetVoice = advisorVoice ?: when (gender) {
                "female" -> p.voiceFemale().get()
                "male" -> p.voiceMale().get()
                else -> ""
            }
            val kind = when (gender) {
                "male" -> VoiceKind.MALE
                "female" -> VoiceKind.FEMALE
                else -> when (presetGender) {
                    VoicePreset.Gender3.MALE -> VoiceKind.MALE
                    VoicePreset.Gender3.FEMALE -> VoiceKind.FEMALE
                    else -> null
                }
            }
            // Разные персонажи одного пола получают разные голоса: слот > 0
            // сдвигает выбор внутри группы. Явный пресет пользователя всегда
            // важнее автоподбора.
            val activeEnginePackage = systemEnginePkg
                ?: runCatching { engine.defaultEngine }.getOrNull()
            val isRhVoice = activeEnginePackage.orEmpty().contains("rhvoice", ignoreCase = true)
            var chosen: android.speech.tts.Voice? = when {
                presetVoice.isNotBlank() && speakerSlot == 0 ->
                    VoiceHelper.pick(
                        engine,
                        kind ?: VoiceKind.FEMALE,
                        presetVoice,
                        systemEnginePkg,
                    )
                kind != null && speakerSlot > 0 ->
                    VoiceHelper.pickForSpeaker(
                        engine,
                        kind,
                        speakerSlot,
                        enginePackage = systemEnginePkg,
                    ) ?: VoiceHelper.pick(engine, kind, null, systemEnginePkg)
                kind != null -> VoiceHelper.pick(engine, kind, null, systemEnginePkg)
                else -> {
                    val saved = p.voiceName().get()
                    // Автоподбор как в overlay-translator: если голос не выбран
                    // или его нет в системе — берём лучший русский женский
                    // (Svetlana и др.), затем любой русский.
                    VoiceHelper.pick(engine, VoiceKind.FEMALE, saved, systemEnginePkg)
                }
            }
            // RHVoice на части прошивок отдаёт пустой getVoices(): клиент «не
            // видит» установленные голоса, pick() соскальзывал на дефолт движка
            // (почти всегда женский), и все роли звучали одним голосом. Сам же
            // сервис RHVoice принимает точное имя и через setVoice(), и через
            // параметр "voiceName" в speak() — поэтому Voice создаётся руками
            // и выбор пользователя больше не теряется.
            if (isRhVoice && presetVoice.isNotBlank() && speakerSlot == 0 &&
                (chosen == null || chosen.name != presetVoice)
            ) {
                chosen = runCatching {
                    android.speech.tts.Voice(
                        presetVoice,
                        Locale("ru", "RU"),
                        android.speech.tts.Voice.QUALITY_NORMAL,
                        0,
                        false,
                        null,
                    )
                }.getOrNull() ?: chosen
            }
            val v = chosen
            val forcedVoiceName = when {
                isRhVoice && presetVoice.isNotBlank() && speakerSlot == 0 -> presetVoice
                isRhVoice -> v?.name
                else -> null
            }
            if (v != null) {
                val res = engine.setVoice(v)
                if (res != TextToSpeech.SUCCESS) {
                    // Some OEM clients reject a manually-created RHVoice Voice
                    // before the engine sees it. speak() below also sends the
                    // exact name in KEY_PARAM_VOICE_NAME, bypassing that bug.
                    logcat(LogPriority.WARN) { "Voice ${v.name} rejected by TextToSpeech client" }
                    engine.language = Locale("ru", "RU")
                }
            } else {
                engine.language = Locale("ru", "RU")
            }
            val voiceParams = forcedVoiceName?.let { name ->
                android.os.Bundle().apply {
                    // Hidden Android framework key used internally by
                    // TextToSpeech.setVoice(); literal keeps public-SDK builds.
                    putString("voiceName", name)
                }
            }
            // Пунктуация → реальные паузы и интонация: текст режется на
            // предложения, каждое говорится отдельной utterance, между ними
            // тишина (250мс после точки, 420мс после !/?, 160мс после запятой).
            // Вопросительные получают лёгкий подъём питча, восклицательные —
            // чуть быстрее и выше.
            // Ударения для локальных голосов: RHVoice понимает «+» после
            // ударного гласного; прочие движки получают исходный текст.
            val spokenText = if (isRhVoice && prefs().ruStress().get() == "on") {
                RuStress.mark(text)
            } else {
                text
            }
            val sentences = splitSentences(spokenText)
            if (sentences.isEmpty()) { setSpeaking(false); return@ensureSystem }
            val lastId = "yk_${sentences.size - 1}"
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    if (utteranceId == "yk_0") setSpeaking(true)
                }
                override fun onDone(utteranceId: String?) {
                    if (utteranceId == lastId) setSpeaking(false)
                }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) = setSpeaking(false)
                override fun onError(utteranceId: String?, errorCode: Int) = setSpeaking(false)
            })
            val baseRate = (p.speechRate().get() * presetAge.rate).coerceIn(0.5f, 2f)
            // Тон по полу: если для пола не нашлось ОТДЕЛЬНОГО голоса,
            // различаем персонажей питчем — мужчины ниже, женщины выше.
            // С отдельными голосами модификатор не нужен (=1.0).
            val voiceMatchesGender = v != null && when (gender) {
                "male" -> VoiceHelper.classify(v) == VoiceKind.MALE
                "female" -> VoiceHelper.classify(v) == VoiceKind.FEMALE
                else -> true
            }
            val genderPitchMod = when {
                voiceMatchesGender -> 1.0f
                gender == "male" -> 0.78f
                gender == "female" -> 1.18f
                else -> 1.0f
            }
            val basePitch = (p.speechPitch().get() * genderPitchMod *
                presetGender.pitch * presetAge.pitch).coerceIn(0.5f, 2f)
            var queued = false
            sentences.forEachIndexed { i, sentence ->
                val trimmed = sentence.trim()
                if (trimmed.isEmpty()) return@forEachIndexed
                when {
                    trimmed.endsWith("?") || trimmed.endsWith("?!") || trimmed.endsWith("⁇") -> {
                        engine.setPitch((basePitch * 1.12f).coerceAtMost(2f))
                        engine.setSpeechRate(baseRate * 0.95f)
                    }
                    trimmed.endsWith("!") || trimmed.endsWith("‼") -> {
                        engine.setPitch((basePitch * 1.07f).coerceAtMost(2f))
                        engine.setSpeechRate((baseRate * 1.05f).coerceAtMost(2f))
                    }
                    else -> {
                        engine.setPitch(basePitch)
                        engine.setSpeechRate(baseRate)
                    }
                }
                val mode = if (queued) TextToSpeech.QUEUE_ADD else TextToSpeech.QUEUE_FLUSH
                val r = try {
                    engine.speak(trimmed, mode, voiceParams, "yk_$i")
                } catch (e: Exception) {
                    logcat(LogPriority.WARN, e) { "speak() rejected an utterance" }
                    TextToSpeech.ERROR
                }
                if (r == TextToSpeech.SUCCESS) queued = true
                val pauseMs = when {
                    trimmed.endsWith("!") || trimmed.endsWith("?") ||
                        trimmed.endsWith("‼") || trimmed.endsWith("⁇") -> 420L
                    trimmed.endsWith(",") || trimmed.endsWith(";") -> 160L
                    else -> 260L
                }
                runCatching {
                    engine.playSilentUtterance(pauseMs, TextToSpeech.QUEUE_ADD, "yk_p$i")
                }
            }
            if (!queued) setSpeaking(false)
        }
    }

    // endregion

    /**
     * ПРОБА КОНКРЕТНЫМ системным голосом (кнопка «Проба» в списке голосов).
     * Раньше проба звала speak() с текущими настройками — пользователь жал
     * кнопку у мужского голоса и слышал дефолтный женский: казалось, что
     * «все голоса одинаковые». Здесь имя голоса передаётся напрямую.
     */
    fun speakSystemVoiceTest(context: Context, voiceName: String) {
        stop()
        currentJob = scope.launch {
            setSpeaking(true)
            try {
                withContext(Dispatchers.Main) {
                    ensureSystem(context) { engine ->
                        if (engine == null) {
                            setSpeaking(false)
                            return@ensureSystem
                        }
                        engine.setOnUtteranceProgressListener(
                            object : android.speech.tts.UtteranceProgressListener() {
                                override fun onStart(utteranceId: String?) = setSpeaking(true)
                                override fun onDone(utteranceId: String?) = setSpeaking(false)
                                @Deprecated("Deprecated in Java")
                                override fun onError(utteranceId: String?) = setSpeaking(false)
                                override fun onError(utteranceId: String?, errorCode: Int) = setSpeaking(false)
                            },
                        )
                        engine.setSpeechRate(prefs().speechRate().get().coerceIn(0.5f, 2f))
                        val known = runCatching { engine.voices?.firstOrNull { it.name == voiceName } }.getOrNull()
                        if (known != null) engine.setVoice(known)
                        val params = android.os.Bundle().apply { putString("voiceName", voiceName) }
                        val r = runCatching {
                            engine.speak(
                                "Привет! Это тест голоса $voiceName.",
                                TextToSpeech.QUEUE_FLUSH,
                                params,
                                "yk_vtest",
                            )
                        }.getOrDefault(TextToSpeech.ERROR)
                        if (r != TextToSpeech.SUCCESS) setSpeaking(false)
                    }
                }
            } catch (e: Exception) {
                logcat(LogPriority.WARN, e) { "voice test failed" }
                setSpeaking(false)
            }
        }
    }

    // region REMOTE (нейроголоса на сервере ПК/ранера)

    /**
     * УДАЛЁННЫЙ НЕЙРОГОЛОС: sherpa-onnx/Piper больше не живёт в APK (R8, ABI и
     * память устройства ломали синтез). Синтез крутится на ПК пользователя или
     * сервере (tools/remote_tts_server.py): приложение шлёт предложение и
     * проигрывает готовый wav. Нет адреса или сервер молчит — дочитываем
     * системным голосом (принцип AlReader: текст всегда озвучен).
     */
    private fun speakRemote(context: Context, text: String, gender: String?) {
        val p = prefs()
        currentJob = scope.launch {
            setSpeaking(true)
            val url = p.remoteTtsUrl().get().trim()
            val sentences = splitSentences(text)
            if (url.isBlank()) {
                withContext(Dispatchers.Main) { speakSystem(context, text, gender) }
                return@launch
            }
            var doneUpTo = 0
            var failed = false
            try {
                for (sentence in sentences) {
                    if (currentJob?.isActive != true) break
                    val trimmed = sentence.trim()
                    val wav = synthesizeRemote(context, url, trimmed, gender)
                    if (wav == null) {
                        failed = true
                        break
                    }
                    playFileBlocking(wav)
                    doneUpTo++
                    kotlinx.coroutines.delay(180L)
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                setSpeaking(false)
                throw e
            } catch (e: Exception) {
                logcat(LogPriority.WARN, e) { "remote TTS failed" }
                failed = true
            }
            if (failed && doneUpTo < sentences.size && currentJob?.isActive == true) {
                val rest = sentences.subList(doneUpTo, sentences.size).joinToString(" ")
                logcat(LogPriority.WARN) { "remote TTS fallback to system from sentence $doneUpTo" }
                withContext(Dispatchers.Main) { speakSystem(context, rest, gender) }
            } else {
                setSpeaking(false)
            }
        }
    }

    /** POST {text, voice, speed} на /tts сервера; ответ — wav-байты. */
    private suspend fun synthesizeRemote(
        context: Context,
        url: String,
        text: String,
        gender: String?,
    ): File? = withContext(Dispatchers.IO) {
        runCatching {
            val conn = java.net.URL(url.trimEnd('/') + "/tts").openConnection()
                as java.net.HttpURLConnection
            conn.connectTimeout = 5_000
            conn.readTimeout = 90_000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            val speed = prefs().speechRate().get().coerceIn(0.5f, 2f)
            val body = "{\"text\":${jsonQuote(text)},\"voice\":${jsonQuote(gender ?: "auto")},\"speed\":$speed}"
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            if (conn.responseCode != 200) {
                logcat(LogPriority.WARN) { "remote TTS HTTP ${conn.responseCode}" }
                return@runCatching null
            }
            val dir = File(context.cacheDir, "remote_tts").apply { mkdirs() }
            val f = File(dir, "seg_${System.currentTimeMillis()}.wav")
            conn.inputStream.use { input -> f.outputStream().use { input.copyTo(it) } }
            if (f.length() < 1024) {
                f.delete()
                null
            } else {
                f
            }
        }.getOrNull()
    }

    // endregion

    // region GOOGLE WEB (без API-ключа)

    private fun speakGoogleWeb(context: Context, text: String) {
        val lang = prefs().ttsWebLanguage().get().ifBlank { "ru" }
        currentJob = scope.launch {
            setSpeaking(true)
            try {
                // Endpoint сайта Google Translate ограничен ~200 симв. — бьём на куски
                val chunks = splitForWeb(text, 180)
                for (chunk in chunks) {
                    if (currentJob?.isActive != true) break
                    val url = "https://translate.google.com/translate_tts" +
                        "?ie=UTF-8&client=tw-ob&tl=" + lang +
                        "&q=" + URLEncoder.encode(chunk, "UTF-8")
                    val file = downloadToCache(context, url) ?: continue
                    playFileBlocking(file)
                }
            } catch (e: Exception) {
                logcat(LogPriority.WARN, e) { "Google Web TTS failed" }
            } finally {
                setSpeaking(false)
            }
        }
    }

    // endregion

    // region ELEVENLABS (API-ключ)

    private fun speakElevenLabs(context: Context, text: String) {
        val p = prefs()
        val apiKey = p.elevenApiKey().get()
        if (apiKey.isBlank()) {
            // Ключа нет — честный фолбэк на бесплатную веб-озвучку
            speakGoogleWeb(context, text)
            return
        }
        val voiceId = p.elevenVoiceId().get().ifBlank { "21m00Tcm4TlvDq8ikWAM" }
        currentJob = scope.launch {
            setSpeaking(true)
            try {
                val conn = URL("https://api.elevenlabs.io/v1/text-to-speech/$voiceId")
                    .openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 20_000
                conn.readTimeout = 60_000
                conn.setRequestProperty("xi-api-key", apiKey)
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Accept", "audio/mpeg")
                val body = """{"text":${jsonQuote(text)},"model_id":"eleven_multilingual_v2"}"""
                conn.outputStream.use { it.write(body.toByteArray()) }
                if (conn.responseCode in 200..299) {
                    val file = File(context.cacheDir, "tts_eleven.mp3")
                    conn.inputStream.use { input -> file.outputStream().use { input.copyTo(it) } }
                    playFileBlocking(file)
                } else {
                    logcat(LogPriority.WARN) { "ElevenLabs HTTP ${conn.responseCode}" }
                    speakGoogleWebInline(context, text)
                }
                conn.disconnect()
            } catch (e: Exception) {
                logcat(LogPriority.WARN, e) { "ElevenLabs TTS failed" }
                speakGoogleWebInline(context, text)
            } finally {
                setSpeaking(false)
            }
        }
    }

    /** Фолбэк внутри уже запущенной корутины. */
    private suspend fun speakGoogleWebInline(context: Context, text: String) {
        val lang = prefs().ttsWebLanguage().get().ifBlank { "ru" }
        for (chunk in splitForWeb(text, 180)) {
            val url = "https://translate.google.com/translate_tts" +
                "?ie=UTF-8&client=tw-ob&tl=" + lang +
                "&q=" + URLEncoder.encode(chunk, "UTF-8")
            val file = downloadToCache(context, url) ?: continue
            playFileBlocking(file)
        }
    }

    // endregion

    // region helpers

    /**
     * Реальный список голосов аккаунта ElevenLabs (GET /v1/voices по ключу).
     * Возвращает пары (voice_id, имя + категория). Пустой список при ошибке
     * или отсутствии ключа — никаких фейковых данных.
     */
    suspend fun fetchElevenVoices(apiKey: String): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        if (apiKey.isBlank()) return@withContext emptyList()
        runCatching {
            val conn = URL("https://api.elevenlabs.io/v1/voices").openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("xi-api-key", apiKey)
            if (conn.responseCode !in 200..299) {
                logcat(LogPriority.WARN) { "ElevenLabs voices HTTP ${conn.responseCode}" }
                conn.disconnect()
                return@runCatching emptyList()
            }
            val body = conn.inputStream.bufferedReader().readText()
            conn.disconnect()
            val arr = org.json.JSONObject(body).optJSONArray("voices") ?: return@runCatching emptyList()
            buildList {
                for (i in 0 until arr.length()) {
                    val v = arr.optJSONObject(i) ?: continue
                    val id = v.optString("voice_id")
                    if (id.isBlank()) continue
                    val name = v.optString("name").ifBlank { id }
                    val labels = v.optJSONObject("labels")
                    val extra = buildList {
                        labels?.optString("gender")?.takeIf { it.isNotBlank() }?.let(::add)
                        labels?.optString("accent")?.takeIf { it.isNotBlank() }?.let(::add)
                        v.optString("category").takeIf { it.isNotBlank() }?.let(::add)
                    }.joinToString(", ")
                    add(id to if (extra.isBlank()) name else "$name ($extra)")
                }
            }
        }.getOrElse {
            logcat(LogPriority.WARN, it) { "ElevenLabs voices fetch failed" }
            emptyList()
        }
    }

    private fun jsonQuote(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> sb.append(c)
            }
        }
        return sb.append('"').toString()
    }

    /** Делит текст на предложения по .!?…; куски без знаков — по 200 симв. */
    fun splitSentences(text: String): List<String> {
        val result = mutableListOf<String>()
        val sb = StringBuilder()
        for (ch in text) {
            sb.append(ch)
            if (ch == '.' || ch == '!' || ch == '?' || ch == '…' || ch == '‼' || ch == '⁇') {
                if (sb.isNotBlank()) result += sb.toString()
                sb.clear()
            } else if (sb.length >= 200 && ch == ' ') {
                result += sb.toString()
                sb.clear()
            }
        }
        if (sb.isNotBlank()) result += sb.toString()

        // Страховка: TextToSpeech.speak() бросает IllegalArgumentException,
        // если строка длиннее getMaxSpeechInputLength() (обычно 4000).
        // Текст без знаков препинания и без пробелов не резался ничем выше.
        return result.flatMap { it.chunked(HARD_UTTERANCE_LIMIT) }
    }

    private fun splitForWeb(text: String, max: Int): List<String> {
        if (text.length <= max) return listOf(text)
        val parts = mutableListOf<String>()
        var rest = text.trim()
        while (rest.isNotEmpty()) {
            if (rest.length <= max) { parts += rest; break }
            var cut = rest.lastIndexOfAny(charArrayOf('.', '!', '?', '…', ';'), max)
            if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
            if (cut < max / 2) cut = max
            parts += rest.substring(0, cut + 1).trim()
            rest = rest.substring(cut + 1).trim()
        }
        return parts.filter { it.isNotBlank() }
    }

    private fun downloadToCache(context: Context, url: String): File? {
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            // Без браузерного UA endpoint отдаёт 403
            conn.setRequestProperty(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
            )
            if (conn.responseCode !in 200..299) {
                conn.disconnect()
                return null
            }
            val file = File(context.cacheDir, "tts_web_${System.nanoTime()}.mp3")
            conn.inputStream.use { input -> file.outputStream().use { input.copyTo(it) } }
            conn.disconnect()
            file
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "TTS download failed" }
            null
        }
    }

    private suspend fun playFileBlocking(file: File) {
        withContext(Dispatchers.IO) {
            suspendCancellableCoroutine { cont ->
                val mp = MediaPlayer()
                mediaPlayer = mp
                try {
                    mp.setDataSource(file.absolutePath)
                    mp.setOnCompletionListener {
                        runCatching { mp.release() }
                        file.delete()
                        if (cont.isActive) cont.resume(Unit)
                    }
                    mp.setOnErrorListener { _, _, _ ->
                        runCatching { mp.release() }
                        file.delete()
                        if (cont.isActive) cont.resume(Unit)
                        true
                    }
                    mp.prepare()
                    mp.start()
                    cont.invokeOnCancellation {
                        runCatching { mp.stop(); mp.release() }
                        file.delete()
                    }
                } catch (e: Exception) {
                    runCatching { mp.release() }
                    file.delete()
                    if (cont.isActive) cont.resume(Unit)
                }
            }
        }
    }

    // endregion
}
