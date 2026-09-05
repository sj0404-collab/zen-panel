package mihon.data.ocr

import mihon.domain.ocr.model.OcrModel
import mihon.domain.ocr.service.ScanRegion

/**
 * Требования плагина к окружению. UI по ним честно показывает, почему движок
 * недоступен, вместо падения или пустого результата.
 */
enum class OcrPluginRequirement {
    /** Нужен интернет. */
    NETWORK,

    /** Нужен скачанный пакет моделей (`cyrillic_ocr`). */
    MODEL_PACK,

    /** Нужен LiteRT (`com.google.ai.edge.litert`). */
    LITERT,

    /** Нужен API-ключ в настройках. */
    API_KEY,

    /** Нужен адрес своего сервера. */
    SERVER_ADDRESS,
}

/**
 * Описание одного OCR-движка как плагина.
 *
 * Реестр НЕ создаёт движки и не владеет ими: экземпляры по-прежнему живёт в
 * [OcrRepositoryImpl] вместе со своими мьютексами и кэшем моделей. Здесь лежит
 * только декларативная часть — id, название, требования, порядок во fallback-
 * цепочке и пресет тюнинга. Благодаря этому список движков можно показывать в
 * настройках, фильтровать по доступности и менять порядок фолбэков, не трогая
 * enum `OcrModel` и не переписывая замки.
 *
 * `engineType` намеренно строковый, а не `OcrRepositoryImpl.EngineType`: этот
 * тип `internal` и привязан к репозиторию, а реестр должен оставаться чистой
 * декларацией, которую можно тестировать без Android.
 */
data class OcrPluginDescriptor(
    val id: String,
    val model: OcrModel,
    val title: String,
    val summary: String,
    val engineType: String,
    val online: Boolean,
    val requirements: Set<OcrPluginRequirement> = emptySet(),
    /** Позиция в fallback-цепочке: меньше — раньше пробуется. */
    val fallbackPriority: Int,
    /** Пресет тюнинга, который лучше всего подходит этому движку. */
    val preferredContentType: OcrContentType = OcrContentType.BALANCED,
    /** Движок отдаёт границы областей, а не только текст. */
    val supportsRegions: Boolean = false,
    /** Миграционный хвост: значение enum, которое больше не выбирается в UI. */
    val legacy: Boolean = false,
)

/**
 * Реестр OCR-плагинов.
 *
 * Порядок [ALL] определяет порядок в настройках. [fallbackChain] повторяет
 * семантику прежних пресетов `pref_fallback_preset`
 * (auto / online / offline / single), но строится из данных реестра, а не из
 * зашитых списков в репозитории.
 */
object OcrPlugins {

    val CYRILLIC = OcrPluginDescriptor(
        id = "cyrillic_ppocr",
        model = OcrModel.CYRILLIC,
        title = "Локальный кириллический PP-OCR",
        summary = "PP-OCRv4 детектор + PP-OCRv3/v5 распознавание. Офлайн, основной русский движок.",
        engineType = "CYRILLIC",
        online = false,
        requirements = setOf(OcrPluginRequirement.MODEL_PACK, OcrPluginRequirement.LITERT),
        fallbackPriority = 0,
        supportsRegions = true,
    )

    val GLENS = OcrPluginDescriptor(
        id = "google_lens",
        model = OcrModel.GLENS,
        title = "Google Lens",
        summary = "Онлайн-распознавание через Google Lens. Работает без ключа, но требует сеть.",
        engineType = "GLENS",
        online = true,
        requirements = setOf(OcrPluginRequirement.NETWORK),
        fallbackPriority = 10,
    )

    val ZEN_FREE = OcrPluginDescriptor(
        id = "zen_free",
        model = OcrModel.ZEN_FREE,
        title = "Zen Free",
        summary = "Бесплатный режим без ключа и настройки. Изображения не принимаются, поэтому идёт через Google Lens.",
        engineType = "ZEN_FREE",
        online = true,
        requirements = setOf(OcrPluginRequirement.NETWORK),
        fallbackPriority = 20,
    )

    val GOOGLE_AI = OcrPluginDescriptor(
        id = "google_ai",
        model = OcrModel.GOOGLE,
        title = "Google AI / Gemini Vision",
        summary = "Vision-модель Gemini. Нужен API-ключ Google AI.",
        engineType = "GOOGLE",
        online = true,
        requirements = setOf(OcrPluginRequirement.NETWORK, OcrPluginRequirement.API_KEY),
        fallbackPriority = 30,
    )

