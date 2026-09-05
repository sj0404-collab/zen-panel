package mihon.data.ocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import com.google.ai.edge.litert.Accelerator
import com.google.ai.edge.litert.CompiledModel
import com.google.ai.edge.litert.Environment
import com.google.ai.edge.litert.TensorBuffer
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import logcat.LogPriority
import mihon.domain.ocr.exception.OcrException
import mihon.domain.ocr.model.OcrBoundingBox
import tachiyomi.core.common.util.system.logcat
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round

/**
 * Downloadable Russian/Cyrillic OCR based on PaddleOCR mobile TFLite models.
 *
 * The detector finds text-line blobs on a full page. PP-OCRv3 recognizes each
 * crop; PP-OCRv5 is evaluated for every Cyrillic crop and ranked against v3.
 * No dictionary spell replacement is performed: benchmarks showed that
 * it could turn a visually correct word (for example "мятой") into a wrong but
 * frequent dictionary word. Models live outside the APK in ocr_models/.
 */
internal class CyrillicOcrEngine(
    private val context: Context,
    private val environment: Environment,
    private val textPostprocessor: TextPostprocessor,
    /**
     * Параметры детектора и признания результата. Провайдер, а не значение:
     * пресет типа контента и ручные переопределения меняются в настройках без
     * пересоздания движка и без повторной загрузки моделей.
     */
    private val tuningProvider: () -> OcrTuning = { OcrTuning.DEFAULT },
) : LineOcrEngine {

    private fun tuning(): OcrTuning = tuningProvider()

    private lateinit var detector: CompiledModel
    private lateinit var primary: CompiledModel
    private var verifier: CompiledModel? = null

    private lateinit var detectorInput: TensorBuffer
    private lateinit var detectorOutput: TensorBuffer
    private lateinit var primaryInput: TensorBuffer
    private lateinit var primaryOutput: TensorBuffer
    private var verifierInput: TensorBuffer? = null
    private var verifierOutput: TensorBuffer? = null

    private lateinit var primaryChars: List<String>
    private var verifierChars: List<String>? = null

    private val detectorPixels = IntArray(DETECTOR_SIZE * DETECTOR_SIZE)
    private val detectorFloats = FloatArray(DETECTOR_SIZE * DETECTOR_SIZE * 3)
    private val recognizerPixels = IntArray(RECOGNIZER_HEIGHT * RECOGNIZER_WIDTH)
    private val recognizerFloats = FloatArray(RECOGNIZER_HEIGHT * RECOGNIZER_WIDTH * 3)
    private val componentQueue = IntArray(DETECTOR_SIZE * DETECTOR_SIZE)
    private val visited = BooleanArray(DETECTOR_SIZE * DETECTOR_SIZE)

    private lateinit var detectorBitmap: Bitmap
    private lateinit var detectorCanvas: Canvas
    private lateinit var detectorPaint: Paint
    private lateinit var recognizerBitmap: Bitmap
    private lateinit var recognizerCanvas: Canvas
    private lateinit var recognizerPaint: Paint

    private val mutex = Mutex()

    @Volatile
    private var initialized = false

    private data class TextBox(val rect: Rect) {
        val centerY: Float get() = (rect.top + rect.bottom) / 2f
        val height: Int get() = rect.height()
    }

    private enum class RecognitionModel { V3, V5 }

    private data class Recognition(
        val text: String,
        val confidence: Float,
        val model: RecognitionModel = RecognitionModel.V3,
        /**
         * Доля «пустых» шагов внутри распознанной подстроки: признак выпавших
         * букв. См. [CtcScoring.innerBlankCoverage].
         */
        val coverage: Float = 0f,
    )

    suspend fun ensureInitialized() {
        if (initialized) return
        mutex.withLock {
            if (!initialized && !init()) throw OcrException.InitializationError()
        }
    }

    private fun init(): Boolean {
        val detectorPath = OcrModelFiles.resolve(context, DETECTOR_PATH) ?: return missing(DETECTOR_PATH)
        val primaryPath = OcrModelFiles.resolve(context, PRIMARY_PATH) ?: return missing(PRIMARY_PATH)
        val primaryDict = OcrModelFiles.resolve(context, PRIMARY_DICT_PATH) ?: return missing(PRIMARY_DICT_PATH)
        val verifierPath = OcrModelFiles.resolve(context, VERIFIER_PATH)
        val verifierDict = OcrModelFiles.resolve(context, VERIFIER_DICT_PATH)

        return runCatching {
            val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 4)
            val options = CompiledModel.Options(Accelerator.CPU).apply {
                cpuOptions = CompiledModel.CpuOptions(threads, null, null)
            }
            detector = CompiledModel.create(detectorPath, options, environment)
            primary = CompiledModel.create(primaryPath, options, environment)
            verifier = if (verifierPath != null && verifierDict != null) {
                CompiledModel.create(verifierPath, options, environment)
            } else {
                null
            }

            detectorInput = detector.createInputBuffers()[0]
            detectorOutput = detector.createOutputBuffers()[0]
            primaryInput = primary.createInputBuffers()[0]
            primaryOutput = primary.createOutputBuffers()[0]
            verifierInput = verifier?.createInputBuffers()?.get(0)
            verifierOutput = verifier?.createOutputBuffers()?.get(0)

            primaryChars = readDictionary(primaryDict)
            verifierChars = verifierDict?.let(::readDictionary)

            detectorBitmap = Bitmap.createBitmap(DETECTOR_SIZE, DETECTOR_SIZE, Bitmap.Config.ARGB_8888)
            detectorCanvas = Canvas(detectorBitmap)
            detectorPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
            recognizerBitmap = Bitmap.createBitmap(RECOGNIZER_WIDTH, RECOGNIZER_HEIGHT, Bitmap.Config.ARGB_8888)
            recognizerCanvas = Canvas(recognizerBitmap)
            recognizerPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

            initialized = true
            logcat(LogPriority.INFO) {
                "Cyrillic OCR initialized (PP-OCRv3 + ${if (verifier != null) "PP-OCRv5 verifier" else "no verifier"})"
            }
            true
        }.onFailure { error ->
            logcat(LogPriority.ERROR, error) { "Failed to initialize Cyrillic OCR" }
            closeInternal()
        }.getOrDefault(false)
    }

    private fun missing(path: String): Boolean {
        logcat(LogPriority.INFO) { "Cyrillic OCR model is not installed: $path" }
        return false
    }

    private fun readDictionary(path: String): List<String> {
        val raw = java.io.File(path).readBytes()
        // Strip UTF-8 BOM (EF BB BF) if present — GitHub raw files
        // and some editors prepend it, causing the first dict entry
        // to be corrupted (e.g. "\uFEFFА" instead of "А").
        val text = if (raw.size >= 3 &&
            raw[0] == 0xEF.toByte() &&
            raw[1] == 0xBB.toByte() &&
            raw[2] == 0xBF.toByte()
        ) {
            String(raw, 3, raw.size - 3, Charsets.UTF_8)
        } else {
            decodeDictionaryBytes(raw)
        }
        return text.lines().dropLastWhile(String::isEmpty)
    }

    /**
     * Декодирует байты словаря, определяя кодировку по содержимому.
     *
     * `String(bytes, UTF_8)` НЕ бросает исключение на невалидных байтах —
     * он молча подставляет U+FFFD. Поэтому прежний `try/catch` с откатом на
     * windows-1251 не срабатывал никогда: словарь в 1251 превращался в
     * строку из «ромбиков», CTC-индексы указывали на мусор, и вместо
     * русского текста пользователь получал крякозябры.
     *
     * Здесь UTF-8 декодируется строго (CharsetDecoder с REPORT). При
     * повреждённом словаре инициализация прекращается, а не создаётся
     * визуально похожий, но неверный текст.
     */
    private fun decodeDictionaryBytes(raw: ByteArray): String {
        val strictUtf8 = java.nio.charset.StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        return strictUtf8.decode(java.nio.ByteBuffer.wrap(raw)).toString()
    }

    /**
     * Границы текстовых строк, найденные детектором PP-OCRv4, в
     * нормализованных координатах.
     *
     * Тот же проход, что и в [recognizeText], но без распознавания: нужен
     * репозиторию, чтобы построить регионы страницы (по региону на реплику)
     * вместо одного региона на весь лист. Раньше эту роль должен был играть
     * DetOcrEngine, но он оставался заглушкой, и детектор был доступен
     * только изнутри распознавания.
     */
    suspend fun detectRegions(image: Bitmap): List<OcrBoundingBox> {
        ensureInitialized()
        OcrStageBus.post(OcrStageBus.Stage.DETECTING)
        return mutex.withLock {
            require(!image.isRecycled) { "Input bitmap is recycled" }
            detectTextBoxes(image).mapNotNull { box ->
                OcrBoxGeometry.normalize(
                    left = box.rect.left,
                    top = box.rect.top,
                    right = box.rect.right,
                    bottom = box.rect.bottom,
                    imageWidth = image.width,
                    imageHeight = image.height,
                )
            }
        }
    }

    override suspend fun recognizeText(image: Bitmap): String {
        ensureInitialized()
        OcrTextCleanerStats.reset()
        return try {
        mutex.withLock {
            require(!image.isRecycled) { "Input bitmap is recycled" }
            val boxes = detectTextBoxes(image)
            OcrStageBus.post(OcrStageBus.Stage.RECOGNIZING, "боксов: ${boxes.size}")
            if (boxes.isEmpty()) {
                OcrStageBus.post(OcrStageBus.Stage.DONE, "рамки проекцией чернил")
                return@withLock recognizeWholeImageFallback(image)
            }

            // Отклонённые по уверенности строки запоминаются: это второй
            // rescue-эшелон (см. ниже).
            val rejected = mutableListOf<Pair<TextBox, Recognition>>()
            val recognized = boxes.mapNotNull { box ->
                val padded = pad(box.rect, image.width, image.height)
                if (padded.width() < 4 || padded.height() < 4) return@mapNotNull null
                val rawCrop = Bitmap.createBitmap(image, padded.left, padded.top, padded.width(), padded.height())
                // Вертикальное облачко (манхва/японская разметка): распознаватель
                // ждёт горизонтальную строку, поэтому поворачиваем кадр.
                val kind = OcrBoxGeometry.classifyKind(
                    padded.left, padded.top, padded.right, padded.bottom,
                    image.width, image.height,
                )
                val crop = if (kind == OcrBoxGeometry.Kind.VERTICAL) rotate90cw(rawCrop) else rawCrop
                try {
                    val result = recognizeLineBitmap(crop)
                    // Отбрасываем только совсем безнадёжное. Для коротких
                    // реплик («а», «а!», «а-а-а») используется более мягкий
                    // порог: длина сама по себе не является доказательством
                    // мусора.
                    if (result.text.isNotBlank() && acceptsConfidence(result)) {
                        box to result.text
                    } else {
                        if (result.text.isNotBlank()) rejected += box to result
                        null
                    }
                } finally {
                    if (crop !== rawCrop) crop.recycle()
                    rawCrop.recycle()
                }
            }
            if (recognized.isEmpty()) {
                // Цельностраничный rescue почти бесполезен для обычной подписи:
                // весь лист уменьшается до 320x48 и текст становится
                // нечитаемым. Поэтому сначала пробуем лучшие из отклонённых
                // строк — их детектор уже нашёл и вырезал по размеру.
                val rescued = rescueRejectedLines(rejected)
                if (rescued.isNotEmpty()) {
                    OcrStageBus.post(OcrStageBus.Stage.DONE, "rescue: ${rescued.length} символов")
                    return@withLock rescued
                }
                OcrStageBus.post(OcrStageBus.Stage.DONE, "цельностраничный rescue")
                return@withLock recognizeWholeImageFallback(image)
            }

            val rows = mutableListOf<MutableList<Pair<TextBox, String>>>()
            recognized.forEach { item ->
                val row = rows.firstOrNull { existing ->
                    val center = existing.map { it.first.centerY }.average().toFloat()
                    val height = existing.map { it.first.height }.average().toFloat()
                    abs(item.first.centerY - center) <= max(item.first.height.toFloat(), height) * 0.60f
                }
                if (row != null) row += item else rows += mutableListOf(item)
            }
            rows.sortBy { row -> row.minOf { it.first.rect.top } }
            val text = rows.joinToString("\n") { row ->
                row.sortedBy { it.first.rect.left }.joinToString(" ") { it.second.trim() }
            }
            val out = cleanRecognition(textPostprocessor.postprocess(text))
            OcrStageBus.post(
                OcrStageBus.Stage.DONE,
                "${out.length} симв | словарь: ${OcrTextCleanerStats.wordDictHits}, " +
                    "пунктуация: ${OcrTextCleanerStats.punctFixes}, " +
                    "разбиение: ${OcrTextCleanerStats.splitFixes}",
            )
            out
        }
        } catch (e: Exception) {
            OcrStageBus.post(OcrStageBus.Stage.FAILED, e.javaClass.simpleName)
            throw e
        }
    }

    /**
     * Второй rescue-эшелон: лучшие из строк, отклонённых по уверенности.
     *
     * Устройство сообщало о подписях, которые не дают никакого результата,
     * хотя детектор их видел. Первый эшелон ([recognizeWholeImageFallback])
     * здесь почти не помогает: он уменьшает весь лист до 320x48, и компактная
     * подпись становится нечитаемой. Здесь же берутся уже вырезанные по боксам
     * кропы — тот же материал, который не прошёл порог уверенности.
     *
     * Возвращается результат только если он проходит все текстовые фильтры
     * (кириллица, «словарная лесенка», пословный salvage). Ничего не
     * додумывается: это выбор лучшего из уже распознанного.
     */
    private fun rescueRejectedLines(rejected: List<Pair<TextBox, Recognition>>): String {
        if (rejected.isEmpty()) return ""
        val candidates = rejected
            .map { (box, recognition) -> box to recognition.text.trim() }
            .filter { (_, text) -> text.isNotBlank() }
            .sortedByDescending { (_, text) -> text.count(Char::isLetter) }
            .take(tuning().rescueMaxLines)
        if (candidates.isEmpty()) return ""

        val rows = mutableListOf<MutableList<Pair<TextBox, String>>>()
        candidates.forEach { item ->
            val row = rows.firstOrNull { existing ->
                val center = existing.map { it.first.centerY }.average().toFloat()
                val height = existing.map { it.first.height }.average().toFloat()
                abs(item.first.centerY - center) <= max(item.first.height.toFloat(), height) * 0.60f
            }
            if (row != null) row += item else rows += mutableListOf(item)
        }
        rows.sortBy { row -> row.minOf { it.first.rect.top } }
        val text = rows.joinToString("\n") { row ->
            row.sortedBy { it.first.rect.left }.joinToString(" ") { it.second }
        }
        return cleanRecognition(textPostprocessor.postprocess(text))
    }

    /**
     * Последний локальный rescue-проход для больших облачков и декоративных
     * шрифтов, которые детектор видит, но построчный путь не принимает. Он
     * возвращает только валидный кириллический результат; это не словарная
     * генерация и не облачный fallback.
     */
    private fun recognizeWholeImageFallback(image: Bitmap): String {
        val result = recognizeCrop(image)
        if (result.text.isBlank() || !acceptsConfidence(result)) return ""
        return cleanRecognition(textPostprocessor.postprocess(result.text))
    }

    /**
     * Распознавание ОДНОЙ вырезанной строки (кроп по боксу детектора).
     *
     * В отличие от [recognizeText] не запускает детектор повторно: строка уже
     * вырезана, а второй проход detectTextBoxes() по кропу дробил надпись на
     * фрагменты букв, и распознаватель выдавал мусор вместо реплики.
     */
    override suspend fun recognizeLine(image: Bitmap): String {
        ensureInitialized()
        return mutex.withLock {
            require(!image.isRecycled) { "Input bitmap is recycled" }
            if (image.width < 4 || image.height < 4) return@withLock ""
            val result = recognizeLineBitmap(image)
            if (result.text.isBlank() || !acceptsConfidence(result)) {
                return@withLock ""
            }
            cleanRecognition(textPostprocessor.postprocess(result.text))
        }
    }

    /**
     * Распознаёт вырезанную детектором строку: сначала режет её на слова по
     * вертикальной проекции «чернил» (как _split_horizontal_words в Python-
     * пайплайне репозитория моделей), потом распознаёт каждое слово отдельно.
     *
     * Детектор PP-OCR склеивает короткую строку в один бокс, а распознаватель
     * обучен на отдельных словах и на целой строке не выдаёт пробелов:
     * «И ПАЛ ПОД ЛЕЗВИЕМ» выходило как «ИПАЛПОДЛЕЗВИЕМ».
     */
    private fun recognizeLineBitmap(crop: Bitmap): Recognition {
        val words = splitWords(crop)
        // PP-OCRv5 надёжно читает многие компактные строковые подписи целиком,
        // но в CTC-выходе не ставит пробелы. Не заменяем целую строку только
        // нарезанными словами: на тонких буквах нарезка может обрезать край
        // глифа и вернуть пустой результат, хотя полный кроп читается верно.
        val wholeLine = recognizeCrop(crop)
        if (words.size == 1) return wholeLine
        val sb = StringBuilder()
        var confSum = 0f
        var recognizedCount = 0
        for (piece in words) {
            try {
                val r = recognizeCrop(piece)
                if (r.text.isNotBlank()) {
                    confSum += r.confidence
                    recognizedCount++
                    if (sb.isNotEmpty()) sb.append(' ')
                    sb.append(r.text)
                }
            } finally {
                piece.recycle()
            }
        }
        val segmented = Recognition(
            text = sb.toString().trim(),
            confidence = if (recognizedCount == 0) 0f else confSum / recognizedCount,
            model = wholeLine.model,
            coverage = wholeLine.coverage,
        )
        return selectLineRecognition(wholeLine, segmented)
    }

    /**
     * Выбирает между полной строкой и визуально разрезанными словами.
     * Полный вариант допускается только если консервативная постобработка уже
     * способна восстановить в нём реальные границы слов. Это не словарная
     * подмена: неизвестные слитные последовательности не получают бонуса и
     * остаются на пути с визуальными промежутками.
     */
    private fun selectLineRecognition(wholeLine: Recognition, segmented: Recognition): Recognition {
        if (segmented.text.isBlank()) return wholeLine
        if (wholeLine.text.isBlank()) return segmented

        val restoredWhole = OcrTextCleaner.normalizeLocalCyrillicCaption(wholeLine.text)
        val restoresBoundaries = restoredWhole.count(Char::isWhitespace) > wholeLine.text.count(Char::isWhitespace)
        val wholeQuality = candidateQuality(wholeLine) + if (restoresBoundaries) tuning().wholeLineBoundaryBonus else 0f
        val segmentedQuality = candidateQuality(segmented)
        return if (restoresBoundaries && wholeQuality >= segmentedQuality) wholeLine else segmented
    }

    /**
     * Вертикальная проекция чернил + порог Оцу: широкие пробелы между словами
     * разделяют кроп. Если явной щели нет — кроп остаётся целым.
     */
    private fun splitWords(crop: Bitmap): List<Bitmap> {
        if (crop.width < tuning().splitMinWidthPx) return listOf(crop)
        val w = crop.width
        val h = crop.height
        val pixels = IntArray(w * h)
        crop.getPixels(pixels, 0, w, 0, 0, w, h)
        val gray = IntArray(w * h)
        val hist = IntArray(256)
        for (i in pixels.indices) {
            val p = pixels[i]
            val lum = (77 * ((p shr 16) and 0xFF) + 150 * ((p shr 8) and 0xFF) + 29 * (p and 0xFF)) shr 8
            gray[i] = lum
            hist[lum]++
        }
        // Порог Оцу по гистограмме яркости.
        var sumAll = 0L
        for (v in 0..255) sumAll += v * hist[v]
        val total = (w * h).toLong()
        var sumB = 0L
        var wB = 0L
        var maxBetween = -1.0
        var otsu = 127
        for (v in 0..255) {
            wB += hist[v]
            if (wB == 0L) continue
            val wF = total - wB
            if (wF == 0L) break
            sumB += v * hist[v]
            val mB = sumB.toDouble() / wB
            val mF = (sumAll - sumB).toDouble() / wF
            val between = wB.toDouble() * wF * (mB - mF) * (mB - mF)
            if (between > maxBetween) {
                maxBetween = between
                otsu = v
            }
        }
        fun inkColumns(lightInk: Boolean): IntArray {
            // Balloon borders are often long solid black/white rows. Counting
            // their pixels as ink marks every column as occupied and prevents
            // spaces from being split. Exclude only near-full rows; glyph rows
            // retain their normal sparse stroke pattern.
            val usableRows = BooleanArray(h)
            var usableRowCount = 0
            for (y in 0 until h) {
                var active = 0
                for (x in 0 until w) {
                    val g = gray[y * w + x]
                    if (if (lightInk) g > otsu else g < otsu) active++
                }
                if (active in 1 until (w * 0.72f).toInt().coerceAtLeast(1)) {
                    usableRows[y] = true
                    usableRowCount++
                }
            }
            // A crop can be a very bold word whose strokes occupy most rows.
            // In that case retain the central band instead of discarding all
            // signal, while still ignoring possible frame edges.
            val useCentralBand = usableRowCount < max(2, h / 6)
            val margin = max(1, h / 10)
            val col = IntArray(w)
            for (x in 0 until w) {
                var c = 0
                for (y in 0 until h) {
                    if (useCentralBand && (y < margin || y >= h - margin)) continue
                    if (!useCentralBand && !usableRows[y]) continue
                    val g = gray[y * w + x]
                    if (if (lightInk) g > otsu else g < otsu) c++
                }
                col[x] = c
            }
            return col
        }
        // Тёмные чернила на светлом фоне; если фон тёмный (светлый текст) —
        // большинство колонок «активны», тогда инвертируем.
        var ink = inkColumns(false)
        if (ink.count { it > 0 } > w * 7 / 10) ink = inkColumns(true)
        val runs = mutableListOf<IntArray>()
        var start = -1
        for (x in 0 until w) {
            if (ink[x] > 0) {
                if (start < 0) start = x
            } else if (start >= 0) {
                runs.add(intArrayOf(start, x - 1))
                start = -1
            }
        }
        if (start >= 0) runs.add(intArrayOf(start, w - 1))
        if (runs.size < 2) return listOf(crop)
        val gaps = IntArray(runs.size - 1) { i -> runs[i + 1][0] - runs[i][1] - 1 }
        val positive = gaps.filter { it > 0 }.sorted()
        val median = if (positive.isEmpty()) 1.0 else positive[positive.size / 2].toDouble()
        val threshold = max(tuning().minWordGapPx, round(median * tuning().wordGapFactor).toInt())
        var splitAfter = 0
        val groups = mutableListOf<IntArray>()
        var groupStart = runs[0][0]
        for (i in gaps.indices) {
            if (gaps[i] >= threshold) {
                groups.add(intArrayOf(groupStart, runs[i][1]))
                groupStart = runs[i + 1][0]
                splitAfter++
            }
        }
        if (splitAfter == 0) return listOf(crop)
        groups.add(intArrayOf(groupStart, runs[runs.size - 1][1]))
        if (groups.size <= 1) return listOf(crop)
        return groups.map { g ->
            val left = max(0, g[0] - 4)
            val right = min(w, g[1] + 5)
            Bitmap.createBitmap(crop, left, 0, max(1, right - left), h)
        }
    }

    /**
     * Пословная правка омоглифов и фильтр мусора «словарной лесенкой».
     * Пословная — чтобы чистая латынь («SOS», «Wi-Fi») оставалась латынью и
     * TTS не читал её по буквам внутри русских слов.
     */
    private fun acceptsConfidence(result: Recognition): Boolean {
        val letters = result.text.count(Char::isLetter)
        val threshold = if (letters in 1..3) {
            tuning().shortTextMinConfidence
        } else {
            tuning().minAcceptConfidence
        }
        // Пропущенные в середине слова шаги (blank) понижают уверенность:
        // «лжн вбинен» вместо «ЛОЖНО ОБВИНЁН» больше не проходит как хороший
        // результат только потому, что уцелевшие буквы были прочитаны чётко.
        val discounted = CtcScoring.coveragePenalty(result.confidence, result.coverage, tuning().minCoverage)
        return discounted >= threshold
    }

    private fun cleanRecognition(text: String): String {
        // Склеиваем переносы с дефисом ДО того, как postprocessing превратит
        // строковые границы в пробелы. Иначе «НЕУПРАВ-\nЛЯЕМЫЙ» остаётся в
        // интерфейсе как ложное «НЕУПРАВ- ЛЯЕМЫЙ».
        val cleaned = OcrTextCleaner.normalizeLocalCyrillicCaption(text).trim()
        if (cleaned.isEmpty() || OcrTextCleaner.looksLikeDictionaryRamp(cleaned)) return ""
        if (OcrTextCleaner.isAcceptableCyrillicOcrText(cleaned)) return cleaned
        // Один мусорный токен больше не обнуляет всю подпись: чистая
        // кириллица сохраняется, а сомнительные строки остаются как есть.
        return OcrTextCleaner.filterGarbageTokens(cleaned)
    }

    private fun detectTextBoxes(image: Bitmap): List<TextBox> {
        val boxes = runDetection(image, 0, 0).toMutableList()
        // Тайловая развёртка: на страницах высокого разрешения мелкие
        // облачка исчезают, когда весь лист ужат в квадрат детектора, —
        // прогоняем модель дополнительно по плиткам 2×2 с перекрытием 12%.
        if (max(image.width, image.height) > DETECTOR_SIZE) {
            val overX = (image.width * 0.12f).toInt()
            val overY = (image.height * 0.12f).toInt()
            val halfW = image.width / 2
            val halfH = image.height / 2
            val tiles = listOf(
                intArrayOf(0, 0, halfW + overX, halfH + overY),
                intArrayOf(halfW - overX, 0, image.width, halfH + overY),
                intArrayOf(0, halfH - overY, halfW + overX, image.height),
                intArrayOf(halfW - overX, halfH - overY, image.width, image.height),
            )
            for (t in tiles) {
                val l = t[0].coerceAtLeast(0)
                val tp = t[1].coerceAtLeast(0)
                val r = t[2].coerceAtMost(image.width)
                val bt = t[3].coerceAtMost(image.height)
                if (r - l < 96 || bt - tp < 96) continue
                val crop = Bitmap.createBitmap(image, l, tp, r - l, bt - tp)
                try {
                    boxes += runDetection(crop, l, tp)
                } finally {
                    crop.recycle()
                }
            }
        }
        val merged = mergeBoxes(boxes, tuning())
        // Облачков нет, но текст есть: рамки строятся проекцией чернил —
        // текст не должен теряться из-за того, что детектор не нашёл пузырь.
        if (merged.isEmpty()) return projectionBoxes(image)
        return merged.take(tuning().maxTextBoxes).map(::TextBox)
    }

    /** Один проход детектора по области; координаты — в системе исходника. */
    private fun runDetection(source: Bitmap, offX: Int, offY: Int): List<Rect> {

        detectorCanvas.drawColor(Color.WHITE)
        val scale = min(DETECTOR_SIZE.toFloat() / source.width, DETECTOR_SIZE.toFloat() / source.height)
        val scaledWidth = max(1, (source.width * scale).toInt())
        val scaledHeight = max(1, (source.height * scale).toInt())
        val offsetX = (DETECTOR_SIZE - scaledWidth) / 2
        val offsetY = (DETECTOR_SIZE - scaledHeight) / 2
        detectorCanvas.drawBitmap(
            source,
            null,
            Rect(offsetX, offsetY, offsetX + scaledWidth, offsetY + scaledHeight),
            detectorPaint,
        )
        detectorBitmap.getPixels(detectorPixels, 0, DETECTOR_SIZE, 0, 0, DETECTOR_SIZE, DETECTOR_SIZE)

        var out = 0
        detectorPixels.forEach { pixel ->
            val r = (pixel shr 16) and 0xFF
            val g = (pixel shr 8) and 0xFF
            val b = pixel and 0xFF
            // Модели PaddleOCR обучены в BGR (OpenCV): синий канал идёт первым,
            // константы нормализации — по позициям каналов, как в rapidocr.
            detectorFloats[out++] = (b / 255f - 0.485f) / 0.229f
            detectorFloats[out++] = (g / 255f - 0.456f) / 0.224f
            detectorFloats[out++] = (r / 255f - 0.406f) / 0.225f
        }
        detectorInput.writeFloat(detectorFloats)
        detector.run(listOf(detectorInput), listOf(detectorOutput))
        val probability = detectorOutput.readFloat()
        if (probability.size < DETECTOR_SIZE * DETECTOR_SIZE) return emptyList()

        visited.fill(false)
        val boxes = mutableListOf<Rect>()
        val limit = DETECTOR_SIZE * DETECTOR_SIZE
        for (start in 0 until limit) {
            if (visited[start] || probability[start] < tuning().detectorThreshold) continue
            var head = 0
            var tail = 0
            componentQueue[tail++] = start
            visited[start] = true
            var minX = DETECTOR_SIZE
            var minY = DETECTOR_SIZE
            var maxX = 0
            var maxY = 0
            var area = 0
            while (head < tail) {
                val index = componentQueue[head++]
                val x = index % DETECTOR_SIZE
                val y = index / DETECTOR_SIZE
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)
                area++
                for (dy in -1..1) for (dx in -1..1) {
                    if (dx == 0 && dy == 0) continue
                    val nx = x + dx
                    val ny = y + dy
                    if (nx !in 0 until DETECTOR_SIZE || ny !in 0 until DETECTOR_SIZE) continue
                    val next = ny * DETECTOR_SIZE + nx
                    if (!visited[next] && probability[next] >= tuning().detectorThreshold) {
                        visited[next] = true
                        componentQueue[tail++] = next
                    }
                }
            }
            if (area < tuning().minComponentArea || maxX - minX < 3 || maxY - minY < 3) continue
            val expandX = max(3, ((maxX - minX) * 0.16f).toInt())
            val expandY = max(2, ((maxY - minY) * 0.20f).toInt())
            val left = offX + (((minX - expandX - offsetX) / scale).toInt()).coerceIn(0, source.width - 1)
            val top = offY + (((minY - expandY - offsetY) / scale).toInt()).coerceIn(0, source.height - 1)
            val right = (offX + ceil((maxX + expandX - offsetX) / scale).toInt()).coerceIn(left + 1, source.width)
            val bottom = (offY + ceil((maxY + expandY - offsetY) / scale).toInt()).coerceIn(top + 1, source.height)
            if (right - left >= 6 && bottom - top >= 6) boxes += Rect(left, top, right, bottom)
        }
        return boxes
    }

    /**
     * Рамки текста без модели: Отсу-порог по яркости, проекция чернил по
     * строкам и столбцам. Спасает страницы, где детектор облачков молчит,
     * а текст есть (пользовательское «нет облачков — выдели рамкой и читай»).
     */
    private fun projectionBoxes(image: Bitmap): List<TextBox> {
        val w = 360
        val h = max(8, (image.height * w.toFloat() / image.width).toInt())
        val small = Bitmap.createScaledBitmap(image, w, h, true)
        val px = IntArray(w * h)
        small.getPixels(px, 0, w, 0, 0, w, h)
        small.recycle()
        val gray = IntArray(w * h) { i ->
            val p = px[i]
            (((p shr 16) and 0xFF) * 77 + ((p shr 8) and 0xFF) * 150 + (p and 0xFF) * 29) shr 8
        }
        // Порог Отсу по гистограмме яркости.
        val hist = IntArray(256)
        gray.forEach { hist[it]++ }
        var total = 0L
        for (i in 0..255) total += i * hist[i]
        var sumB = 0L
        var wB = 0
        var best = -1.0
        var thr = 128
        for (t in 0..255) {
            wB += hist[t]
            if (wB == 0) continue
            val wF = w * h - wB
            if (wF == 0) break
            sumB += t * hist[t]
            val mB = sumB.toDouble() / wB
            val mF = (total - sumB).toDouble() / wF
            val between = wB.toDouble() * wF * (mB - mF) * (mB - mF)
            if (between > best) {
                best = between
                thr = t
            }
        }
        val sx = image.width.toFloat() / w
        val sy = image.height.toFloat() / h
        val rowInk = FloatArray(h) { y ->
            var ink = 0
            for (x in 0 until w) if (gray[y * w + x] < thr) ink++
            ink.toFloat() / w
        }
        val boxes = mutableListOf<Rect>()
        var y = 0
        while (y < h && boxes.size < 12) {
            if (rowInk[y] < 0.04f) {
                y++
                continue
            }
            var y2 = y
            while (y2 < h && rowInk[y2] >= 0.02f) y2++
            if (y2 - y >= max(4, (h * 0.012f).toInt())) {
                val colInk = FloatArray(w) { x ->
                    var ink = 0
                    for (yy in y until y2) if (gray[yy * w + x] < thr) ink++
                    ink.toFloat() / (y2 - y)
                }
                var x = 0
                while (x < w && boxes.size < 12) {
                    if (colInk[x] < 0.05f) {
                        x++
                        continue
                    }
                    var x2 = x
                    while (x2 < w && colInk[x2] >= 0.02f) x2++
                    if (x2 - x >= 6) {
                        val left = ((x - 2) * sx).toInt().coerceIn(0, image.width - 2)
                        val top = ((y - 2) * sy).toInt().coerceIn(0, image.height - 2)
                        val right = ((x2 + 2) * sx).toInt().coerceIn(left + 8, image.width)
                        val bottom = ((y2 + 2) * sy).toInt().coerceIn(top + 8, image.height)
                        boxes += Rect(left, top, right, bottom)
                    }
                    x = x2 + 1
                }
            }
            y = y2 + 1
        }
        return mergeBoxes(boxes, tuning()).take(tuning().maxTextBoxes).map(::TextBox)
    }

    /** Поворот по часовой: вертикальные облачка читаются как горизонтальные. */
    private fun rotate90cw(src: Bitmap): Bitmap {
        val m = android.graphics.Matrix().apply { postRotate(90f) }
        return Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
    }

    private fun mergeBoxes(source: List<Rect>, tuning: OcrTuning): List<Rect> {
        val boxes = source.sortedWith(compareBy({ it.top }, { it.left })).map(::Rect).toMutableList()
        var changed = true
        while (changed) {
            changed = false
            outer@ for (i in boxes.indices) {
                for (j in i + 1 until boxes.size) {
                    val a = boxes[i]
                    val b = boxes[j]
                    val overlapY = max(0, min(a.bottom, b.bottom) - max(a.top, b.top))
                    val minHeight = min(a.height(), b.height()).coerceAtLeast(1)
                    val gapX = max(0, max(a.left, b.left) - min(a.right, b.right))
                    if (
                        overlapY >= minHeight * tuning.mergeOverlapYFactor &&
                        gapX <= max(a.height(), b.height()) * tuning.mergeGapXFactor
                    ) {
                        a.union(b)
                        boxes.removeAt(j)
                        changed = true
                        break@outer
                    }
                }
            }
        }
        return boxes.sortedWith(compareBy({ it.top }, { it.left }))
    }

    private fun pad(rect: Rect, width: Int, height: Int): Rect {
        val px = max(2, (rect.width() * 0.04f).toInt())
        val py = max(2, (rect.height() * 0.12f).toInt())
        return Rect(
            (rect.left - px).coerceAtLeast(0),
            (rect.top - py).coerceAtLeast(0),
            (rect.right + px).coerceAtMost(width),
            (rect.bottom + py).coerceAtMost(height),
        )
    }

    private fun recognizeCrop(crop: Bitmap): Recognition {
        val candidates = mutableListOf(
            runRecognizer(crop, primary, primaryInput, primaryOutput, primaryChars, RecognitionModel.V3),
        )
        if (candidates.last().confidence < tuning().contrastRetryConfidence) {
            val contrast = createHighContrast(crop)
            try {
                val alternate = runRecognizer(
                    contrast,
                    primary,
                    primaryInput,
                    primaryOutput,
                    primaryChars,
                    RecognitionModel.V3,
                )
                candidates += alternate
            } finally {
                contrast.recycle()
            }
        }
        val secondModel = verifier
        val secondInput = verifierInput
        val secondOutput = verifierOutput
        val secondChars = verifierChars
        if (
            secondModel != null &&
            secondInput != null && secondOutput != null && secondChars != null
        ) {
            // Device regression showed that v3 may assign a high confidence to
            // Latin-shaped garbage in clean Cyrillic captions. Always compare
            // v5 rather than treating it as a low-confidence-only fallback.
            val verifierResult = runRecognizer(
                crop,
                secondModel,
                secondInput,
                secondOutput,
                secondChars,
                RecognitionModel.V5,
            )
            candidates += verifierResult
            if (verifierResult.confidence < tuning().contrastRetryConfidence) {
                val contrast = createHighContrast(crop)
                try {
                    candidates += runRecognizer(
                        contrast,
                        secondModel,
                        secondInput,
                        secondOutput,
                        secondChars,
                        RecognitionModel.V5,
                    )
                } finally {
                    contrast.recycle()
                }
            }
        }
        return candidates.maxByOrNull(::candidateQuality) ?: Recognition("", 0f)
    }

    /**
     * PP-OCRv3 can report a high softmax score for Latin-shaped noise in comic
     * fonts. When v5 yields valid Cyrillic, prefer it over v3's softmax-only
     * choice. This is model ranking, not spelling replacement; only verified
     * boundary restoration occurs later in [cleanRecognition].
     */
    private fun candidateQuality(candidate: Recognition): Float {
        if (candidate.text.isBlank()) return Float.NEGATIVE_INFINITY
        val fitness = OcrTextCleaner.cyrillicFitness(candidate.text)
        val lengthBonus = min(candidate.text.count(Char::isLetter) * 0.01f, 0.12f)
        val verifierBonus = if (
            candidate.model == RecognitionModel.V5 &&
            OcrTextCleaner.isAcceptableCyrillicOcrText(
                OcrTextCleaner.fixLookalikesPerWord(candidate.text),
            )
        ) {
            tuning().verifierCyrillicBonus
        } else {
            0f
        }
        return candidate.confidence * fitness + lengthBonus + verifierBonus
    }

    private fun createHighContrast(source: Bitmap): Bitmap {
        val result = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
        val matrix = ColorMatrix().apply {
            setSaturation(0f)
            postConcat(
                ColorMatrix(
                    floatArrayOf(
                        1.5f, 0f, 0f, 0f, -45f,
                        0f, 1.5f, 0f, 0f, -45f,
                        0f, 0f, 1.5f, 0f, -45f,
                        0f, 0f, 0f, 1f, 0f,
                    ),
                ),
            )
        }
        Canvas(result).drawBitmap(source, 0f, 0f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
            colorFilter = ColorMatrixColorFilter(matrix)
        })
        return result
    }

    private fun runRecognizer(
        crop: Bitmap,
        model: CompiledModel,
        input: TensorBuffer,
        output: TensorBuffer,
        chars: List<String>,
        recognitionModel: RecognitionModel,
    ): Recognition {
        recognizerCanvas.drawColor(Color.rgb(128, 128, 128))
        val scale = RECOGNIZER_HEIGHT.toFloat() / crop.height.coerceAtLeast(1)
        val targetWidth = (crop.width * scale).toInt().coerceIn(1, RECOGNIZER_WIDTH)
        recognizerCanvas.drawBitmap(
            crop,
            null,
            Rect(0, 0, targetWidth, RECOGNIZER_HEIGHT),
            recognizerPaint,
        )
        recognizerBitmap.getPixels(
            recognizerPixels,
            0,
            RECOGNIZER_WIDTH,
            0,
            0,
            RECOGNIZER_WIDTH,
            RECOGNIZER_HEIGHT,
        )
        var out = 0
        recognizerPixels.forEach { pixel ->
            // BGR, как в эталонной реализации из репозитория моделей:
            // «the original Paddle model was trained with BGR order».
            recognizerFloats[out++] = ((pixel and 0xFF) / 255f - 0.5f) / 0.5f
            recognizerFloats[out++] = (((pixel shr 8) and 0xFF) / 255f - 0.5f) / 0.5f
            recognizerFloats[out++] = (((pixel shr 16) and 0xFF) / 255f - 0.5f) / 0.5f
        }
        input.writeFloat(recognizerFloats)
        model.run(listOf(input), listOf(output))
        val values = output.readFloat()
        // Число классов берём из фактического размера выхода: recognizer'ы
        // пака отдают [1, 40, C] (README репозитория моделей: «для recognizer
        // output — [1, 40, 165]»), то есть C = values.size / 40. Старый код
        // брал C из словаря (163 строки + 1 = 164), окно чтения дрейфовало
        // на один класс за шаг времени, и decode выдавал «лесенку» словаря —
        // «0123456789», «ABCDEFGHIJKLM» — вместо текста. Это и был «баг
        // кодировки» локального OCR.
        val classes = if (values.size % RECOGNIZER_STEPS == 0 && values.size / RECOGNIZER_STEPS >= 2) {
            values.size / RECOGNIZER_STEPS
        } else {
            chars.size + 1
        }
        val decoded = decodeCtc(values, chars, classes)
        return Recognition(
            text = decoded.text,
            confidence = decoded.confidence,
            model = recognitionModel,
            coverage = CtcScoring.innerBlankCoverage(decoded.blankSteps, decoded.emitted, decoded.steps),
        )
    }

    private fun decodeCtc(
        values: FloatArray,
        chars: List<String>,
        classes: Int,
    ): CtcDecode {
        if (classes <= 1 || values.size < classes) return CtcDecode("", 0f, 0, 0, 0)
        val steps = values.size / classes
        val text = StringBuilder(steps)
        var previous = -1
        var confidenceSum = 0f
        var confidenceCount = 0
        // Шаги, на которых победил blank между первым и последним символом.
        var blankSteps = 0
        var countingBlanks = false
        for (step in 0 until steps) {
            val base = step * classes
            val probabilities = CtcScoring.softmax(values, base, classes)
            var bestIndex = 0
            var bestScore = probabilities[0]
            for (index in 1 until classes) {
                val char = chars.getOrNull(index - 1).orEmpty()
                if (!allowed(char)) continue
                val score = probabilities[index]
                if (score > bestScore) {
                    bestScore = score
                    bestIndex = index
                }
            }
            when {
                bestIndex != 0 && bestIndex != previous -> {
                    chars.getOrNull(bestIndex - 1)?.let(text::append)
                    confidenceSum += bestScore
                    confidenceCount++
                    countingBlanks = true
                }
                // blank между двумя уже выданными символами = выпавшая буква.
                bestIndex == 0 && countingBlanks -> blankSteps++
            }
            previous = bestIndex
        }
        return CtcDecode(
            text = text.toString().trim(),
            confidence = if (confidenceCount == 0) 0f else confidenceSum / confidenceCount,
            emitted = confidenceCount,
            blankSteps = blankSteps,
            steps = steps,
        )
    }

    /**
     * Символы, которые модели разрешено выдавать.
     *
     * Латиница раньше была запрещена, и слова вроде «SOS», «BMW», «Wi-Fi»
     * или «3D» терялись целиком: в CTC на шаге запрещённого символа
     * побеждает другой класс или blank, поэтому рвётся всё слово, а не
     * один знак. В русской манге латиница встречается постоянно —
     * звукоподражания, названия, надписи на вывесках.
     */
    private fun allowed(value: String): Boolean {
        if (value.length != 1) return false
        val char = value[0]
        // Русский локальный режим не должен декодировать латинские омоглифы
        // (`i`, `l`, `m`) и цифры как якобы русские буквы. При сомнении лучше
        // получить пустой/слабый результат, чем «разiiiнение» или «мама-нама».
        return char in '\u0400'..'\u052F' ||
            char.isWhitespace() ||
            char in ALLOWED_PUNCTUATION
    }

    override fun close() {
        closeInternal()
    }

    private fun closeInternal() {
        runCatching { if (::detectorInput.isInitialized) detectorInput.close() }
        runCatching { if (::detectorOutput.isInitialized) detectorOutput.close() }
        runCatching { if (::primaryInput.isInitialized) primaryInput.close() }
        runCatching { if (::primaryOutput.isInitialized) primaryOutput.close() }
        runCatching { verifierInput?.close() }
        runCatching { verifierOutput?.close() }
        verifierInput = null
        verifierOutput = null
        runCatching { if (::detector.isInitialized) detector.close() }
        runCatching { if (::primary.isInitialized) primary.close() }
        runCatching { verifier?.close() }
        verifier = null
        if (::detectorBitmap.isInitialized && !detectorBitmap.isRecycled) detectorBitmap.recycle()
        if (::recognizerBitmap.isInitialized && !recognizerBitmap.isRecycled) recognizerBitmap.recycle()
        initialized = false
    }

    companion object {
        const val PACK = "cyrillic_ocr"
        const val DETECTOR_PATH = "cyrillic_ocr/detector.tflite"
        const val PRIMARY_PATH = "cyrillic_ocr/recognizer_v3.tflite"
        const val VERIFIER_PATH = "cyrillic_ocr/recognizer_v5.tflite"
        const val PRIMARY_DICT_PATH = "cyrillic_ocr/dict_v3.txt"
        const val VERIFIER_DICT_PATH = "cyrillic_ocr/dict_v5.txt"

        private const val DETECTOR_SIZE = 736
        private const val RECOGNIZER_WIDTH = 320
        private const val RECOGNIZER_HEIGHT = 48
        // Число шагов по времени в выходе recognizer'ов пака ([1, 40, C]).
        private const val RECOGNIZER_STEPS = 40
        // Числовые параметры детектора и признания результата перенесены в
        // OcrTuning: ими управляет пресет типа контента (манга / манхва /
        // комикс) и точные переопределения из настроек. Значения по умолчанию
        // в OcrTuning совпадают с прежними константами этого companion object,
        // поэтому BALANCED не меняет поведение приложения.

        private const val ALLOWED_PUNCTUATION = " .,!?;:-()[]{}\"'«»„“”%№+/=…—–"
    }
}
