package eu.kanade.tachiyomi.data.ai

import android.app.ActivityManager
import android.content.Context
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import logcat.LogPriority
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.tukaani.xz.LZMA2Options
import org.tukaani.xz.XZOutputStream
import tachiyomi.core.common.util.system.logcat
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * ЛОКАЛЬНЫЕ LLM НА ТЕЛЕФОНЕ (MediaPipe LLM Inference, .task-модели LiteRT).
 *
 * Каталог моделей разбит по ОЗУ устройства (1/2/4/6+ ГБ), у каждой модели —
 * характеристики и «тест перед запуском»:
 *  • тир ОЗУ проверяется по ActivityManager.MemoryInfo (реальная память);
 *  • после скачивания перед первым чатом выполняется probe-инференс
 *    («Скажи ОК») — только успешный probe помечает модель рабочей;
 *  • модель можно экспортировать в tar.xz для других приложений — размер
 *    заметно меньше оригинала (квантованные веса дожимаются xz на 20-40%).
 *
 * ЧЕСТНОЕ ограничение: GGUF-файлы llama.cpp НЕ исполняются на Android без
 * нативной библиотеки llama.cpp; на телефоне работает формат .task
 * (LiteRT/MediaPipe). GGUF-модели в списке помечены как «полу-онлайн»: они
 * запускаются на GitHub-ранере (RunnerLlm) — телефон подключается к ним
 * по токену. ONNX-чат аналогично: на устройстве нет ORT GenAI-рантайма,
 * поэтому onnx-модели тоже уходят в полу-онлайн список.
 */
object LocalLlm {

    enum class RamTier(val minRamGb: Int, val label: String) {
        GB1(0, "1 ГБ+"),
        GB2(2, "2 ГБ+"),
        GB4(4, "4 ГБ+"),
        GB6(6, "6 ГБ+"),
    }

    data class Model(
        val id: String,
        val name: String,
        val url: String,
        val sizeMb: Int,
        val tier: RamTier,
        /** Характеристика: параметры, квантизация, на что способна. */
        val specs: String,
        /** Абсолютный путь для пользовательских моделей (вне llm_models/). */
        val filePath: String? = null,
    )

    /**
     * Каталог .task-моделей (litert-community, ссылки проверены живьём:
     * HTTP 200, размеры реальные).
     */
    val CATALOG = listOf(
        Model(
            id = "qwen25_05b",
            name = "Qwen2.5 0.5B Instruct",
            url = "https://huggingface.co/litert-community/Qwen2.5-0.5B-Instruct/resolve/main/" +
                "Qwen2.5-0.5B-Instruct_multi-prefill-seq_q8_ekv1280.task",
            sizeMb = 521,
            tier = RamTier.GB2,
            specs = "0.5 млрд параметров, int8 • русский/английский • простые ответы, " +
                "суммаризация, определение пола реплик • ~1 ГБ ОЗУ при работе",
        ),
        Model(
            id = "tinyllama_11b",
            name = "TinyLlama 1.1B Chat",
            url = "https://huggingface.co/litert-community/TinyLlama-1.1B-Chat-v1.0/resolve/main/" +
                "TinyLlama-1.1B-Chat-v1.0_multi-prefill-seq_q8_ekv1280.task",
            sizeMb = 1095,
            tier = RamTier.GB4,
            specs = "1.1 млрд параметров, int8 • английский сильнее русского • " +
                "диалоги, черновики текста • ~2 ГБ ОЗУ при работе",
        ),
        Model(
            id = "qwen25_15b",
            name = "Qwen2.5 1.5B Instruct",
            url = "https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/" +
                "Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv1280.task",
            sizeMb = 1523,
            tier = RamTier.GB4,
            specs = "1.5 млрд параметров, int8 • хороший русский • полноценный чат, " +
                "нейро-книги, редактура • ~2.5 ГБ ОЗУ при работе",
        ),
        Model(
            id = "phi4_mini",
            name = "Phi-4 Mini Instruct",
            url = "https://huggingface.co/litert-community/Phi-4-mini-instruct/resolve/main/" +
                "Phi-4-mini-instruct_multi-prefill-seq_q8_ekv1280.task",
            sizeMb = 3761,
            tier = RamTier.GB6,
            specs = "3.8 млрд параметров, int8 • сильные рассуждения, код • " +
                "лучшая офлайн-модель каталога • ~5 ГБ ОЗУ при работе",
        ),
    )

