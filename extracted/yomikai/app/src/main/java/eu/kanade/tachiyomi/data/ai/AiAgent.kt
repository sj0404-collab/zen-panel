package eu.kanade.tachiyomi.data.ai

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import eu.kanade.domain.source.service.SourcePreferences
import eu.kanade.tachiyomi.data.ui.UiActionRegistry
import eu.kanade.tachiyomi.data.ui.UiTabRegistry
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import logcat.LogPriority
import mihon.data.ui.UiTab
import mihon.data.ui.UiTabs
import mihon.domain.ocr.model.OcrImage
import mihon.domain.ocr.repository.OcrRepository
import org.json.JSONArray
import org.json.JSONObject
import tachiyomi.core.common.util.system.logcat
import tachiyomi.domain.source.service.SourceManager
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.File
import java.net.URLEncoder

/**
 * Агентское ядро встроенного AI-чата (вкладка «AI»). Это НЕ заглушка:
 * модель (Zen/OpenRouter, как в AiAssistant) получает список реальных
 * инструментов и вызывает их через простой текстовый протокол
 * `@tool имя {json}` — одна строка на вызов. Результат инструмента
 * возвращается модели, и она отвечает пользователю.
 *
 * Реальные инструменты:
 *  • write_file    — сохранить файл в workspace (/sdcard/Yomikai/AI)
 *  • gen_image     — сгенерировать картинку через Pollinations (без ключа)
 *  • check_site    — проверить, работает ли сайт (реальный HTTP-запрос)
 *  • list_ext      — перечислить установленные расширения-источники
 *  • filter_ext    — скрыть/показать источники по запросу (правит
 *                    hidden_catalogues — тот же механизм, что в настройках)
 *  • find_manga    — поиск тайтла по включённым источникам (реальный
 *                    getSearchManga каждого источника, до 8 источников)
 *  • zip_workspace — упаковать workspace в zip
 *
 * Смена доменов источников: URL расширений вшиты в их APK; агент не может
 * их «переписать», но check_site честно проверяет зеркала, а find_manga
 * показывает, в каком источнике тайтл РЕАЛЬНО открывается — это решает
 * задачу «не искать долго».
 */
object AiAgent {

    data class ToolCall(val name: String, val args: JSONObject)
    data class ToolResult(
        val name: String,
        val output: String,
        val fileProduced: File? = null,
        /** Аргументы вызова (для показа в карточке). */
        val args: String = "",
        /** Раунд агентского цикла (1, 2, …). */
        val round: Int = 0,
        /** Время исполнения инструмента, мс. */
        val tookMs: Long = 0,
        /** ok | error — статус TODO-списка. */
        val status: String = "ok",
    )

    data class AgentReply(
        val text: String,
        val toolResults: List<ToolResult>,
        val images: List<File>,
        val reasoning: String? = null,
        val model: String = "",
        /** Сколько токенов съели все запросы этого хода. */
        val tokens: Int = 0,
        /** Полное время хода, мс. */
        val tookMs: Long = 0,
        /** Число раундов инструментов. */
        val rounds: Int = 0,
        /** Кнопки-варианты для пользователя ([[...]] из ответа модели). */
        val choices: List<String> = emptyList(),
    )

    private val sourceManager: SourceManager by lazy { Injekt.get() }
    private val sourcePrefs: SourcePreferences by lazy { Injekt.get() }

