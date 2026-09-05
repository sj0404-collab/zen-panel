package eu.kanade.tachiyomi.data.voice

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.speech.tts.TextToSpeech
import eu.kanade.tachiyomi.data.tts.TtsSpeaker
import eu.kanade.tachiyomi.data.tts.VoiceHelper
import eu.kanade.tachiyomi.data.tts.VoiceKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import logcat.LogPriority
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.core.common.util.system.logcat

/**
 * Тип голосового бэкенда. Совпадает со значениями `pref_voice_engine`
 * ("system_tts", "google_web", "eleven_api") и расширяется локальными
 * нейросетевыми движками, которые раньше выбирались отдельными настройками.
 */
/**
 * Id совпадают с константами [TtsSpeaker], потому что именно эти строки
 * сохраняются в `pref_voice_engine` и именно по ним [TtsSpeaker.speakAs]
 * выбирает, чем озвучивать реплику.
 *
 * Раньше ONNX был объявлен как `"onnx"`, а весь UI писал `"onnx_tts"`. Из-за
 * этого расхождения реестр считал выбранным системный TTS, а выбор ONNX в
 * настройках плагинов сохранял значение, которое маршрутизатор озвучки не
 * знал, — реплика молча уходила в системный голос.
 */
enum class VoiceBackend(val id: String) {
    /** Системные и сторонние Android TTS-движки. */
    SYSTEM_TTS(TtsSpeaker.ENGINE_SYSTEM),

    /** Веб-озвучка Google Translate: без ключа, но нужен интернет. */
    GOOGLE_WEB(TtsSpeaker.ENGINE_GOOGLE_WEB),

    /** ElevenLabs по API-ключу. */
    ELEVEN_API(TtsSpeaker.ENGINE_ELEVENLABS),

    /** Нейроголоса на сервере пользователя (ПК/ранер): sherpa-onnx + Piper. */
    REMOTE_TTS(TtsSpeaker.ENGINE_REMOTE),
    ;

    companion object {
        /** Значения из сборок, где ONNX ещё был объявлен как `onnx`. */
        private val LEGACY_IDS = mapOf(
            "onnx" to REMOTE_TTS,
            "onnx_tts" to REMOTE_TTS,
        )

        /**
         * Точное распознавание id, включая legacy-написания. `null`, если
         * значение не соответствует ни одному движку — в отличие от [fromId]
         * здесь нет молчаливого отката, поэтому `byId()` не обязан выдавать
         * системный плагин на любой мусор.
         */
        fun matchOrNull(id: String?): VoiceBackend? {
            val key = id?.trim().orEmpty()
            if (key.isEmpty()) return null
            return entries.firstOrNull { it.id == key } ?: LEGACY_IDS[key]
        }

        fun fromId(id: String?): VoiceBackend = matchOrNull(id) ?: SYSTEM_TTS
    }
}

/** Что нужно движку, чтобы озвучить реплику. */
enum class VoiceRequirement {
    /** Нужен интернет. */
    NETWORK,

    /** Нужен API-ключ. */
    API_KEY,

    /** Нужен установленный в системе Android TTS-движок. */
    SYSTEM_ENGINE,

    /** Нужно скачать модель голоса. */
    MODEL_DOWNLOAD,

    /** Нужна нативная библиотека, которой может не быть в сборке. */
    NATIVE_LIBRARY,

    /** Нужен адрес локального сервера озвучки (ПК/ранер). */
    SERVER_ADDRESS,
}

/**
 * Описание одного голосового движка как плагина.
 *
 * Как и [eu.kanade.tachiyomi.data.ai.AiPlugins], это декларативный реестр: он
 * ничего не озвучивает сам. Реальные вызовы остаются в `TtsSpeaker` и
 * `VoiceHelper`, а реестр даёт настройкам единый список движков с
 * понятными требованиями и списком голосов.
 */
