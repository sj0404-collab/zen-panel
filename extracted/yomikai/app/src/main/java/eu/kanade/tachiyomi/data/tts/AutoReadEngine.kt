package eu.kanade.tachiyomi.data.tts

import android.content.Context
import android.graphics.Bitmap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import logcat.LogPriority
import mihon.data.ocr.OcrHistoryStore
import mihon.data.ocr.RuMorph
import mihon.data.ocr.MangaTranslatorService
import mihon.domain.ocr.interactor.ScanPageOcr
import mihon.domain.ocr.model.OcrBoundingBox
import mihon.domain.ocr.model.OcrImage
import mihon.domain.ocr.model.normalizeOcrTextForDisplay
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.core.common.util.system.logcat
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import kotlin.coroutines.cancellation.CancellationException

/**
 * Движок авточтения: скан кадра → фильтр по языку → (перевод) → озвучка
 * реплика-за-репликой с подсветкой текущей (линейка как в AlReader) →
 * сигнал «страница дочитана» для автолистания.
 *
 * Ключевые правила:
 * • Читается ТОЛЬКО текст выбранного языка (ru/en/ja/…): остальной текст
 *   на кадре игнорируется. UI-оверлеи приложения в кадр не попадают —
 *   захватывается контент, а не плавающие кнопки.
 * • История сканов: каждая прочитанная реплика запоминается (нормализованный
 *   хэш) — при повторном попадании в кадр (скролл туда-сюда, миллисекундные
 *   пересечения при листании) она не читается второй раз.
 * • Автолистание БЛОКИРУЕТСЯ, пока все реплики текущего кадра не озвучены:
 *   колбэк onPageFinished зовётся строго после последней реплики.
 */
