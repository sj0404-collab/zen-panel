package eu.kanade.tachiyomi.data.ai

import android.app.Application
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import logcat.LogPriority
import eu.kanade.tachiyomi.network.NetworkPreferences
import mihon.domain.ocr.service.OcrPreferences
import org.json.JSONArray
import org.json.JSONObject
import tachiyomi.core.common.util.system.logcat
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Онлайн AI-ассистент читалки. Два провайдера, оба OpenAI-совместимые:
 *
 * • ZEN (opencode.ai/zen) — БЕЗ API-ключа. Бесплатные модели:
 *   mimo-v2.5-free, deepseek-v4-flash-free, laguna-s-2.1-free,
 *   nemotron-3-ultra-free, nemotron-3.5-lightning-free, hy3-free,
 *   big-pickle. Проверено живым запросом: отвечают без авторизации.
 *   ВАЖНО: vision у Zen нет («No endpoints found that support image
 *   input»), поэтому ассистент ТЕКСТОВЫЙ — пол говорящих определяет по
 *   репликам, не по картинке.
 *
 * • OPENROUTER — по API-ключу, выбор из бесплатных «:free» моделей
 *   (список тянется живьём с /api/v1/models и фильтруется по суффиксу).
 *
 * Используется авточтением: реплики без уверенного вердикта локальной
 * морфологии батчем уходят ассистенту на определение пола говорящего.
 */
object AiAssistant {

    const val PROVIDER_ZEN = "zen"
    const val PROVIDER_OPENROUTER = "openrouter"

    /**
     * Базовые URL встроенных провайдеров. Вынесены в константы, потому что их
     * читает реестр [AiProviders]: список в настройках обязан показывать те же
     * адреса, куда реально уходит запрос.
     */
    const val ZEN_BASE_URL = "https://opencode.ai/zen/v1"
    const val OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

    /**
     * Модели Zen, проверенные без ключа. Порядок = приоритет ротации:
     * первыми идут БЫСТРЫЕ без тяжёлого reasoning (laguna отвечает «жмн»
     * за долю секунды), reasoning-модели — в хвосте. При FreeUsageLimitError
     * (rate limit конкретной модели) запрос автоматически повторяется на
     * следующей модели списка.
     */
    val ZEN_MODELS = listOf(
        "laguna-s-2.1-free",
        "mimo-v2.5-free",
        "deepseek-v4-flash-free",
        "hy3-free",
        "big-pickle",
        "nemotron-3.5-lightning-free",
        "nemotron-3-ultra-free",
    )

    /** Запасной список OpenRouter :free на случай оффлайна при первом открытии. */
    val OPENROUTER_FREE_FALLBACK = listOf(
        "nvidia/nemotron-3-nano-30b-a3b:free",
        "poolside/laguna-s-2.1:free",
        "z-ai/glm-5.2:free",
        "google/gemma-4-31b-it:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
    )

    private fun prefs(): OcrPreferences = Injekt.get()

    /**
     * Контекст приложения для реестров, которые читают файлы пользователя
     * (`AiProviders`, `AiPlugins`). Зарегистрирован в Injekt через
     * `AppModule.addSingleton(app)`.
     */
    private fun appContext(): Context = Injekt.get<Application>()

    /**
     * Запрос к провайдеру пользователя (любой OpenAI-совместимый endpoint:
     * Ollama, LM Studio, llama.cpp server, корпоративный прокси).
     *
     * Временные сбои ретраятся на том же адресе, как в ветке OpenRouter.
     * Автосмены на Zen здесь НАМЕРЕНО нет: пользователь явно выбрал свой
     * endpoint, и тихая отправка его промпта стороннему сервису была бы
     * неверной. Ошибка возвращается как `null` — вызывающий код деградирует
     * мягко, как и при недоступности встроенных провайдеров.
     */
    private suspend fun customProviderChat(
        spec: AiProviders.Spec,
        userPrompt: String,
        systemPrompt: String?,
        maxTokens: Int,
    ): ChatReply? {
        val url = AiProviders.chatCompletionsUrl(spec.baseUrl)
        if (url == null) {
            lastFailureMessage = "${spec.id}: некорректный baseUrl «${spec.baseUrl}»"
            logcat(LogPriority.WARN) { "Custom provider ${spec.id} has an invalid baseUrl" }
            return null
        }
        var reply: ChatReply? = null
        for (delayMs in longArrayOf(0, 1_200, 2_500)) {
            if (delayMs > 0) kotlinx.coroutines.delay(delayMs)
            when (val outcome = chatRawOutcome(url, spec.model, spec.apiKey, userPrompt, systemPrompt, maxTokens)) {
                is Outcome.Ok -> {
                    reply = outcome.reply
                    break
                }
                Outcome.Transient -> continue
                else -> break
            }
        }
        if (reply == null) {
            logcat(LogPriority.WARN) { "Custom provider ${spec.id} (${spec.model}) did not answer" }
        }
        return reply
    }

