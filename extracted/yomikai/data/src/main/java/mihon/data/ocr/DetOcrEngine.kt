package mihon.data.ocr

import android.graphics.Bitmap
import mihon.domain.ocr.exception.OcrException
import mihon.domain.ocr.model.OcrBoundingBox

internal interface DetOcrEngine {
    suspend fun detectTextRegions(image: Bitmap): List<OcrBoundingBox>

    fun close()
}

internal class UnavailableDetOcrEngine : DetOcrEngine {
    override suspend fun detectTextRegions(image: Bitmap): List<OcrBoundingBox> {
        throw OcrException.DetectionUnavailable()
    }

    override fun close() = Unit
}

/**
 * Детектор текстовых областей на модели PP-OCRv4 (`cyrillic_detector.tflite`).
 *
 * Модель уже входит в пак `cyrillic_ocr` и загружается внутри
 * [CyrillicOcrEngine], поэтому здесь она не открывается второй раз — движок
 * переиспользуется целиком. Владелец движка — репозиторий, так что [close]
 * ничего не закрывает: иначе первый же `closeEngines()` закрыл бы модель
 * дважды.
 */
internal class CyrillicDetOcrEngine(
    private val engineProvider: () -> CyrillicOcrEngine,
) : DetOcrEngine {

    override suspend fun detectTextRegions(image: Bitmap): List<OcrBoundingBox> {
        return try {
            engineProvider().detectRegions(image)
        } catch (e: OcrException) {
            // Модели не установлены или не инициализировались — для вызывающей
            // стороны это то же самое, что «детектора нет».
            throw OcrException.DetectionUnavailable(e)
        }
    }

    /** Жизненным циклом модели управляет владелец [CyrillicOcrEngine]. */
    override fun close() = Unit
}