    // Не const: в промпт подставляется документация инструментов читалки
    // из AiReaderTools, а это выражение, а не литерал.
    private val SYSTEM_PROMPT =
        "Ты — встроенный AI-агент манга-читалки Yomikai (как arena.ai agent, но внутри приложения). " +
            "Отвечай кратко и по-русски. У тебя есть ИНСТРУМЕНТЫ. Чтобы вызвать инструмент, " +
            "напиши отдельной строкой: @tool имя {json-аргументы}. Доступные инструменты:\n" +
            "@tool write_file {\"name\":\"путь/файл.txt\",\"content\":\"текст\"} — сохранить файл в workspace\n" +
            "@tool edit_file {\"name\":\"путь/файл.txt\",\"find\":\"что\",\"replace\":\"чем\"} — правка файла (бэкап создаётся автоматически)\n" +
            "@tool append_file {\"name\":\"путь/файл.txt\",\"content\":\"текст\"} — дописать в конец (для длинных книг по главам, бэкап автоматически)\n" +
            "@tool read_file {\"name\":\"путь/файл.txt\"} — прочитать файл workspace (для продолжения без потери контекста)\n" +
            "@tool gen_image {\"prompt\":\"описание на английском\"} — нарисовать картинку (Pollinations)\n" +
            "@tool check_site {\"url\":\"https://...\"} — проверить, работает ли сайт\n" +
            "@tool list_ext {} — список установленных расширений-источников с их доменами\n" +
            "@tool filter_ext {\"hide\":\"подстрока\",\"show\":\"подстрока\"} — скрыть/показать источники по имени/языку\n" +
            "@tool find_manga {\"title\":\"название\"} — найти мангу по включённым источникам, вернёт где реально открывается\n" +
            "@tool zip_workspace {} — упаковать workspace в zip\n" +
            "ПЛАГИНЫ (самодельные инструменты, без ограничений по количеству):\n" +
            "@tool plugin_create {\"name\":\"имя\",\"kind\":\"http|prompt\",\"description\":\"что делает\"," +
            "\"template\":\"https://api...?q={query} ИЛИ текст-инструкция с {input}\"," +
            "\"method\":\"GET\",\"body\":\"\"} — создать/починить инструмент; после создания вызывай его по имени\n" +
            "@tool plugin_edit {\"name\":\"имя\",\"template\":\"новый шаблон\"} — исправить плагин (менять можно любое поле)\n" +
            "@tool plugin_delete {\"name\":\"имя\"} — удалить плагин\n" +
            "@tool plugin_list {} — список своих плагинов\n" +
            "ПРОВАЙДЕРЫ AI (сторонние сервисы и локальные LLM пользователя):\n" +
            "@tool provider_create {\"id\":\"ollama\",\"title\":\"название\",\"baseUrl\":\"http://192.168.1.10:11434/v1\"," +
            "\"model\":\"qwen2.5:7b\",\"apiKey\":\"\"} — подключить свой OpenAI-совместимый провайдер " +
            "(Ollama, LM Studio, llama.cpp, корпоративный прокси); baseUrl без /chat/completions\n" +
            "@tool provider_edit {\"id\":\"ollama\",\"model\":\"новая-модель\"} — изменить провайдер (любое поле)\n" +
            "@tool provider_delete {\"id\":\"ollama\"} — отключить провайдер\n" +
            "@tool provider_list {} — список провайдеров: встроенные и свои\n" +
            "КНОПКИ В UI ЧИТАЛКИ (пользовательские действия, без исполняемого кода):\n" +
            "@tool ui_action_create {\"id\":\"my_manhwa\",\"title\":\"Манхва одним тапом\"," +
            "\"placement\":\"floating_menu|reader_top_bar|ocr_card\"," +
            "\"effect\":\"ocr_preset|scan_region|reading_mode|voice_engine|ai_provider\"," +
            "\"value\":\"manhwa\",\"order\":100} — добавить свою кнопку в меню читалки; " +
            "значение выбирается из списка эффекта (для ocr_preset — manga|manhwa|comic|balanced)\n" +
            "@tool ui_action_edit {\"id\":\"my_manhwa\",\"title\":\"новое название\"} — изменить кнопку\n" +
            "@tool ui_action_delete {\"id\":\"my_manhwa\"} — убрать кнопку\n" +
            "@tool ui_action_list {} — все кнопки: встроенные и пользовательские\n" +
            "ВКЛАДКИ ПРИЛОЖЕНИЯ (нижняя навигация; скрываем только то, что просит пользователь):\n" +
            "@tool ui_tab_hide {\"id\":\"browser\"} — скрыть вкладку. Доступны: " +
            "local_library|updates|history|browse|browser|ai (library и more закреплены, их скрыть нельзя)\n" +
            "@tool ui_tab_show {\"id\":\"browser\"} — вернуть вкладку\n" +
            "@tool ui_tab_list {} — все вкладки и какие из них скрыты\n" +
            "ЛОГИ: пользователь жалуется на озвучку/скачивание голосов — читай logs/tts.log через read_file.\n" +
            "@tool runner_chat {\"text\":\"вопрос\"} — спросить LLM на GitHub-ранере (если сессия жива и разрешено в настройках)\n" +
            "@tool runner_start {\"model\":\"qwen2.5-1.5b\",\"os\":\"linux|windows\"} — запустить новую ранер-сессию (если разрешено)\n" +
            "@tool github_api {\"path\":\"/repos/OWNER/REPO/actions/runs?per_page=3\"} — GET-запрос к GitHub API привязанным токеном (если разрешено)\n" +
            "ЧИТАЛКА, РАСПОЗНАВАНИЕ И ОЗВУЧКА (реестры плагинов приложения):\n" +
            AiReaderTools.SYSTEM_PROMPT_LINES.joinToString("\n") { it } + "\n" +
            "Если пользователь жалуется, что текст распознаётся плохо или не тем порядком, — " +
            "сначала reader_status, затем ocr_preset с подходящим id (manga/manhwa/comic/balanced).\n" +
            "Если пользователь жалуется на озвучку/голоса/синтез (молчит, один голос на всех ролей, " +
            "движок «исчез» из списка) — ПЕРВЫМ вызывай tts_status и опирайся на него; " +
            "reader_status и plugins_list для голосовых жалоб не подходят.\n" +
            "Если пользователь просит новый инструмент — СОЗДАЙ его через plugin_create и сразу проверь вызовом.\n" +
            "НЕЙРО-КНИГИ и НЕЙРО-КОМИКСЫ: пиши книгу по главам через append_file " +
            "(book/название.md), перед продолжением читай хвост через read_file — так контекст не теряется. " +
            "Для комикса: сцены текстом в comic/сценарий.md + gen_image на каждый кадр.\n" +
            "Можно несколько @tool в одном ответе. После строк @tool больше ничего не пиши — " +
            "результаты придут следующим сообщением, тогда и ответишь пользователю.\n" +
            "ВАРИАНТЫ ВЫБОРА: если уместно предложить пользователю выбор (что делать дальше, " +
            "какой вариант взять), закончи ответ строками вида [[Текст варианта]] — по одной на строку, " +
            "2-4 варианта. Они превратятся в кнопки под сообщением."

    /**
     * Один ход агента: prompt пользователя (+опц. текст из вложений) →
     * модель → выполнение @tool-вызовов → второй запрос модели с
     * результатами → финальный ответ.
     */
    /**
     * Функция чата бэкенда: (prompt, systemPrompt) -> ChatReply?.
     * Позволяет гонять ОДИН И ТОТ ЖЕ агентский цикл с инструментами через
     * ЛЮБОЙ бэкенд: онлайн (Zen/OpenRouter), ЛОКАЛЬНУЮ модель на телефоне
     * (LocalLlm) и полу-онлайн ранер (RunnerLlm). Инструменты (@tool)
     * исполняются самим приложением — модели достаточно уметь писать текст.
     */
    private val onlineChat: suspend (String, String) -> AiAssistant.ChatReply? = { p, sys ->
        AiAssistant.chatFull(p, sys, maxTokens = 1800)
    }

    /**
     * A tool turn must survive a provider hiccup after side effects already
     * happened. Retry only the model call and join max-token continuations;
     * never execute a tool merely because the network response was lost.
     */
    private suspend fun reliableChat(
        chat: suspend (String, String) -> AiAssistant.ChatReply?,
        prompt: String,
        systemPrompt: String,
    ): AiAssistant.ChatReply? {
        var reply: AiAssistant.ChatReply? = null
        for (attempt in 0 until 3) {
            reply = runCatching { chat(prompt, systemPrompt) }.getOrNull()
            if (reply != null) break
            kotlinx.coroutines.delay(800L * (attempt + 1))
        }
        var combined = reply ?: return null
        for (continuation in 0 until 2) {
            if (combined.complete) break
            val next = runCatching {
                chat(
                    prompt + "\n\nОтвет оборвался по лимиту. Уже полученная часть:\n" +
                        combined.content.takeLast(6000) +
                        "\n\nПродолжи строго с места обрыва. Не повторяй уже написанное.",
                    systemPrompt,
                )
            }.getOrNull() ?: break
            combined = combined.copy(
                content = combined.content + "\n" + next.content,
                reasoning = next.reasoning ?: combined.reasoning,
                model = next.model,
                tokens = combined.tokens + next.tokens,
                complete = next.complete,
            )
        }
        return combined
    }