    private val modelCooldownUntil = ConcurrentHashMap<String, Long>()

    @Volatile
    private var lastFailureMessage: String = ""

    fun lastFailure(): String = lastFailureMessage

    /**
     * Raw AI calls used URLConnection directly and silently ignored the proxy
     * configured in Settings → Advanced. Route Zen/OpenRouter through the same
     * HTTP/SOCKS proxy, including optional Basic proxy authentication.
     */
    internal fun openConnection(url: String): HttpURLConnection {
        val network = Injekt.get<NetworkPreferences>()
        val rawHost = network.proxyHost.get().trim()
        val enabled = network.enableProxy.get() && rawHost.isNotBlank()
        val target = URL(url)
        if (!enabled) return target.openConnection() as HttpURLConnection

        val parsed = runCatching {
            val withScheme = if (rawHost.contains("://")) rawHost else "http://$rawHost"
            URL(withScheme)
        }.getOrNull()
        val host = parsed?.host?.takeIf { it.isNotBlank() }
            ?: rawHost.substringBefore(':').substringBefore('/')
        val explicitPort = parsed?.port?.takeIf { it > 0 }
            ?: rawHost.substringAfter(':', "").substringBefore('/').toIntOrNull()
        val port = explicitPort ?: network.proxyPort.get().coerceIn(1, 65_535)
        val type = if (network.proxyType.get() == 1) Proxy.Type.SOCKS else Proxy.Type.HTTP
        val connection = target.openConnection(Proxy(type, InetSocketAddress(host, port))) as HttpURLConnection
        val user = network.proxyUser.get()
        if (user.isNotBlank() && type == Proxy.Type.HTTP) {
            val credentials = "$user:${network.proxyPassword.get()}"
            val encoded = android.util.Base64.encodeToString(
                credentials.toByteArray(Charsets.UTF_8),
                android.util.Base64.NO_WRAP,
            )
            connection.setRequestProperty("Proxy-Authorization", "Basic $encoded")
        }
        return connection
    }

    private fun coolingDown(model: String): Boolean =
        (modelCooldownUntil[model] ?: 0L) > System.currentTimeMillis()

    private fun coolDown(model: String, durationMs: Long) {
        modelCooldownUntil[model] = System.currentTimeMillis() + durationMs
    }

    /** Запись скрытого AI-чата: что спросили, что ответила модель, сколько заняло. */
    data class LogEntry(
        val time: Long,
        val model: String,
        val prompt: String,
        val answer: String,
        val tookMs: Long,
    )

    /** Кольцевой журнал последних обращений — «скрытый чат» ассистента. */
    private val logBuffer = ArrayDeque<LogEntry>()

    @Synchronized
    fun log(): List<LogEntry> = logBuffer.toList()

    @Synchronized
    private fun addLog(e: LogEntry) {
        logBuffer.addLast(e)
        while (logBuffer.size > 40) logBuffer.removeFirst()
    }

    /** Живой список бесплатных моделей OpenRouter (":free"). */
    suspend fun fetchOpenRouterFreeModels(): List<String> = withContext(Dispatchers.IO) {
        runCatching {
            val conn = openConnection("$OPENROUTER_BASE_URL/models")
            conn.connectTimeout = 10_000
            conn.readTimeout = 20_000
            val body = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            conn.disconnect()
            val arr = JSONObject(body).getJSONArray("data")
            buildList {
                for (i in 0 until arr.length()) {
                    val id = arr.getJSONObject(i).optString("id")
                    if (id.endsWith(":free")) add(id)
                }
            }.sorted()
        }.getOrDefault(OPENROUTER_FREE_FALLBACK)
    }

