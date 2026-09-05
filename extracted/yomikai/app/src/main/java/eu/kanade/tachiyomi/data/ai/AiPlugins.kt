package eu.kanade.tachiyomi.data.ai

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import logcat.LogPriority
import org.json.JSONObject
import tachiyomi.core.common.util.system.logcat
import java.io.File
import java.net.URLEncoder

/**
 * ПЛАГИНЫ РАЗРАБОТЧИКА: самодельные инструменты агента. Агент (или
 * пользователь через агента) создаёт их прямо в чате командами
 * plugin_create / plugin_edit / plugin_delete — количество не ограничено.
 * Хранятся как JSON-файлы в workspace/plugins/ (виден во вкладке «Плагины»),
 * переживают перезапуск, экспортируются вместе с workspace.
 *
 * Виды плагинов (оба РЕАЛЬНО исполняются приложением):
 *
 * • kind="http" — шаблон HTTP-запроса. В url/body подставляются аргументы
 *   вызова: {query}, {id} и т.д. ({query} URL-кодируется в url).
 *   Пример: погода, курсы валют, любой публичный API.
 *
 * • kind="prompt" — промпт-макрос: сохранённая инструкция, которая
 *   оборачивает вход и прогоняется через ТЕКУЩИЙ AI-бэкенд.
 *   Пример: «переводи в стиле пиратов», «суммаризируй в 3 пунктах».
 *
 * Плагин вызывается по имени как обычный инструмент: @tool имя {json}.
 */
object AiPlugins {

    data class Plugin(
        val name: String,
        val kind: String, // http | prompt
        val description: String,
        /** http: url-шаблон; prompt: текст инструкции с {input}. */
        val template: String,
        val method: String = "GET",
        val body: String = "",
        val headers: Map<String, String> = emptyMap(),
    )

    private fun dir(context: Context): File =
        File(AiWorkspace.root(context), "plugins").apply { mkdirs() }

    private fun fileOf(context: Context, name: String): File =
        File(dir(context), sanitize(name) + ".json")

    private fun sanitize(name: String) =
        name.lowercase().replace(Regex("[^a-z0-9_а-яё-]"), "_").take(40)

    fun list(context: Context): List<Plugin> =
        dir(context).listFiles { f -> f.extension == "json" }
            ?.mapNotNull { runCatching { fromJson(JSONObject(it.readText())) }.getOrNull() }
            ?.sortedBy { it.name }
            .orEmpty()

    fun get(context: Context, name: String): Plugin? =
        fileOf(context, name).takeIf { it.isFile }
            ?.let { runCatching { fromJson(JSONObject(it.readText())) }.getOrNull() }

    fun save(context: Context, p: Plugin): Boolean {
        if (p.name.isBlank() || p.kind !in setOf("http", "prompt")) return false
        // Имя не должно перекрывать встроенные инструменты
        // Сюда же входят инструменты читалки (reader_status / ocr_preset /
        // plugins_list): плагин разработчика не может их перехватить.
        if (sanitize(p.name) in RESERVED_TOOL_NAMES) return false
        return runCatching {
            fileOf(context, p.name).writeText(toJson(p).toString(2))
            true
        }.getOrDefault(false)
    }

    fun delete(context: Context, name: String): Boolean = fileOf(context, name).delete()