    val OPENROUTER = OcrPluginDescriptor(
        id = "openrouter",
        model = OcrModel.OPENROUTER,
        title = "OpenRouter",
        summary = "Любая vision-модель через OpenRouter. Нужен API-ключ.",
        engineType = "OPENROUTER",
        online = true,
        requirements = setOf(OcrPluginRequirement.NETWORK, OcrPluginRequirement.API_KEY),
        fallbackPriority = 40,
    )

    val OWOCR = OcrPluginDescriptor(
        id = "owocr",
        model = OcrModel.OWOCR,
        title = "OwOCR (свой сервер)",
        summary = "Self-hosted сервер OwOCR по WebSocket-адресу.",
        engineType = "OWOCR",
        online = true,
        requirements = setOf(OcrPluginRequirement.NETWORK, OcrPluginRequirement.SERVER_ADDRESS),
        fallbackPriority = 50,
    )

    /** Значения enum, которые оставлены только для миграции старых настроек. */
    val LEGACY_ALIASES = listOf(
        OcrModel.LEGACY to CYRILLIC.id,
        OcrModel.FAST to CYRILLIC.id,
        OcrModel.TESSERACT to CYRILLIC.id,
    )

    /** Все выбираемые плагины в порядке показа в настройках. */
    val ALL = listOf(CYRILLIC, GLENS, ZEN_FREE, GOOGLE_AI, OPENROUTER, OWOCR)

    private val BY_ID = ALL.associateBy { it.id }
    private val BY_ENGINE_TYPE = ALL.associateBy { it.engineType }
    private val BY_MODEL = ALL.associateBy { it.model }

    fun byId(id: String?): OcrPluginDescriptor? = id?.let { BY_ID[it] }

    fun byEngineType(engineType: String): OcrPluginDescriptor? = BY_ENGINE_TYPE[engineType]

    /**
     * Плагин для значения `pref_ocr_model`. Миграционные значения enum
     * прозрачно ведут на локальный кириллический движок — ровно так же, как
     * раньше это делал `selectedEngineType()` в репозитории.
     */
    fun byModel(model: OcrModel): OcrPluginDescriptor =
        BY_MODEL[model] ?: CYRILLIC

    /** Плагины, у которых выполнены все требования. */
    fun available(
        networkAvailable: Boolean,
        modelsInstalled: Boolean,
        litertAvailable: Boolean,
        hasApiKey: (OcrPluginDescriptor) -> Boolean = { false },
        hasServerAddress: (OcrPluginDescriptor) -> Boolean = { false },
    ): List<OcrPluginDescriptor> = ALL.filter { plugin ->
        plugin.requirements.all { requirement ->
            when (requirement) {
                OcrPluginRequirement.NETWORK -> networkAvailable
                OcrPluginRequirement.MODEL_PACK -> modelsInstalled
                OcrPluginRequirement.LITERT -> litertAvailable
                OcrPluginRequirement.API_KEY -> hasApiKey(plugin)
                OcrPluginRequirement.SERVER_ADDRESS -> hasServerAddress(plugin)
            }
        }
    }

    /**
     * Цепочка фолбэков без первичного движка.
     *
     * Порядок воспроизводит прежний `fallbackChain()` из `OcrRepositoryImpl`:
     * сначала онлайн-движки, затем локальные, внутри группы — по
     * [OcrPluginDescriptor.fallbackPriority]. Локальный движок намеренно
     * последний: он медленный, а онлайн обычно даёт лучший результат, поэтому
     * «авто» не должно начинаться с него.
     *
     * @param preset auto | online | offline | single — значения прежнего
     *   `pref_fallback_preset`, неизвестное значение читается как auto.
     */
    fun fallbackChain(
        primary: OcrPluginDescriptor,
        preset: String,
        networkAvailable: Boolean,
    ): List<OcrPluginDescriptor> {
        val pool = when (preset) {
            "single" -> return emptyList()
            "online" -> ALL.filter { it.online }
            "offline" -> ALL.filterNot { it.online }
            else -> if (networkAvailable) ALL else ALL.filterNot { it.online }
        }
        return pool
            .filter { it.id != primary.id }
            .sortedWith(compareByDescending<OcrPluginDescriptor> { it.online }.thenBy { it.fallbackPriority })
    }
}

/**
 * Профиль распознавания области страницы: пресет типа контента + область +
 * точные переопределения пользователя.
 */
data class OcrRegionProfile(
    val contentType: OcrContentType = OcrContentType.BALANCED,
    val scanRegion: ScanRegion = ScanRegion.FULL_PAGE,
    val overrides: OcrTuningOverrides = OcrTuningOverrides(),
) {
    /** Итоговые параметры для движка. */
    fun tuning(): OcrTuning = overrides.applyTo(OcrTuning.preset(contentType, scanRegion))
}
