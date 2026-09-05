package mihon.data.ocr

import android.graphics.Path
import android.graphics.RectF
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.PI

/**
 * Продвинутые формы рамки сканирования.
 *
 * Запрос пользователя: квадратные, круглые, ромбовидные, восьмеркой и другие фигуры.
 * Каждая форма генерирует [Path] в координатах оверлея (0..width, 0..height),
 * который используется для:
 *  - визуальной рамки (drawPath с подсветкой)
 *  - обрезки Bitmap (clipPath) перед отправкой в OCR — вне фигуры текст игнорируется
 *  - стриминг-подсветки: слово подсвечивается сразу после распознавания слова
 *
 * Поддерживается 7 форм; `FREE` — произвольный путь, рисуемый пальцем.
 */
enum class ScanShape(
    val id: String,
    val title: String,
    val icon: String,
) {
    RECT("rect", "Прямоугольник", "▭"),
    CIRCLE("circle", "Круг", "○"),
    DIAMOND("diamond", "Ромб", "◇"),
    HEXAGON("hexagon", "Шестиугольник", "⬡"),
    OCTAGON("octagon", "Восьмиугольник", "⬢"),
    FIGURE8("figure8", "Восьмёрка", "∞"),
    FREE("free", "Произвольная", "✎"),
    ;

    companion object {
        fun fromId(id: String?): ScanShape = entries.firstOrNull { it.id == id } ?: RECT
        val allIds: List<String> get() = entries.map { it.id }
    }

    /**
     * Построить Path фигуры, вписанной в [bounds].
     * Для FIGURE8 — два круга, для FREE — ожидается внешняя установка.
     */
    fun buildPath(bounds: RectF, freePath: Path? = null): Path {
        if (this == FREE && freePath != null) return freePath
        val path = Path()
        val cx = bounds.centerX()
        val cy = bounds.centerY()
        val w = bounds.width()
        val h = bounds.height()
        val r = min(w, h) / 2f

        when (this) {
            RECT -> path.addRect(bounds, Path.Direction.CW)
            CIRCLE -> path.addCircle(cx, cy, r, Path.Direction.CW)
            DIAMOND -> {
                path.moveTo(cx, bounds.top)
                path.lineTo(bounds.right, cy)
                path.lineTo(cx, bounds.bottom)
                path.lineTo(bounds.left, cy)
                path.close()
            }
            HEXAGON -> polygon(path, cx, cy, r, sides = 6, rotationDeg = 30f)
            OCTAGON -> polygon(path, cx, cy, r, sides = 8, rotationDeg = 22.5f)
            FIGURE8 -> {
                // Две окружности, касающиеся центром — классическая «8»
                val r2 = min(w / 2f * 0.48f, h * 0.42f)
                val topCy = bounds.top + r2 + h * 0.05f
                val bottomCy = bounds.bottom - r2 - h * 0.05f
                path.addCircle(cx, topCy, r2, Path.Direction.CW)
                path.addCircle(cx, bottomCy, r2, Path.Direction.CW)
                // Связка убирается — merge двух кругов
                path.fillType = Path.FillType.EVEN_ODD
            }
            FREE -> path.addRect(bounds, Path.Direction.CW) // fallback
        }
        return path
    }

    private fun polygon(path: Path, cx: Float, cy: Float, radius: Float, sides: Int, rotationDeg: Float) {
        val rot = Math.toRadians(rotationDeg.toDouble())
        for (i in 0 until sides) {
            val angle = rot + 2 * PI * i / sides - PI / 2
            val x = cx + radius * cos(angle).toFloat()
            val y = cy + radius * sin(angle).toFloat()
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        path.close()
    }
}