    suspend fun run(
        context: Context,
        userText: String,
        attachmentsInfo: String? = null,
        history: List<Pair<String, String>> = emptyList(), // role to content
        chatFn: (suspend (String, String) -> AiAssistant.ChatReply?)? = null,
    ): AgentReply = withContext(Dispatchers.IO) {
        val chat = chatFn ?: onlineChat
        val results = mutableListOf<ToolResult>()
        val images = mutableListOf<File>()

        // Продвинутый лимит истории и токен-бюджет (запрос: не тратить 50к токенов)
        // Продвинутый лимит истории и токен-бюджет (запрос: не тратить 50к токенов)
        val prefs = runCatching { uy.kohesive.injekt.Injekt.get<mihon.domain.ocr.service.OcrPreferences>() }.getOrNull()
        val historyLimit = prefs?.aiHistoryLimit()?.get()?.coerceIn(4, 100) ?: 12
        val tokenBudget = prefs?.aiTokenBudget()?.get()?.coerceIn(1000, 16000) ?: 4000
        // Грубая оценка токенов: 3.5 символа ≈ 1 токен
        fun est(s: String) = (s.length / 3.5).toInt()
        var budgetedHistory = history
        var total = history.sumOf { est(it.second) }
        while (budgetedHistory.size > 4 && total > (tokenBudget * 0.7).toInt()) {
            val removed = budgetedHistory.first()
            total -= est(removed.second)
            budgetedHistory = budgetedHistory.drop(1)
        }
        val trimmedHistory = budgetedHistory
        val historyBlock = trimmedHistory.takeLast(historyLimit).joinToString("\n") { (role, c) ->
            (if (role == "user") "Пользователь: " else "Ассистент: ") + c.take(280)
        }
        val capabilityBlock = runCatching { AiCapabilityReporter.renderForPrompt(context) }.getOrNull().orEmpty()
        val prompt = buildString {
            if (historyBlock.isNotBlank()) append("Контекст диалога (последние $historyLimit, бюджет ${tokenBudget} токенов):\n").append(historyBlock).append("\n\n")
            if (!attachmentsInfo.isNullOrBlank()) append("Вложения пользователя:\n").append(attachmentsInfo).append("\n\n")
            if (capabilityBlock.isNotBlank()) append(capabilityBlock).append("\n\n")
            append(userText)
            append("\n\n[Инструкция: отвечай кратко на русском, одним языком, reasoning ≤250 токенов, укажи что доступно/недоступно из блока выше, не повторяй запрос; токен-бюджет хода ${tokenBudget}.]")
        }
        val systemPromptEffective = SYSTEM_PROMPT + "\n\n" + capabilityBlock

        val turnStarted = System.currentTimeMillis()
        var totalTokens = 0
        var roundsDone = 0

        var reply = reliableChat(chat, prompt, systemPromptEffective)
            ?: return@withContext AgentReply(
                buildString {
                    append("Нет ответа от AI-бэкенда после повторов и ротации.")
                    AiAssistant.lastFailure().takeIf { it.isNotBlank() }?.let {
                        append(" Последняя ошибка: ").append(it)
                    }
                    append(" Проверьте прокси в ⚙ или смените бэкенд.")
                },
                emptyList(), emptyList(),
            )
        totalTokens += reply.tokens
        var answer = reply.content
        var reasoning = reply.reasoning
        var usedModel = reply.model

        // Раундов стало больше (было 6 — сложные задачи обрывались на середине),
        // дубликаты вызовов по-прежнему не исполняются дважды за один ход
        // (важно для append_file/write_file).
        val executedCalls = mutableSetOf<String>()
        for (round in 1..12) {
            val parsedCalls = parseToolCalls(context, answer)
            if (parsedCalls.isEmpty()) break
            val calls = parsedCalls.filter { call ->
                executedCalls.add(call.name + "\u0000" + call.args.toString())
            }
            if (calls.isEmpty()) {
                answer = stripToolSyntax(context, answer).ifBlank {
                    "Все запрошенные инструменты уже выполнены; повторный вызов пропущен."
                }
                break
            }
            roundsDone = round
            val outputs = calls.map { call ->
                val t0 = System.currentTimeMillis()
                // Инструменты больше не могут зависнуть навсегда (gen_image /
                // check_site на медленной сети): жёсткий таймаут 120 секунд.
                val r = runCatching {
                    withTimeoutOrNull(120_000L) { execute(context, call, chat) }
                        ?: ToolResult(call.name, "ОШИБКА: инструмент не ответил за 120 секунд", status = "error")
                }
                    .getOrElse { ToolResult(call.name, "ОШИБКА: ${it.message?.take(160)}", status = "error") }
                    .copy(
                        args = call.args.toString().take(200),
                        round = round,
                        tookMs = System.currentTimeMillis() - t0,
                    )
                val finalR = if (r.output.startsWith("ОШИБКА")) r.copy(status = "error") else r
                if (finalR.fileProduced != null && finalR.name == "gen_image") images += finalR.fileProduced
                results += finalR
                "${finalR.name}: ${finalR.output.take(700)}"
            }
            val followUp = "Твой предыдущий ответ с вызовами:\n${answer.take(6000)}\n\n" +
                "Результаты инструментов:\n" + outputs.joinToString("\n---\n") +
                "\n\nПродолжи задачу. Если всё сделано — дай полный финальный ответ без @tool."
            val next = reliableChat(
                chat,
                prompt + "\n\n(вызовы выполнены приложением)\n" + followUp,
                systemPromptEffective,
            )
            if (next != null) {
                totalTokens += next.tokens
                answer = next.content
                if (next.reasoning != null) reasoning = next.reasoning
                usedModel = next.model
            } else {
                // Network/provider failed after tools already made changes.
                // Return a complete local checkpoint instead of losing the
                // turn or forcing the user to execute the same tools again.
                answer = buildString {
                    append(stripToolSyntax(context, answer).takeIf { it.isNotBlank() }.orEmpty())
                    if (isNotEmpty()) append("\n\n")
                    append("Инструменты выполнены, но финальный ответ модели не получен:\n")
                    results.forEach { result ->
                        append("• ").append(result.name).append(": ")
                            .append(result.output.take(700)).append('\n')
                    }
                    append("Результаты сохранены; повторять инструменты не требуется.")
                }
                break
            }
        }

        var cleanText = stripToolSyntax(context, answer)
        // Кнопки-варианты: [[Вариант]] по одной на строку в конце ответа
        val choiceRe = Regex("\\[\\[(.{2,80}?)]]")
        val choices = choiceRe.findAll(cleanText).map { it.groupValues[1].trim() }.take(4).toList()
        if (choices.isNotEmpty()) cleanText = choiceRe.replace(cleanText, "").trim()
        cleanText = cleanText.ifBlank { "Готово. Результаты — в карточках инструментов ниже и в workspace." }
        AgentReply(
            cleanText, results, images,
            reasoning = reasoning, model = usedModel,
            tokens = totalTokens,
            tookMs = System.currentTimeMillis() - turnStarted,
            rounds = roundsDone,
            choices = choices,
        )
    }

