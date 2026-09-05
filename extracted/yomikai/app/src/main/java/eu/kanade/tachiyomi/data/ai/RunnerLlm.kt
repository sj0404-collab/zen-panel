package eu.kanade.tachiyomi.data.ai

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import logcat.LogPriority
import mihon.domain.ocr.service.OcrPreferences
import org.json.JSONArray
import org.json.JSONObject
import tachiyomi.core.common.util.system.logcat
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * ПОЛУ-ОНЛАЙН LLM: GGUF/большие модели исполняются НЕ на телефоне, а на
 * GitHub Actions ранере (workflow llm-runner.yml):
 *  1) приложение по PAT-токену диспатчит workflow с выбранной моделью и
 *     случайным id сессии;
 *  2) ранер скачивает GGUF, поднимает llama.cpp server + cloudflared-туннель
 *     и публикует артефакт endpoint-<session> c URL и ключом сессии;
 *  3) приложение опрашивает артефакты, забирает endpoint и дальше говорит с
 *     моделью напрямую (OpenAI-совместимый /v1/chat/completions).
 *
 * Каждая сессия сохраняется НА ТЕЛЕФОНЕ (files/llm_sessions/<session>.json):
 * URL, ключ, модель, история сообщений — при перезапуске приложения диалог
 * продолжается без потери контекста, пока жив ранер (до ~5.5 часов).
 */
object RunnerLlm {

    data class Session(
        val id: String,
        val model: String,
        var url: String? = null,
        var apiKey: String? = null,
        /** Веб-терминал ранера (ttyd): живые логи llama-server + shell. */
        var terminalUrl: String? = null,
        /** ОС ранера: linux | windows. */
        var os: String = "linux",
        val messages: MutableList<Pair<String, String>> = mutableListOf(), // role -> content
        var createdAt: Long = System.currentTimeMillis(),
    )

    /** key -> (описание, ТОЧНЫЙ размер скачивания в ранер, МБ — проверено HEAD). */
    val GGUF_MODELS = listOf(
        Triple("qwen2.5-0.5b", "Qwen2.5 0.5B (GGUF Q4) — самый быстрый старт", 468),
        Triple("qwen2.5-1.5b", "Qwen2.5 1.5B (GGUF Q4) — лучший русский", 1065),
        Triple("llama3.2-1b", "Llama 3.2 1B (GGUF Q4) — английский", 770),
        Triple("gemma3-1b", "Gemma 3 1B (GGUF Q4) — компактная от Google", 768),
    )

    private const val REPO = "sj0404-collab/yomihon-custom"
    private const val WORKFLOW = "llm-runner.yml"

    private fun prefs(): OcrPreferences = Injekt.get()

    private fun sessionsDir(context: Context): File =
        File(context.filesDir, "llm_sessions").apply { mkdirs() }

    fun listSessions(context: Context): List<Session> =
        sessionsDir(context).listFiles { f -> f.extension == "json" }
            ?.mapNotNull { runCatching { fromJson(JSONObject(it.readText())) }.getOrNull() }
            ?.sortedByDescending { it.createdAt }
            .orEmpty()

    fun saveSession(context: Context, s: Session) {
        File(sessionsDir(context), "${s.id}.json").writeText(toJson(s).toString())
    }

    fun deleteSession(context: Context, s: Session) {
        File(sessionsDir(context), "${s.id}.json").delete()
    }

    private fun toJson(s: Session) = JSONObject()
        .put("id", s.id).put("model", s.model).put("url", s.url ?: "")
        .put("apiKey", s.apiKey ?: "").put("createdAt", s.createdAt)
        .put("terminalUrl", s.terminalUrl ?: "")
        .put("os", s.os)
        .put(
            "messages",
            JSONArray().apply {
                s.messages.forEach { (r, c) -> put(JSONObject().put("role", r).put("content", c)) }
            },
        )

