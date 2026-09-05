package mihon.data.ocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Rect
import com.google.ai.edge.litert.Environment
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import logcat.LogPriority
import mihon.domain.ocr.exception.OcrException
import mihon.domain.ocr.model.OcrBoundingBox
import mihon.domain.ocr.model.OcrImage
import mihon.domain.ocr.model.OcrModel
import mihon.domain.ocr.model.OcrPageResult
import mihon.domain.ocr.model.OcrRegion
import mihon.domain.ocr.model.OcrTextOrientation
import mihon.domain.ocr.repository.OcrRepository
import tachiyomi.core.common.preference.AndroidPreferenceStore
import tachiyomi.core.common.preference.getEnum
import tachiyomi.core.common.util.system.logcat
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * OCR repository implementation that manages engine selection, page scanning, and OCR cache.
 */
class OcrRepositoryImpl(
    private val context: Context,
) : OcrRepository {
    private val preferenceStore = AndroidPreferenceStore(context)
    private val ocrModelPref = preferenceStore.getEnum("pref_ocr_model", OcrModel.CYRILLIC)
    private val useFallbackModelsPref = preferenceStore.getBoolean("pref_use_fallback_models", true)

    private val environmentResult by lazy {
        runCatching { Environment.create() }
            .onFailure { error ->
                logcat(LogPriority.WARN, error) {
                    "LiteRT environment unavailable; local OCR engines will fall back"
                }
            }
    }

    private val textPostprocessor by lazy { TextPostprocessor() }
    private val cacheStore by lazy { OcrCacheStore(context) }
    private val ocrPreferences by lazy { mihon.domain.ocr.service.OcrPreferences(preferenceStore) }

    /**
     * Профиль распознавания: пресет типа контента + область + ручные
     * переопределения. Пересобирается на каждый вызов, поэтому смена пресета в
     * настройках применяется сразу и не требует пересоздания движка.
     */
    private fun regionProfile(): OcrRegionProfile = OcrRegionProfile(
        contentType = OcrContentType.fromId(ocrPreferences.contentType().get()),
        scanRegion = presetScanRegion(),
        overrides = tuningOverrides(),
    )

    private fun currentTuning(): OcrTuning = regionProfile().tuning()

    /** Область из пресета; `pref_scan_region` остаётся быстрым переопределением. */
    private fun presetScanRegion(): mihon.domain.ocr.service.ScanRegion =
        OcrRegionRules.effectiveRegion(
            presetKey = ocrPreferences.presetScanRegion().get(),
            legacy = ocrPreferences.scanRegion().get(),
        )

    /**
     * Ручные переопределения пресета. Незаполненное или нечисловое поле
     * означает «как в пресете»: настройка, сохранённая старой версией, не
     * должна ломать распознавание.
     */
    private fun tuningOverrides(): OcrTuningOverrides = OcrRegionRules.overridesOf(
        detectorThreshold = ocrPreferences.detectorThresholdOverride().get(),
        minComponentArea = ocrPreferences.minComponentAreaOverride().get(),
        maxTextBoxes = ocrPreferences.maxTextBoxesOverride().get(),
        wordGapFactor = ocrPreferences.wordGapFactorOverride().get(),
        minAcceptConfidence = ocrPreferences.minAcceptConfidenceOverride().get(),
        shortTextMinConfidence = ocrPreferences.shortTextConfidenceOverride().get(),
        minCoverage = ocrPreferences.minCoverageOverride().get(),
        rescueMaxLines = ocrPreferences.rescueMaxLinesOverride().get(),
    )

    private var cyrillicEngine: CyrillicOcrEngine? = null
    private var legacyEngine: LegacyOcrEngine? = null
    private var fastEngine: FastOcrEngine? = null
    private var glensEngine: GlensOcrEngine? = null
    private var owOcrEngine: OwOcrEngine? = null
    private var openRouterEngine: OpenRouterOcrEngine? = null
    private var googleAiEngine: GoogleAiOcrEngine? = null
    private var zenFreeEngine: ZenFreeOcrEngine? = null
    private var detEngine: DetOcrEngine? = null

    private val engineLocks = OcrEngineLocks()
    private val cleanupMutex = Mutex()
    private val sessionMutex = Mutex()
    private val operationMutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val taskQueue = PrioritizedTaskQueue(scope) {
        scope.launch {
            performDeferredCleanupIfIdle()
        }
    }

    private var cleanupRequested = false

    private var activeScanSessions = 0
    private var activeOperations = 0

    internal enum class EngineType {
        CYRILLIC,
        LEGACY,
        FAST,
        GLENS,
        OWOCR,
        OPENROUTER,
        GOOGLE,
        ZEN_FREE,
    }

    private fun selectedEngineType(): EngineType {
        return when (ocrModelPref.get()) {
            OcrModel.CYRILLIC -> EngineType.CYRILLIC
            // Old offline selections migrate transparently to the Russian
            // engine; the Japanese FAST/LEGACY models are no longer defaults.
            OcrModel.LEGACY -> EngineType.CYRILLIC
            OcrModel.FAST -> EngineType.CYRILLIC
            OcrModel.GLENS -> EngineType.GLENS
            OcrModel.OWOCR -> EngineType.OWOCR
            OcrModel.OPENROUTER -> EngineType.OPENROUTER
            OcrModel.GOOGLE -> EngineType.GOOGLE
            OcrModel.ZEN_FREE -> EngineType.ZEN_FREE
            OcrModel.TESSERACT -> EngineType.CYRILLIC
        }
    }

    private fun isConnectivityFailure(error: Throwable): Boolean {
        var current: Throwable? = error
        while (current != null) {
            if (
                current is UnknownHostException ||
                current is ConnectException ||
                current is SocketTimeoutException ||
                current.message?.contains("Unable to resolve host", ignoreCase = true) == true
            ) {
                return true
            }
            current = current.cause
        }
        return false
    }

    private val onlineEngines = setOf(
        EngineType.GLENS, EngineType.ZEN_FREE, EngineType.OWOCR,
        EngineType.OPENROUTER, EngineType.GOOGLE,
    )
    private val offlineEngines = listOf(
        // One canonical offline engine for Russian/Cyrillic text. Legacy,
        // FAST and Tesseract remain migration-only enum values.
        EngineType.CYRILLIC,
    )

    private fun isNetworkAvailable(): Boolean {
        return runCatching {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
                as android.net.ConnectivityManager
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            caps?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        }.getOrDefault(false)
    }

    /**
     * ЦЕПОЧКА фолбэков (по пресету пользователя), а не один шаг:
     *  auto    — при сети: онлайн → локальные; без сети: ТОЛЬКО локальные
     *            (онлайн даже не пробуются — мгновенный переход, без таймаутов);
     *  online  — только онлайн-движки;
     *  offline — только локальный Cyrillic PP-OCR (скачиваемый pack);
     *  single  — фолбэков нет.
     */
    private fun fallbackChain(primary: EngineType): List<EngineType> {
        val preset = preferenceStore.getString("pref_fallback_preset", "auto").get()
        val online = listOf(EngineType.GLENS, EngineType.ZEN_FREE, EngineType.GOOGLE)
        val chain = when (preset) {
            "single" -> emptyList()
            "online" -> online
            "offline" -> offlineEngines
            else -> { // auto
                if (isNetworkAvailable()) online + offlineEngines else offlineEngines
            }
        }
        return chain.filter { it != primary }
    }

    private fun requireEnvironment(): Environment {
        return environmentResult.getOrElse { cause ->
            throw OcrException.InitializationError(cause)
        }
    }

    private fun localOcrAvailable(): Boolean {
        return environmentResult.isSuccess
    }

    private fun engineFor(type: EngineType): OcrEngine {
        return when (type) {
            EngineType.CYRILLIC -> {
                cyrillicEngine ?: CyrillicOcrEngine(
                    context,
                    requireEnvironment(),
                    textPostprocessor,
                    ::currentTuning,
                ).also { cyrillicEngine = it }
            }
            EngineType.FAST -> {
                fastEngine ?: FastOcrEngine(context, requireEnvironment(), textPostprocessor).also {
                    fastEngine = it
                }
            }
            EngineType.LEGACY -> {
                legacyEngine ?: LegacyOcrEngine(context, requireEnvironment(), textPostprocessor).also {
                    legacyEngine = it
                }
            }
            EngineType.GLENS -> {
                glensEngine ?: GlensOcrEngine().also {
                    glensEngine = it
                }
            }
            EngineType.OWOCR -> {
                owOcrEngine ?: OwOcrEngine(context).also {
                    owOcrEngine = it
                }
            }
            EngineType.OPENROUTER -> {
                openRouterEngine ?: OpenRouterOcrEngine(context, ocrPreferences).also {
                    openRouterEngine = it
                }
            }
            EngineType.GOOGLE -> {
                googleAiEngine ?: GoogleAiOcrEngine(context, ocrPreferences).also {
                    googleAiEngine = it
                }
            }
            EngineType.ZEN_FREE -> {
                zenFreeEngine ?: ZenFreeOcrEngine(context, ocrPreferences).also {
                    zenFreeEngine = it
                }
            }
        }
    }

    private fun detectionEngine(): DetOcrEngine {
        return detEngine ?: (
            // Детектор живёт в паке cyrillic_ocr вместе с распознавателями.
            // Пока модели не скачаны (или LiteRT недоступен) — заглушка, и
            // scanLocally честно деградирует на распознавание всей страницы.
            if (localOcrAvailable() && cyrillicModelsInstalled()) {
                CyrillicDetOcrEngine { engineFor(EngineType.CYRILLIC) as CyrillicOcrEngine }
            } else {
                UnavailableDetOcrEngine()
            }
            ).also {
            detEngine = it
        }
    }

    /** Пак cyrillic_ocr установлен целиком (детектор + распознаватель + словарь). */
    private fun cyrillicModelsInstalled(): Boolean {
        return OcrModelFiles.allInstalled(
            context,
            listOf(
                CyrillicOcrEngine.DETECTOR_PATH,
                CyrillicOcrEngine.PRIMARY_PATH,
                CyrillicOcrEngine.PRIMARY_DICT_PATH,
            ),
        )
    }

    private suspend fun recognizeWithEngine(type: EngineType, image: Bitmap): String {
        return engineLocks.withTextEngineLock(type) {
            // Онлайн-модели отдают текст построчно и не склеивают переносы —
            // соединяем «пере-\nносится» в «переносится» централизованно.
            OcrTextCleaner.joinLineHyphens(engineFor(type).recognizeText(image))
        }
    }

    private suspend fun recognizeWithFallback(primary: EngineType, image: Bitmap): String {
        // Без сети онлайн-первичный движок не пробуем вовсе — сразу цепочка
        val skipPrimary = primary in onlineEngines && !isNetworkAvailable()
        var lastError: Throwable? = null

        if (!skipPrimary) {
            try {
                return recognizeWithEngine(primary, image)
            } catch (e: Throwable) {
                if (e is CancellationException) throw e
                lastError = e
            }
        }

        if (!useFallbackModelsPref.get()) {
            throw lastError ?: OcrException.ConnectionError(null)
        }

        for (engine in fallbackChain(primary)) {
            // Пропускаем онлайн-движки при отсутствии сети
            if (engine in onlineEngines && !isNetworkAvailable()) continue
            try {
                logcat(LogPriority.WARN) {
                    "OCR (${primary.name.lowercase()}) unavailable, trying ${engine.name.lowercase()}"
                }
                return recognizeWithEngine(engine, image)
            } catch (e: Throwable) {
                if (e is CancellationException) throw e
                lastError?.addSuppressed(e) ?: run { lastError = e }
            }
        }
        throw lastError ?: OcrException.InitializationError()
    }

    override suspend fun recognizeText(image: OcrImage): String {
        return withActiveOperation {
            submitTask(PrioritizedTaskQueue.Priority.HIGH) {
                image.useBitmap { bitmap ->
                    recognizeWithFallback(selectedEngineType(), bitmap)
                }
            }
        }
    }

    override suspend fun scanPage(
        chapterId: Long,
        pageIndex: Int,
        image: OcrImage,
    ): OcrPageResult {
        return withActiveOperation {
            val regionChoice = ocrPreferences.scanRegion().get()
            val result = image.useBitmap { originalBitmap ->
                // Авто-пресет: один раз на главу, до чтения профиля детектора.
                ContentAutoPreset.maybeApply(
                    chapterId = chapterId,
                    pageWidth = originalBitmap.width,
                    pageHeight = originalBitmap.height,
                    prefs = ocrPreferences,
                )
                val bitmap = when (regionChoice) {
                    mihon.domain.ocr.service.ScanRegion.TOP_HALF -> Bitmap.createBitmap(originalBitmap, 0, 0, originalBitmap.width, originalBitmap.height / 2)
                    mihon.domain.ocr.service.ScanRegion.BOTTOM_HALF -> Bitmap.createBitmap(originalBitmap, 0, originalBitmap.height / 2, originalBitmap.width, originalBitmap.height / 2)
                    else -> originalBitmap
                }
                when (val selectedModel = ocrModelPref.get()) {
                    OcrModel.CYRILLIC -> scanLocalOrFallback(
                        chapterId = chapterId,
                        pageIndex = pageIndex,
                        image = bitmap,
                        modelKey = selectedModel,
                        type = EngineType.CYRILLIC,
                    )
                    OcrModel.GLENS -> scanWithGlens(
                        chapterId = chapterId,
                        pageIndex = pageIndex,
                        image = bitmap,
                        modelKey = selectedModel,
                    )
                    OcrModel.LEGACY -> scanLocalOrFallback(
                        chapterId = chapterId,
                        pageIndex = pageIndex,
                        image = bitmap,
                        modelKey = selectedModel,
                        type = EngineType.CYRILLIC,
                    )
                    OcrModel.FAST -> scanLocalOrFallback(
                        chapterId = chapterId,
                        pageIndex = pageIndex,
                        image = bitmap,
                        modelKey = selectedModel,
                        type = EngineType.CYRILLIC,
                    )
                    OcrModel.OWOCR -> scanOwOcrOrFallback(
                        chapterId = chapterId,
                        pageIndex = pageIndex,
                        image = bitmap,
                        modelKey = selectedModel,
                    )
                    OcrModel.OPENROUTER -> scanWithEngineOrFallback(
                        chapterId = chapterId,
                        pageIndex = pageIndex,
                        image = bitmap,
                        modelKey = selectedModel,
                        type = EngineType.OPENROUTER,
                    )
                    OcrModel.GOOGLE -> scanWithEngineOrFallback(
                        chapterId = chapterId,
                        pageIndex = pageIndex,
                        image = bitmap,
                        modelKey = selectedModel,
                        type = EngineType.GOOGLE,
                    )
                    OcrModel.TESSERACT -> scanLocalOrFallback(
                        chapterId = chapterId,
                        pageIndex = pageIndex,
                        image = bitmap,
                        modelKey = selectedModel,
                        type = EngineType.CYRILLIC,
                    )
                    OcrModel.ZEN_FREE -> scanWithEngineOrFallback(
                        chapterId = chapterId,
                        pageIndex = pageIndex,
                        image = bitmap,
                        modelKey = selectedModel,
                        type = EngineType.ZEN_FREE,
                    )
                }
            }

            cacheStore.upsert(result)
            result
        }
    }

    override suspend fun getCachedPage(
        chapterId: Long,
        pageIndex: Int,
    ): OcrPageResult? {
        return cacheStore.getPage(
            chapterId = chapterId,
            pageIndex = pageIndex,
        )
    }

    override suspend fun getCachedChapterIds(chapterIds: Collection<Long>): Set<Long> {
        return cacheStore.getCachedChapterIds(
            chapterIds = chapterIds,
        )
    }

    override suspend fun clearCachedChapter(chapterId: Long) {
        cacheStore.clearChapter(chapterId)
    }

    override suspend fun clearCache() {
        cacheStore.clear()
    }

    override suspend fun getCacheSizeBytes(): Long {
        return cacheStore.sizeBytes()
    }

    override suspend fun <T> withScanSession(block: suspend () -> T): T {
        sessionMutex.withLock {
            activeScanSessions++
        }

        return try {
            block()
        } finally {
            sessionMutex.withLock {
                activeScanSessions--
            }
            performDeferredCleanupIfIdle()
        }
    }

    private suspend fun scanWithEngineOrFallback(
        chapterId: Long,
        pageIndex: Int,
        image: Bitmap,
        modelKey: OcrModel,
        type: EngineType,
    ): OcrPageResult {
        return try {
            val text = recognizeWithEngine(type, image)
            val bbox = OcrBoundingBox(0f, 0f, 1f, 1f)
            val region = OcrRegion(
                order = 0,
                text = text,
                boundingBox = bbox,
                textOrientation = OcrTextOrientation.Horizontal,
            )
            OcrPageResult(
                chapterId = chapterId,
                pageIndex = pageIndex,
                ocrModel = modelKey,
                imageWidth = image.width,
                imageHeight = image.height,
                regions = if (text.isBlank()) emptyList() else listOf(region),
            )
        } catch (e: Throwable) {
            if (!useFallbackModelsPref.get()) {
                throw e
            }
            if (isNetworkAvailable()) {
                scanWithGlens(
                    chapterId = chapterId,
                    pageIndex = pageIndex,
                    image = image,
                    modelKey = modelKey,
                )
            } else {
                // Без сети используем единый Cyrillic PP-OCR.
                scanLocally(
                    chapterId = chapterId,
                    pageIndex = pageIndex,
                    image = image,
                    modelKey = modelKey,
                    type = EngineType.CYRILLIC,
                )
            }
        }
    }

    private suspend fun scanLocalOrFallback(
        chapterId: Long,
        pageIndex: Int,
        image: Bitmap,
        modelKey: OcrModel,
        type: EngineType,
    ): OcrPageResult {
        return try {
            scanLocally(
                chapterId = chapterId,
                pageIndex = pageIndex,
                image = image,
                modelKey = modelKey,
                type = type,
            )
        } catch (e: Throwable) {
            val target = if (isNetworkAvailable()) EngineType.ZEN_FREE else EngineType.CYRILLIC
            logcat(LogPriority.WARN, e) {
                "Local OCR model unavailable; falling back to ${target.name.lowercase()}"
            }
            scanWithEngineOrFallback(
                chapterId = chapterId,
                pageIndex = pageIndex,
                image = image,
                modelKey = modelKey,
                type = target,
            )
        }
    }

    private suspend fun scanWithGlens(
        chapterId: Long,
        pageIndex: Int,
        image: Bitmap,
        modelKey: OcrModel,
    ): OcrPageResult {
        val result = try {
            submitTask(PrioritizedTaskQueue.Priority.NORMAL) {
                engineLocks.withTextEngineLock(EngineType.GLENS) {
                    val engine = glensEngine ?: GlensOcrEngine().also {
                        glensEngine = it
                    }
                    engine.recognizePage(image)
                }
            }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            if (isConnectivityFailure(error)) {
                throw OcrException.ConnectionError(error)
            }
            throw error
        }
        return OcrPageResult(
            chapterId = chapterId,
            pageIndex = pageIndex,
            ocrModel = modelKey,
            imageWidth = image.width,
            imageHeight = image.height,
            regions = result.regions.map { it.copy(text = OcrTextCleaner.joinLineHyphens(it.text)) },
        )
    }

    private suspend fun scanWithOwOcr(
        chapterId: Long,
        pageIndex: Int,
        image: Bitmap,
        modelKey: OcrModel,
    ): OcrPageResult {
        val result = try {
            submitTask(PrioritizedTaskQueue.Priority.NORMAL) {
                engineLocks.withTextEngineLock(EngineType.OWOCR) {
                    val engine = owOcrEngine ?: OwOcrEngine(context).also {
                        owOcrEngine = it
                    }
                    engine.recognizePage(image)
                }
            }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            if (isConnectivityFailure(error)) {
                throw OcrException.ConnectionError(error)
            }
            throw error
        }
        return OcrPageResult(
            chapterId = chapterId,
            pageIndex = pageIndex,
            ocrModel = modelKey,
            imageWidth = image.width,
            imageHeight = image.height,
            regions = result.map { it.copy(text = OcrTextCleaner.joinLineHyphens(it.text)) },
        )
    }

    private suspend fun scanOwOcrOrFallback(
        chapterId: Long,
        pageIndex: Int,
        image: Bitmap,
        modelKey: OcrModel,
    ): OcrPageResult {
        return try {
            scanWithOwOcr(
                chapterId = chapterId,
                pageIndex = pageIndex,
                image = image,
                modelKey = modelKey,
            )
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            if (!useFallbackModelsPref.get()) {
                throw e
            }
            logcat(LogPriority.WARN, e) {
                "OwOCR scanning failed, falling back to glens"
            }
            scanWithGlens(
                chapterId = chapterId,
                pageIndex = pageIndex,
                image = image,
                modelKey = modelKey,
            )
        }
    }

    private suspend fun scanLocally(
        chapterId: Long,
        pageIndex: Int,
        image: Bitmap,
        modelKey: OcrModel,
        type: EngineType,
    ): OcrPageResult {
        // Детектор областей работает на модели PP-OCRv4 из пака cyrillic_ocr
        // и даёт по региону на строку — благодаря этому тап по конкретной
        // реплике открывает именно её.
        //
        // Если пак не установлен (или LiteRT недоступен), детектор бросает
        // DetectionUnavailable, и мы честно деградируем: распознаём страницу
        // целиком и отдаём один регион на весь лист (isWholePage = true).
        // Раньше заглушка бросала всегда, поэтому постраничный режим был
        // единственно возможным.
        val boxes: List<OcrBoundingBox>? = try {
            submitTask(PrioritizedTaskQueue.Priority.NORMAL) {
                engineLocks.withDetectionLock {
                    val engine = detectionEngine()
                    engine.detectTextRegions(image)
                }
            }
                .filter(OcrBoundingBox::isValid)
        } catch (e: OcrException.DetectionUnavailable) {
            logcat(LogPriority.INFO) {
                "Region detector unavailable; falling back to whole-page recognition"
            }
            null
        }

        // Детектор ничего не нашёл, либо нашёл единственный бокс во весь лист:
        // разметки по репликам не получится, поэтому идём общим путём, а не
        // сообщаем «текста нет».
        val usableBoxes = boxes?.takeIf { found ->
            found.isNotEmpty() && !(found.size == 1 && OcrBoxGeometry.coversWholePage(found[0]))
        }

        if (usableBoxes == null) {
            val text = submitTask(PrioritizedTaskQueue.Priority.NORMAL) {
                recognizeWithEngine(type, image)
            }.trim()
            val regions = if (text.isBlank()) {
                emptyList()
            } else {
                listOf(
                    OcrRegion(
                        order = 0,
                        text = text,
                        boundingBox = OcrBoundingBox(0f, 0f, 1f, 1f),
                        textOrientation = OcrTextOrientation.Horizontal,
                    ),
                )
            }
            return OcrPageResult(
                chapterId = chapterId,
                pageIndex = pageIndex,
                ocrModel = modelKey,
                imageWidth = image.width,
                imageHeight = image.height,
                regions = regions,
            )
        }

        val regions = usableBoxes.mapIndexedNotNull { index, box ->
            val crop = cropBitmap(image, box) ?: return@mapIndexedNotNull null
            try {
                val text = submitTask(PrioritizedTaskQueue.Priority.NORMAL) {
                    engineLocks.withTextEngineLock(type) {
                        val engine = engineFor(type)
                        if (engine is LineOcrEngine) {
                            // Кроп — уже готовая строка: повторный детектор
                            // запрещён, иначе линия дробится и текст рушится.
                            engine.recognizeLine(crop)
                        } else {
                            engine.recognizeText(crop)
                        }
                    }
                }.trim()
                if (text.isBlank()) {
                    null
                } else {
                    OcrRegion(
                        order = index,
                        text = text,
                        boundingBox = box,
                        textOrientation = OcrTextOrientation.Horizontal,
                    )
                }
            } finally {
                if (!crop.isRecycled) {
                    crop.recycle()
                }
            }
        }

        // Если детектор нашёл области, но каждая построчная попытка была
        // отклонена, не превращаем видимое большое облачко в «Нет результатов».
        // Выполняем один локальный цельностраничный rescue-проход; он проходит
        // через тот же CyrillicOcrEngine и те же UTF-8/кириллические фильтры.
        val finalRegions = if (regions.isNotEmpty()) {
            regions
        } else {
            val text = submitTask(PrioritizedTaskQueue.Priority.NORMAL) {
                recognizeWithEngine(type, image)
            }.trim()
            if (text.isBlank()) {
                emptyList()
            } else {
                listOf(
                    OcrRegion(
                        order = 0,
                        text = text,
                        boundingBox = OcrBoundingBox(0f, 0f, 1f, 1f),
                        textOrientation = OcrTextOrientation.Horizontal,
                    ),
                )
            }
        }

        return OcrPageResult(
            chapterId = chapterId,
            pageIndex = pageIndex,
            ocrModel = modelKey,
            imageWidth = image.width,
            imageHeight = image.height,
            regions = finalRegions,
        )
    }

    private fun cropBitmap(
        image: Bitmap,
        box: OcrBoundingBox,
    ): Bitmap? {
        val left = (box.left * image.width).toInt().coerceIn(0, image.width - 1)
        val top = (box.top * image.height).toInt().coerceIn(0, image.height - 1)
        val right = (box.right * image.width).toInt().coerceIn(left + 1, image.width)
        val bottom = (box.bottom * image.height).toInt().coerceIn(top + 1, image.height)

        val rect = Rect(left, top, right, bottom)
        if (rect.width() <= 0 || rect.height() <= 0) {
            return null
        }

        return Bitmap.createBitmap(image, rect.left, rect.top, rect.width(), rect.height())
    }

    override fun cleanup() {
        scope.launch {
            cleanupMutex.withLock {
                cleanupRequested = true
            }
            performDeferredCleanupIfIdle()
        }
    }

    private suspend fun <T> submitTask(
        priority: PrioritizedTaskQueue.Priority,
        block: suspend () -> T,
    ): T {
        return taskQueue.submit(priority, block)
    }

    private suspend fun <T> withActiveOperation(block: suspend () -> T): T {
        operationMutex.withLock {
            activeOperations++
        }

        return try {
            block()
        } finally {
            operationMutex.withLock {
                activeOperations--
            }
            performDeferredCleanupIfIdle()
        }
    }

    private suspend fun performDeferredCleanupIfIdle() {
        val shouldCleanup = cleanupMutex.withLock {
            if (!cleanupRequested || !taskQueue.isIdle() || hasActiveOperations() || hasActiveScanSessions()) {
                return@withLock false
            }

            cleanupRequested = false
            true
        }

        if (!shouldCleanup) {
            return
        }

        try {
            closeEngines()
            cacheStore.close()
            logcat(LogPriority.INFO) { "OcrRepositoryImpl cleaned up successfully" }
        } catch (e: Exception) {
            logcat(LogPriority.ERROR, e) { "Error cleaning up OcrRepositoryImpl" }
        }
    }

    private suspend fun <T> OcrImage.useBitmap(
        block: suspend (Bitmap) -> T,
    ): T {
        val bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
        return try {
            block(bitmap)
        } finally {
            if (!bitmap.isRecycled) {
                bitmap.recycle()
            }
        }
    }

    private suspend fun hasActiveScanSessions(): Boolean {
        return sessionMutex.withLock { activeScanSessions > 0 }
    }

    private suspend fun hasActiveOperations(): Boolean {
        return operationMutex.withLock { activeOperations > 0 }
    }

    private suspend fun closeEngines() {
        engineLocks.withAllLocks {
            // Сначала сбрасываем детектор: он делегирует в cyrillicEngine и
            // после его закрытия ссылался бы на закрытые модели.
            detEngine = null

            cyrillicEngine?.close()
            cyrillicEngine = null

            legacyEngine?.close()
            legacyEngine = null

            fastEngine?.close()
            fastEngine = null

            glensEngine?.close()
            glensEngine = null

            owOcrEngine?.close()
            owOcrEngine = null

            openRouterEngine?.close()
            openRouterEngine = null

            googleAiEngine?.close()
            googleAiEngine = null

            zenFreeEngine?.close()
            zenFreeEngine = null

            detEngine?.close()
            detEngine = null
        }
    }
}
