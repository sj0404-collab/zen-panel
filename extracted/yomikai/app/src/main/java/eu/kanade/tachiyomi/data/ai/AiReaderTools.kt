package eu.kanade.tachiyomi.data.ai

import android.content.Context
import eu.kanade.tachiyomi.data.voice.VoiceBackend
import eu.kanade.tachiyomi.data.voice.VoicePlugins
import eu.kanade.tachiyomi.ui.reader.setting.ReaderPreferences
import eu.kanade.tachiyomi.ui.reader.setting.ReadingMode
import mihon.data.ocr.ContentAutoPreset
import mihon.data.ocr.OcrContentType
import mihon.data.ocr.ReaderContextBus
import mihon.data.ocr.OcrPluginAvailability
import mihon.data.ocr.OcrPlugins
import mihon.data.ocr.OcrRegionRules
import mihon.domain.ocr.service.OcrPreferences
import mihon.domain.ocr.service.ScanRegion
import tachiyomi.core.common.util.system.isNetworkAvailable
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * СВЯЗЬ AI-ЧАТА С МОДУЛЬНОЙ СИСТЕМОЙ: инструменты агента, которые видят
 * текущие настройки распознавания и озвучки и умеют переключать пресет типа
 * контента (манга / манхва / комикс).
 *
 * Принцип тот же, что у реестров `OcrPlugins`, `VoicePlugins` и `AiBackends`:
 * инструмент ничего не знает о внутренностях движка, он читает реестр и
 * настройки. Поэтому ответ агента не может разойтись с тем, что пользователь
 * видит в настройках, — источник данных один.
 *
 * Инструменты намеренно НЕ меняют ничего, кроме пресета типа контента и его
 * области: точная подстройка, выбор движка и ключи остаются за пользователем.
 */
object AiReaderTools {

    const val TOOL_READER_STATUS = "reader_status"
    const val TOOL_OCR_PRESET = "ocr_preset"
    const val TOOL_PLUGINS_LIST = "plugins_list"
    const val TOOL_TTS_STATUS = "tts_status"

    val TOOL_NAMES = listOf(
        TOOL_READER_STATUS,
        TOOL_OCR_PRESET,
        TOOL_PLUGINS_LIST,
        TOOL_TTS_STATUS,
    )

    /** Документация инструментов для системного промпта агента. */
    val SYSTEM_PROMPT_LINES = listOf(
        "@tool reader_status {} — текущие настройки читалки: пресет типа контента, " +
            "область сканирования, порядок чтения, движки OCR и озвучки, что из них доступно",
        "@tool ocr_preset {\"id\":\"manga|manhwa|comic|balanced\"} — применить пресет типа " +
            "контента (меняет параметры детектора, область и порядок чтения)",
        "@tool plugins_list {} — реестры плагинов: OCR-движки, голосовые движки и бэкенды AI-чата " +
            "с требованиями и доступностью",
        "@tool tts_status {} — озвучка: выбранный движок и голоса, установленные системные " +
            "TTS-движки, адрес сервера синтеза и последняя ошибка, хвост logs/tts.log",
    )

