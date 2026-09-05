package mihon.data.ocr

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import org.json.JSONArray

/**
 * Service providing instant translation for manga OCR text.
 * Supports Google Translate, DeepL, and LLM translation gateways.
 */
object MangaTranslatorService {

    /** Переводчик может расставить пробелы внутри @@@ — учитываем это. */
    private val SEPARATOR_REGEX = Regex("""\s*@\s*@\s*@\s*""")

    /**
     * Переводит СПИСОК реплик одним запросом.
     *
     * Раньше авточтение переводило по одной реплике на HTTP-запрос: на
     * странице с 15 бабблами это 15 последовательных обращений между
     * озвучками. Здесь строки склеиваются разделителем, который переводчик
     * не трогает, и режутся обратно; при несовпадении числа строк —
     * безопасный откат на построчный перевод.
     */
    suspend fun translateAll(
        texts: List<String>,
        targetLang: String = "ru",
        sourceLang: String = "auto",
    ): List<String> = withContext(Dispatchers.IO) {
        if (texts.isEmpty()) return@withContext emptyList()
        if (texts.size == 1) return@withContext listOf(translate(texts[0], targetLang, sourceLang))

        // Разделитель из символов, которые переводчик оставляет как есть.
        val separator = "\n@@@\n"
        val joined = texts.joinToString(separator)

        // У endpoint есть лимит на длину query — режем на порции.
        if (joined.length > 1500) {
            val half = texts.size / 2
            return@withContext translateAll(texts.take(half), targetLang, sourceLang) +
                translateAll(texts.drop(half), targetLang, sourceLang)
        }

        val translated = translate(joined, targetLang, sourceLang)
        val parts = translated.split(SEPARATOR_REGEX).map { it.trim() }
        if (parts.size == texts.size) {
            parts.mapIndexed { index, part -> part.ifBlank { texts[index] } }
        } else {
            logcat(LogPriority.INFO) { "Batch translate mismatch, falling back to per-line" }
            texts.map { translate(it, targetLang, sourceLang) }
        }
    }

    /**
     * Translates input text into target language (default: Russian "ru").
     */
    suspend fun translate(
        text: String,
        targetLang: String = "ru",
        sourceLang: String = "auto",
    ): String = withContext(Dispatchers.IO) {
        if (text.isBlank()) return@withContext ""

        try {
            // Instant Google Free Translate API
            val encodedText = URLEncoder.encode(text, "UTF-8")
            val urlString = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=$sourceLang&tl=$targetLang&dt=t&q=$encodedText"

            val connection = (URL(urlString).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8_000
                readTimeout = 15_000
                setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            }

            val responseText = connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            val jsonArray = JSONArray(responseText)
            val sentences = jsonArray.optJSONArray(0)

            val translatedBuilder = StringBuilder()
            if (sentences != null) {
                for (i in 0 until sentences.length()) {
                    val sentence = sentences.optJSONArray(i)
                    if (sentence != null) {
                        translatedBuilder.append(sentence.optString(0, ""))
                    }
                }
            }

            connection.disconnect()
            val result = translatedBuilder.toString().trim()
            if (result.isNotBlank()) result else text
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "Manga translation failed for: $text" }
            text
        }
    }
}
