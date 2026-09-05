package mihon.data.ocr

import mihon.domain.ocr.model.OcrBoundingBox

/**
 * Перевод координат текстовых боксов из пикселей изображения в нормализованные
 * (0..1) координаты, которыми оперирует [OcrBoundingBox].
 *
 * Вынесено отдельно от движка: это чистая арифметика без Android-зависимостей,
 * поэтому её можно проверить обычным юнит-тестом.
 */
internal object OcrBoxGeometry {

    /** Тип текстового бокса: пресет обработки привязывается к облачку сам. */
    enum class Kind { BUBBLE, CAPTION, VERTICAL }

    /**
     * Классификация бокса без модели: по геометрии относительно страницы.
     *  - VERTICAL — высокое и узкое (вертикальная разметка): кадр поворачиваем;
     *  - CAPTION — широкая низкая плашка у края страницы или очень широкая:
     *    подписи читаются словарным DP без «пузырной» эвристики;
     *  - BUBBLE — всё остальное (реплики в пузырях).
     */
    fun classifyKind(
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
        imageWidth: Int,
        imageHeight: Int,
    ): Kind {
        val w = (right - left).coerceAtLeast(1)
        val h = (bottom - top).coerceAtLeast(1)
        if (imageWidth <= 0 || imageHeight <= 0) return Kind.BUBBLE
        if (h > 2.2f * w) return Kind.VERTICAL
        val atEdge = top < imageHeight * 0.12f || bottom > imageHeight * 0.88f
        return if ((w >= 2.6f * h && atEdge) || w >= 4.5f * h) Kind.CAPTION else Kind.BUBBLE
    }


    /**
     * @return нормализованный бокс или null, если он вырожденный либо
     * изображение имеет нулевой размер.
     */
    fun normalize(
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
        imageWidth: Int,
        imageHeight: Int,
    ): OcrBoundingBox? {
        if (imageWidth <= 0 || imageHeight <= 0) return null
        if (right <= left || bottom <= top) return null

        val l = (left.toFloat() / imageWidth).coerceIn(0f, 1f)
        val t = (top.toFloat() / imageHeight).coerceIn(0f, 1f)
        val r = (right.toFloat() / imageWidth).coerceIn(0f, 1f)
        val b = (bottom.toFloat() / imageHeight).coerceIn(0f, 1f)

        val box = OcrBoundingBox(l, t, r, b)
        return box.takeIf { it.isValid() }
    }

    /**
     * Бокс занимает практически весь лист.
     *
     * Такие регионы бесполезны как цель для тапа (см. OcrRegion.isWholePage):
     * если детектор вернул один бокс на всю страницу, лучше считать, что
     * разметки нет, и не плодить нетапабельные регионы.
     */
    fun coversWholePage(box: OcrBoundingBox): Boolean {
        return box.left <= 0.02f &&
            box.top <= 0.02f &&
            box.right >= 0.98f &&
            box.bottom >= 0.98f
    }
}
