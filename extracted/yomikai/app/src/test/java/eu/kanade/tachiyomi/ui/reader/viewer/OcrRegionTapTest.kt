package eu.kanade.tachiyomi.ui.reader.viewer

import io.kotest.matchers.shouldBe
import mihon.domain.ocr.model.OcrBoundingBox
import mihon.domain.ocr.model.OcrModel
import mihon.domain.ocr.model.OcrPageResult
import mihon.domain.ocr.model.OcrRegion
import mihon.domain.ocr.model.OcrTextOrientation
import org.junit.jupiter.api.Test

/**
 * Тап по странице открывал панель распознанного текста в любой точке.
 *
 * Полностраничный OCR складывает весь лист в один регион (0,0,1,1), и
 * findRegionAt() находил его при каждом касании — включая пустые поля.
 */
class OcrRegionTapTest {

    private fun region(
        order: Int,
        left: Float,
        top: Float,
        right: Float,
        bottom: Float,
        text: String = "реплика",
    ) = OcrRegion(
        order = order,
        text = text,
        boundingBox = OcrBoundingBox(left, top, right, bottom),
        textOrientation = OcrTextOrientation.Horizontal,
    )

    private fun page(vararg regions: OcrRegion) = OcrPageResult(
        chapterId = 1L,
        pageIndex = 0,
        ocrModel = OcrModel.ZEN_FREE,
        imageWidth = 1000,
        imageHeight = 2000,
        regions = regions.toList(),
    )

    @Test
    fun `a whole-page region is recognised as such`() {
        region(0, 0f, 0f, 1f, 1f).isWholePage shouldBe true
        region(0, 0.1f, 0.2f, 0.5f, 0.4f).isWholePage shouldBe false
    }

    @Test
    fun `tapping empty space no longer opens the panel`() {
        // Единственный регион — вся страница: тап не должен ничего находить.
        val result = page(region(0, 0f, 0f, 1f, 1f, "весь распознанный лист"))
        result.findRegionAt(500f, 1000f) shouldBe null
        result.findRegionAt(10f, 10f) shouldBe null
    }

    @Test
    fun `real bubbles are still tappable`() {
        val bubble = region(1, 0.1f, 0.1f, 0.4f, 0.2f, "Мы на месте...")
        val result = page(region(0, 0f, 0f, 1f, 1f, "весь лист"), bubble)

        // точка внутри бабла -> находим именно его
        result.findRegionAt(200f, 300f)?.text shouldBe "Мы на месте..."
        // точка вне бабла -> ничего, хотя регион «вся страница» её покрывает
        result.findRegionAt(900f, 1800f) shouldBe null
    }

    @Test
    fun `the smallest matching region wins`() {
        val panel = region(1, 0.0f, 0.0f, 0.9f, 0.9f, "панель")
        val bubble = region(2, 0.1f, 0.1f, 0.3f, 0.2f, "бабл")
        val result = page(panel, bubble)

        // Точка попадает и в панель, и во вложенный бабл — нужен бабл.
        result.findRegionAt(150f, 300f)?.text shouldBe "бабл"
        // Точка только в панели.
        result.findRegionAt(800f, 1500f)?.text shouldBe "панель"
    }

    @Test
    fun `an empty page yields nothing`() {
        page().findRegionAt(100f, 100f) shouldBe null
    }
}