    /** Имена всех известных инструментов — для «мягкого» синтаксиса без @tool. */
    private fun knownToolNames(context: Context): Set<String> =
        setOf(
            "write_file", "edit_file", "append_file", "read_file", "gen_image",
            "check_site", "list_ext", "filter_ext", "find_manga", "zip_workspace",
            "plugin_create", "plugin_edit", "plugin_delete", "plugin_list",
            "runner_chat", "runner_start", "github_api",
            "provider_create", "provider_edit", "provider_delete", "provider_list",
            "ui_action_create", "ui_action_edit", "ui_action_delete", "ui_action_list",
            "ui_tab_hide", "ui_tab_show", "ui_tab_list",
        ) + AiReaderTools.TOOL_NAMES + AiPlugins.list(context).map { it.name }

    /**
     * Разбор вызовов инструментов. Модели (особенно бесплатные) пишут вызов
     * как попало — поддерживаем все варианты (баги со скриншотов):
     *  • @tool list_ext {}      — канонический;
     *  • @list_ext {}           — без слова tool;
     *  • list_ext {}            — вообще без @, если имя известно;
     *  • `@tool list_ext {}`    — в бэктиках/код-блоке;
     *  • <tool_call>имя<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
     *    — XML-стиль, которым laguna пишет вызовы (второй скриншот).
     */
    private fun parseToolCalls(context: Context, text: String): List<ToolCall> {
        val known = knownToolNames(context)
        val out = mutableListOf<ToolCall>()

        // --- XML-стиль: <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>…</tool_call>
        val xmlRe = Regex("<tool_call>(.*?)</tool_call>", RegexOption.DOT_MATCHES_ALL)
        val argRe = Regex("<arg_key>(.*?)</arg_key>\\s*<arg_value>(.*?)</arg_value>", RegexOption.DOT_MATCHES_ALL)
        for (m in xmlRe.findAll(text)) {
            val inner = m.groupValues[1]
            val name = inner.substringBefore("<arg_key>").trim()
                .removePrefix("@tool").removePrefix("@").trim()
            if (name !in known) continue
            val args = JSONObject()
            for (am in argRe.findAll(inner)) {
                args.put(am.groupValues[1].trim(), am.groupValues[2].trim())
            }
            out += ToolCall(name, args)
        }

        // --- Multiline @tool name { ... } with balanced JSON. This recovers
        // calls split across model lines or joined from a max-token continuation.
        val markerRe = Regex("(?:@tool\\s+|@)([A-Za-z0-9_]+)\\s*")
        for (marker in markerRe.findAll(text)) {
            val name = marker.groupValues[1]
            if (name !in known) continue
            val start = text.indexOf('{', marker.range.last + 1)
            if (start < 0) continue
            var depth = 0
            var quoted = false
            var escaped = false
            var end = -1
            for (i in start until text.length) {
                val ch = text[i]
                if (escaped) {
                    escaped = false
                    continue
                }
                if (quoted && ch == '\\') {
                    escaped = true
                    continue
                }
                if (ch == '"') quoted = !quoted
                if (!quoted) {
                    if (ch == '{') depth++
                    if (ch == '}') {
                        depth--
                        if (depth == 0) {
                            end = i
                            break
                        }
                    }
                }
            }
            if (end > start) {
                runCatching { JSONObject(text.substring(start, end + 1)) }
                    .getOrNull()
                    ?.let { out += ToolCall(name, it) }
            }
        }

        // --- Строчные стили
        for (raw in text.lines()) {
            var t = raw.trim().trim('`').trim()
            if (t.isEmpty() || t.contains("<tool_call>")) continue
            if (t.startsWith("@tool ")) t = t.removePrefix("@tool ").trim()
            else if (t.startsWith("@")) t = t.removePrefix("@").trim()
            val space = t.indexOf(' ')
            val name = (if (space > 0) t.substring(0, space) else t).trim()
            if (name !in known) continue
            val json = if (space > 0) t.substring(space + 1).trim() else "{}"
            runCatching { ToolCall(name, JSONObject(json.ifBlank { "{}" })) }
                .getOrNull()
                ?.let(out::add) // incomplete JSON is recovered by the multiline parser
        }
        return out
    }

    /** Убирает из видимого текста все формы tool-вызовов (строчные и XML). */
    fun stripToolSyntax(context: Context, text: String): String {
        val known = knownToolNames(context)
        var cleaned = text.replace(
            Regex("<tool_call>.*?</tool_call>", RegexOption.DOT_MATCHES_ALL),
            "",
        )
        // laguna пишет аргументы XML-тегами прямо после имени инструмента и
        // часто без обёртки <tool_call>: такие огрызки («@tool ocr_preset<arg_key>…»)
        // раньше оставались в пузыре ответа. Убираем и их.
        cleaned = cleaned.replace(
            Regex("<arg_key>.*?</arg_value>", RegexOption.DOT_MATCHES_ALL),
            " ",
        )
        cleaned = cleaned.lines().filterNot { line ->
            val t = line.trim().trim('`').trim()
                .removePrefix("@tool ").removePrefix("@").trim()
                .substringBefore('<')
            t.substringBefore(' ') in known && (
                line.trimStart().startsWith("@") || t.contains("{") || t.substringBefore(' ') == t
                )
        }.joinToString("\n")
        return cleaned.trim()
    }

