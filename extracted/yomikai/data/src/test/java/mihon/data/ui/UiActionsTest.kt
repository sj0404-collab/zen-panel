package mihon.data.ui

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import mihon.data.ocr.OcrContentType
import mihon.data.ocr.OcrViewerHint
import mihon.domain.ocr.service.ScanRegion
import org.junit.jupiter.api.Test

/**
 * Реестр пользовательских действий UI.
 *
 * Проверяется декларативная часть: допустимые значения эффектов, валидация с
 * конкретной причиной, защита имён встроенных действий и сортировка. Применение
 * эффектов требует Android и в юнит-тесты не входит.
 */
class UiActionsTest {

    private val valid = UiActionSpec(
        id = "my_manhwa",
        title = "Манхва одним тапом",
        placement = UiPlacement.FLOATING_MENU,
        effect = UiEffect.OCR_PRESET,
        value = OcrContentType.MANHWA.id,
    )

    @Test
    fun `a valid declaration passes`() {
        UiActions.validate(valid).shouldBeNull()
    }

    @Test
    fun `every effect declares the values it accepts`() {
        UiActions.allowedValues(UiEffect.OCR_PRESET) shouldBe OcrContentType.entries.map { it.id }.toSet()
        UiActions.allowedValues(UiEffect.SCAN_REGION) shouldBe ScanRegion.entries.map { it.name }.toSet()
        UiActions.allowedValues(UiEffect.READING_MODE) shouldBe OcrViewerHint.entries.map { it.id }.toSet()
        // Эти два проверяет app-модуль по своим реестрам.
        UiActions.allowedValues(UiEffect.VOICE_ENGINE).shouldBeNull()
        UiActions.allowedValues(UiEffect.AI_PROVIDER).shouldBeNull()
    }

    @Test
    fun `an unknown value is rejected with the list of allowed ones`() {
        val reason = UiActions.validate(valid.copy(value = "dota"))
        reason shouldContain "недопустимо"
        reason shouldContain OcrContentType.MANHWA.id
    }

    @Test
    fun `blank fields are rejected with a concrete reason`() {
        UiActions.validate(valid.copy(id = "   ")) shouldBe "Пустой id"
        UiActions.validate(valid.copy(title = "")) shouldBe "Пустое название кнопки"
        UiActions.validate(valid.copy(value = "")) shouldContain "Не указано значение"
    }

    @Test
    fun `built-in action ids cannot be shadowed`() {
        ("preset_manhwa" in UiActions.RESERVED_IDS) shouldBe true
        ("region_full" in UiActions.RESERVED_IDS) shouldBe true
        UiActions.validate(valid.copy(id = "preset_manhwa")) shouldContain "занято встроенным"
        // Встроенное объявление с таким id — это оно и есть.
        UiActions.validate(valid.copy(id = "preset_manhwa", builtIn = true)).shouldBeNull()
    }

    @Test
    fun `every built-in declaration is itself valid`() {
        // Иначе встроенная кнопка не прошла бы собственную валидацию.
        UiActions.builtIn().forEach { spec ->
            UiActions.validate(spec).shouldBeNull()
            spec.builtIn shouldBe true
        }
        UiActions.builtIn().map { it.id }.distinct().size shouldBe UiActions.builtIn().size
    }

    @Test
    fun `placement and effect ids are unique and parsed case-insensitively`() {
        UiPlacement.entries.map { it.id }.distinct().size shouldBe UiPlacement.entries.size
        UiEffect.entries.map { it.id }.distinct().size shouldBe UiEffect.entries.size
        UiPlacement.fromId("  FLOATING_MENU ") shouldBe UiPlacement.FLOATING_MENU
        UiEffect.fromId("ocr_preset") shouldBe UiEffect.OCR_PRESET
        UiPlacement.fromId("что-то-новое").shouldBeNull()
        UiEffect.fromId(null).shouldBeNull()
    }

    @Test
    fun `actions of a placement are ordered by order then title`() {
        val a = valid.copy(id = "a", title = "b", order = 5)
        val b = valid.copy(id = "b", title = "a", order = 5)
        val c = valid.copy(
            id = "c",
            title = "c",
            order = 1,
            placement = UiPlacement.OCR_CARD,
        )
        val sorted = UiActions.forPlacement(listOf(a, b, c), UiPlacement.FLOATING_MENU)
        sorted.map { it.id } shouldBe listOf("b", "a")
        UiActions.forPlacement(listOf(a, b, c), UiPlacement.OCR_CARD).map { it.id } shouldBe listOf("c")
    }

    @Test
    fun `sanitizeId normalizes case and unsafe characters`() {
        UiActions.sanitizeId("  My Button ") shouldBe "my_button"
        UiActions.sanitizeId("../../etc").contains("/") shouldBe false
        UiActions.sanitizeId("a".repeat(80)).length shouldBe 40
    }
}
