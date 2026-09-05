package eu.kanade.presentation.reader.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import eu.kanade.tachiyomi.data.tts.AutoReadEngine
import mihon.domain.ocr.service.OcrPreferences
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import kotlin.math.roundToInt

/**
 * «Линейка чтения»: подсветка текущей озвучиваемой реплики.
 *
 * Вид настраивается (Настройки → Озвучка):
 * - [OcrPreferences.highlightColor] — цвет пятна/рамки/линии;
 * - [OcrPreferences.highlightStyle] — `bubble` (мягкие еле заметные кружки,
 *   по умолчанию), `box` (рамка), `underline` (подчёркивание) или `both`;
 * - [OcrPreferences.highlightWidth] — толщина в dp для box/underline.
 *
 * В режиме `bubble` никакие прямоугольники не рисуются вообще: текущая
 * реплика — радиальное пятно-круг, сходящее к нулю на краях, а история и
 * план чтения — совсем тусклые кружки. Промах бокса при таком пятне не
 * режет глаз, в отличие от жёсткой рамки.
 *
 * Номер реплики показывается рядом с рамкой: он нужен глазами, чтобы видеть
 * порядок чтения, но в озвучку не попадает (снимается SpeechMarkup.strip).
 */
@Composable
fun AutoReadHighlight(
    region: AutoReadEngine.SpokenRegion,
    modifier: Modifier = Modifier,
    engine: AutoReadEngine? = null,
    /** The actual displayed image rect within the parent (0..1 normalized).
     *  When null, falls back to the full composable area (may be wrong
     *  with letterboxed images). Set this from ReaderPageImageView.displayedImageLocalRect(). */
    imageRect: android.graphics.RectF? = null,
) {
    val prefs = remember { Injekt.get<OcrPreferences>() }
    // Не кэшируем навсегда: пользователь меняет цвет в настройках — рамки
    // перекрашиваются со следующей реплики, без перезапуска читалки
    val accent = Color(prefs.highlightColor().get().toULong().toLong())
    val style = prefs.highlightStyle().get()
    val strokeWidth = prefs.highlightWidth().get().coerceIn(1f, 12f)

    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        val density = LocalDensity.current

        // Карта кадра: прочитанные (тускло), текущая (ярко), будущие (пунктир).
        // Видно и историю, и предстоящий план чтения.
        val frameRegions: List<AutoReadEngine.FrameRegion> = if (engine != null) {
            engine.frameRegions.collectAsState().value
        } else {
            emptyList()
        }
        val imgFr = imageRect
        val iwFr = if (imgFr != null) (imgFr.right - imgFr.left) * w else w
        val ihFr = if (imgFr != null) (imgFr.bottom - imgFr.top) * h else h
        val ixFr = if (imgFr != null) imgFr.left * w else 0f
        val iyFr = if (imgFr != null) imgFr.top * h else 0f
        for (fr in frameRegions) {
            if (fr.state == AutoReadEngine.FrameRegion.State.CURRENT) continue // текущую рисуем ниже ярче
            val b = engine?.mapToViewport(fr.box) ?: fr.box
            val done = fr.state == AutoReadEngine.FrameRegion.State.DONE
            if (style == "bubble") {
                // Еле прозрачный кружок: прочитанное — совсем тускло,
                // предстоящее — чуть заметнее. Без единого прямого угла.
                val frW = with(density) { ((b.right - b.left) * iwFr).toDp() }
                val frH = with(density) { ((b.bottom - b.top) * ihFr).toDp() }
                val sideDp = maxOf(frW, frH) * 1.5f
                val sidePx = with(density) { sideDp.toPx() }
                val cx = ixFr + (b.left + b.right) / 2f * iwFr
                val cy = iyFr + (b.top + b.bottom) / 2f * ihFr
                Box(
                    modifier = Modifier
                        .offset {
                            IntOffset(
                                (cx - sidePx / 2f).roundToInt(),
                                (cy - sidePx / 2f).roundToInt(),
                            )
                        }
                        .width(sideDp)
                        .height(sideDp)
                        .background(
                            color = accent.copy(alpha = if (done) 0.04f else 0.08f),
                            shape = CircleShape,
                        ),
                )
            } else {
                val frW = with(density) { ((b.right - b.left) * iwFr).toDp() }
                val frH = with(density) { ((b.bottom - b.top) * ihFr).toDp() }
                Box(
                    modifier = Modifier
                        .offset {
                            IntOffset(
                                (ixFr + b.left * iwFr).roundToInt(),
                                (iyFr + b.top * ihFr).roundToInt(),
                            )
                        }
                        .width(frW)
                        .height(frH)
                        .border(
                            width = 1.5.dp,
                            color = if (done) {
                                accent.copy(alpha = 0.25f)
                            } else {
                                accent.copy(alpha = 0.55f)
                            },
                            shape = RoundedCornerShape(4.dp),
                        )
                        .background(
                            if (done) accent.copy(alpha = 0.05f) else Color.Transparent,
                            RoundedCornerShape(4.dp),
                        ),
                )
            }
        }

        val img = imageRect
        val iw = if (img != null) (img.right - img.left) * w else w
        val ih = if (img != null) (img.bottom - img.top) * h else h
        val ix = if (img != null) img.left * w else 0f
        val iy = if (img != null) img.top * h else 0f
        val mapped = engine?.mapToViewport(region.box) ?: region.box
        // Санитария: вырожденный бокс (узкая полоса во всю высоту) — мусор
        // маппинга, а не реплика: схлопываем в точку, рисовать нечего.
        val mappedSafe = if ((mapped.right - mapped.left) < 0.12f || (mapped.bottom - mapped.top) > 0.92f) {
            mihon.domain.ocr.model.OcrBoundingBox(
                left = mapped.left,
                top = mapped.top,
                right = mapped.left,
                bottom = mapped.top,
            )
        } else {
            mapped
        }
        val boxWidth = with(density) { ((mappedSafe.right - mappedSafe.left) * iw).toDp() }
        val boxHeight = with(density) { ((mappedSafe.bottom - mappedSafe.top) * ih).toDp() }
        val offsetModifier = Modifier.offset {
            IntOffset(
                (ix + mappedSafe.left * iw).roundToInt(),
                (iy + mappedSafe.top * ih).roundToInt(),
            )
        }

        if (style == "bubble") {
            // Мягкий круг: радиальное пятно с центром на реплике, полностью
            // сходит в ноль — ни рамки, ни капсулы, ни «прямоугольника в
            // высоту». Диаметр чуть больше реплики, чтобы накрыть текст.
            val sideDp = maxOf(boxWidth, boxHeight) * 1.6f
            val sidePx = with(density) { sideDp.toPx() }
            val cx = ix + (mappedSafe.left + mappedSafe.right) / 2f * iw
            val cy = iy + (mappedSafe.top + mappedSafe.bottom) / 2f * ih
            Box(
                modifier = Modifier
                    .offset {
                        IntOffset(
                            (cx - sidePx / 2f).roundToInt(),
                            (cy - sidePx / 2f).roundToInt(),
                        )
                    }
                    .width(sideDp)
                    .height(sideDp)
                    .background(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                accent.copy(alpha = 0.16f),
                                accent.copy(alpha = 0.06f),
                                Color.Transparent,
                            ),
                        ),
                        shape = CircleShape,
                    ),
            )
        }

        if (style == "box" || style == "both") {
            Box(
                modifier = offsetModifier
                    .width(boxWidth)
                    .height(boxHeight)
                    .border(
                        width = strokeWidth.dp,
                        color = accent,
                        shape = RoundedCornerShape(6.dp),
                    )
                    .background(accent.copy(alpha = 0.14f), RoundedCornerShape(6.dp)),
            )
        }

        if (style == "underline" || style == "both") {
            // Подчёркивание: линия по нижней границе реплики.
            // Считаем по iw/ih и со смещением ix/iy — как рамка выше. Раньше
            // здесь стояло w/h без смещения, поэтому линия уезжала от текста
            // тем сильнее, чем больше поля вокруг страницы.
            Box(
                modifier = Modifier
                    .offset {
                        IntOffset(
                            (ix + mappedSafe.left * iw).roundToInt(),
                            (iy + mappedSafe.bottom * ih).roundToInt(),
                        )
                    }
                    .width(boxWidth)
                    .height(strokeWidth.dp)
                    .background(accent, RoundedCornerShape(strokeWidth.dp / 2)),
            )
        }
    }
}