    private suspend fun execute(
        context: Context,
        call: ToolCall,
        chatFn: suspend (String, String) -> AiAssistant.ChatReply?,
    ): ToolResult = when (call.name) {
        // Инструменты читалки: видят те же реестры и настройки, что и экраны,
        // поэтому ответ агента не может разойтись с настройками пользователя.
        AiReaderTools.TOOL_READER_STATUS -> runCatching {
            ToolResult(call.name, AiReaderTools.readerStatus(context))
        }.getOrElse { ToolResult(call.name, "ОШИБКА: ${it.message?.take(160)}") }

        AiReaderTools.TOOL_OCR_PRESET -> runCatching {
            ToolResult(call.name, AiReaderTools.applyPreset(context, call.args.optString("id")))
        }.getOrElse { ToolResult(call.name, "ОШИБКА: ${it.message?.take(160)}") }

        AiReaderTools.TOOL_PLUGINS_LIST -> runCatching {
            ToolResult(call.name, AiReaderTools.pluginsReport(context))
        }.getOrElse { ToolResult(call.name, "ОШИБКА: ${it.message?.take(160)}") }

        AiReaderTools.TOOL_TTS_STATUS -> runCatching {
            ToolResult(call.name, AiReaderTools.ttsStatus(context))
        }.getOrElse { ToolResult(call.name, "ОШИБКА: ${it.message?.take(160)}") }

        "runner_chat" -> {
            val prefsR = uy.kohesive.injekt.Injekt.get<mihon.domain.ocr.service.OcrPreferences>()
            if (!prefsR.aiAllowRunner().get()) {
                ToolResult("runner_chat", "ЗАПРЕЩЕНО настройками: включите «Доступ агента к ранеру» в ⚙ вкладки AI")
            } else {
                val text = call.args.optString("text")
                val session = RunnerLlm.listSessions(context).firstOrNull { it.url != null }
                when {
                    text.isBlank() -> ToolResult("runner_chat", "ОШИБКА: пустой text")
                    session == null -> ToolResult("runner_chat", "Нет живой ранер-сессии — запусти runner_start или вручную в ⚙")
                    else -> {
                        val answer = RunnerLlm.chat(context, session, text)
                        ToolResult("runner_chat", answer ?: "Ранер не ответил (сессия могла умереть)")
                    }
                }
            }
        }

        "runner_start" -> {
            val prefsR = uy.kohesive.injekt.Injekt.get<mihon.domain.ocr.service.OcrPreferences>()
            if (!prefsR.aiAllowRunner().get()) {
                ToolResult("runner_start", "ЗАПРЕЩЕНО настройками: включите «Доступ агента к ранеру» в ⚙ вкладки AI")
            } else {
                val model = call.args.optString("model").ifBlank { "qwen2.5-0.5b" }
                val osArg = call.args.optString("os").ifBlank { "linux" }
                var last = ""
                val session = RunnerLlm.startSession(context, model, { st -> last = st }, osArg)
                if (session != null) {
                    ToolResult("runner_start", "Сессия запущена: ${session.model} @${session.os}, url=${session.url}")
                } else {
                    ToolResult("runner_start", "Не удалось запустить: $last")
                }
            }
        }

        "github_api" -> {
            val prefsR = uy.kohesive.injekt.Injekt.get<mihon.domain.ocr.service.OcrPreferences>()
            if (!prefsR.aiAllowGithub().get()) {
                ToolResult("github_api", "ЗАПРЕЩЕНО настройками: включите «Доступ агента к GitHub» в ⚙ вкладки AI")
            } else {
                val token = prefsR.githubPat().get()
                val path = call.args.optString("path")
                when {
                    token.isBlank() -> ToolResult("github_api", "PAT не привязан: задайте его в ⚙ вкладки AI")
                    !path.startsWith("/") -> ToolResult("github_api", "ОШИБКА: path должен начинаться с /")
                    else -> runCatching {
                        val conn = AiAssistant.openConnection("https://api.github.com$path")
                        conn.connectTimeout = 15_000
                        conn.readTimeout = 30_000
                        conn.setRequestProperty("Authorization", "token $token")
                        conn.setRequestProperty("Accept", "application/vnd.github+json")
                        val code = conn.responseCode
                        val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                            ?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                        conn.disconnect()
                        ToolResult("github_api", "HTTP $code:\n" + body.take(1200))
                    }.getOrElse { ToolResult("github_api", "ОШИБКА: ${it.message?.take(120)}") }
                }
            }
        }

        "plugin_create", "plugin_edit" -> {
            val name = call.args.optString("name")
            val existing = AiPlugins.get(context, name)
            if (call.name == "plugin_edit" && existing == null) {
                ToolResult(call.name, "Плагин «$name» не найден — сначала plugin_create")
            } else {
                val p = AiPlugins.Plugin(
                    name = name,
                    kind = call.args.optString("kind").ifBlank { existing?.kind ?: "prompt" },
                    description = call.args.optString("description").ifBlank { existing?.description.orEmpty() },
                    template = call.args.optString("template").ifBlank { existing?.template.orEmpty() },
                    method = call.args.optString("method").ifBlank { existing?.method ?: "GET" },
                    body = call.args.optString("body").ifBlank { existing?.body.orEmpty() },
                    headers = existing?.headers ?: emptyMap(),
                )
                if (p.template.isBlank()) {
                    ToolResult(call.name, "ОШИБКА: пустой template")
                } else if (AiPlugins.save(context, p)) {
                    ToolResult(call.name, "Плагин «${p.name}» (${p.kind}) сохранён. Вызывай: @tool ${p.name} {\"query\":\"...\"} или {\"input\":\"...\"}")
                } else {
                    ToolResult(call.name, "ОШИБКА: имя занято встроенным инструментом или некорректно")
                }
            }
        }

        "plugin_delete" -> {
            val name = call.args.optString("name")
            ToolResult("plugin_delete", if (AiPlugins.delete(context, name)) "Плагин «$name» удалён" else "Плагин «$name» не найден")
        }

        "plugin_list" -> {
            val ps = AiPlugins.list(context)
            ToolResult(
                "plugin_list",
                if (ps.isEmpty()) "Плагинов нет" else ps.joinToString("\n") { "• ${it.name} (${it.kind}) — ${it.description.take(80)}" },
            )
        }

        "write_file" -> {
            val name = call.args.optString("name").ifBlank { "note_${System.currentTimeMillis() / 1000}.txt" }
            val content = call.args.optString("content")
            val f = AiWorkspace.writeText(context, name, content)
            if (f != null) {
                ToolResult("write_file", "Сохранено: ${AiWorkspace.relPath(context, f)} (${f.length()} байт)", f)
            } else {
                ToolResult("write_file", "ОШИБКА: некорректный путь")
            }
        }

        "gen_image" -> {
            val prompt = call.args.optString("prompt").ifBlank { "anime illustration" }
            val f = generateImage(context, prompt)
            if (f != null) {
                ToolResult("gen_image", "Картинка готова: ${AiWorkspace.relPath(context, f)}", f)
            } else {
                ToolResult("gen_image", "ОШИБКА: Pollinations не ответил (сеть?)")
            }
        }

        "check_site" -> {
            val url = call.args.optString("url")
            ToolResult("check_site", checkSite(url))
        }

        "list_ext" -> ToolResult("list_ext", listExtensions())

        "filter_ext" -> {
            val hide = call.args.optString("hide")
            val show = call.args.optString("show")
            ToolResult("filter_ext", filterExtensions(hide, show))
        }

        "find_manga" -> {
            val title = call.args.optString("title")
            ToolResult("find_manga", findManga(title))
        }

        "edit_file" -> {
            val name = call.args.optString("name")
            val find = call.args.optString("find")
            val replace = call.args.optString("replace")
            val f = AiWorkspace.resolve(context, name)
            when {
                f == null || !f.isFile -> ToolResult("edit_file", "ОШИБКА: файл не найден: $name")
                find.isBlank() -> ToolResult("edit_file", "ОШИБКА: пустой параметр find")
                else -> {
                    val original = f.readText()
                    if (!original.contains(find)) {
                        ToolResult("edit_file", "Текст «${find.take(60)}» не найден в $name — файл не тронут")
                    } else {
                        AiWorkspace.backup(context, f) // бэкап ДО правки
                        f.writeText(original.replace(find, replace))
                        ToolResult("edit_file", "Заменено в $name (бэкап в backups/)", f)
                    }
                }
            }
        }

        "append_file" -> {
            val name = call.args.optString("name")
            val content = call.args.optString("content")
            val f = AiWorkspace.resolve(context, name)
            if (f == null) {
                ToolResult("append_file", "ОШИБКА: некорректный путь")
            } else {
                if (f.isFile) AiWorkspace.backup(context, f)
                f.parentFile?.mkdirs()
                f.appendText(if (f.isFile && f.length() > 0) "\n$content" else content)
                ToolResult("append_file", "Дописано в $name (теперь ${f.length()} байт)", f)
            }
        }

        "read_file" -> {
            val name = call.args.optString("name")
            val f = AiWorkspace.resolve(context, name)
            if (f?.isFile == true && f.extension.lowercase() in setOf("png", "jpg", "jpeg", "webp", "gif", "bmp")) {
                // Картинку модель не увидит: readText() по JPEG/PNG давал
                // бинарный мусор в контекст (скриншот: агент «читает» скриншот
                // и отвечает, что не может его интерпретировать). Честнее
                // сразу сказать, что нужно описание словами.
                ToolResult(
                    "read_file",
                    "«$name» — изображение (${f.length()} байт). Я не вижу картинки: " +
                        "попроси пользователя описать скриншот словами (текст ошибки, " +
                        "название экрана, что нажимали) или дать текстовый файл.",
                )
            } else if (f?.isFile == true) {
                val text = f.readText()
                // Хвост файла важнее начала: продолжение книги пишется с конца
                val slice = if (text.length > 3000) "…" + text.takeLast(3000) else text
                ToolResult("read_file", "Содержимое $name (${f.length()} байт):\n$slice")
            } else {
                ToolResult("read_file", "Файл не найден: $name")
            }
        }

        "zip_workspace" -> {
            val f = AiWorkspace.zipAll(context)
            if (f == null) {
                ToolResult(
                    "zip_workspace",
                    "ОШИБКА: не удалось собрать архив (нет места или хранилище недоступно)",
                    status = "error",
                )
            } else {
                ToolResult("zip_workspace", "Архив: ${AiWorkspace.relPath(context, f)} (${f.length() / 1024} КБ)", f)
            }
        }

        "provider_create", "provider_edit" -> {
            val id = call.args.optString("id")
            if (id.isBlank()) {
                ToolResult(call.name, "ОШИБКА: нужен id провайдера (например, ollama)", status = "error")
            } else {
                val existing = AiProviders.userProvider(context, id)
                if (call.name == "provider_edit" && existing == null) {
                    ToolResult(call.name, "Провайдер «$id» не найден — сначала provider_create", status = "error")
                } else {
                    // Правка меняет только переданные поля: иначе edit затирал бы
                    // ключ и модель, которые пользователь не трогал.
                    val spec = AiProviders.Spec(
                        id = id,
                        title = call.args.optString("title").ifBlank { existing?.title ?: id },
                        summary = call.args.optString("summary").ifBlank { existing?.summary.orEmpty() },
                        baseUrl = call.args.optString("baseUrl").ifBlank { existing?.baseUrl.orEmpty() },
                        model = call.args.optString("model").ifBlank { existing?.model.orEmpty() },
                        apiKey = if (call.args.has("apiKey")) call.args.optString("apiKey") else existing?.apiKey.orEmpty(),
                    )
                    val error = AiProviders.validate(spec)
                    when {
                        error != null -> ToolResult(call.name, "ОШИБКА: $error", status = "error")
                        AiProviders.save(context, spec) -> ToolResult(
                            call.name,
                            "Провайдер «${spec.title}» (${spec.model} @ ${spec.baseUrl}) сохранён. " +
                                "Выберите его в настройках озвучки/AI-чата.",
                        )
                        else -> ToolResult(call.name, "ОШИБКА: не удалось записать провайдер", status = "error")
                    }
                }
            }
        }

        "provider_delete" -> {
            val id = call.args.optString("id")
            when {
                id.isBlank() -> ToolResult(call.name, "ОШИБКА: нужен id провайдера", status = "error")
                AiProviders.delete(context, id) ->
                    ToolResult(call.name, "Провайдер «$id» отключён")
                else -> ToolResult(
                    call.name,
                    "ОШИБКА: провайдер «$id» не найден (встроенные zen/openrouter не удаляются)",
                    status = "error",
                )
            }
        }

        "provider_list" -> {
            val specs = AiProviders.all(context)
            val prefsR = uy.kohesive.injekt.Injekt.get<mihon.domain.ocr.service.OcrPreferences>()
            val selected = prefsR.aiProvider().get()
            ToolResult(
                "provider_list",
                buildString {
                    appendLine("Провайдеров: ${specs.size} (выбран: $selected)")
                    specs.forEach { spec ->
                        append("• ${spec.id} — ${spec.title}: ${spec.model} @ ${spec.baseUrl}")
                        if (spec.builtIn) append(" [встроенный]")
                        if (spec.apiKey.isNotBlank()) append(" [ключ задан]")
                        appendLine()
                    }
                }.trim(),
            )
        }

        "ui_action_create", "ui_action_edit" -> {
            val id = call.args.optString("id")
            if (id.isBlank()) {
                ToolResult(call.name, "ОШИБКА: нужен id кнопки", status = "error")
            } else {
                val existing = UiActionRegistry.list(context).firstOrNull { it.id == id }
                if (call.name == "ui_action_edit" && existing == null) {
                    ToolResult(call.name, "Кнопка «$id» не найдена — сначала ui_action_create", status = "error")
                } else {
                    val placement = mihon.data.ui.UiPlacement.fromId(
                        call.args.optString("placement").ifBlank { existing?.placement?.id.orEmpty() },
                    )
                    val effect = mihon.data.ui.UiEffect.fromId(
                        call.args.optString("effect").ifBlank { existing?.effect?.id.orEmpty() },
                    )
                    when {
                        placement == null -> ToolResult(
                            call.name,
                            "ОШИБКА: неизвестное placement. Можно: " +
                                mihon.data.ui.UiPlacement.entries.joinToString { it.id },
                            status = "error",
                        )
                        effect == null -> ToolResult(
                            call.name,
                            "ОШИБКА: неизвестный effect. Можно: " +
                                mihon.data.ui.UiEffect.entries.joinToString { it.id },
                            status = "error",
                        )
                        else -> {
                            val spec = mihon.data.ui.UiActionSpec(
                                id = id,
                                title = call.args.optString("title").ifBlank { existing?.title ?: id },
                                placement = placement,
                                effect = effect,
                                value = call.args.optString("value").ifBlank { existing?.value.orEmpty() },
                                order = if (call.args.has("order")) call.args.optInt("order") else existing?.order ?: 100,
                            )
                            val error = mihon.data.ui.UiActions.validate(spec)
                            when {
                                error != null -> ToolResult(call.name, "ОШИБКА: $error", status = "error")
                                UiActionRegistry.save(context, spec) -> ToolResult(
                                    call.name,
                                    "Кнопка «${spec.title}» добавлена (${placement.title}, " +
                                        "эффект ${effect.title} = ${spec.value}). Откройте меню читалки.",
                                )
                                else -> ToolResult(call.name, "ОШИБКА: не удалось записать кнопку", status = "error")
                            }
                        }
                    }
                }
            }
        }

        "ui_action_delete" -> {
            val id = call.args.optString("id")
            when {
                id.isBlank() -> ToolResult(call.name, "ОШИБКА: нужен id кнопки", status = "error")
                UiActionRegistry.delete(context, id) -> ToolResult(call.name, "Кнопка «$id» убрана")
                else -> ToolResult(
                    call.name,
                    "ОШИБКА: кнопка «$id» не найдена (встроенные не удаляются)",
                    status = "error",
                )
            }
        }

        "ui_action_list" -> {
            val actions = UiActionRegistry.all(context)
            ToolResult(
                "ui_action_list",
                buildString {
                    appendLine("Кнопок: ${actions.size}")
                    actions.forEach { a ->
                        append("• ${a.id} — ${a.title}: ${a.placement.id}/${a.effect.id}=${a.value}")
                        if (a.builtIn) append(" [встроенная]")
                        appendLine()
                    }
                    appendLine("Эффекты: " + mihon.data.ui.UiEffect.entries.joinToString { "${it.id} (${it.title})" })
                    append("Размещения: " + mihon.data.ui.UiPlacement.entries.joinToString { it.id })
                },
            )
        }

        "ui_tab_hide", "ui_tab_show" -> {
            val id = call.args.optString("id")
            val hide = call.name == "ui_tab_hide"
            val ok = when {
                id.isBlank() -> false
                hide -> UiTabRegistry.hide(context, id)
                else -> UiTabRegistry.show(context, id)
            }
            when {
                id.isBlank() -> ToolResult(
                    call.name,
                    "ОШИБКА: нужен id вкладки. Доступны: " + UiTabs.IDS.joinToString(),
                    status = "error",
                )
                ok -> ToolResult(
                    call.name,
                    "Вкладка «${UiTab.fromId(id)?.title ?: id}» " +
                        (if (hide) "скрыта" else "возвращена") +
                        ". Панель обновилась сразу; если пользователь был на этой вкладке, " +
                        "содержимое останется до перехода на другую.",
                )
                hide && UiTabs.validate(id) != null ->
                    ToolResult(call.name, "ОШИБКА: " + UiTabs.validate(id), status = "error")
                UiTab.fromId(id) == null -> ToolResult(
                    call.name,
                    "ОШИБКА: неизвестная вкладка «$id». Доступны: " + UiTabs.IDS.joinToString(),
                    status = "error",
                )
                // Id годный, валидация прошла — значит не записался файл.
                else -> ToolResult(
                    call.name,
                    "ОШИБКА: не удалось записать список вкладок (workspace недоступен?)",
                    status = "error",
                )
            }
        }

        "ui_tab_list" -> {
            val hidden = UiTabRegistry.hidden(context)
            ToolResult(
                "ui_tab_list",
                buildString {
                    appendLine("Вкладок: ${UiTab.entries.size}, скрыто: ${hidden.size}")
                    UiTab.entries.forEach { tab ->
                        append("• ${tab.id} — ${tab.title}")
                        if (tab.pinned) append(" [закреплена]")
                        if (tab.id in hidden) append(" [скрыта]")
                        appendLine()
                    }
                    append("Скрыть можно: " + UiTabs.IDS.filterNot { it in UiTabs.PROTECTED_IDS }.joinToString())
                },
            )
        }

        else -> {
            // Самодельный плагин? Исполняем его (http или prompt через текущий бэкенд)
            val plugin = AiPlugins.get(context, call.name)
            if (plugin != null) {
                ToolResult(call.name, AiPlugins.execute(context, plugin, call.args, chatFn))
            } else {
                ToolResult(call.name, "Неизвестный инструмент")
            }
        }
    }

