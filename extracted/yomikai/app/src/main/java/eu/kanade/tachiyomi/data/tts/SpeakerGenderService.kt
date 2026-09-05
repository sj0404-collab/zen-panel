package eu.kanade.tachiyomi.data.tts

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import logcat.LogPriority
import mihon.domain.ocr.service.OcrPreferences
import org.json.JSONArray
import org.json.JSONObject
import tachiyomi.core.common.util.system.logcat
import java.net.HttpURLConnection
import java.net.URL

/**
 * Определение пола говорящего по странице: Gemini Vision получает кадр и
 * список реплик и отвечает, кто произносит каждую (male/female/unknown) —
 * по лицам персонажей и хвостикам речевых баллонов.
 *
 * Требует Google AI ключ (Настройки → OCR). Без ключа/при ошибке возвращает
 * unknown для всех реплик — озвучка идёт основным голосом, ничего не ломается.
 */
object SpeakerGenderService {

    suspend fun detect(
        imageJpeg: ByteArray,
        lines: List<String>,
        prefs: OcrPreferences,
    ): List<String?> = withContext(Dispatchers.IO) {
        val unknown = List<String?>(lines.size) { null }
        val apiKey = prefs.googleApiKey().get()
        if (apiKey.isBlank() || lines.isEmpty()) return@withContext unknown

        try {
            val model = prefs.googleModel().get().ifBlank { "gemini-2.5-flash" }
            val numbered = lines.mapIndexed { i, t -> "${i + 1}. ${t.take(120)}" }.joinToString("\n")
            val prompt =
                "This is a manga/comic page. For each numbered dialogue line below, look at the " +
                    "characters' faces and the speech bubble tails to decide WHO SPEAKS it. " +
                    "Answer ONLY with a JSON array of strings, one per line, in the same order, " +
                    "each being exactly \"male\", \"female\" or \"unknown\". No other text.\n\n" + numbered

            val body = JSONObject().apply {
                put("generationConfig", JSONObject().put("temperature", 0.0))
                put(
                    "contents",
                    JSONArray().put(
                        JSONObject().put(
                            "parts",
                            JSONArray()
                                .put(JSONObject().put("text", prompt))
                                .put(
                                    JSONObject().put(
                                        "inline_data",
                                        JSONObject()
                                            .put("mime_type", "image/jpeg")
                                            .put(
                                                "data",
                                                android.util.Base64.encodeToString(
                                                    imageJpeg,
                                                    android.util.Base64.NO_WRAP,
                                                ),
                                            ),
                                    ),
                                ),
                        ),
                    ),
                )
            }

            val url = "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=$apiKey"
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 45_000
                setRequestProperty("Content-Type", "application/json")
            }
            val response = try {
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                if (code !in 200..299) {
                    logcat(LogPriority.WARN) { "Gender detect HTTP $code: ${text.take(120)}" }
                    return@withContext unknown
                }
                text
            } finally {
                conn.disconnect()
            }

            val answer = JSONObject(response)
                .optJSONArray("candidates")?.optJSONObject(0)
                ?.optJSONObject("content")?.optJSONArray("parts")
                ?.optJSONObject(0)?.optString("text").orEmpty()
                .replace("```json", "").replace("```", "").trim()

            val arr = JSONArray(answer)
            List(lines.size) { i ->
                when (arr.optString(i, "unknown").lowercase()) {
                    "male" -> "male"
                    "female" -> "female"
                    else -> null
                }
            }
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "Speaker gender detection failed" }
            unknown
        }
    }
}
