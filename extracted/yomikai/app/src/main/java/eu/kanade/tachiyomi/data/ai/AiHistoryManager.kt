package eu.kanade.tachiyomi.data.ai

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import logcat.LogPriority
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.core.common.util.system.logcat
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.File

/**
 * Продвинутое управление историей AI-чата.
 *
 * Проблемы, которые решает:
 *  - История терялась при пересоздании вкладки / смене процесса (не было persist)
 *  - Тратил до 50к токенов на reasoning двух языков (нет лимита, нет сокращения)
 *  - Не говорил что доступно/невозможно (нет capability report)
 *
 * Решения:
 *  - Файл `workspace/ai_history.json` + StateFlow + лимит из `pref_ai_history_limit` (дефолт 12)
 *  - Токен-бюджет `pref_ai_token_budget` (дефолт 4000) — обрезка истории и max_tokens в запросе
 *  - Availability report перед каждым ходом: сеть, ключи, модели, ранер, локальная LLM
 *  - Сжатие истории: старые сообщения суммируются в краткий «контекст» вместо удаления
 */
object AiHistoryManager {

    @Serializable
    data class Msg(
        val role: String, // user | ai
        val text: String,
        val time: Long = System.currentTimeMillis(),
        val tokens: Int = 0,
        val model: String = "",
    )

    private const val FILE = "ai_history.json"
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private fun prefs(): OcrPreferences = Injekt.get()

    fun historyFile(context: Context): File {
        val ws = aiWorkspaceDir(context)
        ws.mkdirs()
        return File(ws, FILE)
    }

    private fun aiWorkspaceDir(context: Context): File {
        // Yomikai workspace — /sdcard/Yomikai/AI или внутренние файлы как fallback
        val ext = context.getExternalFilesDir(null)
        val candidate = if (ext != null) File(ext, "../../Yomikai/AI").canonicalFile else File(context.filesDir, "ai_workspace")
        // Fallback если нет разрешения на ext
        return if (candidate.exists() || candidate.mkdirs()) candidate else File(context.filesDir, "ai_workspace")
    }

    fun load(context: Context): MutableList<Msg> {
        val f = historyFile(context)
        if (!f.exists()) return mutableListOf()
        return try {
            val raw = f.readText()
            val list = json.decodeFromString<List<Msg>>(raw)
            // Обрезаем до лимита при загрузке
            val limit = prefs().aiHistoryLimit().get().coerceIn(4, 100)
            list.takeLast(limit).toMutableList()
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "AiHistoryManager load failed" }
            mutableListOf()
        }
    }

    fun save(context: Context, history: List<Msg>) {
        try {
            val limit = prefs().aiHistoryLimit().get().coerceIn(4, 100)
            val toSave = history.takeLast(limit)
            historyFile(context).writeText(json.encodeToString(toSave))
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "AiHistoryManager save failed" }
        }
    }

    fun append(context: Context, history: MutableList<Msg>, msg: Msg) {
        history.add(msg)
        val limit = prefs().aiHistoryLimit().get().coerceIn(4, 100)
        while (history.size > limit) {
            // Сжимаем: первые 2 сообщения → один summary
            val oldest = history.removeAt(0)
            val second = if (history.isNotEmpty()) history.removeAt(0) else null
            val summary = buildString {
                append("[Сжато: ")
                append(oldest.role).append(": ").append(oldest.text.take(80))
                if (second != null) append(" | ").append(second.role).append(": ").append(second.text.take(80))
                append("]")
            }
            history.add(0, Msg(role = "ai", text = summary, time = System.currentTimeMillis()))
        }
        save(context, history)
    }

    /**
     * Оценка токенов грубо: 1 токен ≈ 4 символа (для ru/en). Точнее — после ответа модели.
     */
    fun estimateTokens(text: String): Int = (text.length / 3.5).toInt().coerceAtLeast(1)

    fun totalTokens(history: List<Msg>): Int = history.sumOf { if (it.tokens > 0) it.tokens else estimateTokens(it.text) }

    fun trimToBudget(history: List<Msg>, budget: Int): List<Msg> {
        if (budget <= 0) return history
        var total = totalTokens(history)
        if (total <= budget) return history
        // Убираем старые, оставляя последние дорогие
        val mutable = history.toMutableList()
        while (mutable.size > 4 && total > budget * 0.85) {
            val removed = mutable.removeAt(0)
            total -= if (removed.tokens > 0) removed.tokens else estimateTokens(removed.text)
        }
        return mutable
    }
}