    // ---- Реализации инструментов ----

    /** Pollinations: бесплатная генерация картинок без ключа. */
    suspend fun generateImage(context: Context, prompt: String): File? = withContext(Dispatchers.IO) {
        runCatching {
            val url = "https://image.pollinations.ai/prompt/" +
                URLEncoder.encode(prompt.take(400), "UTF-8").replace("+", "%20") +
                "?width=768&height=768&nologo=true"
            val conn = AiAssistant.openConnection(url)
            conn.connectTimeout = 20_000
            conn.readTimeout = 120_000
            conn.setRequestProperty("User-Agent", "Yomikai/1.0")
            if (conn.responseCode !in 200..299) {
                conn.disconnect()
                return@runCatching null
            }
            val bytes = conn.inputStream.use { it.readBytes() }
            conn.disconnect()
            if (bytes.size < 1000) return@runCatching null
            val f = AiWorkspace.newImageFile(context, prompt)
            f.writeBytes(bytes)
            f
        }.getOrElse {
            logcat(LogPriority.WARN, it) { "Pollinations failed" }
            null
        }
    }

    /** Реальная проверка сайта: HTTP-статус, редиректы, время ответа. */
    private fun checkSite(rawUrl: String): String {
        if (rawUrl.isBlank()) return "ОШИБКА: пустой URL"
        val url = if (rawUrl.startsWith("http")) rawUrl else "https://$rawUrl"
        return runCatching {
            val started = System.currentTimeMillis()
            val conn = AiAssistant.openConnection(url)
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.instanceFollowRedirects = false
            conn.requestMethod = "GET"
            conn.setRequestProperty(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
            )
            val code = conn.responseCode
            val took = System.currentTimeMillis() - started
            val location = conn.getHeaderField("Location")
            conn.disconnect()
            when {
                code in 200..299 -> "$url — РАБОТАЕТ (HTTP $code, ${took}мс)"
                code in 300..399 -> "$url — редирект на ${location ?: "?"} (HTTP $code)"
                code == 403 -> "$url — HTTP 403: вероятно, Cloudflare-защита; в браузере может открыться"
                else -> "$url — НЕ работает (HTTP $code)"
            }
        }.getOrElse { "$url — НЕ отвечает: ${it.message?.take(100)}" }
    }