    /**
     * Что сейчас настроено и что реально доступно. Текст уходит модели как
     * результат инструмента, поэтому он плотный и без разметки.
     */
    fun readerStatus(context: Context, prefs: OcrPreferences = Injekt.get()): String {
        val online = isNetworkAvailable(context)
        val profile = OcrRegionRules.profileOf(prefs)
        val tuning = profile.tuning()
        val ocrAvailable = ocrAvailableIds(context, prefs, online)
        val plugin = OcrPlugins.byModel(prefs.ocrModel().get())
        val chain = OcrPlugins.fallbackChain(
            primary = plugin,
            preset = prefs.fallbackPreset().get(),
            networkAvailable = online,
        )
        val voicePlugin = VoicePlugins.current(prefs)
        val voiceAvailable = voiceAvailableIds(context, prefs, online)
        val backend = AiBackends.byId(prefs.aiBackend().get())
        val backendStatus = AiBackends.statusOf(backend, AiBackends.state(context, prefs), prefs.aiProvider().get())

        return buildString {
            appendLine("Сеть: ${if (online) "есть" else "нет"}")
            appendLine()
            appendLine("РАСПОЗНАВАНИЕ")
            appendLine("Пресет типа контента: ${profile.contentType.id} (${profile.contentType.title})")
            appendLine("Область сканирования: ${OcrRegionRules.regionTitle(profile.scanRegion)}")
            appendLine("Порядок чтения: ${OcrRegionRules.orderTitle(tuning.readingOrder)}")
            appendLine("Режим чтения по пресету: ${profile.contentType.viewer.title}")
            appendLine(
                "Точная подстройка: " +
                    if (profile.overrides.isEmpty) "не задана, все параметры из пресета"
                    else profile.overrides.toString(),
            )
            appendLine(
                "Параметры детектора: порог=${tuning.detectorThreshold}, " +
                    "мин. площадь=${tuning.minComponentArea}, макс. блоков=${tuning.maxTextBoxes}, " +
                    "зазор слов=${tuning.wordGapFactor}, мин. уверенность=${tuning.minAcceptConfidence}, " +
                    "покрытие=${tuning.minCoverage}",
            )
            appendLine("Движок: ${plugin.title} (${if (plugin.id in ocrAvailable) "доступен" else "НЕДОСТУПЕН"})")
            appendLine(
                "Цепочка фолбэков (${prefs.fallbackPreset().get()}): " +
                    if (chain.isEmpty()) "пусто" else chain.joinToString(" -> ") { it.title },
            )
            appendLine("Доступные движки: ${ocrAvailable.sorted().joinToString(", ").ifBlank { "нет" }}")
            appendLine()
            appendLine("ОЗВУЧКА")
            appendLine("Движок: ${voicePlugin.title} (${if (voicePlugin.id in voiceAvailable) "готов" else "НЕ готов"})")
            appendLine("Голос: ${prefs.voiceName().get().ifBlank { "по умолчанию" }}")
            appendLine("Доступные движки: ${voiceAvailable.sorted().joinToString(", ").ifBlank { "нет" }}")
            appendLine()
            appendLine("AI-ЧАТ")
            appendLine("Бэкенд: ${backend.title} (${if (backendStatus.available) "готов" else "не готов"})")
            appendLine(backendStatus.detail)
            if (backendStatus.missing.isNotEmpty()) {
                appendLine("Не хватает: ${backendStatus.missing.joinToString(", ") { it.name }}")
            }
            appendLine("Плагинов разработчика: ${AiPlugins.list(context).size}")
        }.trim()
    }

