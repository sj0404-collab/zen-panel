package eu.kanade.tachiyomi.data.ocr

import android.content.Context
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import eu.kanade.tachiyomi.R
import logcat.LogPriority
import mihon.data.ocr.OcrModelFiles
import tachiyomi.core.common.util.system.logcat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads optional local OCR/vision models into the app's external files dir
 * (Android/data/<package>/files/ocr_models/). Models are NOT bundled in the APK:
 * out of the box the app uses online engines only, and local models are an
 * opt-in download. Files can also be installed manually into Yomihon/OCR/ on
 * shared storage (see OcrModelFiles for the full search order).
 */

/** Utility: format bytes to human-readable size. */
private fun formatSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes Б"
    bytes < 1048576 -> "${"%.1f".format(bytes / 1024.0)} КБ"
    bytes < 1073741824 -> "${"%.1f".format(bytes / 1048576.0)} МБ"
    else -> "${"%.2f".format(bytes / 1073741824.0)} ГБ"
}

private const val CHANNEL_ID = "model_download"
private const val NOTIF_ID = 77001

private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Загрузка моделей", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Прогресс загрузки OCR и TTS моделей"
                }
            )
        }
    }
}

/** Show/update download progress notification in the shade. */
private fun showNotif(
    context: Context,
    title: String,
    text: String,
    progress: Int,
    downloadedBytes: Long = 0,
    totalBytes: Long = 0,
) {
    ensureChannel(context)
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val pi = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    // Build informative sub-text with size when available
    val sizeText = when {
        totalBytes > 0 -> "${formatSize(downloadedBytes)} / ${formatSize(totalBytes)}"
        downloadedBytes > 0 -> formatSize(downloadedBytes)
        else -> null
    }
    val contentText = if (sizeText != null) "$text  ($sizeText)" else text
    val notif = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setContentTitle(title)
        .setContentText(contentText)
        .setProgress(100, progress, progress < 0)
        .setContentIntent(pi)
        .setOngoing(true)
        .setSilent(true)
        .build()
    nm.notify(NOTIF_ID, notif)
}

private fun cancelNotif(context: Context) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    nm?.cancel(NOTIF_ID)
}

object OcrModelDownloader {

    /** Model packs: pack name -> list of (url, flat file name). */
    val PACKS: Map<String, List<Pair<String, String>>> = mapOf(
        // Default Russian/Cyrillic offline OCR. Pinned to an immutable commit;
        // models are downloaded once and never inflate the APK.
        "cyrillic_ocr" to listOf(
            cyrillic("models/tflite/pp-ocrv4_mobile_det_float32.tflite") to "cyrillic_detector.tflite",
            cyrillic("models/tflite/cyrillic_pp-ocrv3_mobile_rec_float32.tflite") to "cyrillic_recognizer_v3.tflite",
            cyrillic("models/tflite/cyrillic_pp-ocrv5_mobile_rec_float32.tflite") to "cyrillic_recognizer_v5.tflite",
            cyrillic("models/dicts/cyrillic_dict.txt") to "cyrillic_dict_v3.txt",
            cyrillic("models/dicts/ppocrv5_cyrillic_dict.txt") to "cyrillic_dict_v5.txt",
        ),
        "manga_ocr" to listOf(
            hf("bluolightning/manga-ocr-tflite", "mocr_2025_encoder_fp32.tflite") to "encoder.tflite",
            hf("bluolightning/manga-ocr-tflite", "mocr_2025_decoder_float32.tflite") to "decoder.tflite",
            hf("bluolightning/manga-ocr-tflite", "mocr_2025_embeddings_float32.bin") to "embeddings.bin",
        ),
        "manga_ocr_fast" to listOf(
            hf("bluolightning/manga-ocr-mobile", "v1_fp16/encoder.tflite") to "encoder_fast.tflite",
            hf("bluolightning/manga-ocr-mobile", "v1_fp16/decoder.tflite") to "decoder_fast.tflite",
        ),
        "panel_detector" to listOf(
            hf("leoxs22/manga-panel-detector-yolo26n", "manga_panel_detector_int8.tflite") to "panel_detector.tflite",
        ),
    )

    /** Asset-style paths per pack, used to check installation and delete files. */
    val PACK_ASSET_PATHS: Map<String, List<String>> = mapOf(
        "cyrillic_ocr" to listOf(
            "cyrillic_ocr/detector.tflite",
            "cyrillic_ocr/recognizer_v3.tflite",
            "cyrillic_ocr/recognizer_v5.tflite",
            "cyrillic_ocr/dict_v3.txt",
            "cyrillic_ocr/dict_v5.txt",
        ),
        "manga_ocr" to listOf("ocr/encoder.tflite", "ocr/decoder.tflite", "ocr/embeddings.bin"),
        "manga_ocr_fast" to listOf("ocr_fast/encoder.tflite", "ocr_fast/decoder.tflite"),
        "panel_detector" to listOf("panel_detector/model.tflite"),
    )

