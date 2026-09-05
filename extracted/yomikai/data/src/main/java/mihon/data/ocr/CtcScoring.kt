package mihon.data.ocr

import kotlin.math.exp

/**
 * Чистая математика CTC-декодирования, вынесенная из [CyrillicOcrEngine],
 * чтобы её можно было проверить unit-тестами без Android/TFLite.
 */
internal object CtcScoring {

    /**
     * Softmax по срезу класса одного временного шага.
     *
     * PP-OCR recognizer'ы пака отдают НЕ нормализованные логиты. Раньше
     * «уверенностью» считалось среднее сырых логитов победивших классов, и
     * порог [CyrillicOcrEngine.MIN_ACCEPT_CONFIDENCE] = 0.25 проходил любой
     * шум: логит 8.0 «увереннее» порога в 32 раза. После нормализации
     * значение всегда в [0, 1] и пороги снова означают то, что заявляют.
     */
    fun softmax(values: FloatArray, base: Int, classes: Int): FloatArray {
        val out = FloatArray(classes)
        var max = Float.NEGATIVE_INFINITY
        for (index in 0 until classes) {
            val v = values[base + index]
            if (v > max) max = v
        }
        var sum = 0f
        for (index in 0 until classes) {
            val e = exp((values[base + index] - max).toDouble()).toFloat()
            out[index] = e
            sum += e
        }
        if (sum <= 0f) return out
        for (index in 0 until classes) out[index] /= sum
        return out
    }

    /**
     * Доля временных шагов внутри распознанной подстроки (между первым и
     * последним выданным символом), на которых победил blank.
     *
     * Это и есть «выпавшие» буквы: на device-проверке `ЛОЖНО ОБВИНЁН`
     * читалось как `лжн вбинен`, а `ОН БЫЛ` — как `н был`. Гласные и первые
     * буквы тоньше, их шаги чаще проигрывают blank'у, но средняя уверенность
     * оставшихся символов была высокой, и строка проходила все фильтры.
     */
    fun innerBlankCoverage(blankSteps: Int, emitted: Int, steps: Int): Float {
        if (emitted == 0 || steps <= 0) return 0f
        val inner = steps - emitted
        if (inner <= 0) return 0f
        return blankSteps.toFloat().coerceIn(0f, 1f) * (inner.toFloat() / steps)
    }

    /**
     * Штраф к уверенности за пропуски в середине слова.
     *
     * Намеренно НЕ нормализует сырые логиты: модель может выдавать любую
     * шкалу, и нормализация изменила бы смысл уже подобранных порогов
     * (строки, которые устройство читало верно, начали бы отбрасываться).
     * Штраф только понижает оценку — ни одна ранее принятая строка не станет
     * принятой «случайно», а строки с выпавшими буквами теряют до 40 %.
     */
    fun coveragePenalty(confidence: Float, coverage: Float, minCoverage: Float): Float {
        if (coverage <= minCoverage) return confidence
        val over = ((coverage - minCoverage) / (1f - minCoverage)).coerceIn(0f, 1f)
        return confidence * (1f - 0.40f * over)
    }
}

/**
 * Результат CTC-декодирования одного кропа.
 *
 * @param emitted число временных шагов, выдавших символ;
 * @param blankSteps число шагов внутри распознанной подстроки, где победил blank.
 */
internal data class CtcDecode(
    val text: String,
    val confidence: Float,
    val emitted: Int,
    val blankSteps: Int,
    val steps: Int,
)
