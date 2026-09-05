package mihon.data.ocr

import io.kotest.matchers.shouldBe
import mihon.domain.ocr.model.OcrBoundingBox
import org.junit.jupiter.api.Test

/**
 * Детектор PP-OCRv4 отдаёт боксы в пикселях, а регионы страницы описываются
 * долями (0..1). Ошибка в этом переводе означала бы, что тап попадает не в ту
 * реплику, поэтому арифметика вынесена отдельно и проверяется тестом.
 */
class OcrBoxGeometryTest {

    @Test
    fun `pixels are converted to fractions of the page`() {
        val box = OcrBoxGeometry.normalize(
            left = 100,
            top = 200,
            right = 500,
            bottom = 400,
            imageWidth = 1000,
            imageHeight = 2000,
        )
        box shouldBe OcrBoundingBox(0.1f, 0.1f, 0.5f, 0.2f)
    }

    @Test
    fun `a box that leaves the page is clamped`() {
        val box = OcrBoxGeometry.normalize(
            left = -50,
            top = -10,
            right = 2000,
            bottom = 5000,
            imageWidth = 1000,
            imageHeight = 2000,
        )
        box shouldBe OcrBoundingBox(0f, 0f, 1f, 1f)
    }

    @Test
    fun `degenerate boxes are rejected`() {
        // нулевая ширина
        OcrBoxGeometry.normalize(10, 10, 10, 50, 1000, 2000) shouldBe null
        // нулевая высота
        OcrBoxGeometry.normalize(10, 10, 50, 10, 1000, 2000) shouldBe null
        // перевёрнутый бокс
        OcrBoxGeometry.normalize(50, 50, 10, 10, 1000, 2000) shouldBe null
    }

    @Test
    fun `a zero-sized image yields nothing`() {
        OcrBoxGeometry.normalize(0, 0, 10, 10, 0, 100) shouldBe null
        OcrBoxGeometry.normalize(0, 0, 10, 10, 100, 0) shouldBe null
    }

    @Test
    fun `a full-page box is detected as such`() {
        OcrBoxGeometry.coversWholePage(OcrBoundingBox(0f, 0f, 1f, 1f)) shouldBe true
        // почти во весь лист — тоже считаем полностраничным
        OcrBoxGeometry.coversWholePage(OcrBoundingBox(0.01f, 0.01f, 0.99f, 0.99f)) shouldBe true
    }

    @Test
    fun `a speech bubble is not a full-page box`() {
        OcrBoxGeometry.coversWholePage(OcrBoundingBox(0.1f, 0.1f, 0.4f, 0.2f)) shouldBe false
        // широкая, но невысокая полоса — это строка, а не страница
        OcrBoxGeometry.coversWholePage(OcrBoundingBox(0f, 0.4f, 1f, 0.5f)) shouldBe false
    }

    @Test
    fun `a detected line keeps its position on the page`() {
        // Реплика в правом верхнем углу страницы манги.
        val box = OcrBoxGeometry.normalize(
            left = 700,
            top = 100,
            right = 950,
            bottom = 260,
            imageWidth = 1000,
            imageHeight = 2000,
        )!!
        box.left shouldBe 0.7f
        box.right shouldBe 0.95f
        box.top shouldBe 0.05f
        box.bottom shouldBe 0.13f
        OcrBoxGeometry.coversWholePage(box) shouldBe false
    }

    @Test
    fun `box kinds follow geometry so presets bind to bubbles automatically`() {
        // Квадратное облачко в середине страницы — реплика в пузыре.
        OcrBoxGeometry.classifyKind(300, 800, 620, 1100, 1000, 2000) shouldBe OcrBoxGeometry.Kind.BUBBLE
        // Широкая низкая плашка у верхнего края — подпись (caption).
        OcrBoxGeometry.classifyKind(60, 40, 940, 150, 1000, 2000) shouldBe OcrBoxGeometry.Kind.CAPTION
        // То же у нижнего края — тоже подпись.
        OcrBoxGeometry.classifyKind(60, 1880, 940, 1970, 1000, 2000) shouldBe OcrBoxGeometry.Kind.CAPTION
        // Очень широкая полоса в середине — плашка перевода.
        OcrBoxGeometry.classifyKind(40, 900, 960, 1080, 1000, 2000) shouldBe OcrBoxGeometry.Kind.CAPTION
        // Узкое высокое облачко — вертикальная разметка: кадр повернём.
        OcrBoxGeometry.classifyKind(700, 300, 800, 900, 1000, 2000) shouldBe OcrBoxGeometry.Kind.VERTICAL
        // Вырожденный размер изображения не должен ронять классификатор.
        OcrBoxGeometry.classifyKind(1, 1, 5, 5, 0, 0) shouldBe OcrBoxGeometry.Kind.BUBBLE
    }
}