    /** Полный ответ модели: текст, «размышления» (reasoning), реальная модель. */
    data class ChatReply(
        val content: String,
        val reasoning: String?,
        val model: String,
        /** Токены запроса+ответа (usage.total_tokens; 0 если провайдер не отдал). */
        val tokens: Int = 0,
        /** false when provider stopped because max_tokens was exhausted. */
        val complete: Boolean = true,
    )

    /**
     * Один chat-запрос выбранному провайдеру. null при любой ошибке —
     * вызывающий код обязан деградировать мягко (нейтральный голос,
     * пропуск перевода и т.п.).
     */
    suspend fun chat(userPrompt: String, systemPrompt: String? = null, maxTokens: Int = 500): String? =
        chatFull(userPrompt, systemPrompt, maxTokens)?.content

    /**
     * Как chat(), но с reasoning-блоком и именем фактически ответившей
     * модели (при автосмене может отличаться от выбранной).
     */
    suspend fun chatFull(userPrompt: String, systemPrompt: String? = null, maxTokens: Int = 500): ChatReply? =
        withContext(Dispatchers.IO) {
            val p = prefs()
            val provider = p.aiProvider().get()

            // Провайдер пользователя из реестра AiProviders (свой base URL,
            // модель и ключ). Проверяется первым: id у него свой, поэтому ветки
            // Zen/OpenRouter ниже не затрагиваются.
            val custom = AiProviders.userProvider(appContext(), provider)
            if (custom != null) {
                return@withContext customProviderChat(custom, userPrompt, systemPrompt, maxTokens)
            }

            val key = p.openrouterApiKey().get()
            if (provider == PROVIDER_OPENROUTER && key.isNotBlank()) {
                val model = p.openrouterFreeModel().get().ifBlank { OPENROUTER_FREE_FALLBACK.first() }
                if (coolingDown(model) && p.aiAutoRotate().get()) {
                    return@withContext zenChatWithRotation(userPrompt, systemPrompt, maxTokens)
                }
                // Временные сбои сети/прокси ретраим на той же модели,
                // прежде чем считать OpenRouter «упавшим».
                var reply: ChatReply? = null
                var lastOutcome: Outcome? = null
                for (delayMs in longArrayOf(0, 1_200, 2_500)) {
                    if (delayMs > 0) kotlinx.coroutines.delay(delayMs)
                    val outcome = chatRawOutcome(
                        "$OPENROUTER_BASE_URL/chat/completions",
                        model, key, userPrompt, systemPrompt, maxTokens,
                    )
                    lastOutcome = outcome
                    when (outcome) {
                        is Outcome.Ok -> {
                            reply = outcome.reply
                            modelCooldownUntil.remove(model)
                        }
                        Outcome.Transient -> continue
                        else -> {}
                    }
                    break
                }
                if (reply == null) {
                    coolDown(
                        model,
                        when (lastOutcome) {
                            Outcome.RateLimited -> 15 * 60_000L
                            Outcome.Fatal -> 5 * 60_000L
                            else -> 90_000L
                        },
                    )
                }
                if (reply != null || !p.aiAutoRotate().get()) return@withContext reply
                // Автосмена: OpenRouter реально недоступен → пробуем Zen
                return@withContext zenChatWithRotation(userPrompt, systemPrompt, maxTokens)
            }
            if (provider == PROVIDER_OPENROUTER) {
                logcat(LogPriority.WARN) { "OpenRouter selected but no API key; falling back to Zen" }
            }
            zenChatWithRotation(userPrompt, systemPrompt, maxTokens)
        }

