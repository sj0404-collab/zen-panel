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
 * OCR Engine backed by Google AI / Gemini Vision API with strict verbatim transcription.
 */
internal class GoogleAiOcrEngine(
    private val context: Context,
    private val ocrPreferences: OcrPreferences,
) : OcrEngine {

    override suspend fun recognizeText(image: Bitmap): String = withContext(Dispatchers.IO) {
        require(!image.isRecycled) { "Input bitmap is recycled" }

        val apiKey = ocrPreferences.googleApiKey().get()
        val model = ocrPreferences.googleModel().get().ifBlank { "gemini-2.5-flash" }
        val base64Image = encodeBitmapToBase64(image)

        val jsonBody = JSONObject().apply {
            val generationConfig = JSONObject().apply {
                put("temperature", 0.0)
            }
            put("generationConfig", generationConfig)
            val contents = JSONArray()
            val contentItem = JSONObject().apply {
                val parts = JSONArray()
                parts.put(JSONObject().apply {
                    put("text", "Perform STRICT OPTICAL CHARACTER RECOGNITION (OCR) ONLY. Transcribe the exact characters seen in this image verbatim. Do not hallucinate, do not translate, do not add any markdown formatting or commentary.")
                })
                parts.put(JSONObject().apply {
                    put("inline_data", JSONObject().apply {
                        put("mime_type", "image/jpeg")
                        put("data", base64Image)
                    })
                })
                put("parts", parts)
            }
            contents.put(contentItem)
            put("contents", contents)
        }

        val urlString = "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=$apiKey"
        val connection = (URL(urlString).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 60_000
            setRequestProperty("Content-Type", "application/json")
        }

        try {
            connection.outputStream.use { os ->
                os.write(jsonBody.toString().toByteArray(Charsets.UTF_8))
            }

            val statusCode = connection.responseCode
            val responseText = (if (statusCode in 200..299) connection.inputStream else connection.errorStream)
                ?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""

            if (statusCode !in 200..299) {
                throw Exception("Google AI request failed HTTP $statusCode: ${responseText.take(200)}")
            }

            val jsonResponse = JSONObject(responseText)
            val candidates = jsonResponse.optJSONArray("candidates")
            val extractedText = if (candidates != null && candidates.length() > 0) {
                val candidateParts = candidates.getJSONObject(0)
                    .optJSONObject("content")?.optJSONArray("parts")
                if (candidateParts != null && candidateParts.length() > 0) {
                    candidateParts.getJSONObject(0).optString("text", "")
                } else ""
            } else ""

            val usageMetadata = jsonResponse.optJSONObject("usageMetadata")
            val totalTokens = usageMetadata?.optLong("totalTokenCount", 120L) ?: 120L
            ocrPreferences.incrementTokens(totalTokens)

            extractedText.trim()
        } catch (e: Exception) {
            logcat(LogPriority.ERROR, e) { "Google AI OCR failed" }
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