    /** Пин коммита репозитория моделей: неизменяемый источник файлов. */
    private const val CYRILLIC_PIN = "0279620ace18256b36850d6773bad03ffad03fa7"

    private fun cyrillic(path: String): String {
        return "https://raw.githubusercontent.com/sj0404-collab/ocr-rus-cyrillic/$CYRILLIC_PIN/$path"
    }

    /** Зеркало через jsDelivr CDN (тот же пин) — резерв при сбоях raw.github. */
    private fun cyrillicMirror(path: String): String {
        return "https://cdn.jsdelivr.net/gh/sj0404-collab/ocr-rus-cyrillic@$CYRILLIC_PIN/$path"
    }

    /**
     * Резервные URL по плоскому имени файла: если основной источник
     * недоступен (rate-limit raw.githubusercontent, блокировки провайдера),
     * загрузчик автоматически пробует зеркала.
     */
    private val FILE_MIRRORS: Map<String, List<String>> = mapOf(
        "cyrillic_detector.tflite" to listOf(
            cyrillicMirror("models/tflite/pp-ocrv4_mobile_det_float32.tflite"),
        ),
        "cyrillic_recognizer_v3.tflite" to listOf(
            cyrillicMirror("models/tflite/cyrillic_pp-ocrv3_mobile_rec_float32.tflite"),
        ),
        "cyrillic_recognizer_v5.tflite" to listOf(
            cyrillicMirror("models/tflite/cyrillic_pp-ocrv5_mobile_rec_float32.tflite"),
        ),
        "cyrillic_dict_v3.txt" to listOf(cyrillicMirror("models/dicts/cyrillic_dict.txt")),
        "cyrillic_dict_v5.txt" to listOf(cyrillicMirror("models/dicts/ppocrv5_cyrillic_dict.txt")),
    )

    private fun hf(repo: String, path: String): String {
        return "https://huggingface.co/$repo/resolve/main/$path"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val downloadMutex = Mutex()
    private val activePacks = mutableSetOf<String>()

    /**
     * ЖИВОЙ ИНДИКАТОР загрузки (по требованию пользователя): pack -> прогресс.
     *  0f..1f  — идёт загрузка (доля скачанных байт всех файлов пака);
     *  null    — пак не качается (установлен или не тронут).
     * UI подписывается на flow и рисует LinearProgressIndicator с процентами.
     */
    private val _progress = kotlinx.coroutines.flow.MutableStateFlow<Map<String, Float>>(emptyMap())
    val progress: kotlinx.coroutines.flow.StateFlow<Map<String, Float>> = _progress

    private fun setProgress(pack: String, value: Float?) {
        _progress.value = if (value == null) {
            _progress.value - pack
        } else {
            _progress.value + (pack to value)
        }
    }

    /** Суммарный размер установленных файлов пака в байтах (0 если нет). */
    fun installedSize(context: Context, pack: String): Long {
        val paths = PACK_ASSET_PATHS[pack] ?: return 0L
        return paths.sumOf { p ->
            OcrModelFiles.resolve(context, p)?.let { File(it).length() } ?: 0L
        }
    }

    /**
     * Гарантирует наличие YOLO-детектора: если пак не установлен — качает
     * его прямо сейчас (6МБ, suspend). Вернёт путь к .tflite или null.
     * Используется авточтением как замена прежнему встроенному tar.xz
     * (вынесен из APK ради веса — приложение похудело на 10.6МБ).
     */
    suspend fun ensurePanelDetector(context: Context): String? {
        val path = OcrModelFiles.resolve(context, "panel_detector/model.tflite")
        if (path != null) return path
        return kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            downloadPack(context, "panel_detector") { ok ->
                val p2 = if (ok) OcrModelFiles.resolve(context, "panel_detector/model.tflite") else null
                if (cont.isActive) cont.resumeWith(Result.success(p2))
            }
        }
    }

    fun isPackInstalled(context: Context, pack: String): Boolean {
        val paths = PACK_ASSET_PATHS[pack] ?: return false
        return OcrModelFiles.allInstalled(context, paths)
    }

    fun deletePack(context: Context, pack: String) {
        val paths = PACK_ASSET_PATHS[pack] ?: return
        OcrModelFiles.delete(context, paths)
        context.toast("Локальные файлы модели удалены")
    }