class AutoReadEngine(
    private val context: Context,
    private val scanPageOcr: ScanPageOcr = Injekt.get(),
    private val prefs: OcrPreferences = Injekt.get(),
) {

    /** Детектор панелей/баллонов (YOLO Seeneva, модель в APK). */
    private val detectPanels: mihon.domain.panel.interactor.DetectPanels by lazy { Injekt.get() }

    /** Selected OCR engine for individual balloon crops (Cyrillic by default). */
    private val bubbleOcr: mihon.domain.ocr.interactor.OcrProcessor by lazy { Injekt.get() }

    /** Строка кадра: текст + нормализованный box (для подсветки/порядка). */
    private data class Line(val text: String, val boundingBox: OcrBoundingBox)

    data class SpokenRegion(
        val text: String,
        val translated: String?,
        /** Служебные пометки для показа ({1}{ж}) — TTS их не произносит. */
        val marks: String = "",
        val box: OcrBoundingBox,
        val index: Int,
        val total: Int,
    )

    /** Текущая читаемая реплика — для подсветки-линейки поверх страницы. */
    private val _currentRegion = MutableStateFlow<SpokenRegion?>(null)
    val currentRegion = _currentRegion.asStateFlow()

    /**
     * ВСЕ реплики кадра с их статусом: прочитана / читается / предстоит.
     * Оверлей рисует прочитанные полупрозрачно, текущую — ярко, будущие —
     * пунктирно, так видно и историю, и план чтения.
     */
    data class FrameRegion(
        val box: OcrBoundingBox,
        val index: Int,
        val state: State,
    ) {
        enum class State { DONE, CURRENT, UPCOMING }
    }

    private val _frameRegions = MutableStateFlow<List<FrameRegion>>(emptyList())
    val frameRegions = _frameRegions.asStateFlow()

    /**
     * Зона книги внутри вьюпорта (доли 0..1) — если кадр перед OCR был
     * обрезан до неё, оверлей обязан пересчитать box'ы обратно.
     */
    @Volatile
    var highlightZone: android.graphics.RectF? = null

    /** Box из координат обрезанного кадра -> координаты вьюпорта. */
    fun mapToViewport(box: OcrBoundingBox): OcrBoundingBox {
        val z = highlightZone ?: return box
        val zw = z.right - z.left
        val zh = z.bottom - z.top
        return OcrBoundingBox(
            left = z.left + box.left * zw,
            top = z.top + box.top * zh,
            right = z.left + box.right * zw,
            bottom = z.top + box.bottom * zh,
        )
    }

    private val _isReading = MutableStateFlow(false)
    val isReading = _isReading.asStateFlow()

    /** Был ли в последнем кадре новый текст (для темпа автоскролла). */
    @Volatile
    var lastFrameHadText: Boolean = false
        private set

    /** Весь распознанный текст последнего кадра — контекст для AI-чата. */
    @Volatile
    var lastFrameText: String = ""
        private set

    /** Реплики прошлого кадра — передаются ассистенту для дедупликации. */
    private var prevFrameLines: List<String> = emptyList()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    /** Поколение запуска: stop() инвалидирует все колбэки прежних запусков. */
    @Volatile
    private var generation = 0

    /**
     * История прочитанного с НЕЧЁТКИМ сравнением: OCR той же реплики при
     * смещённом кадре даёт слегка другой текст (обрезанные края, дрожание),
     * поэтому точный хэш пропускал дубли. Храним нормализованные строки и
     * сравниваем по включению/похожести 3-граммами (порог 0.75).
     */
    private val spokenTexts = ArrayDeque<String>()

    @Synchronized
    private fun isDuplicate(rawText: String): Boolean {
        val norm = rawText.lowercase().filter { it.isLetterOrDigit() }
        if (norm.length < 4) return true // мусор/односимвольные не читаем повторно
        for (old in spokenTexts) {
            if (old.contains(norm) || norm.contains(old)) return true
            if (trigramSimilarity(old, norm) >= 0.75f) return true
        }
        spokenTexts.addLast(norm)
        while (spokenTexts.size > HISTORY_LIMIT) spokenTexts.removeFirst()
        return false
    }

    private fun trigramSimilarity(a: String, b: String): Float {
        if (a.length < 3 || b.length < 3) return if (a == b) 1f else 0f
        val ta = HashSet<String>(a.length)
        for (i in 0..a.length - 3) ta.add(a.substring(i, i + 3))
        var common = 0
        var total = 0
        for (i in 0..b.length - 3) {
            total++
            if (b.substring(i, i + 3) in ta) common++
        }
        return if (total == 0) 0f else common.toFloat() / total
    }

    @Synchronized
    fun clearHistory() = spokenTexts.clear()

    /**
     * Прочитать кадр. [onPageFinished] вызывается ПОСЛЕ озвучки всех реплик —
     * там вызывающая сторона листает/скроллит дальше. Если нового текста нет
     * (всё уже в истории) — завершится сразу.
     */
    fun readFrame(
        bitmap: Bitmap,
        chapterId: Long,
        pageIndex: Int,
        onPageFinished: () -> Unit,
    ) {
        job?.cancel()
        TtsSpeaker.stop()
        val myGen = ++generation
        job = scope.launch {
            _isReading.value = true
            var aiRefine: Job? = null
            try {
                val pixels = IntArray(bitmap.width * bitmap.height)
                bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
                val image = OcrImage(bitmap.width, bitmap.height, pixels)
                // Кадр в JPEG для AI-определения пола говорящих (если включено)
                // В ручном режиме пол задан читателем — AI Vision не нужен.
                val genderJpeg: ByteArray? = if (prefs.aiGenderVoices().get() &&
                    !prefs.manualVoiceMode().get()
                ) {
                    runCatching {
                        val out = java.io.ByteArrayOutputStream()
                        val scaled = if (bitmap.width > 1024) {
                            val h = bitmap.height * 1024 / bitmap.width
                            Bitmap.createScaledBitmap(bitmap, 1024, h, true)
                        } else bitmap
                        scaled.compress(Bitmap.CompressFormat.JPEG, 70, out)
                        if (scaled !== bitmap && !scaled.isRecycled) scaled.recycle()
                        out.toByteArray()
                    }.getOrNull()
                } else null

                val result = scanPageOcr.await(chapterId, pageIndex, image)

                val language = prefs.autoReadLanguage().get()
                val translate = prefs.autoReadTranslate().get()
                val order = prefs.scanReadingOrder().get()

                // ===== БАЛЛОНЫ ВМЕСТО «ВСЕЙ СТРАНИЦЫ» (фикс по скриншотам) =====
                // Полностраничные движки возвращают один регион 0,0-1,1.
                // Для авточтения такой результат дополнительно разбирается:
                //  1) YOLO-детектор находит баллоны;
                //  2) каждый баллон распознаётся выбранным OCR (по умолчанию
                //     полностью офлайн Cyrillic PP-OCR);
                //  3) каждый баллон = своя реплика со своей рамкой, номером
                //     {N} и полом говорящего.
                // Если детектор ничего не нашёл — текст страницы хотя бы
                // делится на строки-реплики вместо одного блока.
                var lines: List<Line> = result.regions.map {
                    Line(normalizeOcrTextForDisplay(it.text).trim(), it.boundingBox)
                }
                val wholePage = result.regions.size == 1 && result.regions.first().isWholePage
                if (wholePage && !bitmap.isRecycled) {
                    val bubbleLines = runCatching { readBubbles(bitmap, chapterId, pageIndex, order) }
                        .onFailure {
                            logcat(LogPriority.WARN, it) { "Bubble detection failed" }
                            OcrHistoryStore.addAutoRead(false, "детектор облачков", it.message ?: it.javaClass.simpleName)
                        }
                        .getOrDefault(emptyList())
                    lines = if (bubbleLines.isNotEmpty()) {
                        bubbleLines
                    } else {
                        // Фолбэк: строки полностраничного текста как реплики
                        lines.firstOrNull()?.let { splitWholePageToLines(it) } ?: emptyList()
                    }
                }
                if (!bitmap.isRecycled) bitmap.recycle()

                // 1) фильтр мусора OCR (обрывки «eS la 4», «| | > |», «о»)
                //    + фильтр по языку; 2) отсев уже прочитанного
                val fresh = lines
                    .asSequence()
                    .map { it.copy(text = cleanOcrGarbage(it.text, language)) }
                    .filter { it.text.length >= MIN_TEXT_LENGTH }
                    .filter { isMeaningful(it.text, language) }
                    .filter { !isDuplicate(it.text) }
                    // Рамка обязана лежать внутри страницы и иметь разумный
                    // размер: иначе голубая подсветка вылезает за текст/экран.
                    .filter { b ->
                        val bb = b.boundingBox
                        bb.left >= -0.001f && bb.top >= -0.001f &&
                            bb.right <= 1.001f && bb.bottom <= 1.001f &&
                            (bb.right - bb.left) > 0.02f &&
                            (bb.bottom - bb.top) > 0.01f
                    }
                    .toList()

                // 3) порядок чтения
                val ordered = when (order) {
                    "ltr" -> fresh.sortedWith(compareBy({ rowOf(it.boundingBox.top) }, { it.boundingBox.left }))
                    "vertical" -> fresh.sortedBy { it.boundingBox.top }
                    else -> fresh.sortedWith(compareBy({ rowOf(it.boundingBox.top) }, { -it.boundingBox.right }))
                }

                // 3.5) Пол говорящих. Приоритет:
                //  а) ВСТРОЕННЫЙ локальный AI (LocalSpeakerAi) — морфология
                //     русского текста, работает без сети и без ключей;
                //  б) AI-конвейер (prepareFrame) — ПАРАЛЛЕЛЬНО, без блокировки.
                //
                // БЫСТРОЕ АВТОЧТЕНИЕ (фикс замедления): раньше конвейер
                // «чат → голос» БЛОКИРОВАЛ старт озвучки до 8 секунд на
                // каждом кадре (ждали ответа модели). Теперь чтение стартует
                // МГНОВЕННО с локальной морфологией, а ответ ассистента
                // подхватывается на лету и применяется к ещё НЕ прочитанным
                // репликам (пол, чистка, скип дублей). Дубли прошлых кадров
                // и так режутся локальной нечёткой историей — заглушек нет,
                // просто больше не ждём сеть.
                val preparedRef = java.util.concurrent.atomic.AtomicReference<
                    List<eu.kanade.tachiyomi.data.ai.AiAssistant.PreparedLine>?,
                    >(null)
                if (prefs.aiGenderVoices().get() && ordered.isNotEmpty()) {
                    val newLines = ordered.map { it.text }
                    val prevSnapshot = prevFrameLines
                    scope.launch {
                        preparedRef.set(
                            eu.kanade.tachiyomi.data.ai.AiAssistant.prepareFrame(
                                newLines = newLines,
                                prevLines = prevSnapshot,
                            ),
                        )
                    }
                }
                prevFrameLines = ordered.map { it.text }

                val localGenders = LocalSpeakerAi.guessGenders(ordered.map { it.text })
                val genders = java.util.concurrent.atomic.AtomicReferenceArray<String?>(ordered.size)
                for (i in ordered.indices) {
                    genders.set(i, localGenders[i] ?: detectGenderByDictionary(ordered[i].text))
                }
                aiRefine = null
                // Gemini Vision как ещё один фоновый уточнитель — только с ключом
                if (genderJpeg != null && ordered.isNotEmpty() &&
                    prefs.googleApiKey().get().isNotBlank() && localGenders.any { it == null }
                ) {
                    scope.launch {
                        val vision = SpeakerGenderService.detect(genderJpeg, ordered.map { it.text }, prefs)
                        for (i in ordered.indices) {
                            if (genders.get(i) == null) genders.set(i, vision.getOrNull(i))
                        }
                    }
                }

                lastFrameHadText = ordered.isNotEmpty()
                if (ordered.isNotEmpty()) {
                    lastFrameText = ordered.joinToString("\n") { it.text }
                }

                // 3.7) перевод ВСЕЙ страницы одним запросом (раньше был
                // отдельный HTTP-запрос на каждую реплику — на 15 бабблах
                // это 15 последовательных обращений между озвучками).
                val target = prefs.translateTarget().get().ifBlank { "ru" }
                val translations: List<String> = if (translate && language != target) {
                    runCatching { MangaTranslatorService.translateAll(ordered.map { it.text }, target) }
                        .getOrElse { ordered.map { it.text } }
                } else {
                    ordered.map { it.text }
                }

                // Публикуем карту кадра: всё, что будет прочитано
                _frameRegions.value = ordered.mapIndexed { i, r ->
                    FrameRegion(r.boundingBox, i + 1, FrameRegion.State.UPCOMING)
                }

                // 4) реплика за репликой: подсветка -> озвучка -> ждём конца
                for ((i, region) in ordered.withIndex()) {
                    if (job?.isActive != true) break

                    // Ответ ассистента подхватывается на лету (если уже
                    // пришёл): скип дублей, чистый текст, пол. Если ещё не
                    // пришёл — читаем немедленно локальным конвейером.
                    val prep = preparedRef.get()?.getOrNull(i)
                    if (prep != null && !prep.speak) continue
                    if (prep?.gender != null && genders.get(i) == null) genders.set(i, prep.gender)

                    // Обновляем статусы: до i — прочитано, i — читается, после — предстоит
                    _frameRegions.value = ordered.mapIndexed { j, r ->
                        FrameRegion(
                            r.boundingBox,
                            j + 1,
                            when {
                                j < i -> FrameRegion.State.DONE
                                j == i -> FrameRegion.State.CURRENT
                                else -> FrameRegion.State.UPCOMING
                            },
                        )
                    }

                    // Текст: приоритет — очищенный ассистентом, затем перевод, затем сырой OCR
                    val speakTextRaw = prep?.text?.takeIf { it.isNotBlank() }
                        ?: translations.getOrNull(i) ?: region.text

                    // Ручной режим важнее автоопределения: читатель выбрал
                    // голос кнопкой в читалке и ждёт именно его.
                    val gender = if (prefs.manualVoiceMode().get()) {
                        prefs.manualVoiceGender().get().takeIf { it.isNotBlank() } ?: "female"
                    } else {
                        genders.get(i) // мог дозаполниться AI пока читали предыдущие
                    }

                    // Служебные пометки: номер по порядку чтения и пол.
                    // Они показываются на экране, но НЕ произносятся —
                    // SpeechMarkup.strip() снимает их перед синтезом.
                    val marks = buildString {
                        if (prefs.showSpeechNumbers().get()) append("{").append(i + 1).append("}")
                        when (gender) {
                            "female" -> append("{ж}")
                            "male" -> append("{м}")
                        }
                    }

                    _currentRegion.value = SpokenRegion(
                        text = region.text,
                        translated = speakTextRaw.takeIf { it != region.text },
                        box = region.boundingBox,
                        index = i + 1,
                        total = ordered.size,
                        marks = marks,
                    )

                    // Слот говорящего: два персонажа одного пола в сцене
                    // получают разные голоса. Считаем по индексам, а не через
                    // indexOf: одинаковые реплики иначе дали бы один и тот же
                    // слот.
                    val slot = if (prefs.perSpeakerVoices().get()) {
                        (0 until i).count { genders.get(it) == gender }
                    } else {
                        0
                    }

                    speakAndAwait(SpeechMarkup.strip(speakTextRaw), gender, slot)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                logcat(LogPriority.ERROR, e) { "AutoRead frame failed" }
                OcrHistoryStore.addAutoRead(false, "сбой страницы", e.message ?: e.javaClass.simpleName)
            } finally {
                aiRefine?.cancel()
                _currentRegion.value = null
                _frameRegions.value = emptyList()
                _isReading.value = false
                // Колбэк только для АКТУАЛЬНОГО запуска: после stop() старый
                // цикл не имеет права листать дальше или перезапускать чтение
                if (myGen == generation && job?.isCancelled != true) {
                    onPageFinished()
                }
            }
        }
    }

    fun stop() {
        generation++ // инвалидируем все pending-колбэки
        job?.cancel()
        job = null
        TtsSpeaker.stop()
        _currentRegion.value = null
        _frameRegions.value = emptyList()
        _isReading.value = false
    }

    /** Озвучка с ожиданием реального окончания фразы. */
    private suspend fun speakAndAwait(text: String, gender: String? = null, speakerSlot: Int = 0) {
        val done = MutableStateFlow(false)
        var started = false
        val t0 = System.currentTimeMillis()
        TtsSpeaker.speakAs(context, text, gender, speakerSlot) { speaking ->
            if (speaking && !started) {
                started = true
                logcat(LogPriority.DEBUG) { "TTS started (${System.currentTimeMillis() - t0}ms): ${text.take(60)}" }
            }
            if (!speaking && started) {
                done.value = true
                logcat(LogPriority.DEBUG) { "TTS done in ${System.currentTimeMillis() - t0}ms" }
                OcrHistoryStore.addAutoRead(true, "озвучено (${System.currentTimeMillis() - t0} мс)", text.take(60))
            }
        }
        // страховка: макс. время = длина текста * 220мс + запас 5с
        val timeoutMs = text.length * 220L + 5_000L
        val start = System.currentTimeMillis()
        while (!done.value && System.currentTimeMillis() - start < timeoutMs) {
            if (job?.isActive != true) {
                TtsSpeaker.stop()
                return
            }
            delay(40) // быстрый опрос: между репликами нет лишней паузы
        }
        // Диагностика недоговорённых реплик: TTS мог прерваться без onDone.
        if (started && !done.value) {
            logcat(LogPriority.WARN) {
                "TTS timeout without onDone: ${text.take(60)} (waited ${System.currentTimeMillis() - start}ms)"
            }
            OcrHistoryStore.addAutoRead(false, "TTS без завершения", text.take(60))
        } else if (!started) {
            logcat(LogPriority.WARN) { "TTS never started: ${text.take(60)}" }
            OcrHistoryStore.addAutoRead(false, "TTS не запустился", text.take(60))
        }
    }

    /** Строка (ряд) для сортировки: реплики в пределах 12% высоты — один ряд. */
    private fun rowOf(top: Float): Int = (top / 0.12f).toInt()

    /**
     * Словарный фолбэк пола говорящего: работает, когда морфология
     * LocalSpeakerAi не дала ответа (в реплике нет «я …ла/…л»). Ориентируемся
     * на маркеры окружения персонажа: родственные связи и роли. Возвращаем
     * пол только при явном перевесе — иначе null (нейтральный голос).
     */
    private fun detectGenderByDictionary(text: String): String? {
        val maleMarkers = listOf(
            "брат", "отец", "папа", "дед", "сын", "мужчина", "парень",
            "господин", "старик", "мальчик", "юноша", "принц", "король",
        )
        val femaleMarkers = listOf(
            "сестра", "мать", "мама", "бабушка", "дочь", "женщина", "девушка",
            "госпожа", "старуха", "девочка", "принцесса", "королева",
        )
        val lower = text.lowercase()
        // Подстрочный поиск покрывает падежи: «моей сестры», «к отцу».
        val maleCount = maleMarkers.count { lower.contains(it) }
        val femaleCount = femaleMarkers.count { lower.contains(it) }
        val byMarkers = when {
            maleCount > femaleCount -> "male"
            femaleCount > maleCount -> "female"
            else -> null
        }
        if (byMarkers != null) return byMarkers
        // Морфологический фолбэк: род по окончаниям словоформ (RuMorph).
        val morph = RuMorph.guessGender(text)
        if (morph != null) {
            OcrHistoryStore.addAutoRead(true, "пол говорящего: морфология", "$morph: ${text.take(40)}")
        }
        return morph
    }

    // region Баллоны (YOLO) и чистка OCR-мусора

    /**
     * YOLO-детект баллонов на кадре + пофрагментный OCR. Каждый найденный
     * баллон становится отдельной репликой со своей рамкой. После разовой
     * загрузки моделей весь конвейер работает полностью офлайн.
     */
    private suspend fun readBubbles(
        bitmap: Bitmap,
        chapterId: Long,
        pageIndex: Int,
        order: String,
    ): List<Line> {
        val direction = when (order) {
            "ltr" -> tachiyomi.core.common.util.system.ReadingDirection.LTR
            "vertical" -> tachiyomi.core.common.util.system.ReadingDirection.VERTICAL
            else -> tachiyomi.core.common.util.system.ReadingDirection.RTL
        }
        val det = detectPanels.await(
            cacheKey = "autoread_${chapterId}_$pageIndex",
            image = bitmap,
            originalWidth = bitmap.width,
            originalHeight = bitmap.height,
            direction = direction,
        )
        val bubbles = det.debugBubbles
            .map { it.rect }
            .filter { it.width() > 16 && it.height() > 16 }
            .take(MAX_BUBBLES_PER_FRAME)
        if (bubbles.isEmpty()) return emptyList()

        val out = mutableListOf<Line>()
        for (r in bubbles) {
            if (job?.isActive != true) break
            // Поля 6%: рамка YOLO бывает впритык к тексту
            val padX = (r.width() * 0.06f).toInt()
            val padY = (r.height() * 0.06f).toInt()
            val left = (r.left - padX).coerceAtLeast(0)
            val top = (r.top - padY).coerceAtLeast(0)
            val right = (r.right + padX).coerceAtMost(bitmap.width)
            val bottom = (r.bottom + padY).coerceAtMost(bitmap.height)
            if (right - left < 16 || bottom - top < 16) continue
            val crop = Bitmap.createBitmap(bitmap, left, top, right - left, bottom - top)
            val text = try {
                val cropPixels = IntArray(crop.width * crop.height)
                crop.getPixels(cropPixels, 0, crop.width, 0, 0, crop.width, crop.height)
                bubbleOcr.getText(OcrImage(crop.width, crop.height, cropPixels))
            } finally {
                if (!crop.isRecycled) crop.recycle()
            }
            val clean = normalizeOcrTextForDisplay(text).trim()
            if (clean.isNotBlank()) {
                out += Line(
                    text = clean,
                    boundingBox = OcrBoundingBox(
                        left = left.toFloat() / bitmap.width,
                        top = top.toFloat() / bitmap.height,
                        right = right.toFloat() / bitmap.width,
                        bottom = bottom.toFloat() / bitmap.height,
                    ),
                )
            }
        }
        return out
    }

    /**
     * Полностраничный результат (один регион 0..1) делится на строки:
     * каждая непустая строка — отдельная реплика. Рамки приблизительные
     * (равномерно по высоте) — хоть какая-то подсветка вместо всей страницы.
     */
    private fun splitWholePageToLines(whole: Line): List<Line> {
        val rows = whole.text.lines().map { it.trim() }.filter { it.isNotBlank() }
        if (rows.size <= 1) return listOf(whole)
        val h = 1f / rows.size
        return rows.mapIndexed { i, t ->
            Line(t, OcrBoundingBox(0.05f, i * h, 0.95f, (i + 1) * h))
        }
    }

    // endregion

    // region Чистка мусора OCR

    companion object {
        private const val MIN_TEXT_LENGTH = 2
        private const val HISTORY_LIMIT = 600
        private const val MAX_BUBBLES_PER_FRAME = 14

        /**
         * Чистка OCR-мусора ВНУТРИ реплики (по скриншотам пользователя:
         * «АХЕ возьмешь — МЕНЯ НА РУЧКИ? eS la 4…», «Я | | > | КАК ПРИНЦЕСС…»,
         * «РУ у 4а (WX i ДЖЕЙН…»). Правила:
         *  • строки из символов-палок/скобок/стрелок выбрасываются целиком;
         *  • строки, где смесь латиницы+цифр не похожа на слова (eS la 4,
         *    WX i, 4a) — выбрасываются при целевом языке ru;
         *  • одиночные буквы-обрывки («о», «Я» без продолжения в 1 строку из
         *    многих) — выбрасываются;
         *  • остальные строки склеиваются пробелом.
         */
        fun cleanOcrGarbage(text: String, language: String): String {
            val rawRows = text.lines().map { it.trim() }.filter { it.isNotBlank() }
            // OCR часто путает буквы с цифрами («4» вместо «а», «1» вместо «л»).
            // Убираем цифровые обрывки (числа без буквенного соседства):
            // «4а», «eS la 4», случайные «7» в середине текста.
            val rows = rawRows.map { row ->
                row.replace(Regex("(?<![\\p{L}0-9])[0-9]+(?![\\p{L}])"), " ")
                    .replace(Regex("\\s+"), " ").trim()
            }.filter { it.isNotBlank() }
            if (rows.isEmpty()) return ""
            val kept = rows.filter { row -> isMeaningfulRow(row, language) }
            // Если ВСЁ забраковано, но исходник был длинный — вернём самую
            // «словесную» строку, чтобы не терять настоящие реплики.
            if (kept.isEmpty()) {
                val best = rows.maxByOrNull { r -> r.count { it.isLetter() } }
                return if (best != null && best.count { it.isLetter() } >= 4) best else ""
            }
            return kept.joinToString(" ").replace(Regex("\\s+"), " ").trim()
        }

        /** Похожа ли строка на осмысленный текст (не обрывок/не мусор). */
        private fun isMeaningfulRow(row: String, language: String): Boolean {
            val letters = row.count { it.isLetter() }
            val total = row.length
            // Палки, скобки, стрелки, точки: буквы < 40% строки — мусор
            if (letters == 0) return false
            if (letters.toFloat() / total < 0.4f && total >= 3) return false
            // Одна-две буквы («о», «РУ») — обрывок
            if (letters <= 2) return false
            when (language) {
                "ru" -> {
                    val cyr = row.count { it in '\u0400'..'\u04FF' }
                    // Латиница с цифрами (eS la 4, WX i) при русском языке — мусор
                    if (cyr == 0) return false
                    if (cyr.toFloat() / letters < 0.6f) return false
                    // Должно быть хотя бы одно «слово» из 3+ кириллических букв
                    return Regex("[\\u0400-\\u04FF]{3,}").containsMatchIn(row)
                }
                "en" -> {
                    val lat = row.count { it in 'a'..'z' || it in 'A'..'Z' }
                    if (lat.toFloat() / letters < 0.6f) return false
                    return Regex("[A-Za-z]{3,}").containsMatchIn(row)
                }
                else -> return true
            }
        }

        /** Финальная проверка собранной реплики перед чтением. */
        fun isMeaningful(text: String, language: String): Boolean {
            if (text.isBlank()) return false
            if (!matchesLanguage(text, language)) return false
            // Реплика обязана содержать хотя бы одно слово из 3+ букв
            return text.split(Regex("\\s+")).any { w -> w.count { it.isLetter() } >= 3 } ||
                // …или быть короткой осмысленной («Да!», «Ах!», «Нет?»)
                (text.length in 2..6 && text.count { it.isLetter() } >= 2)
        }

        /**
         * Определение языка текста по алфавиту. Реплика проходит фильтр,
         * если ≥60% её букв принадлежат целевому алфавиту.
         */
        fun matchesLanguage(text: String, language: String): Boolean {
            if (language == "any") return true
            val letters = text.filter { it.isLetter() }
            if (letters.isEmpty()) return false
            val matching = letters.count { ch ->
                when (language) {
                    "ru" -> ch in '\u0400'..'\u04FF'
                    "en" -> ch in 'a'..'z' || ch in 'A'..'Z'
                    "ja" -> ch in '\u3040'..'\u30FF' || ch in '\u4E00'..'\u9FFF' || ch in '\u31F0'..'\u31FF'
                    "ko" -> ch in '\uAC00'..'\uD7AF' || ch in '\u1100'..'\u11FF'
                    "zh" -> ch in '\u4E00'..'\u9FFF'
                    else -> true
                }
            }
            return matching.toFloat() / letters.length >= 0.6f
        }
    }
}