    private fun listExtensions(): String {
        val sources = sourceManager.getAll().filterIsInstance<CatalogueSource>()
        if (sources.isEmpty()) return "Расширения не установлены"
        val disabled = sourcePrefs.disabledSources.get()
        return sources.take(60).joinToString("\n") { s ->
            val domain = (s as? HttpSource)?.baseUrl ?: "локальный"
            val state = if (s.id.toString() in disabled) "СКРЫТ" else "виден"
            "• ${s.name} [${s.lang}] — $domain — $state (id=${s.id})"
        }
    }

    /** Скрыть/показать источники по подстроке имени, языка или домена. */
    private fun filterExtensions(hide: String, show: String): String {
        val sources = sourceManager.getAll().filterIsInstance<CatalogueSource>()
        val pref = sourcePrefs.disabledSources
        val current = pref.get().toMutableSet()
        val log = StringBuilder()
        fun matches(s: CatalogueSource, q: String): Boolean {
            val d = (s as? HttpSource)?.baseUrl.orEmpty()
            return s.name.contains(q, true) || s.lang.contains(q, true) || d.contains(q, true)
        }
        if (hide.isNotBlank()) {
            val victims = sources.filter { matches(it, hide) }
            victims.forEach { current += it.id.toString() }
            log.append("Скрыто ${victims.size}: ${victims.joinToString { it.name }.take(200)}\n")
        }
        if (show.isNotBlank()) {
            val victims = sources.filter { matches(it, show) }
            victims.forEach { current -= it.id.toString() }
            log.append("Показано ${victims.size}: ${victims.joinToString { it.name }.take(200)}\n")
        }
        pref.set(current)
        return log.toString().ifBlank { "Ничего не найдено по запросу" }
    }

