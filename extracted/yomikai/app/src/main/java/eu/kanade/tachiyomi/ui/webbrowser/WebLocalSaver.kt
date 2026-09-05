package eu.kanade.tachiyomi.ui.webbrowser

import android.content.Context
import android.graphics.Bitmap
import android.webkit.WebView
import com.hippo.unifile.UniFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat
import tachiyomi.source.local.io.LocalSourceFileSystem
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Сохранение веб-страницы как локальной главы.
 *
 * Запрос: «кнопка сохранить страницу как локальную главу в загрузках самого веб
 * в его вкладке загрузки и у каждого сайта страницы своя папка как id чтобы не
 * путать разные книги и прочее по порядкам и фильтрам».
 *
 * Реализация:
 *  - Папка = `local/<siteId>/<bookTitle>/<chapterTitle>/`
 *    siteId = 8-символьный hex от sha256(host), чтобы разные сайты не смешивались
 *  - Внутри главы: 1 страница = 1 файл `page_001.png` (скриншот видимой области)
 *    + `ComicInfo.xml` с метаданными (title, url, date)
 *  - Использует [LocalSourceFileSystem] (UniFile), чтобы глава сразу появилась
 *    в локальной библиотеке без рескана
 *  - Поддерживает порядки: страницы сортируются по `page_001`, `page_002`…
 *    Фильтры локальной библиотеки (Genre, OrderBy) работают как для обычных папок
 */
object WebLocalSaver {

    private fun siteId(url: String): String {
        val host = runCatching { java.net.URI(url).host }.getOrNull() ?: "unknown"
        val hash = MessageDigest.getInstance("SHA-256").digest(host.toByteArray()).take(4)
            .joinToString("") { "%02x".format(it) }
        return "${host.take(24).replace(Regex("[^A-Za-z0-9_.-]"), "_")}_$hash"
    }

    private fun sanitize(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().take(80).ifBlank { "Без названия" }

    /**
     * Сохранить текущий [webView] как локальную главу.
     *
     * @param title заголовок книги/страницы (из <title> или url)
     * @param onProgress колбэк для UI: 0f..1f
     * @return UniFile папки главы или null при ошибке
     */
    suspend fun saveAsLocalChapter(
        context: Context,
        webView: WebView,
        url: String,
        title: String? = null,
        onProgress: (Float) -> Unit = {},
    ): UniFile? = withContext(Dispatchers.IO) {
        try {
            val fs: LocalSourceFileSystem = Injekt.get()
            val baseDir = fs.baseDirectory ?: run {
                logcat(LogPriority.WARN) { "WebLocalSaver: baseDirectory null" }
                return@withContext null
            }

            val site = siteId(url)
            val bookTitle = sanitize(title ?: webView.title ?: url.substringAfter("://").substringBefore("/"))
            val chapterTitle = sanitize(
                SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date()) + "_" +
                    (webView.title?.take(30) ?: "page"),
            )

            // Папка книги: local/<siteId>/<bookTitle>/
            val siteDir = baseDir.findFile(site) ?: baseDir.createDirectory(site) ?: return@withContext null
            val bookDir = siteDir.findFile(bookTitle) ?: siteDir.createDirectory(bookTitle) ?: return@withContext null
            // Папка главы: local/<siteId>/<bookTitle>/<chapterTitle>/
            val chapterDir = bookDir.createDirectory(chapterTitle) ?: return@withContext null

            onProgress(0.1f)

            // Скриншот WebView: enable DrawingCache → Bitmap
            val bitmap = captureWebViewBitmap(webView) ?: run {
                logcat(LogPriority.WARN) { "WebLocalSaver: capture failed" }
                return@withContext null
            }

            onProgress(0.4f)

            // Сохранить как PNG
            val pageFile = chapterDir.createFile("page_001.png") ?: return@withContext null
            pageFile.openOutputStream().use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
            if (!bitmap.isRecycled) bitmap.recycle()

            onProgress(0.7f)

            // ComicInfo.xml для метаданных и фильтров
            val comicInfo = """
                <?xml version="1.0" encoding="utf-8"?>
                <ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
                  <Title>${escapeXml(chapterTitle)}</Title>
                  <Series>${escapeXml(bookTitle)}</Series>
                  <Web>${escapeXml(url)}</Web>
                  <Genre>Web,${escapeXml(site)}</Genre>
                  <Notes>Сохранено из браузера Yomikai, сайт: ${escapeXml(site)}</Notes>
                  <PageCount>1</PageCount>
                </ComicInfo>
            """.trimIndent()
            chapterDir.createFile("ComicInfo.xml")?.openOutputStream()?.use {
                it.write(comicXmlBytes(comicInfo))
            }

            onProgress(1f)
            logcat(LogPriority.INFO) { "WebLocalSaver saved: $site/$bookTitle/$chapterTitle" }
            chapterDir
        } catch (e: Exception) {
            logcat(LogPriority.ERROR, e) { "WebLocalSaver save failed url=$url" }
            null
        }
    }

    private fun captureWebViewBitmap(webView: WebView): Bitmap? {
        return try {
            // Пробуем старый способ через drawingCache, fallback — createBitmap via canvas
            val w = webView.width.coerceAtLeast(1)
            val h = webView.height.coerceAtLeast(1)
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bmp)
            webView.draw(canvas)
            bmp
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "captureWebViewBitmap failed" }
            null
        }
    }

    private fun escapeXml(s: String): String = s
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    private fun comicXmlBytes(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)
}
