package mihon.data.ocr

import mihon.domain.ocr.service.ScanRegion

/**
 * Тип контента, под который подбираются параметры детектора и распознавания.
 *
 * Пресет меняет ТОЛЬКО числовые параметры и порядок чтения: он не подменяет
 * модель и не включает словарную коррекцию. Значения подобраны под форму
 * кадров, а не под конкретный тайтл.
 */
enum class OcrContentType(
    val id: String,
    val title: String,
    val hint: String,
    /**
     * Режим чтения, который соответствует пресету. Совпадает с порядком чтения
     * OCR ([OcrTuning.readingOrder]) — связь проверяет `OcrViewerHintTest`.
     */
    val viewer: OcrViewerHint = OcrViewerHint.KEEP,
) {
    /**
     * Универсальный профиль. В точности повторяет значения, которые раньше
     * были зашиты константами в [CyrillicOcrEngine], поэтому поведение
     * приложения без явного выбора пресета не меняется.
     */
    BALANCED(
        id = "balanced",
        title = "Сбалансированный",
        hint = "Поведение по умолчанию: параметры прежних констант движка.",
    ),

    /**
     * Японская манга: мелкие буквы, плотные баллоны, чтение справа налево,
     * много коротких реплик на страницу.
     */
    MANGA(
        id = "manga",
        title = "Манга",
        hint = "Мелкий плотный текст в баллонах, чтение справа налево.",
        viewer = OcrViewerHint.PAGER_RTL,
    ),

    /**
     * Корейская манхва/вебтун: длинные вертикальные полосы, крупные надписи,
     * широкий межсловный пробел, много пустого фона между репликами.
     */
    MANHWA(
        id = "manhwa",
        title = "Манхва / вебтун",
        hint = "Вертикальные полосы, крупные надписи, широкие пробелы.",
        viewer = OcrViewerHint.WEBTOON,
    ),

    /**
     * Западный комикс: плотный леттеринг, крупные заголовки, чтение слева
     * направо, прямоугольные баллоны стоят близко друг к другу.
     */
    COMIC(
        id = "comic",
        title = "Комикс",
        hint = "Плотный леттеринг и заголовки, чтение слева направо.",
        viewer = OcrViewerHint.PAGER_LTR,
    ),
    ;

    companion object {
        fun fromId(id: String?): OcrContentType =
            entries.firstOrNull { it.id == id } ?: BALANCED
    }
}

/**
 * Полный набор параметров детектора и распознавания для одного прогона.
 *
 * Все значения по умолчанию совпадают с прежними константами
 * [CyrillicOcrEngine], поэтому `BALANCED` ничего не меняет в поведении.
 */
