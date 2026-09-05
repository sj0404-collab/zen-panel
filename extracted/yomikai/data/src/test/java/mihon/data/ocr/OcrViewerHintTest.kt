package mihon.data.ocr

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Связка пресета типа контента и режима чтения.
 *
 * Проверяется инвариант: подсказка вьюера обязана совпадать с порядком чтения,
 * который пресет задаёт для OCR. Иначе пресет «манхва» резал бы страницу
 * вертикальными полосами, а листалась бы она постранично справа налево.
 */
class OcrViewerHintTest {

    @Test
    fun `every content type declares the viewer it needs`() {
        OcrContentType.BALANCED.viewer shouldBe OcrViewerHint.KEEP
        OcrContentType.MANGA.viewer shouldBe OcrViewerHint.PAGER_RTL
        OcrContentType.MANHWA.viewer shouldBe OcrViewerHint.WEBTOON
        OcrContentType.COMIC.viewer shouldBe OcrViewerHint.PAGER_LTR
    }

    @Test
    fun `viewer hint agrees with the reading order of the preset`() {
        listOf(OcrContentType.MANGA, OcrContentType.MANHWA, OcrContentType.COMIC).forEach { type ->
            val tuning = OcrTuning.preset(type)
            OcrViewerHint.forReadingOrder(tuning.readingOrder) shouldBe type.viewer
        }
    }

    @Test
    fun `every reading order used by presets has a matching hint`() {
        // READING_ORDERS — источник допустимых значений порядка чтения: ни одно
        // из них не должно теряться в KEEP, и для каждого обязан находиться
        // пресет, у которого подсказка вьюера совпадает с порядком.
        OcrTuning.READING_ORDERS.forEach { order ->
            val hint = OcrViewerHint.forReadingOrder(order)
            (hint != OcrViewerHint.KEEP) shouldBe true
            OcrContentType.entries.any { type ->
                OcrTuning.preset(type).readingOrder == order && type.viewer == hint
            } shouldBe true
        }
    }

    @Test
    fun `balanced preset keeps the previous behaviour`() {
        // BALANCED обязан повторять прежние константы движка, включая порядок
        // чтения, и не трогать выбранный пользователем вьюер.
        OcrTuning.preset(OcrContentType.BALANCED).readingOrder shouldBe OcrTuning.DEFAULT.readingOrder
        OcrContentType.BALANCED.viewer shouldBe OcrViewerHint.KEEP
    }

    @Test
    fun `hint ids are unique and unknown values fall back to keep`() {
        OcrViewerHint.entries.map { it.id }.distinct().size shouldBe OcrViewerHint.entries.size
        OcrViewerHint.entries.forEach { OcrViewerHint.fromId(it.id) shouldBe it }
        // id нормализуется: регистр и пробелы по краям не ломают поиск.
        OcrViewerHint.fromId("  WEBTOON  ") shouldBe OcrViewerHint.WEBTOON
        OcrViewerHint.fromId(null) shouldBe OcrViewerHint.KEEP
        OcrViewerHint.fromId("") shouldBe OcrViewerHint.KEEP
        OcrViewerHint.fromId("что-то-новое") shouldBe OcrViewerHint.KEEP
    }

    @Test
    fun `every hint has a user-facing title`() {
        OcrViewerHint.entries.forEach { hint ->
            hint.title.isNotBlank() shouldBe true
            OcrContentType.entries.forEach { type ->
                if (type.viewer == hint) type.hint.isNotBlank() shouldBe true
            }
        }
    }
}