data class VoicePluginDescriptor(
    val id: String,
    val backend: VoiceBackend,
    val title: String,
    val summary: String,
    val requirements: Set<VoiceRequirement> = emptySet(),
    /** Движок умеет разводить реплики по полу говорящего. */
    val supportsGender: Boolean = false,
    /** Движок умеет несколько разных голосов одновременно. */
    val supportsMultipleVoices: Boolean = false,
    /** Движок работает без сети. */
    val offline: Boolean = true,
)

/**
 * Реестр голосовых плагинов и один голос внутри них.
 *
 * [voices] намеренно функция, а не поле: список системных голосов зависит от
 * устройства и меняется во время работы приложения.
 */
/** голоса серверного синтеза: те же Piper-модели, что раньше качались в APK. */
private val REMOTE_VOICE_CATALOG = listOf(
    Triple("irina", "Ирина (женский, мягкий)", "female"),
    Triple("dmitri", "Дмитрий (мужской)", "male"),
    Triple("ruslan", "Руслан (мужской, низкий)", "male"),
)

object VoicePlugins {

    /** id серверных голосов — для настроек и контрактов (тесты). */
    val REMOTE_VOICE_CATALOG_IDS = REMOTE_VOICE_CATALOG.map { it.first }


    /** Один конкретный голос внутри движка. */
    data class Voice(
        val id: String,
        val name: String,
        /** female | male | neutral. */
        val gender: String,
        /** Язык в теге BCP-47, если движок его знает. */
        val language: String? = null,
        /** Размер модели в МБ, если голос нужно скачивать. */
        val sizeMb: Int = 0,
        /**
         * Готов ли голос к работе прямо сейчас. Для ONNX это реальная проверка
         * распакованной модели на диске, поэтому список не обещает голосов,
         * которых на устройстве нет.
         */
        val installed: Boolean = true,
    )

    val SYSTEM_TTS = VoicePluginDescriptor(
        id = VoiceBackend.SYSTEM_TTS.id,
        backend = VoiceBackend.SYSTEM_TTS,
        title = "Системный TTS",
        summary = "Голоса установленных Android-движков (Google, RHVoice, Acapela и любые другие).",
        requirements = setOf(VoiceRequirement.SYSTEM_ENGINE),
        supportsGender = true,
        supportsMultipleVoices = true,
    )

    val GOOGLE_WEB = VoicePluginDescriptor(
        id = VoiceBackend.GOOGLE_WEB.id,
        backend = VoiceBackend.GOOGLE_WEB,
        title = "Google Web (без ключа)",
        summary = "Веб-озвучка Google Translate: работает без API-ключа, но требует интернет.",
        requirements = setOf(VoiceRequirement.NETWORK),
        offline = false,
    )

    val ELEVEN_API = VoicePluginDescriptor(
        id = VoiceBackend.ELEVEN_API.id,
        backend = VoiceBackend.ELEVEN_API,
        title = "ElevenLabs",
        summary = "Нейросетевая озвучка по API-ключу ElevenLabs.",
        requirements = setOf(VoiceRequirement.NETWORK, VoiceRequirement.API_KEY),
        supportsMultipleVoices = true,
        offline = false,
    )

    val REMOTE_TTS = VoicePluginDescriptor(
        id = VoiceBackend.REMOTE_TTS.id,
        backend = VoiceBackend.REMOTE_TTS,
        title = "TTS-сервер (ПК/ранер)",
        summary = "sherpa-onnx и русские Piper-голоса на вашей машине: приложение шлёт текст и проигрывает wav.",
        requirements = setOf(VoiceRequirement.SERVER_ADDRESS),
        supportsGender = true,
        supportsMultipleVoices = true,
        offline = false,
    )

    val ALL = listOf(SYSTEM_TTS, GOOGLE_WEB, ELEVEN_API, REMOTE_TTS)

    private val BY_ID = ALL.associateBy { it.id }

