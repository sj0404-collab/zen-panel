package mihon.data.ocr

import io.kotest.matchers.shouldBe
import mihon.domain.ocr.service.ScanRegion
import org.junit.jupiter.api.Test

/**
 * Правила области сканирования и точной подстройки.
 *
 * Эти функции — единственный источник истины для движка, экрана настроек и
 * инструментов AI-агента, поэтому проверяются отдельно: расхождение здесь
 * означало бы, что агент докладывает пользователю не те параметры, которые
 * реально применятся к странице.
 */
class OcrRegionRulesTest {

    @Test
    fun `preset region key wins over the legacy preference`() {
        OcrRegionRules.effectiveRegion("top", ScanRegion.FULL_PAGE) shouldBe ScanRegion.TOP_HALF
        OcrRegionRules.effectiveRegion("bottom", ScanRegion.FULL_PAGE) shouldBe ScanRegion.BOTTOM_HALF
        OcrRegionRules.effectiveRegion("full", ScanRegion.TOP_HALF) shouldBe ScanRegion.FULL_PAGE
    }

    @Test
    fun `legacy preference is the fallback for unknown or empty keys`() {
        // Пустое значение и значение старой версии не должны ломать область.
        OcrRegionRules.effectiveRegion("", ScanRegion.BOTTOM_HALF) shouldBe ScanRegion.BOTTOM_HALF
        OcrRegionRules.effectiveRegion(null, ScanRegion.TOP_HALF) shouldBe ScanRegion.TOP_HALF
        OcrRegionRules.effectiveRegion("quarter", ScanRegion.FULL_PAGE) shouldBe ScanRegion.FULL_PAGE
    }

    @Test
    fun `region keys are exactly the values stored in pref_ocr_preset_region`() {
        OcrRegionRules.REGION_KEYS shouldBe listOf("full", "top", "bottom")
        OcrRegionRules.REGION_KEYS.forEach { key ->
            OcrRegionRules.regionOf(key) shouldBe OcrRegionRules.effectiveRegion(key, ScanRegion.TOP_HALF)
        }
        // Каждый ключ обязан иметь человекочитаемое имя.
        OcrRegionRules.REGION_KEYS
            .mapNotNull { OcrRegionRules.regionOf(it) }
            .forEach { OcrRegionRules.regionTitle(it).isNotBlank() shouldBe true }
    }

    @Test
    fun `blank or malformed overrides mean -as in preset-`() {
        OcrRegionRules.overridesOf("", "", "", "", "", "", "", "").isEmpty shouldBe true

        val garbage = OcrRegionRules.overridesOf("abc", "12px", "0.2f", "", "", "", "", "")
        garbage.isEmpty shouldBe true
        garbage.detectorThreshold shouldBe null
        garbage.minComponentArea shouldBe null
        garbage.maxTextBoxes shouldBe null
    }

    @Test
    fun `comma decimal separator is accepted and means the same as a dot`() {
        // Приложение русское: «0,19» и «0.19» обязаны давать одно значение.
        // Без приведения разделителя toFloatOrNull() читает запятую как
        // разделитель групп разрядов, и «12,5f» превращается в 1.25.
        OcrRegionRules.overridesOf("0,19", "", "", "", "", "", "", "").detectorThreshold shouldBe 0.19f
        OcrRegionRules.overridesOf("0.19", "", "", "", "", "", "", "").detectorThreshold shouldBe 0.19f
        OcrRegionRules.overridesOf("", "", "", "1,5", "", "", "", "").wordGapFactor shouldBe 1.5f
        OcrRegionRules.overridesOf("", "", "", "", "", "", "", " 8 ").rescueMaxLines shouldBe 8
        OcrRegionRules.overridesOf("", "12", "", "", "", "", "", "").minComponentArea shouldBe 12
        // Пробелы по краям не ломают значение.
        OcrRegionRules.overridesOf(" 0.22 ", "", "", "", "", "", "", "").detectorThreshold shouldBe 0.22f
    }

    @Test
    fun `overrides replace only the fields the user filled in`() {
        val overrides = OcrRegionRules.overridesOf(
            detectorThreshold = "0.19",
            minComponentArea = "",
            maxTextBoxes = "40",
            wordGapFactor = "",
            minAcceptConfidence = "",
            shortTextMinConfidence = "",
            minCoverage = "",
            rescueMaxLines = "",
        )
        val preset = OcrTuning.preset(OcrContentType.MANGA, ScanRegion.FULL_PAGE)
        val tuning = overrides.applyTo(preset)

        tuning.detectorThreshold shouldBe 0.19f
        tuning.maxTextBoxes shouldBe 40
        // Незаполненные поля остались значениями пресета.
        tuning.minComponentArea shouldBe preset.minComponentArea
        tuning.wordGapFactor shouldBe preset.wordGapFactor
        tuning.minAcceptConfidence shouldBe preset.minAcceptConfidence
        tuning.readingOrder shouldBe preset.readingOrder
    }

    @Test
    fun `reading order names cover every preset value`() {
        OcrContentType.entries
            .map { OcrTuning.preset(it).readingOrder }
            .distinct()
            .forEach { order -> OcrRegionRules.orderTitle(order).isNotBlank() shouldBe true }

        OcrRegionRules.orderTitle("rtl") shouldBe "справа налево"
        OcrRegionRules.orderTitle("ltr") shouldBe "слева направо"
        OcrRegionRules.orderTitle("vertical") shouldBe "сверху вниз"
        // Неизвестное значение показываем как есть, а не выдумываем перевод.
        OcrRegionRules.orderTitle("diagonal") shouldBe "diagonal"
    }
}