    /**
     * Реальный поиск тайтла по включённым источникам: до 8 источников,
     * каждому 12с. Возвращает, где тайтл реально находится.
     */
    private suspend fun findManga(title: String): String {
        if (title.isBlank()) return "ОШИБКА: пустое название"
        val disabled = sourcePrefs.disabledSources.get()
        val sources = sourceManager.getAll().filterIsInstance<CatalogueSource>()
            .filter { it.id.toString() !in disabled }
            .take(8)
        if (sources.isEmpty()) return "Нет включённых источников"
        val sb = StringBuilder()
        for (s in sources) {
            val found = withTimeoutOrNull(12_000) {
                runCatching {
                    s.getSearchManga(1, title, eu.kanade.tachiyomi.source.model.FilterList()).mangas
                }.getOrNull()
            }
            when {
                found == null -> sb.append("• ${s.name} [${s.lang}] — таймаут/ошибка\n")
                found.isEmpty() -> sb.append("• ${s.name} [${s.lang}] — не найдено\n")
                else -> {
                    val top = found.take(3).joinToString("; ") { it.title.take(60) }
                    sb.append("• ${s.name} [${s.lang}] — НАЙДЕНО ${found.size}: $top\n")
                }
            }
        }
        return sb.toString()
    }

    /** OCR картинки-вложения текущим движком распознавания (с фолбэками). */
    suspend fun ocrAttachment(file: File): String? = withContext(Dispatchers.IO) {
        runCatching {
            val opts = BitmapFactory.Options()
            var bmp: Bitmap = BitmapFactory.decodeFile(file.absolutePath, opts) ?: return@runCatching null
            if (bmp.width > 1600) {
                val h = bmp.height * 1600 / bmp.width
                val scaled = Bitmap.createScaledBitmap(bmp, 1600, h, true)
                bmp.recycle()
                bmp = scaled
            }
            val pixels = IntArray(bmp.width * bmp.height)
            bmp.getPixels(pixels, 0, bmp.width, 0, 0, bmp.width, bmp.height)
            val image = OcrImage(bmp.width, bmp.height, pixels)
            bmp.recycle()
            val repo = Injekt.get<OcrRepository>()
            repo.recognizeText(image).trim().ifBlank { null }
        }.getOrElse {
            logcat(LogPriority.WARN, it) { "AI attachment OCR failed" }
            null
        }
    }

    // JSONArray импортирован для будущих инструментов; подавляем предупреждение
    @Suppress("unused")
    private val unusedKeep = JSONArray()
}