data class OcrTuning(
    // ---- Детектор текстовых областей (PP-OCRv4) ----
    /** Порог активации карты вероятностей детектора. */
    val detectorThreshold: Float = 0.20f,

    /** Минимальная площадь связной области в пикселях карты 736x736. */
    val minComponentArea: Int = 16,

    /** Сколько боксов максимум берётся со страницы. */
    val maxTextBoxes: Int = 96,

    /** Доля вертикального перекрытия, при которой два бокса склеиваются. */
    val mergeOverlapYFactor: Float = 0.55f,

    /** Горизонтальный зазор (в высотах строки), при котором боксы склеиваются. */
    val mergeGapXFactor: Float = 0.55f,

    // ---- Деление строки на слова по проекции чернил ----
    /** Минимальная ширина кропа, при которой вообще пробуем делить на слова. */
    val splitMinWidthPx: Int = 32,

    /** Во сколько раз зазор должен превышать медианный, чтобы считать его пробелом. */
    val wordGapFactor: Float = 1.7f,

    /** Абсолютный минимум зазора в пикселях. */
    val minWordGapPx: Int = 5,

    // ---- Признание результата ----
    /** Ниже этого порога кроп распознаётся повторно с усиленным контрастом. */
    val contrastRetryConfidence: Float = 0.90f,

    /** Пол строки/кропа отбрасывается ниже этой уверенности. */
    val minAcceptConfidence: Float = 0.25f,

    /** Более мягкий порог для коротких реплик («а», «а!», «а-а-а»). */
    val shortTextMinConfidence: Float = 0.12f,

    /** Доля пропущенных CTC-шагов, после которой уверенность снижается. */
    val minCoverage: Float = 0.12f,

    // ---- Ранжирование моделей и путей ----
    /** Бонус PP-OCRv5, когда он дал валидную кириллицу. */
    val verifierCyrillicBonus: Float = 0.20f,

    /** Бонус цельного кропа, если его слитный вывод разделяется на известные слова. */
    val wholeLineBoundaryBonus: Float = 0.08f,

    /** Сколько лучших отклонённых строк поднимает второй rescue-эшелон. */
    val rescueMaxLines: Int = 6,

    // ---- Порядок чтения и область страницы ----
    /** rtl — манга, ltr — комиксы, vertical — вебтуны. */
    val readingOrder: String = "rtl",

    /** Какая часть страницы уходит в распознавание. */
    val scanRegion: ScanRegion = ScanRegion.FULL_PAGE,
) {
    init {
        require(detectorThreshold in 0.01f..0.99f) { "detectorThreshold вне диапазона 0.01..0.99" }
        require(minComponentArea in 1..4096) { "minComponentArea вне диапазона 1..4096" }
        require(maxTextBoxes in 1..1024) { "maxTextBoxes вне диапазона 1..1024" }
        require(contrastRetryConfidence in 0.05f..1f) { "contrastRetryConfidence вне диапазона 0.05..1" }
        require(minAcceptConfidence in 0f..1f) { "minAcceptConfidence вне диапазона 0..1" }
        require(shortTextMinConfidence in 0f..1f) { "shortTextMinConfidence вне диапазона 0..1" }
        require(minCoverage in 0f..0.9f) { "minCoverage вне диапазона 0..0.9" }
        require(rescueMaxLines in 0..64) { "rescueMaxLines вне диапазона 0..64" }
        require(readingOrder in READING_ORDERS) { "неизвестный readingOrder: $readingOrder" }
    }

    companion object {
        val READING_ORDERS = setOf("rtl", "ltr", "vertical")

        /** Профиль по умолчанию = прежнее поведение движка. */
        val DEFAULT = OcrTuning()

        /**
         * Пресет типа контента.
         *
         * Меняются только те параметры, где форма кадров действительно
         * другая: у вебтуна длинные полосы и крупные буквы (можно реже
         * склеивать боксы и требовать меньше строк), у манги мелкий плотный
         * текст (нужен ниже порог детектора и больше боксов на страницу).
         */
        fun preset(type: OcrContentType, scanRegion: ScanRegion = ScanRegion.FULL_PAGE): OcrTuning =
            when (type) {
                OcrContentType.BALANCED -> DEFAULT.copy(scanRegion = scanRegion)

                OcrContentType.MANGA -> DEFAULT.copy(
                    detectorThreshold = 0.17f,
                    minComponentArea = 12,
                    maxTextBoxes = 128,
                    mergeOverlapYFactor = 0.60f,
                    mergeGapXFactor = 0.45f,
                    wordGapFactor = 1.5f,
                    minWordGapPx = 4,
                    contrastRetryConfidence = 0.88f,
                    minAcceptConfidence = 0.22f,
                    rescueMaxLines = 8,
                    readingOrder = "rtl",
                    scanRegion = scanRegion,
                )

                OcrContentType.MANHWA -> DEFAULT.copy(
                    detectorThreshold = 0.18f,
                    minComponentArea = 20,
                    maxTextBoxes = 64,
                    mergeOverlapYFactor = 0.45f,
                    mergeGapXFactor = 0.80f,
                    splitMinWidthPx = 40,
                    wordGapFactor = 2.0f,
                    minWordGapPx = 7,
                    minAcceptConfidence = 0.26f,
                    rescueMaxLines = 5,
                    readingOrder = "vertical",
                    scanRegion = scanRegion,
                )

                OcrContentType.COMIC -> DEFAULT.copy(
                    detectorThreshold = 0.22f,
                    minComponentArea = 18,
                    maxTextBoxes = 96,
                    mergeOverlapYFactor = 0.58f,
                    mergeGapXFactor = 0.50f,
                    wordGapFactor = 1.6f,
                    minWordGapPx = 5,
                    minAcceptConfidence = 0.24f,
                    readingOrder = "ltr",
                    scanRegion = scanRegion,
                )
            }
    }
}

/**
 * Точные переопределения пресета из настроек.
 *
 * Каждое поле может быть `null` — тогда берётся значение пресета. Все поля
 * ограничены диапазонами: пользователь не должен иметь возможность выставить
 * порог, при котором детектор перестаёт работать.
 */
data class OcrTuningOverrides(
    val detectorThreshold: Float? = null,
    val minComponentArea: Int? = null,
    val maxTextBoxes: Int? = null,
    val wordGapFactor: Float? = null,
    val minAcceptConfidence: Float? = null,
    val shortTextMinConfidence: Float? = null,
    val minCoverage: Float? = null,
    val rescueMaxLines: Int? = null,
) {
    val isEmpty: Boolean
        get() = detectorThreshold == null &&
            minComponentArea == null &&
            maxTextBoxes == null &&
            wordGapFactor == null &&
            minAcceptConfidence == null &&
            shortTextMinConfidence == null &&
            minCoverage == null &&
            rescueMaxLines == null

    /**
     * Применяет переопределения к пресету, отбрасывая значения вне допустимых
     * диапазонов. Молчаливый отброс намеренный: настройка, сохранённая старой
     * версией приложения, не должна ронять распознавание.
     */
    fun applyTo(base: OcrTuning): OcrTuning = base.copy(
        detectorThreshold = detectorThreshold?.coerceIn(0.01f, 0.99f) ?: base.detectorThreshold,
        minComponentArea = minComponentArea?.coerceIn(1, 4096) ?: base.minComponentArea,
        maxTextBoxes = maxTextBoxes?.coerceIn(1, 1024) ?: base.maxTextBoxes,
        wordGapFactor = wordGapFactor?.coerceIn(1.0f, 6.0f) ?: base.wordGapFactor,
        minAcceptConfidence = minAcceptConfidence?.coerceIn(0.0f, 1.0f) ?: base.minAcceptConfidence,
        shortTextMinConfidence = shortTextMinConfidence
            ?.coerceIn(0.0f, 1.0f)
            ?: base.shortTextMinConfidence,
        minCoverage = minCoverage?.coerceIn(0.0f, 0.9f) ?: base.minCoverage,
        rescueMaxLines = rescueMaxLines?.coerceIn(0, 64) ?: base.rescueMaxLines,
    )
}
