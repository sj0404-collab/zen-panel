package mihon.data.ocr

import io.kotest.matchers.floats.shouldBeGreaterThan
import io.kotest.matchers.floats.shouldBeLessThan
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * CTC-метрики декодера: нормализованная вероятность blank и штраф за
 * выпавшие буквы. Это чистые функции, поэтому проверяются без Android/TFLite.
 */
class CtcScoringTest {

    private fun synthetic(rows: List<Pair<Float, Float>>): FloatArray {
        // Класс 0 — blank, класс 1 — буква.
        val values = FloatArray(rows.size * 2)
        rows.forEachIndexed { index, (blank, letter) ->
            values[index * 2] = blank
            values[index * 2 + 1] = letter
        }
        return values
    }

    @Test
    fun `blank probability is a normalized value between zero and one`() {
        val probability = CtcScoring.softmax(synthetic(listOf(10f to 0f)), 0, 2)[0]
        probability shouldBeGreaterThan 0.99f
        probability shouldBeLessThan 1.0001f
    }

    @Test
    fun `raw logits are no longer mistaken for confidence`() {
        // Логит 8.0 раньше считался «уверенностью 8.0» и проходил любой порог.
        val probability = CtcScoring.softmax(synthetic(listOf(0f to 8f)), 0, 2)[1]
        probability shouldBeGreaterThan 0.99f
        probability shouldBeLessThan 1.0001f
    }

    @Test
    fun `blanks between letters are counted as dropped characters`() {
        // «А» + два blank + «Б»: два пропуска внутри распознанной подстроки.
        val decode = CtcDecode("АБ", 0.9f, emitted = 2, blankSteps = 2, steps = 4)
        CtcScoring.innerBlankCoverage(decode.blankSteps, decode.emitted, decode.steps) shouldBe 0.5f
    }

    @Test
    fun `clean text keeps its confidence`() {
        CtcScoring.coveragePenalty(0.9f, 0.05f, 0.12f) shouldBe 0.9f
        CtcScoring.coveragePenalty(0.9f, 0.12f, 0.12f) shouldBe 0.9f
    }

    @Test
    fun `dropped letters lower the confidence`() {
        CtcScoring.coveragePenalty(0.9f, 0.56f, 0.12f) shouldBeLessThan 0.75f
        CtcScoring.coveragePenalty(0.9f, 1.0f, 0.12f) shouldBe 0.54f
    }

    @Test
    fun `empty decode has no coverage`() {
        CtcScoring.innerBlankCoverage(0, 0, 0) shouldBe 0f
    }
}