    /**
     * Поиск плагина по сохранённому значению `pref_voice_engine`. Проходит
     * через [VoiceBackend.matchOrNull], поэтому legacy-запись `"onnx"` из
     * старых сборок находит тот же плагин, что и `"onnx_tts"`.
     */
    fun byId(id: String?): VoicePluginDescriptor? =
        VoiceBackend.matchOrNull(id)?.let { backend -> BY_ID[backend.id] }

    fun byBackend(backend: VoiceBackend): VoicePluginDescriptor? =
        ALL.firstOrNull { it.backend == backend }

    /** Движки, готовые к работе прямо сейчас. */
    fun available(
        networkAvailable: Boolean,
        systemEnginePresent: Boolean,
        hasApiKey: (VoicePluginDescriptor) -> Boolean = { false },
        nativeLibraryPresent: (VoicePluginDescriptor) -> Boolean = { true },
        modelsDownloaded: (VoicePluginDescriptor) -> Boolean = { false },
        hasServerAddress: (VoicePluginDescriptor) -> Boolean = { false },
    ): List<VoicePluginDescriptor> = ALL.filter { plugin ->
        plugin.requirements.all { requirement ->
            when (requirement) {
                VoiceRequirement.NETWORK -> networkAvailable
                VoiceRequirement.API_KEY -> hasApiKey(plugin)
                VoiceRequirement.SYSTEM_ENGINE -> systemEnginePresent
                VoiceRequirement.MODEL_DOWNLOAD -> modelsDownloaded(plugin)
                VoiceRequirement.NATIVE_LIBRARY -> nativeLibraryPresent(plugin)
                VoiceRequirement.SERVER_ADDRESS -> hasServerAddress(plugin)
            }
        }
    }

    /**
     * Голоса движка: системные берутся из настроек, серверные — из
     * каталога Piper-голосов ранера/ПК.
     */
    fun voices(context: Context, plugin: VoicePluginDescriptor, prefs: OcrPreferences): List<Voice> =
        when (plugin.backend) {
            VoiceBackend.REMOTE_TTS -> REMOTE_VOICE_CATALOG.map { voice ->
                Voice(
                    id = voice.first,
                    name = voice.second,
                    gender = voice.third,
                    language = "ru-RU",
                    installed = true,
                )
            }

            VoiceBackend.SYSTEM_TTS -> systemVoiceSources(prefs)

            VoiceBackend.ELEVEN_API -> listOfNotNull(
                prefs.elevenVoiceId().get().takeIf(String::isNotBlank)?.let {
                    Voice(id = it, name = "Голос ElevenLabs", gender = "neutral")
                },
            )

            VoiceBackend.GOOGLE_WEB -> listOf(
                Voice(
                    id = prefs.ttsWebLanguage().get().ifBlank { "ru" },
                    name = "Веб-голос ${prefs.ttsWebLanguage().get().ifBlank { "ru" }}",
                    gender = "neutral",
                ),
            )
        }

    /**
     * Текущий движок из настроек. Неизвестное или пустое значение читается как
     * системный TTS — так же, как это уже делает `pref_voice_engine`.
     */
    fun current(prefs: OcrPreferences): VoicePluginDescriptor =
        byId(prefs.voiceEngine().get()) ?: SYSTEM_TTS

    /**
     * Сохранённые пресеты голосов. Список намеренно короткий: полный перечень
     * голосов устройства требует живой `TextToSpeech` (см. [systemVoices]), а
     * реестр вызывается прямо из Compose и не должен блокировать UI.
     */
    fun systemVoiceSources(prefs: OcrPreferences): List<Voice> = listOfNotNull(
        prefs.voiceFemale().get().takeIf(String::isNotBlank)?.let {
            Voice(id = it, name = "Женский пресет", gender = "female")
        },
        prefs.voiceMale().get().takeIf(String::isNotBlank)?.let {
            Voice(id = it, name = "Мужской пресет", gender = "male")
        },
        prefs.voiceName().get().takeIf(String::isNotBlank)?.let {
            Voice(id = it, name = "Выбранный голос", gender = "neutral")
        },
    ).distinctBy { it.id }

