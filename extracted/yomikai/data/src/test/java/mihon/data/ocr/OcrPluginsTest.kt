package mihon.data.ocr

import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import mihon.domain.ocr.model.OcrModel
import mihon.domain.ocr.service.ScanRegion
import org.junit.jupiter.api.Test

/**
 * Реестр OCR-плагинов и пресеты типа контента.
 *
 * Обе сущности — чистые данные, поэтому проверяются без Android и без
 * загрузки моделей. Отдельно зафиксировано, что пресет BALANCED в точности
 * повторяет прежние константы CyrillicOcrEngine: это гарантия того, что
 * пользователь, не выбиравший пресет, не получает изменённое распознавание.
 */
class OcrPluginsTest {

    @Test
    fun `balanced preset repeats the previous engine constants`() {
        val balanced = OcrTuning.preset(OcrContentType.BALANCED)
        balanced.detectorThreshold shouldBe 0.20f
        balanced.minComponentArea shouldBe 16
        balanced.maxTextBoxes shouldBe 96
        balanced.mergeOverlapYFactor shouldBe 0.55f
        balanced.mergeGapXFactor shouldBe 0.55f
        balanced.splitMinWidthPx shouldBe 32
        balanced.wordGapFactor shouldBe 1.7f
        balanced.minWordGapPx shouldBe 5
        balanced.contrastRetryConfidence shouldBe 0.90f
        balanced.minAcceptConfidence shouldBe 0.25f
        balanced.shortTextMinConfidence shouldBe 0.12f
        balanced.minCoverage shouldBe 0.12f
        balanced.verifierCyrillicBonus shouldBe 0.20f
        balanced.wholeLineBoundaryBonus shouldBe 0.08f
        balanced.rescueMaxLines shouldBe 6
        balanced.readingOrder shouldBe "rtl"
        balanced.scanRegion shouldBe ScanRegion.FULL_PAGE
    }

    @Test
    fun `content presets set reading order and scan region`() {
        OcrTuning.preset(OcrContentType.MANGA).readingOrder shouldBe "rtl"
        OcrTuning.preset(OcrContentType.MANHWA).readingOrder shouldBe "vertical"
        OcrTuning.preset(OcrContentType.COMIC).readingOrder shouldBe "ltr"
        OcrTuning.preset(OcrContentType.MANHWA, ScanRegion.TOP_HALF).scanRegion shouldBe ScanRegion.TOP_HALF
    }

    @Test
    fun `manhwa tolerates wide gaps and manga lowers the detector threshold`() {
        val balanced = OcrTuning.DEFAULT
        OcrTuning.preset(OcrContentType.MANHWA).wordGapFactor shouldBe 2.0f
        OcrTuning.preset(OcrContentType.MANHWA).wordGapFactor shouldBe balanced.wordGapFactor + 0.3f
        OcrTuning.preset(OcrContentType.MANGA).detectorThreshold shouldBe 0.17f
        OcrTuning.preset(OcrContentType.MANGA).detectorThreshold shouldBe balanced.detectorThreshold - 0.03f
        // Вебтун: длинные полосы, поэтому боксов нужно меньше, а склеивать соседние
        // строки агрессивно нельзя.
        OcrTuning.preset(OcrContentType.MANHWA).maxTextBoxes shouldBe 64
        OcrTuning.preset(OcrContentType.MANHWA).mergeOverlapYFactor shouldBe 0.45f
    }

    @Test
    fun `overrides replace only the fields the user filled in`() {
        val base = OcrTuning.preset(OcrContentType.MANGA)
        val tuned = OcrTuningOverrides(detectorThreshold = 0.31f, rescueMaxLines = 3).applyTo(base)
        tuned.detectorThreshold shouldBe 0.31f
        tuned.rescueMaxLines shouldBe 3
        // Остальное осталось пресетным.
        tuned.minComponentArea shouldBe base.minComponentArea
        tuned.wordGapFactor shouldBe base.wordGapFactor
        tuned.minAcceptConfidence shouldBe base.minAcceptConfidence
    }

    @Test
    fun `out-of-range overrides are clamped instead of breaking the detector`() {
        val base = OcrTuning.DEFAULT
        val tuned = OcrTuningOverrides(
            detectorThreshold = 9f,
            minComponentArea = -5,
            maxTextBoxes = 0,
            wordGapFactor = 99f,
            minCoverage = 3f,
            rescueMaxLines = -1,
        ).applyTo(base)
        tuned.detectorThreshold shouldBe 0.99f
        tuned.minComponentArea shouldBe 1
        tuned.maxTextBoxes shouldBe 1
        tuned.wordGapFactor shouldBe 6.0f
        tuned.minCoverage shouldBe 0.9f
        tuned.rescueMaxLines shouldBe 0
    }

    @Test
    fun `empty overrides keep the preset untouched`() {
        val base = OcrTuning.preset(OcrContentType.COMIC)
        OcrTuningOverrides().isEmpty shouldBe true
        OcrTuningOverrides().applyTo(base) shouldBe base
    }