    /**
     * Имена встроенных инструментов: плагин разработчика не может их занять,
     * иначе @tool-вызов ушёл бы не туда. Сюда же входят инструменты читалки
     * из [AiReaderTools] — они исполняются приложением наравне с остальными.
     */
    val RESERVED_TOOL_NAMES = setOf(
        "write_file", "edit_file", "append_file", "read_file", "gen_image",
        "check_site", "list_ext", "filter_ext", "find_manga", "zip_workspace",
        "plugin_create", "plugin_edit", "plugin_delete", "plugin_list",
        // Ранер и GitHub отсутствовали в списке, хотя такие инструменты у
        // агента есть: плагин разработчика с именем runner_chat перехватывал
        // бы вызов. Теперь закрыто.
        "runner_chat", "runner_start", "github_api",
        // Инструменты реестра провайдеров (AiProviders): плагин разработчика не
        // может занять их имена и перехватить подключение стороннего AI.
        "provider_create", "provider_edit", "provider_delete", "provider_list",
        // Инструменты реестра действий пользовательского UI (UiActions):
        // плагин разработчика не может занять их имена.
        "ui_action_create", "ui_action_edit", "ui_action_delete", "ui_action_list",
        // Инструменты реестра видимости вкладок (UiTabs): тоже закрыты, иначе
        // плагин с именем ui_tab_hide перехватил бы управление навигацией.
        "ui_tab_hide", "ui_tab_show", "ui_tab_list",
    ) + AiReaderTools.TOOL_NAMES

    private fun toJson(p: Plugin) = JSONObject()
        .put("name", sanitize(p.name))
        .put("kind", p.kind)
        .put("description", p.description)
        .put("template", p.template)
        .put("method", p.method)
        .put("body", p.body)
        .put("headers", JSONObject(p.headers))

    private fun fromJson(j: JSONObject) = Plugin(
        name = j.getString("name"),
        kind = j.getString("kind"),
        description = j.optString("description"),
        template = j.getString("template"),
        method = j.optString("method").ifBlank { "GET" },
        body = j.optString("body"),
        headers = j.optJSONObject("headers")?.let { h ->
            h.keys().asSequence().associateWith { h.optString(it) }
        } ?: emptyMap(),
    )

    /** Подстановка аргументов вызова в шаблон: {ключ} -> значение. */
    private fun substitute(template: String, args: JSONObject, urlEncode: Boolean): String {
        var out = template
        args.keys().forEach { k ->
            val v = args.optString(k)
            out = out.replace("{$k}", if (urlEncode) URLEncoder.encode(v, "UTF-8") else v)
        }
        return out
    }

    /**
     * Исполнение плагина. [chatFn] — текущий AI-бэкенд для kind=prompt.
     * Возвращает текст результата (обрезанный до разумного размера).
     */
    suspend fun execute(
        context: Context,
        plugin: Plugin,
        args: JSONObject,
        chatFn: suspend (String, String) -> AiAssistant.ChatReply?,
    ): String = withContext(Dispatchers.IO) {
        when (plugin.kind) {
            "http" -> runCatching {
                val url = substitute(plugin.template, args, urlEncode = true)
                val conn = AiAssistant.openConnection(url)
                conn.requestMethod = plugin.method.uppercase().ifBlank { "GET" }
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.setRequestProperty("User-Agent", "Yomikai-Plugin/1.0")
                plugin.headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
                if (plugin.method.uppercase() in setOf("POST", "PUT") && plugin.body.isNotBlank()) {
                    conn.doOutput = true
                    conn.outputStream.use {
                        it.write(substitute(plugin.body, args, urlEncode = false).toByteArray())
                    }
                }
                val code = conn.responseCode
                val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                conn.disconnect()
                "HTTP $code:\n" + text.take(1500)
            }.getOrElse { "ОШИБКА плагина ${plugin.name}: ${it.message?.take(120)}" }

            "prompt" -> {
                val input = args.optString("input").ifBlank { args.toString() }
                val prompt = substitute(plugin.template, args, urlEncode = false)
                    .let { if (it.contains("{input}")) it.replace("{input}", input) else "$it\n\n$input" }
                chatFn(prompt, "Ты — плагин «${plugin.name}»: ${plugin.description}. Выполни инструкцию точно.")
                    ?.content ?: "ОШИБКА: бэкенд не ответил"
            }

            else -> "ОШИБКА: неизвестный вид плагина ${plugin.kind}"
        }.also {
            logcat(LogPriority.INFO) { "Plugin ${plugin.name} executed" }
        }
    }
}