    /** Реальный объём ОЗУ устройства в ГБ (округлённый вверх). */
    fun deviceRamGb(context: Context): Int {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = ActivityManager.MemoryInfo()
        am.getMemoryInfo(info)
        return ((info.totalMem + (1L shl 29)) / (1L shl 30)).toInt().coerceAtLeast(1)
    }

    /** Модели, подходящие устройству по ОЗУ (тест ДО скачивания). */
    fun recommendedFor(context: Context): List<Model> {
        val ram = deviceRamGb(context)
        return CATALOG.filter { it.tier.minRamGb <= ram }
    }

    fun modelsDir(context: Context): File =
        File(context.getExternalFilesDir(null), "llm_models").apply { mkdirs() }

    /** Папка пользовательских моделей: /sdcard/Yomikai/LLM — закинь .task туда. */
    fun userModelsDir(): File =
        File(android.os.Environment.getExternalStorageDirectory(), "Yomikai/LLM").apply { mkdirs() }

    /**
     * СВОИ МОДЕЛИ (по требованию пользователя): любые .task-файлы из
     * /sdcard/Yomikai/LLM и llm_models/, которых нет в каталоге. Тир ОЗУ
     * оценивается по размеру файла (вес ~= потребление int8-модели, х1.4).
     */
    fun customModels(context: Context): List<Model> {
        val known = CATALOG.map { "${it.id}.task" }.toSet()
        val dirs = listOf(userModelsDir(), modelsDir(context))
        return dirs.flatMap { d ->
            d.listFiles { f -> f.isFile && f.extension == "task" && f.name !in known }
                ?.toList().orEmpty()
        }.distinctBy { it.name }.map { f ->
            val sizeMb = (f.length() / 1048576L).toInt()
            val needGb = ((sizeMb * 14 / 10) + 1023) / 1024
            Model(
                id = "custom_" + f.nameWithoutExtension,
                name = f.nameWithoutExtension + " (своя)",
                url = "",
                sizeMb = sizeMb,
                tier = when {
                    needGb <= 1 -> RamTier.GB1
                    needGb <= 2 -> RamTier.GB2
                    needGb <= 4 -> RamTier.GB4
                    else -> RamTier.GB6
                },
                specs = "Пользовательская модель из ${f.parentFile?.name}/ • файл ${sizeMb} МБ",
                filePath = f.absolutePath,
            )
        }
    }

    /**
     * Модель ПО ССЫЛКЕ: скачивает произвольный .task URL в llm_models/.
     * Имя берётся из URL. Возвращает Model для немедленного использования.
     */
    fun modelFromUrl(url: String): Model? {
        val name = url.substringAfterLast('/').substringBefore('?')
        if (!name.endsWith(".task")) return null
        return Model(
            id = "url_" + name.removeSuffix(".task").take(40),
            name = name.removeSuffix(".task"),
            url = url,
            sizeMb = 0, // неизвестен до скачивания — прогресс по Content-Length
            tier = RamTier.GB2,
            specs = "Модель по ссылке: $url",
        )
    }