    /**
     * Zen с авторотацией: выбранная модель первая, при rate limit / ошибке —
     * следующая из списка. Бесплатные лимиты Zen помодельные, поэтому
     * ротация почти всегда находит живую модель. Тумблер «Автосмена моделей»
     * (pref_ai_auto_rotate) ограничивает попытки одной выбранной моделью.
     */
    /**
     * Zen с ПРАВИЛЬНОЙ ротацией (фикс по жалобе пользователя):
     *  • настоящий rate limit (429/FreeUsageLimit) → сразу СЛЕДУЮЩАЯ модель;
     *  • временный сбой (таймаут/5xx/обрыв прокси) → до 2 ретраев ТОЙ ЖЕ
     *    модели с паузой 1.2с/2.5с — рабочая модель не бросается из-за
     *    моргнувшей сети;
     *  • фатальная ошибка → следующая модель.
     */
    private suspend fun zenChatWithRotation(userPrompt: String, systemPrompt: String?, maxTokens: Int): ChatReply? {
        val preferred = prefs().zenModel().get().ifBlank { ZEN_MODELS.first() }
        val configuredOrder = if (prefs().aiAutoRotate().get()) {
            listOf(preferred) + ZEN_MODELS.filter { it != preferred }
        } else {
            listOf(preferred)
        }
        // A model that just returned a limit/5xx must not become first again
        // when the user taps Retry. Keep it on cooldown across chat turns.
        val order = configuredOrder.filterNot(::coolingDown).ifEmpty { configuredOrder }
        val retryDelaysMs = longArrayOf(1_200, 2_500)
        for (m in order) {
            var attempt = 0
            while (true) {
                when (val res = chatRawOutcome(
                    "$ZEN_BASE_URL/chat/completions",
                    m, "", userPrompt, systemPrompt, maxTokens,
                )) {
                    is Outcome.Ok -> {
                        modelCooldownUntil.remove(m)
                        return res.reply
                    }
                    Outcome.RateLimited -> {
                        coolDown(m, 15 * 60_000L)
                        break
                    }
                    Outcome.Fatal -> {
                        coolDown(m, 5 * 60_000L)
                        break
                    }
                    Outcome.Transient -> {
                        if (attempt >= retryDelaysMs.size) {
                            coolDown(m, 90_000L)
                            break
                        }
                        kotlinx.coroutines.delay(retryDelaysMs[attempt])
                        attempt++
                    }
                }
            }
        }
        return null
    }

    /**
     * Исход одного запроса. Нужен, чтобы ротация вела себя ПРАВИЛЬНО
     * (жалоба пользователя: «rate limit неверный — у одной модели
     * правильный, у другой просто сбои сети/прокси, потом отвечает»):
     *  • Ok            — ответ получен;
     *  • RateLimited   — НАСТОЯЩИЙ лимит (HTTP 429 или FreeUsageLimitError
     *                    в теле) → переключаться на следующую модель;
     *  • Transient     — временный сбой (таймаут, 5xx, обрыв соединения,
     *                    прокси) → ретраить ТУ ЖЕ модель с паузой, а не
     *                    убегать с рабочей модели;
     *  • Fatal         — постоянная ошибка модели (4xx кроме 429, кривой
     *                    ответ) → следующая модель.
     */
    private sealed class Outcome {
        data class Ok(val reply: ChatReply) : Outcome()
        object RateLimited : Outcome()
        object Transient : Outcome()
        object Fatal : Outcome()
    }