    /**
     * Применение пресета типа контента. Возвращает текст ответа для агента.
     *
     * `balanced` разрешён явно: это пресет прежнего поведения, и его выбор
     * ничего не ломает (значения побайтово равны старым константам движка).
     */
    fun applyPreset(
        context: Context,
        id: String?,
        prefs: OcrPreferences = Injekt.get(),
    ): String {
        val requested = id?.trim()?.lowercase().orEmpty()
        if (requested.isBlank()) {
            return "ОШИБКА: укажите id пресета. Доступны: " +
                OcrContentType.entries.joinToString(", ") { "${it.id} (${it.title})" }
        }
        val contentType = OcrContentType.entries.firstOrNull { it.id == requested }
            ?: return "ОШИБКА: пресет «$requested» не найден. Доступны: " +
                OcrContentType.entries.joinToString(", ") { it.id }

        // Меняем ТОЛЬКО тип контента: область (`pref_ocr_preset_region`) и её
        // быстрое переопределение (`pref_scan_region`) принадлежат пользователю,
        // и пресет не имеет права их сбрасывать. Порядок чтения и параметры
        // детектора при этом всё равно следуют за типом контента.
        prefs.contentType().set(contentType.id)
        // Запоминаем выбор агента для текущей манги (память авто-пресета).
        ContentAutoPreset.rememberManual(
            ReaderContextBus.current.value?.mangaId,
            contentType.id,
            prefs,
        )

        // Пресет задаёт и вьюер: порядок чтения OCR и направление листания —
        // одна сущность. BALANCED (KEEP) выбор пользователя не трогает.
        val viewerHint = contentType.viewer
        val readingMode = ReadingMode.fromOcrHint(viewerHint)
        if (readingMode != null) {
            Injekt.get<ReaderPreferences>().defaultReadingMode.set(readingMode.flagValue)
        }

        val profile = OcrRegionRules.profileOf(prefs)
        val tuning = profile.tuning()
        return buildString {
            appendLine("Пресет применён: ${contentType.id} (${contentType.title})")
            appendLine("Область: ${OcrRegionRules.regionTitle(profile.scanRegion)}")
            appendLine("Порядок чтения: ${OcrRegionRules.orderTitle(tuning.readingOrder)}")
            appendLine("Режим чтения: ${viewerHint.title}")
            appendLine(
                "Параметры: порог=${tuning.detectorThreshold}, мин. площадь=${tuning.minComponentArea}, " +
                    "макс. блоков=${tuning.maxTextBoxes}, зазор слов=${tuning.wordGapFactor}, " +
                    "мин. уверенность=${tuning.minAcceptConfidence}, покрытие=${tuning.minCoverage}, " +
                    "спасение строк=${tuning.rescueMaxLines}",
            )
            if (!profile.overrides.isEmpty) {
                appendLine(
                    "ВНИМАНИЕ: задана точная подстройка, она перекрывает пресет: " +
                        profile.overrides,
                )
            }
            append("Новые параметры применяются к следующей странице без перезапуска.")
        }
    }

    /** Все три реестра одним текстом — ответ инструмента `plugins_list`. */
    fun pluginsReport(context: Context, prefs: OcrPreferences = Injekt.get()): String {
        val online = isNetworkAvailable(context)
        val ocrAvailable = ocrAvailableIds(context, prefs, online)
        val voiceAvailable = voiceAvailableIds(context, prefs, online)
        val state = AiBackends.state(context, prefs)
        val provider = prefs.aiProvider().get()
        val selectedOcr = OcrPlugins.byModel(prefs.ocrModel().get()).id
        val selectedVoice = VoicePlugins.current(prefs).id
        val selectedBackend = AiBackends.byId(prefs.aiBackend().get()).id

        return buildString {
            appendLine("OCR-ПЛАГИНЫ (выбран: $selectedOcr)")
            OcrPlugins.ALL.forEach { plugin ->
                appendLine(
                    "- ${plugin.id}: ${plugin.title} | ${if (plugin.online) "онлайн" else "офлайн"} | " +
                        mark(plugin.id in ocrAvailable) +
                        regions(plugin.supportsRegions) +
                        requirements(plugin.requirements.map { it.name }),
                )
            }
            appendLine()
            appendLine("ГОЛОСОВЫЕ ПЛАГИНЫ (выбран: $selectedVoice)")
            VoicePlugins.ALL.forEach { plugin ->
                appendLine(
                    "- ${plugin.id}: ${plugin.title} | ${if (plugin.offline) "офлайн" else "онлайн"} | " +
                        mark(plugin.id in voiceAvailable) +
                        gender(plugin.supportsGender) +
                        requirements(plugin.requirements.map { it.name }),
                )
            }
            appendLine()
            appendLine("БЭКЕНДЫ AI-ЧАТА (выбран: $selectedBackend)")
            AiBackends.ALL.forEach { plugin ->
                val status = AiBackends.statusOf(plugin, state, provider)
                appendLine(
                    "- ${plugin.id}: ${plugin.title} | ${if (plugin.offline) "офлайн" else "онлайн"} | " +
                        mark(status.available) + " | ${status.detail}" +
                        requirements(status.missing.map { it.name }),
                )
            }
            appendLine()
            append("Плагины разработчика (самодельные инструменты): ${AiPlugins.list(context).size}")
        }
    }