    /**
     * Все Android TTS-движки устройства: пакет → имя. Пустой id — «движок по
     * умолчанию системы».
     *
     * Это и есть «голоса из APK»: любой установленный сторонний TTS-движок
     * является отдельным приложением и виден здесь. Список идёт в
     * `pref_system_tts_engine`, а не в `pref_voice_name`: движок и голос внутри
     * движка — разные настройки, и их смешение ломало бы выбор голоса.
     *
     * Здесь намеренно НЕ используется `TtsSpeaker.installedEngines()`: вторая
     * половина того метода до трёх секунд ждёт `onInit` на `CountDownLatch`, а
     * реестр вызывается из Compose. `queryIntentServices` отдаёт тот же список
     * пакетов мгновенно и без инициализации движка.
     */
    fun systemEngineOptions(
        context: Context,
        prefs: OcrPreferences,
        defaultLabel: String,
    ): List<Pair<String, String>> {
        val engines = installedSystemEngines(context)
        val selected = runCatching { prefs.systemTtsEngine().get().trim() }.getOrDefault("")
        val fallback = selected
            .takeIf { it.isNotBlank() && engines.none { (pkg, _) -> pkg == selected } }
            ?.let { pkg -> listOf(pkg to "Выбранный движок ($pkg)") }
            .orEmpty()
        return listOf("" to defaultLabel) + engines + fallback
    }

    /**
     * Android TTS-движки, установленные в системе: пакет → человекочитаемое имя.
     */
    fun installedSystemEngines(context: Context): List<Pair<String, String>> {
        val app = context.applicationContext
        return runCatching {
            val pm = app.packageManager
            val intent = Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE)
            val services = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.queryIntentServices(intent, PackageManager.ResolveInfoFlags.of(0L))
            } else {
                @Suppress("DEPRECATION")
                pm.queryIntentServices(intent, 0)
            }
            val found = LinkedHashMap<String, String>()
            services.forEach { info ->
                val pkg = info.serviceInfo?.packageName ?: return@forEach
                val label = runCatching { info.serviceInfo.loadLabel(pm).toString() }
                    .getOrNull()
                    ?.takeIf { it.isNotBlank() }
                    ?: pkg
                found.putIfAbsent(pkg, label)
            }
            found.toList()
        }.onFailure { error ->
            logcat(LogPriority.WARN, error) { "Не удалось перечислить системные TTS-движки" }
        }.getOrDefault(emptyList())
    }

    /**
     * Голоса конкретного системного движка по языку. Тяжёлая операция: нужен
     * живой `TextToSpeech`, поэтому вызывается из корутины, а не из Compose.
     */
    suspend fun systemVoices(
        context: Context,
        enginePackage: String?,
        language: String,
    ): List<Voice> = withContext(Dispatchers.IO) {
        val tts = runCatching {
            TextToSpeech(
                context.applicationContext,
                {},
                enginePackage?.takeIf { it.isNotBlank() },
            )
        }.getOrNull() ?: return@withContext emptyList()
        try {
            VoiceHelper.prepareForLanguage(tts, language)
            VoiceHelper.voicesFor(tts, language, enginePackage).map { voice ->
                Voice(
                    id = voice.name,
                    name = voice.name,
                    gender = when (VoiceHelper.classify(voice)) {
                        VoiceKind.FEMALE -> "female"
                        VoiceKind.MALE -> "male"
                        else -> "neutral"
                    },
                    language = runCatching { voice.locale.toLanguageTag() }.getOrNull(),
                    installed = true,
                )
            }
        } finally {
            runCatching { tts.shutdown() }
        }
    }
}