    private fun chatRawOutcome(
        url: String,
        model: String,
        apiKey: String,
        userPrompt: String,
        systemPrompt: String?,
        maxTokens: Int = 500,
    ): Outcome {
        val startedAt = System.currentTimeMillis()
        return try {
            val messages = JSONArray()
            if (!systemPrompt.isNullOrBlank()) {
                messages.put(JSONObject().put("role", "system").put("content", systemPrompt))
            }
            messages.put(JSONObject().put("role", "user").put("content", userPrompt))
            val body = JSONObject()
                .put("model", model)
                .put("messages", messages)
                .put("max_tokens", maxTokens)
                .put("temperature", 0.0)
                .put("stream", false)

            val conn = openConnection(url)
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 90_000
            conn.setRequestProperty("Content-Type", "application/json")
            if (apiKey.isNotBlank()) conn.setRequestProperty("Authorization", "Bearer $apiKey")

            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            conn.disconnect()
            if (code !in 200..299) {
                lastFailureMessage = "$model: HTTP $code — ${text.take(160)}"
                logcat(LogPriority.WARN) { "AI assistant HTTP $code ($model): ${text.take(160)}" }
                addLog(
                    LogEntry(
                        startedAt, model, userPrompt.take(200),
                        "HTTP $code: ${text.take(120)}",
                        System.currentTimeMillis() - startedAt,
                    ),
                )
                // Классификация: настоящий лимит vs временный сбой vs фатально
                val isLimit = code == 429 ||
                    text.contains("FreeUsageLimit", ignoreCase = true) ||
                    text.contains("rate_limit", ignoreCase = true) ||
                    text.contains("quota", ignoreCase = true)
                return when {
                    isLimit -> Outcome.RateLimited
                    code in 500..599 || code == 408 -> Outcome.Transient // 5xx/таймаут — прокси/сайт барахлит
                    else -> Outcome.Fatal
                }
            }
            val root = JSONObject(text)
            val choice = root.optJSONArray("choices")?.optJSONObject(0)
            val message = choice?.optJSONObject("message")
            val finishReason = choice?.optString("finish_reason").orEmpty()
            val tokens = root.optJSONObject("usage")?.optInt("total_tokens", 0) ?: 0
            val answer = message?.optString("content")?.trim()?.ifBlank { null }
            // Размышления reasoning-моделей: Zen отдаёт их в «reasoning»
            // (nemotron) или «reasoning_content» (hy3) — проверено живыми
            // запросами. Показываются в AI-чате при включённой опции.
            // org.json.optString возвращает ЛИТЕРАЛ "null", когда поле есть,
            // но равно JSON null — из-за этого в чате показывалось «🤔 null»
            // (баг со скриншота пользователя). Отфильтровываем.
            val reasoning = message?.let { m ->
                m.optString("reasoning").takeIf { it.isNotBlank() && it != "null" }
                    ?: m.optString("reasoning_content").takeIf { it.isNotBlank() && it != "null" }
            }?.trim()?.ifBlank { null }
            addLog(LogEntry(startedAt, model, userPrompt.take(200), (answer ?: "<пусто>").take(200), System.currentTimeMillis() - startedAt))
            answer?.let {
                lastFailureMessage = ""
                Outcome.Ok(
                    ChatReply(
                        content = it,
                        reasoning = reasoning,
                        model = model,
                        tokens = tokens,
                        complete = finishReason != "length",
                    ),
                )
            } ?: Outcome.Fatal
        } catch (e: Exception) {
            lastFailureMessage = "$model: ${e.javaClass.simpleName} — ${e.message?.take(160)}"
            addLog(LogEntry(startedAt, model, userPrompt.take(200), "ОШИБКА: ${e.message?.take(120)}", System.currentTimeMillis() - startedAt))
            logcat(LogPriority.WARN, e) { "AI assistant call failed ($model)" }
            // Сетевые исключения (SocketTimeout, ConnectException, SSL,
            // UnknownHost, обрыв прокси) — ВРЕМЕННЫЕ: модель не виновата
            Outcome.Transient
        }
    }

    /** Строка подготовленного кадра: говорить ли, каким полом, каким текстом. */
    data class PreparedLine(val speak: Boolean, val gender: String?, val text: String)