    /**
     * Downloads all files of a pack into ocr_models/ with .part staging so the
     * engines never pick up partially written files. Reports progress via toasts
     * and [onFinished] with success flag.
     */
    fun downloadPack(
        context: Context,
        pack: String,
        onFinished: (Boolean) -> Unit = {},
    ) {
        val files = PACKS[pack]
        if (files == null) {
            context.toast("Неизвестный пакет моделей: $pack")
            onFinished(false)
            return
        }

        scope.launch {
            val shouldStart = downloadMutex.withLock { activePacks.add(pack) }
            if (!shouldStart) {
                withContext(Dispatchers.Main) { context.toast("Загрузка уже идёт…") }
                return@launch
            }

            withContext(Dispatchers.Main) {
                context.toast("Загрузка моделей началась (${files.size} файл(ов))…")
            }

            setProgress(pack, 0f)
            val ok = try {
                val baseDir = context.getExternalFilesDir(null)
                    ?.let { File(it, OcrModelFiles.MODELS_DIR) }
                    ?.apply { mkdirs() }

                if (baseDir == null) {
                    false
                } else {
                    // Прогресс по файлам: каждый файл — своя доля пака,
                    // внутри файла — по скачанным байтам (Content-Length).
                    // Pre-fetch Content-Length for all files to show total size
                    val fileSizes = files.map { (url, _) ->
                        runCatching {
                            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                                connectTimeout = 10_000
                                requestMethod = "HEAD"
                            }
                            conn.disconnect()
                            conn.contentLengthLong.takeIf { it > 0 } ?: 0L
                        }.getOrDefault(0L)
                    }
                    val totalPackSize = fileSizes.sum()
                    var done = 0
                    var totalDownloaded = 0L
                    files.all { (url, name) ->
                        val fileIndex = done
                        var fileDownloaded = 0L
                        // Основной URL + зеркала (jsDelivr): raw.githubusercontent
                        // иногда rate-limit-ит или недоступен — пробуем по порядку.
                        val candidates = listOf(url) + FILE_MIRRORS[name].orEmpty()
                        var r = false
                        for ((attempt, candidateUrl) in candidates.withIndex()) {
                            if (attempt > 0) {
                                logcat(LogPriority.WARN) {
                                    "Pack $pack: primary source failed for $name, trying mirror"
                                }
                            }
                            r = downloadFile(candidateUrl, File(baseDir, name)) { frac ->
                            val prev = fileDownloaded
                            fileDownloaded = (fileSizes[fileIndex] * frac).toLong()
                            totalDownloaded += (fileDownloaded - prev)
                            setProgress(pack, (fileIndex + frac) / files.size)
                            val pct = ((fileIndex + frac) / files.size * 100).toInt()
                            showNotif(
                                context,
                                "Загрузка моделей: $pack",
                                "${pct}% — файл ${fileIndex + 1}/${files.size}",
                                pct,
                                downloadedBytes = totalDownloaded,
                                totalBytes = totalPackSize.takeIf { it > 0 } ?: 0L,
                            )
                        }
                            if (r) break
                        }
                        // If server didn't report size, track from actual download
                        if (fileSizes[fileIndex] == 0L) {
                            totalDownloaded += File(baseDir, name).length()
                        }
                        done++
                        r
                    }
                }
            } catch (e: Throwable) {
                logcat(LogPriority.ERROR, e) { "OCR model pack download failed: $pack" }
                false
            } finally {
                downloadMutex.withLock { activePacks.remove(pack) }
                setProgress(pack, null)
            cancelNotif(context)
            }

            withContext(Dispatchers.Main) {
                if (ok) {
                    cancelNotif(context)
                    val size = installedSize(context, pack)
                    val sizeStr = if (size > 0) " (${formatSize(size)})" else ""
                    showNotif(context, "Модели установлены", "Локальный OCR готов$sizeStr", 100)
                    context.toast("Модели установлены: локальный OCR готов к работе$sizeStr")
                } else {
                    cancelNotif(context)
                    context.toast("Не удалось скачать модели. Проверьте интернет и повторите")
                }
                onFinished(ok)
            }
        }
    }

    private fun downloadFile(
        url: String,
        destination: File,
        onProgress: (Float) -> Unit = {},
    ): Boolean {
        if (destination.isFile && destination.length() > 0) {
            onProgress(1f)
            return true
        }

        destination.parentFile?.mkdirs() // паки с подпапками (tessdata/…)
        val part = File(destination.parentFile, destination.name + ".part")
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 30_000
                readTimeout = 60_000
                instanceFollowRedirects = true
            }
            if (connection.responseCode !in 200..299) {
                logcat(LogPriority.WARN) { "Model download HTTP ${connection.responseCode} for $url" }
                return false
            }
            val total = connection.contentLengthLong.takeIf { it > 0 }
            connection.inputStream.use { input ->
                part.outputStream().use { output ->
                    val buf = ByteArray(256 * 1024)
                    var read = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        read += n
                        if (total != null) onProgress((read.toFloat() / total).coerceIn(0f, 1f))
                    }
                }
            }
            onProgress(1f)
            part.renameTo(destination)
        } catch (e: Throwable) {
            logcat(LogPriority.WARN, e) { "Model file download failed: $url" }
            part.delete()
            false
        } finally {
            connection?.disconnect()
        }
    }
}
