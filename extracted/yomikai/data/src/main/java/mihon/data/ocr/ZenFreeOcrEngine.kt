package mihon.data.ocr

import android.content.Context
import android.graphics.Bitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import logcat.LogPriority
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.core.common.util.system.logcat

/**
 * «Zen Free» — бесплатный OCR без ключа.
 *
 * ВАЖНО про название. Провайдер Zen (opencode.ai/zen) раздаёт бесплатные
 * LLM (laguna-s, mimo, nemotron и др.), но на 18.08.2026 ни одна из них не
 * принимает изображения: запрос с картинкой возвращает
 * "No endpoints found that support image input". OCR по картинке через Zen
 * технически невозможен, поэтому распознаванием здесь занимается Google Lens
 * — единственный бесплатный движок без ключа.
 *
 * То есть это не отдельная нейросеть, а бесплатный режим «без настройки».
 * Если Zen однажды добавит vision-модели, достаточно заменить делегата.
 */
internal class ZenFreeOcrEngine(
    @Suppress("UNUSED_PARAMETER") context: Context,
    @Suppress("UNUSED_PARAMETER") ocrPreferences: OcrPreferences,
) : OcrEngine {

    // Реальный исполнитель распознавания. Назван delegate, а не fallback:
    // это основной и единственный движок данного режима.
    private val delegate = GlensOcrEngine()

    override suspend fun recognizeText(image: Bitmap): String = withContext(Dispatchers.IO) {
        require(!image.isRecycled) { "Input bitmap is recycled" }

        logcat(LogPriority.INFO) { "Free OCR (no API key): Google Lens backend" }

        // Счётчик токенов здесь намеренно НЕ увеличивается: бесплатный режим
        // не тратит токенов, а прежняя оценка (длина текста * 1.5) показывала
        // пользователю несуществующий расход.
        delegate.recognizeText(image)
    }

    override fun close() {
        delegate.close()
    }
}
