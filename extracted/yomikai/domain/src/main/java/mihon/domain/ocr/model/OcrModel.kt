package mihon.domain.ocr.model

/**
 * Represents the available OCR and AI vision models.
 */
enum class OcrModel {
    /**
     * Default downloadable Russian/Cyrillic offline engine: PP-OCRv3 with
     * PP-OCRv5 verifier and PP-OCRv4 text detector.
     */
    CYRILLIC,

    /**
     * Legacy and slower model, supports GPU/CPU.
     */
    LEGACY,

    /**
     * Faster model designed for ARM CPU.
     */
    FAST,

    /**
     * Online Google Lens OCR model.
     */
    GLENS,

    /**
     * Self-hosted OwOCR model.
     */
    OWOCR,

    /**
     * OpenRouter online AI model.
     */
    OPENROUTER,

    /**
     * Google AI / Gemini Vision model.
     */
    GOOGLE,

    /**
     * Бесплатный режим без ключа и без настройки.
     *
     * Исполняется движком Google Lens: бесплатные модели провайдера Zen
     * не принимают изображения ("No endpoints found that support image
     * input"), поэтому OCR через них невозможен.
     */
    ZEN_FREE,

    /**
     * Полностью офлайн Tesseract (модели eng+rus в tar.xz внутри APK,
     * активируются только при включении движка).
     */
    TESSERACT,
}