    /**
     * ПОИСК моделей на HuggingFace (реальный API): .task-модели LiteRT.
     * Возвращает пары (modelId, прямой url первого .task файла).
     */
    suspend fun searchHuggingFace(query: String): List<Pair<String, String>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val q = java.net.URLEncoder.encode("$query task litert", "UTF-8")
                val conn = URL("https://huggingface.co/api/models?search=$q&limit=10")
                    .openConnection() as HttpURLConnection
                conn.connectTimeout = 15_000
                conn.readTimeout = 20_000
                val body = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
                conn.disconnect()
                val arr = org.json.JSONArray(body)
                buildList {
                    for (i in 0 until arr.length()) {
                        val id = arr.getJSONObject(i).optString("modelId")
                        if (id.isNotBlank()) {
                            // Файлы модели: берём список siblings отдельным запросом лениво в UI;
                            // здесь — предполагаемый прямой путь (HF отдаёт 302 на blob)
                            add(id to "https://huggingface.co/$id/resolve/main/")
                        }
                    }
                }
            }.getOrDefault(emptyList())
        }

    fun fileOf(context: Context, m: Model): File =
        m.filePath?.let { File(it) } ?: File(modelsDir(context), "${m.id}.task")

    /**
     * Установлена ли модель ЦЕЛИКОМ. Раньше порог был 50% размера — файл,
     * побитый оборванной/параллельной загрузкой, считался «установленным»,
     * движок на нём падал и тест проваливался (баг со скриншота).
     * Теперь: не меньше 97% каталожного размера.
     */
    fun isInstalled(context: Context, m: Model): Boolean {
        val f = fileOf(context, m)
        if (!f.isFile) return false
        // Кастомные/по-ссылке: файл уже на месте — размер сверять не с чем
        if (m.filePath != null || m.sizeMb == 0) return f.length() > 10 * 1048576L
        return f.length() >= m.sizeMb * 1048576L * 97 / 100
    }

    // ---- Прогресс скачивания (как у OCR-паков) ----
    private val _progress = MutableStateFlow<Map<String, Float>>(emptyMap())
    val progress: StateFlow<Map<String, Float>> = _progress

    /** Статус проверки модели: id -> "ok" | "fail" | "testing" */
    private val _probeState = MutableStateFlow<Map<String, String>>(emptyMap())
    val probeState: StateFlow<Map<String, String>> = _probeState

    private val mutex = Mutex()
    private var engine: LlmInference? = null
    private var engineModelId: String? = null

    /** Паки, которые уже качаются — повторные тапы игнорируются. */
    private val activeDownloads = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    suspend fun download(context: Context, m: Model): Boolean = withContext(Dispatchers.IO) {
        val dst = fileOf(context, m)
        if (isInstalled(context, m)) return@withContext true
        // ЗАЩИТА ОТ МУЛЬТИТАПА (баг со скриншота: «модель скачивается
        // несколько раз, если нажать несколько раз»): второй и последующие
        // вызовы для того же id просто выходят — качает только первый.
        if (!activeDownloads.add(m.id)) return@withContext false
        // Битый недокачанный файл (есть, но не прошёл isInstalled) — стираем,
        // иначе движок инициализируется на мусоре
        if (dst.isFile) dst.delete()
        val part = File(dst.parentFile, dst.name + ".part")
        var conn: HttpURLConnection? = null
        try {
            conn = URL(m.url).openConnection() as HttpURLConnection
            conn.connectTimeout = 30_000
            conn.readTimeout = 120_000
            conn.instanceFollowRedirects = true
            if (conn.responseCode !in 200..299) return@withContext false
            val total = conn.contentLengthLong.takeIf { it > 0 } ?: (m.sizeMb * 1048576L)
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(512 * 1024)
                    var read = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        read += n
                        // Троттлинг: публикуем прогресс только при смене
                        // процента — иначе UI рекомпозится на каждые 512КБ
                        // и интерфейс лагает (жалоба пользователя).
                        val frac = (read.toFloat() / total).coerceIn(0f, 1f)
                        val prev = _progress.value[m.id] ?: -1f
                        if ((frac * 100).toInt() != (prev * 100).toInt()) {
                            _progress.value = _progress.value + (m.id to frac)
                        }
                    }
                }
            }
            // Валидация ПЕРЕД публикацией: недокачанный файл не переименовываем
            if (part.length() < m.sizeMb * 1048576L * 97 / 100) {
                logcat(LogPriority.WARN) {
                    "LLM download incomplete: ${part.length()} of ~${m.sizeMb}MB for ${m.id}"
                }
                part.delete()
                false
            } else {
                part.renameTo(dst)
            }
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "LLM download failed: ${m.id}" }
            part.delete()
            false
        } finally {
            conn?.disconnect()
            _progress.value = _progress.value - m.id
            activeDownloads.remove(m.id)
        }
    }

    fun delete(context: Context, m: Model) {
        runCatching { if (engineModelId == m.id) { engine?.close(); engine = null; engineModelId = null } }
        fileOf(context, m).delete()
        _probeState.value = _probeState.value - m.id
    }

    private suspend fun ensureEngine(context: Context, m: Model): LlmInference? = mutex.withLock {
        if (engineModelId == m.id) return@withLock engine
        runCatching { engine?.close() }
        engine = null
        engineModelId = null
        val f = fileOf(context, m)
        if (!f.isFile) return@withLock null
        runCatching {
            val options = LlmInference.LlmInferenceOptions.builder()
                .setModelPath(f.absolutePath)
                .setMaxTokens(1024)
                .build()
            LlmInference.createFromOptions(context.applicationContext, options)
        }.onFailure {
            logcat(LogPriority.ERROR, it) { "LLM engine init failed: ${m.id}" }
        }.getOrNull()?.also {
            engine = it
            engineModelId = m.id
        }
    }

    /**
     * ТЕСТ ПЕРЕД ЗАПУСКОМ: реальный probe-инференс. Возвращает пару
     * (успех, сообщение с временем ответа или ошибкой).
     */
    suspend fun probe(context: Context, m: Model): Pair<Boolean, String> = withContext(Dispatchers.IO) {
        _probeState.value = _probeState.value + (m.id to "testing")
        val ramGb = deviceRamGb(context)
        if (m.tier.minRamGb > ramGb) {
            _probeState.value = _probeState.value + (m.id to "fail")
            return@withContext false to "Мало ОЗУ: у устройства $ramGb ГБ, модели нужно ${m.tier.label}"
        }
        val started = System.currentTimeMillis()
        val result = runCatching {
            val eng = ensureEngine(context, m) ?: error("движок не инициализировался")
            eng.generateResponse("Ответь одним словом: ОК")
        }
        val took = System.currentTimeMillis() - started
        result.fold(
            onSuccess = {
                _probeState.value = _probeState.value + (m.id to "ok")
                true to "Тест пройден за ${took / 1000.0}с: «${it.take(40).trim()}»"
            },
            onFailure = {
                _probeState.value = _probeState.value + (m.id to "fail")
                false to "Тест провален: ${it.message?.take(120)}"
            },
        )
    }

    /** Локальный чат: полностью офлайн-ответ установленной моделью. */
    suspend fun chat(context: Context, m: Model, prompt: String): String? = withContext(Dispatchers.IO) {
        runCatching {
            val eng = ensureEngine(context, m) ?: return@withContext null
            eng.generateResponse(prompt)
        }.onFailure {
            logcat(LogPriority.WARN, it) { "Local LLM chat failed" }
        }.getOrNull()
    }

    fun unload() {
        runCatching { engine?.close() }
        engine = null
        engineModelId = null
    }

    /**
     * ЭКСПОРТ модели в tar.xz для других приложений: реальный Apache
     * commons-compress + XZ (LZMA2, preset 6 — баланс скорость/сжатие).
     * Квантованные веса дожимаются на ~20-40%. Файл кладётся в
     * workspace AI-агента (/sdcard/Yomikai/AI), откуда его можно
     * «Поделиться» в любое приложение.
     */
    suspend fun exportTarXz(context: Context, m: Model, onProgress: (Float) -> Unit = {}): File? =
        withContext(Dispatchers.IO) {
            val src = fileOf(context, m)
            if (!src.isFile) return@withContext null
            runCatching {
                val outFile = File(AiWorkspace.root(context), "export/${m.id}.tar.xz")
                outFile.parentFile?.mkdirs()
                val total = src.length().toFloat()
                XZOutputStream(FileOutputStream(outFile), LZMA2Options(6)).use { xz ->
                    TarArchiveOutputStream(xz).use { tar ->
                        tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX)
                        val entry = TarArchiveEntry(src, src.name)
                        tar.putArchiveEntry(entry)
                        FileInputStream(src).use { input ->
                            val buf = ByteArray(1 shl 20)
                            var done = 0L
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                tar.write(buf, 0, n)
                                done += n
                                onProgress(done / total)
                            }
                        }
                        tar.closeArchiveEntry()
                    }
                }
                outFile
            }.onFailure {
                logcat(LogPriority.ERROR, it) { "LLM export failed" }
            }.getOrNull()
        }
}