    /** Id OCR-плагинов, доступных прямо сейчас. */
    private fun ocrAvailableIds(
        context: Context,
        prefs: OcrPreferences,
        networkAvailable: Boolean,
    ): Set<String> = OcrPluginAvailability.availableIds(
        context = context,
        networkAvailable = networkAvailable,
        hasApiKey = { plugin ->
            when (plugin.id) {
                "openrouter" -> prefs.openrouterApiKey().get().isNotBlank()
                "google_ai" -> prefs.googleApiKey().get().isNotBlank()
                else -> false
            }
        },
        hasServerAddress = { prefs.owocrAddress().get().isNotBlank() },
    )

    /** Id голосовых плагинов, доступных прямо сейчас. */
    private fun voiceAvailableIds(
        context: Context,
        prefs: OcrPreferences,
        networkAvailable: Boolean,
    ): Set<String> = VoicePlugins.available(
        networkAvailable = networkAvailable,
        systemEnginePresent = true,
        hasApiKey = { plugin ->
            plugin.backend == VoiceBackend.ELEVEN_API && prefs.elevenApiKey().get().isNotBlank()
        },
        hasServerAddress = { plugin ->
            plugin.backend == VoiceBackend.REMOTE_TTS && prefs.remoteTtsUrl().get().isNotBlank()
        },
    ).map { it.id }.toSet()

    private fun mark(available: Boolean) = if (available) "доступен" else "НЕДОСТУПЕН"
    private fun regions(supported: Boolean) = if (supported) " | находит области" else ""
    private fun gender(supported: Boolean) = if (supported) " | различает пол" else ""
    private fun requirements(names: List<String>) =
        if (names.isEmpty()) "" else " | нужно: ${names.joinToString(", ")}"

    /**
     * Плотный статус озвучки для агента: почему молчит / каким голосом
     * говорит / какие движки вообще есть в системе. Данные — те же prefs и
     * реестры, что видит экран настроек, плюс хвост лога синтеза.
     */
    fun ttsStatus(context: Context, prefs: OcrPreferences = Injekt.get()): String {
        val pm = context.packageManager
        val intent = android.content.Intent(
            android.speech.tts.TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE,
        )
        val services = runCatching { pm.queryIntentServices(intent, 0) }.getOrNull().orEmpty()
        val logTail = runCatching {
            val f = java.io.File(AiWorkspace.root(context), "logs/tts.log")
            if (f.isFile) f.readLines().takeLast(12).joinToString("\n") else null
        }.getOrNull()
        return buildString {
            appendLine("Движок озвучки: ${prefs.voiceEngine().get()}")
            appendLine(
                "Системный TTS-движок: " +
                    prefs.systemTtsEngine().get().ifBlank { "по умолчанию системы" },
            )
            appendLine("Основной голос: ${prefs.voiceName().get().ifBlank { "не задан" }}")
            appendLine("Женские реплики: ${prefs.voiceFemale().get().ifBlank { "не задан" }}")
            appendLine("Мужские реплики: ${prefs.voiceMale().get().ifBlank { "не задан" }}")
            appendLine()
            appendLine(
                "Удалённый TTS-сервер: " +
                    prefs.remoteTtsUrl().get().ifBlank { "адрес не задан" },
            )
            appendLine()
            appendLine("Системные TTS-движки (PackageManager):")
            if (services.isEmpty()) appendLine("  не найдены")
            services.forEach { ri ->
                appendLine("  - ${ri.serviceInfo.packageName} (${ri.loadLabel(pm)})")
            }
            appendLine()
            if (logTail.isNullOrBlank()) {
                appendLine("logs/tts.log: пусто или нет файла")
            } else {
                appendLine("Хвост logs/tts.log:")
                appendLine(logTail)
            }
        }
    }
}