    @Test
    fun `region profile composes preset and overrides`() {
        val profile = OcrRegionProfile(
            contentType = OcrContentType.MANHWA,
            scanRegion = ScanRegion.BOTTOM_HALF,
            overrides = OcrTuningOverrides(minAcceptConfidence = 0.4f),
        )
        val tuning = profile.tuning()
        tuning.readingOrder shouldBe "vertical"
        tuning.scanRegion shouldBe ScanRegion.BOTTOM_HALF
        tuning.minAcceptConfidence shouldBe 0.4f
        // Не переопределённое поле осталось из пресета манхвы.
        tuning.wordGapFactor shouldBe OcrTuning.preset(OcrContentType.MANHWA).wordGapFactor
    }

    @Test
    fun `unknown content type falls back to balanced`() {
        OcrContentType.fromId("manhwa") shouldBe OcrContentType.MANHWA
        OcrContentType.fromId("комикс") shouldBe OcrContentType.BALANCED
        OcrContentType.fromId(null) shouldBe OcrContentType.BALANCED
        OcrContentType.fromId("") shouldBe OcrContentType.BALANCED
    }

    @Test
    fun `every selectable plugin has a unique id and engine type`() {
        OcrPlugins.ALL.map { it.id }.distinct().size shouldBe OcrPlugins.ALL.size
        OcrPlugins.ALL.map { it.engineType }.distinct().size shouldBe OcrPlugins.ALL.size
        OcrPlugins.ALL.forEach { plugin ->
            OcrPlugins.byId(plugin.id) shouldBe plugin
            OcrPlugins.byEngineType(plugin.engineType) shouldBe plugin
            OcrPlugins.byModel(plugin.model) shouldBe plugin
        }
    }

    @Test
    fun `legacy engine selections migrate to the cyrillic plugin`() {
        OcrPlugins.byModel(OcrModel.LEGACY) shouldBe OcrPlugins.CYRILLIC
        OcrPlugins.byModel(OcrModel.FAST) shouldBe OcrPlugins.CYRILLIC
        OcrPlugins.byModel(OcrModel.TESSERACT) shouldBe OcrPlugins.CYRILLIC
        OcrPlugins.LEGACY_ALIASES.map { it.second }.toSet() shouldContainExactly setOf(OcrPlugins.CYRILLIC.id)
    }

    @Test
    fun `availability follows the declared requirements`() {
        val offlineOnly = OcrPlugins.available(
            networkAvailable = false,
            modelsInstalled = true,
            litertAvailable = true,
        )
        offlineOnly shouldContainExactly listOf(OcrPlugins.CYRILLIC)

        val nothing = OcrPlugins.available(
            networkAvailable = false,
            modelsInstalled = false,
            litertAvailable = false,
        )
        nothing shouldBe emptyList()

        val withKeys = OcrPlugins.available(
            networkAvailable = true,
            modelsInstalled = true,
            litertAvailable = true,
            hasApiKey = { true },
            hasServerAddress = { true },
        )
        withKeys.size shouldBe OcrPlugins.ALL.size
    }

    @Test
    fun `fallback chain keeps the semantics of the old presets`() {
        val primary = OcrPlugins.CYRILLIC

        OcrPlugins.fallbackChain(primary, "single", networkAvailable = true) shouldBe emptyList()

        // offline: локальный движок единственный, поэтому цепочка пуста.
        OcrPlugins.fallbackChain(primary, "offline", networkAvailable = true) shouldBe emptyList()

        OcrPlugins.fallbackChain(primary, "online", networkAvailable = true).map { it.id } shouldContainExactly
            listOf("google_lens", "zen_free", "google_ai", "openrouter", "owocr")

        // auto без сети не пробует онлайн-движки вовсе.
        OcrPlugins.fallbackChain(OcrPlugins.GLENS, "auto", networkAvailable = false).map { it.id } shouldContainExactly
            listOf("cyrillic_ppocr")

        // auto с сетью: сначала онлайн по приоритету, потом локальный.
        OcrPlugins.fallbackChain(OcrPlugins.GLENS, "auto", networkAvailable = true).map { it.id } shouldContainExactly
            listOf("zen_free", "google_ai", "openrouter", "owocr", "cyrillic_ppocr")

        // Неизвестный пресет читается как auto.
        OcrPlugins.fallbackChain(primary, "что-то-новое", networkAvailable = false) shouldBe emptyList()
    }

    @Test
    fun `only the cyrillic plugin exposes detected regions`() {
        OcrPlugins.ALL.filter { it.supportsRegions }.map { it.id } shouldContainExactly
            listOf(OcrPlugins.CYRILLIC.id)
    }

    @Test
    fun `online flags match the fallback pools`() {
        OcrPlugins.ALL.filter { it.online }.map { it.id } shouldContainExactly
            listOf("google_lens", "zen_free", "google_ai", "openrouter", "owocr")
        OcrPlugins.ALL.filterNot { it.online }.map { it.id } shouldContainExactly listOf("cyrillic_ppocr")
    }
}
