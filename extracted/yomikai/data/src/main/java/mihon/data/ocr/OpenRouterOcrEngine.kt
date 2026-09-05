package mihon.data.ocr

import android.content.Context
import android.graphics.Bitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import logcat.LogPriority
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.core.common.util.system.logcat
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/**
 * OCR Engine backed by OpenRouter AI Vision models with strict verbatim transcription.
 */
internal class OpenRouterOcrEngine(
    private val context: Context,
    private val ocrPreferences: OcrPreferences,
) : OcrEngine {

    override suspend fun recognizeText(image: Bitmap): String = withContext(Dispatchers.IO) {
        require(!image.isRecycled) { "Input bitmap is recycled" }

        val apiKey = ocrPreferences.openrouterApiKey().get()
        if (apiKey.isBlank()) {
            logcat(LogPriority.WARN) { "OpenRouter API key is empty" }
        }

        val model = ocrPreferences.openrouterModel().get().ifBlank { "google/gemini-2.5-flash" }
        val base64Image = encodeBitmapToBase64(image)

        val jsonBody = JSONObject().apply {
            put("model", model)
            put("temperature", 0.0)
            val messages = JSONArray()
            val userMsg = JSONObject().apply {
                put("role", "user")
                val content = JSONArray()
                content.put(JSONObject().apply {
                    put("type", "text")
                    put("text", "Perform STRICT OPTICAL CHARACTER RECOGNITION (OCR) ONLY. Transcribe the exact text from the image verbatim without translating, explaining, summarizing, or adding any commentary. If no text is visible, return empty string.")
                })
                content.put(JSONObject().apply {
                    put("type", "image_url")
                    put("image_url", JSONObject().apply {
                        put("url", "data:image/jpeg;base64,$base64Image")
                    })
                })
                put("content", content)
            }
            messages.put(userMsg)
            put("messages", messages)
        }

        val endpoint = "https://openrouter.ai/api/v1/chat/completions"
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 60_000
            setRequestProperty("Content-Type", "application/json")
            if (apiKey.isNotBlank()) {
                setRequestProperty("Authorization", "Bearer $apiKey")
            }
            setRequestProperty("HTTP-Referer", "https://yomihon.github.io")
            setRequestProperty("X-Title", "Yomihon")
        }

        try {
            connection.outputStream.use { os ->
                os.write(jsonBody.toString().toByteArray(Charsets.UTF_8))
            }

            val statusCode = connection.responseCode
            val responseText = (if (statusCode in 200..299) connection.inputStream else connection.errorStream)
                ?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""

            if (statusCode !in 200..299) {
                throw Exception("OpenRouter request failed HTTP $statusCode: ${responseText.take(200)}")
            }

            val jsonResponse = JSONObject(responseText)
            val choices = jsonResponse.optJSONArray("choices")
            val extractedText = if (choices != null && choices.length() > 0) {
                choices.getJSONObject(0).optJSONObject("message")?.optString("content", "") ?: ""
            } else ""

            val usage = jsonResponse.optJSONObject("usage")
            val totalTokens = usage?.optLong("total_tokens", 100L) ?: 100L
            ocrPreferences.incrementTokens(totalTokens)

            extractedText.trim()
        } catch (e: Exception) {
            logcat(LogPriority.ERROR, e) { "OpenRouter OCR failed" }
            throw e
        } finally {
            connection.disconnect()
        }
    }

    override fun close() = Unit

    private companion object {
        /** Длинная сторона страницы перед отправкой в vision-модель. */
        const val MAX_IMAGE_SIDE = 1500
    }

    private fun encodeBitmapToBase64(bitmap: Bitmap): String {
        val stream = ByteArrayOutputStream()
        // Страница уменьшается до 1500 px по длинной стороне и кодируется
        // в JPEG: раньше улетал PNG полного размера (несколько мегабайт в
        // base64 внутри JSON), из-за чего запрос к vision-модели тянулся
        // десятки секунд и стоил дороже. Параметр качества у PNG к тому же
        // игнорировался — формат без потерь.
        val maxSide = maxOf(bitmap.width, bitmap.height)
        val scaled = if (maxSide > MAX_IMAGE_SIDE) {
            val factor = MAX_IMAGE_SIDE.toFloat() / maxSide
            Bitmap.createScaledBitmap(
                bitmap,
                (bitmap.width * factor).toInt().coerceAtLeast(1),
                (bitmap.height * factor).toInt().coerceAtLeast(1),
                true,
            )
        } else {
            null
        }
        val source = scaled ?: bitmap
        try {
            source.compress(Bitmap.CompressFormat.JPEG, 85, stream)
        } finally {
            if (scaled != null && !scaled.isRecycled) scaled.recycle()
        }
        val byteArray = stream.toByteArray()
        return Base64.getEncoder().encodeToString(byteArray)
    }
}