    /**
     * ГЛАВНЫЙ шаг конвейера (по требованию пользователя): текст кадра
     * отправляется В ЧАТ ДО озвучки. Модель одним запросом:
     *  1) вычищает реплики, повторяющие прошлый кадр (перекрытие скролла);
     *  2) назначает пол говорящего каждой оставшейся;
     *  3) возвращает чистый текст для синтеза.
     * Протокол ответа — по строке на реплику: «N|г|текст» (г: м/ж/н) или
     * «N|-» для пропуска дубля. Всё видно в скрытом чате (журнале).
     * Таймаут 8с: при сбое вызывающий код откатывается на локальный конвейер.
     */
    suspend fun prepareFrame(newLines: List<String>, prevLines: List<String>): List<PreparedLine>? {
        if (newLines.isEmpty()) return emptyList()
        val prevBlock = if (prevLines.isEmpty()) {
            "(прошлый кадр пуст)"
        } else {
            prevLines.takeLast(20).joinToString("\n") { "- ${it.take(90)}" }
        }
        val newBlock = newLines.mapIndexed { i, t -> "${i + 1}. ${t.take(140)}" }.joinToString("\n")
        val answer = kotlinx.coroutines.withTimeoutOrNull(8_000) {
            chat(
                userPrompt = "Прошлый кадр манги содержал реплики:\n$prevBlock\n\n" +
                    "Новый кадр:\n$newBlock\n\n" +
                    "Для КАЖДОЙ реплики нового кадра ответь отдельной строкой строго в формате " +
                    "«N|г|текст», где N — номер, г — пол говорящего (м/ж/н), " +
                    "текст — реплика, очищенная от мусора OCR. Если реплика повторяет прошлый кадр " +
                    "(даже частично/с искажениями) — ответь «N|-». Больше НИЧЕГО не пиши.",
                systemPrompt = "Ты конвейер озвучки манги: чистишь повторы и назначаешь пол. " +
                    "Отвечаешь только строками формата N|г|текст или N|-.",
                maxTokens = 600,
            )
        } ?: return null

        val byIndex = HashMap<Int, PreparedLine>()
        for (line in answer.lines()) {
            val parts = line.trim().split('|', limit = 3)
            val n = parts.getOrNull(0)?.trim()?.toIntOrNull() ?: continue
            if (n !in 1..newLines.size) continue
            if (parts.size < 2 || parts[1].trim() == "-") {
                byIndex[n] = PreparedLine(speak = false, gender = null, text = "")
                continue
            }
            val gender = when (parts[1].trim().lowercase()) {
                "м" -> "male"
                "ж" -> "female"
                else -> null
            }
            val text = parts.getOrNull(2)?.trim().orEmpty().ifBlank { newLines[n - 1] }
            byIndex[n] = PreparedLine(speak = true, gender = gender, text = text)
        }
        if (byIndex.isEmpty()) return null // модель ответила не по протоколу
        return List(newLines.size) { i ->
            byIndex[i + 1] ?: PreparedLine(speak = true, gender = null, text = newLines[i])
        }
    }

    /**
     * Пол говорящих — СВЕРХБЫСТРЫЙ формат: модель отвечает строкой из букв,
     * по одной на реплику: «м» (мужской), «ж» (женский), «н» (не ясно).
     * Никакого JSON и рассуждений: max_tokens=40, ответ приходит за долю
     * секунды даже у reasoning-моделей. Плюс жёсткий таймаут 6с — если сеть
     * тупит, чтение продолжается нейтральным голосом, а не ждёт модель.
     * Фолбэк: локальный словарь морфологии (LocalSpeakerAi) уже отработал
     * ДО этого вызова — сюда приходят только реплики без вердикта.
     */
    suspend fun detectGendersByText(lines: List<String>): List<String?> {
        if (lines.isEmpty()) return emptyList()
        val numbered = lines.mapIndexed { i, t -> "${i + 1}) ${t.take(100)}" }.joinToString("\n")
        val answer = kotlinx.coroutines.withTimeoutOrNull(6_000) {
            chat(
                userPrompt = "Кто говорит каждую реплику? Ответь ТОЛЬКО строкой из ${lines.size} букв " +
                    "без пробелов: м=мужчина, ж=женщина, н=неясно. Пример ответа: мжнм\n\n" + numbered,
                systemPrompt = "Отвечай только буквами м/ж/н, ничего больше. Без рассуждений.",
                maxTokens = 40,
            )
        } ?: return List(lines.size) { null }

        // Берём последнюю строку ответа (reasoning-модели любят префиксы),
        // выбрасываем всё, кроме м/ж/н
        val letters = answer.lines().lastOrNull { l -> l.any { it in "мжн" } }
            ?.filter { it in "мжн" }.orEmpty()
        return List(lines.size) { i ->
            when (letters.getOrNull(i)) {
                'м' -> "male"
                'ж' -> "female"
                else -> null
            }
        }
    }
}