    private fun fromJson(j: JSONObject) = Session(
        id = j.getString("id"),
        model = j.getString("model"),
        url = j.optString("url").ifBlank { null },
        apiKey = j.optString("apiKey").ifBlank { null },
        terminalUrl = j.optString("terminalUrl").ifBlank { null },
        os = j.optString("os").ifBlank { "linux" },
        createdAt = j.optLong("createdAt"),
        messages = mutableListOf<Pair<String, String>>().apply {
            val arr = j.optJSONArray("messages") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val m = arr.getJSONObject(i)
                add(m.getString("role") to m.getString("content"))
            }
        },
    )

    /**
     * Запуск новой сессии: dispatch workflow → ожидание артефакта endpoint
     * (обычно 2-4 минуты: скачивание модели в ранер). [onStatus] — живые
     * статусы для UI. null при ошибке/отсутствии токена.
     */
    suspend fun startSession(
        context: Context,
        modelKey: String,
        onStatus: (String) -> Unit,
        os: String = "linux",
    ): Session? = startSessionInternal(context, modelKey, "", onStatus, os)

    private suspend fun startSessionInternal(
        context: Context,
        modelKey: String,
        customUrl: String,
        onStatus: (String) -> Unit,
        os: String = "linux",
    ): Session? = withContext(Dispatchers.IO) {
        val token = prefs().githubPat().get()
        if (token.isBlank()) {
            onStatus("Нет GitHub-токена: задайте его в настройках вкладки AI (⚙)")
            return@withContext null
        }
        val selectedOs = if (os == "windows") "windows" else "linux"
        val session = Session(
            id = "s" + System.currentTimeMillis().toString(36) + (1000..9999).random(),
            model = modelKey,
            os = selectedOs,
        )

        onStatus("Отправляем запуск в GitHub Actions…")
        val dispatchBody = JSONObject()
            .put("ref", "main")
            .put(
                "inputs",
                JSONObject()
                    .put("model", modelKey)
                    .put("session", session.id)
                    .put("custom_url", customUrl)
                    .put("os", selectedOs),
            )
        val dispatch = runCatching {
            githubRequest(
                token = token,
                url = "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/dispatches",
                method = "POST",
                body = dispatchBody.toString(),
            )
        }.getOrElse {
            onStatus("Не удалось связаться с GitHub: ${it.message ?: "ошибка сети"}")
            return@withContext null
        }
        if (dispatch.code !in 200..299) {
            onStatus("GitHub отклонил запуск (${dispatch.code}): ${apiError(dispatch.body)}")
            return@withContext null
        }

        // Workflow dispatch не возвращает id запуска. Находим ровно наш run по
        // уникальному session id, затем читаем только ЕГО job и артефакты.
        // Это устраняет гонку старой реализации с глобальными 20 артефактами.
        val deadline = System.currentTimeMillis() + START_TIMEOUT_MS
        var lastStatus = ""
        var runId: Long? = null
        while (System.currentTimeMillis() < deadline) {
            val state = fetchRunState(token, session.id, selectedOs)
            runId = state.runId ?: runId
            if (state.message != lastStatus) {
                onStatus(state.message)
                lastStatus = state.message
            }

            // Endpoint публикуется до долгого keep-alive шага. Ищем его в
            // конкретном run, поэтому параллельные ранеры больше не мешают.
            runId?.let { id ->
                fetchEndpointArtifact(token, id, session.id)?.let { endpoint ->
                    session.url = endpoint.first
                    session.apiKey = endpoint.second
                    session.terminalUrl = endpoint.third.ifBlank { null }
                    saveSession(context, session)
                    onStatus("✅ Сессия готова: ${endpoint.first}")
                    return@withContext session
                }
            }

            // Раньше failure/cancelled молча проглатывались, и приложение все
            // восемь минут показывало ожидание. Теперь ошибка шага видна сразу.
            if (state.terminal) {
                onStatus(state.message)
                return@withContext null
            }
            delay(POLL_INTERVAL_MS)
        }
        onStatus(
            if (runId == null) {
                "Таймаут: GitHub не создал запуск за ${START_TIMEOUT_MS / 60_000} минут"
            } else {
                "Таймаут: endpoint не появился за ${START_TIMEOUT_MS / 60_000} минут. " +
                    "Последний статус: ${lastStatus.ifBlank { "неизвестен" }}"
            },
        )
        null
    }

    private const val START_TIMEOUT_MS = 12L * 60_000L
    private const val POLL_INTERVAL_MS = 5_000L

    private data class GithubResponse(val code: Int, val body: String)

    private data class BinaryResponse(val code: Int, val body: ByteArray)

    private data class RunState(
        val runId: Long? = null,
        val terminal: Boolean = false,
        val message: String,
    )

    /**
     * GET/POST GitHub API с таймаутами и чтением тела ошибки.
     * Ходит через прокси приложения (Настройки → Сеть), как и AI-чат:
     * раньше раннеры молча игнорировали прокси и не работали там, где
     * прямой доступ к api.github.com заблокирован.
     */
    private fun githubRequest(
        token: String,
        url: String,
        method: String = "GET",
        body: String? = null,
    ): GithubResponse {
        val conn = AiAssistant.openConnection(url) as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            conn.setRequestProperty("User-Agent", "Yomihon-Runner")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.outputStream.use { it.write(body.toByteArray()) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            return GithubResponse(code, stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty())
        } finally {
            conn.disconnect()
        }
    }

    /** Скачивание бинарного артефакта с безопасным проходом GitHub redirect. */
    private fun githubDownload(token: String, initialUrl: String): BinaryResponse {
        var currentUrl = initialUrl
        repeat(5) {
            val url = URL(currentUrl)
            // Redirects ведут на внешнее хранилище артефактов — напрямую, без прокси.
            val viaProxy = url.host == "api.github.com"
            val conn = if (viaProxy) {
                AiAssistant.openConnection(currentUrl) as HttpURLConnection
            } else {
                url.openConnection() as HttpURLConnection
            }
            try {
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.setRequestProperty("Accept", "application/vnd.github+json")
                conn.setRequestProperty("User-Agent", "Yomihon-Runner")
                // Не отправляем PAT на внешний release-assets/blob storage.
                if (url.host == "api.github.com") {
                    conn.setRequestProperty("Authorization", "Bearer $token")
                    conn.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
                }
                val code = conn.responseCode
                if (code in setOf(301, 302, 303, 307, 308)) {
                    currentUrl = conn.getHeaderField("Location")
                        ?: return BinaryResponse(code, ByteArray(0))
                } else {
                    val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                    return BinaryResponse(code, stream?.use { it.readBytes() } ?: ByteArray(0))
                }
            } finally {
                conn.disconnect()
            }
        }
        return BinaryResponse(310, ByteArray(0))
    }

    private fun apiError(body: String): String = runCatching {
        JSONObject(body).optString("message").ifBlank { body.take(180) }
    }.getOrDefault(body.take(180)).ifBlank { "нет описания" }

    /** Реальный статус выбранной job; failure/cancelled являются терминальными. */
    private fun fetchRunState(token: String, sessionId: String, os: String): RunState {
        return runCatching {
            val runsResponse = githubRequest(
                token,
                "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/runs" +
                    "?event=workflow_dispatch&per_page=20",
            )
            if (runsResponse.code !in 200..299) {
                return RunState(message = "GitHub API ${runsResponse.code}: ${apiError(runsResponse.body)}")
            }
            val runs = JSONObject(runsResponse.body).getJSONArray("workflow_runs")
            var run: JSONObject? = null
            for (i in 0 until runs.length()) {
                val candidate = runs.getJSONObject(i)
                if (candidate.optString("display_title").contains(sessionId)) {
                    run = candidate
                    break
                }
            }
            val foundRun = run ?: return RunState(message = "⏳ Запуск принят, ждём ранер GitHub…")
            val runId = foundRun.getLong("id")
            val runStatus = foundRun.optString("status")
            val runConclusion = foundRun.optString("conclusion")
            if (runStatus == "queued" || runStatus == "waiting" || runStatus == "pending") {
                return RunState(runId = runId, message = "⏳ Ранер в очереди GitHub…")
            }

            val jobsResponse = githubRequest(
                token,
                "https://api.github.com/repos/$REPO/actions/runs/$runId/jobs?per_page=20",
            )
            if (jobsResponse.code !in 200..299) {
                return RunState(
                    runId = runId,
                    terminal = runStatus == "completed",
                    message = "GitHub jobs API ${jobsResponse.code}: ${apiError(jobsResponse.body)}",
                )
            }
            val jobs = JSONObject(jobsResponse.body).getJSONArray("jobs")
            val wantedName = "serve-$os"
            var job: JSONObject? = null
            for (i in 0 until jobs.length()) {
                val candidate = jobs.getJSONObject(i)
                if (candidate.optString("name") == wantedName) {
                    job = candidate
                    break
                }
            }
            if (job == null) {
                for (i in 0 until jobs.length()) {
                    val candidate = jobs.getJSONObject(i)
                    if (candidate.optString("conclusion") != "skipped") {
                        job = candidate
                        break
                    }
                }
            }

            val selectedJob = job
            val completed = runStatus == "completed" || selectedJob?.optString("status") == "completed"
            val conclusion = selectedJob?.optString("conclusion").orEmpty().ifBlank { runConclusion }
            val steps = selectedJob?.optJSONArray("steps")
            if (completed) {
                var failedStep = ""
                if (steps != null) {
                    for (i in 0 until steps.length()) {
                        val step = steps.getJSONObject(i)
                        if (step.optString("conclusion") in setOf("failure", "cancelled", "timed_out")) {
                            failedStep = step.optString("name")
                            break
                        }
                    }
                }
                val detail = when (conclusion) {
                    "cancelled" -> "запуск отменён"
                    "timed_out" -> "превышен лимит времени"
                    "success" -> "job завершилась до публикации endpoint"
                    else -> "ошибка запуска"
                }
                return RunState(
                    runId = runId,
                    terminal = true,
                    message = "❌ $detail" +
                        failedStep.takeIf { it.isNotBlank() }?.let { " • шаг: $it" }.orEmpty() +
                        " • run #$runId",
                )
            }

            if (steps != null) {
                for (i in 0 until steps.length()) {
                    val step = steps.getJSONObject(i)
                    if (step.optString("status") == "in_progress") {
                        val name = step.optString("name")
                        val text = when {
                            name.startsWith("Restore model cache") -> "Проверяем кэш модели…"
                            name.startsWith("Download llama.cpp") -> "Скачивается llama.cpp…"
                            name.startsWith("Download GGUF") -> "Скачивается модель в ранер…"
                            name.startsWith("Save model cache") -> "Сохраняем модель в кэш…"
                            name.startsWith("Start server") -> "Запускаются сервер и туннель…"
                            name.startsWith("Upload endpoint") -> "Публикуется endpoint…"
                            name.startsWith("Keep session") -> "Ранер готов, забираем endpoint…"
                            else -> name
                        }
                        return RunState(runId = runId, message = "▶ $text")
                    }
                }
            }
            RunState(runId = runId, message = "▶ Ранер запускается…")
        }.getOrElse {
            RunState(runId = null, message = "Временная ошибка статуса: ${it.message ?: "сеть"}")
        }
    }

    /** Ищет endpoint только внутри нужного run, скачивает zip и читает JSON. */
    private fun fetchEndpointArtifact(
        token: String,
        runId: Long,
        sessionId: String,
    ): Triple<String, String, String>? {
        return runCatching {
            val response = githubRequest(
                token,
                "https://api.github.com/repos/$REPO/actions/runs/$runId/artifacts?per_page=100",
            )
            if (response.code !in 200..299) return null
            val artifacts = JSONObject(response.body).getJSONArray("artifacts")
            var downloadUrl: String? = null
            for (i in 0 until artifacts.length()) {
                val artifact = artifacts.getJSONObject(i)
                if (
                    artifact.getString("name") == "endpoint-$sessionId" &&
                    !artifact.getBoolean("expired")
                ) {
                    downloadUrl = artifact.getString("archive_download_url")
                    break
                }
            }
            val url = downloadUrl ?: return null
            val zipResponse = githubDownload(token, url)
            if (zipResponse.code !in 200..299 || zipResponse.body.isEmpty()) return null
            var endpointJson: String? = null
            ZipInputStream(zipResponse.body.inputStream()).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    if (entry.name == "endpoint.json") {
                        endpointJson = zis.readBytes().toString(Charsets.UTF_8)
                        break
                    }
                    entry = zis.nextEntry
                }
            }
            val endpoint = JSONObject(endpointJson ?: return null)
            Triple(
                endpoint.getString("url"),
                endpoint.getString("api_key"),
                endpoint.optString("terminal"),
            )
        }.getOrNull()
    }

    /** Чат с ранером: OpenAI-совместимый endpoint llama.cpp. */
    suspend fun chat(context: Context, session: Session, userText: String): String? =
        withContext(Dispatchers.IO) {
            val url = session.url ?: return@withContext null
            val key = session.apiKey ?: return@withContext null
            session.messages += "user" to userText
            val messages = JSONArray()
            // Контекст: последние 24 сообщения сессии — без потери нити диалога
            session.messages.takeLast(24).forEach { (r, c) ->
                messages.put(JSONObject().put("role", r).put("content", c))
            }
            val answer = runCatching {
                // Туннель cloudflared тоже может требовать прокси (как chat.try.ai).
                val conn = AiAssistant.openConnection("$url/v1/chat/completions") as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 20_000
                conn.readTimeout = 180_000
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer $key")
                val body = JSONObject()
                    .put("model", session.model)
                    .put("messages", messages)
                    .put("max_tokens", 800)
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
                val text = (if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream)
                    ?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                conn.disconnect()
                JSONObject(text).optJSONArray("choices")?.optJSONObject(0)
                    ?.optJSONObject("message")?.optString("content")?.trim()
            }.onFailure {
                logcat(LogPriority.WARN, it) { "Runner LLM chat failed" }
            }.getOrNull()
            if (answer != null) {
                session.messages += "assistant" to answer
                saveSession(context, session)
            }
            answer
        }

    /** Жива ли сессия (реальный запрос /health к туннелю). */
    suspend fun isAlive(session: Session): Boolean = withContext(Dispatchers.IO) {
        val url = session.url ?: return@withContext false
        runCatching {
            val conn = AiAssistant.openConnection("$url/health") as HttpURLConnection
            conn.connectTimeout = 8_000
            conn.readTimeout = 8_000
            session.apiKey?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
            val ok = conn.responseCode in 200..299
            conn.disconnect()
            ok
        }.getOrDefault(false)
    }

    /** Статус ранера для индикации в UI. */
    data class RunnerStatus(
        val alive: Boolean,
        /** Аптайм сессии, мс (от createdAt). */
        val uptimeMs: Long,
        /** Осталось до 5.5-часового лимита job, мс. */
        val remainingMs: Long,
        /** Время последней проверки. */
        val checkedAt: Long,
    )

    private const val SESSION_LIFETIME_MS = 330L * 60_000L // 5.5 часов

    /**
     * ИНДИКАЦИЯ РАНЕРА (по требованию пользователя): живой /health-пинг +
     * аптайм + сколько осталось до конца сессии.
     */
    suspend fun status(session: Session): RunnerStatus {
        val alive = isAlive(session)
        val uptime = System.currentTimeMillis() - session.createdAt
        return RunnerStatus(
            alive = alive,
            uptimeMs = uptime,
            remainingMs = (SESSION_LIFETIME_MS - uptime).coerceAtLeast(0),
            checkedAt = System.currentTimeMillis(),
        )
    }

    /**
     * Своя GGUF-модель ПО ССЫЛКЕ: воркфлоу принимает custom_url — ранер
     * скачает её вместо каталожной. Размер неизвестен заранее — воркфлоу
     * напишет его в лог, а стартовый статус покажет прогресс этапов.
     */
    suspend fun startSessionWithUrl(
        context: Context,
        ggufUrl: String,
        onStatus: (String) -> Unit,
        os: String = "linux",
    ): Session? = startSessionInternal(context, "custom", ggufUrl, onStatus, os)
}
