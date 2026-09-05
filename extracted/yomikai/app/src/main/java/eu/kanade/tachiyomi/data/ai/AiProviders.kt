package eu.kanade.tachiyomi.data.ai

import android.content.Context
import logcat.LogPriority
import org.json.JSONObject
import tachiyomi.core.common.util.system.logcat
import java.io.File

/**
 * Реестр AI-провайдеров чата, которыми владеет пользователь.
 *
 * Приложение знало ровно два провайдера — зашитые [AiAssistant.PROVIDER_ZEN] и
 * [AiAssistant.PROVIDER_OPENROUTER]. Подключить свой было нельзя: ни локальную
 * LLM (Ollama, LM Studio, llama.cpp server), ни корпоративный прокси, ни любой
 * другой OpenAI-совместимый endpoint. Здесь провайдер появляется как данные, а
 * не как код.
 *
 * Объявления пользователя лежат JSON-файлами в `workspace/providers/`, поэтому:
 *  • они переживают перезапуск и уезжают вместе с архивом workspace;
 *  • их создаёт и правит сам пользователь — файлом или через встроенный AI-чат
 *    (инструменты `provider_create` / `provider_edit` / `provider_delete`);
 *  • исполняемого кода в них нет: приложение не загружает чужие классы и не
 *    падает из-за чужого APK.
 *
 * API-ключ хранится только на устройстве и уходит лишь самому провайдеру в
 * заголовке `Authorization`.
 *
 * Надёжность: ни один метод не бросает исключение наружу. Битый JSON
 * пропускается (остальные провайдеры работают), недоступное хранилище даёт
 * пустой список, а не краш.
 */
object AiProviders {

    /**
     * Объявление провайдера. OpenAI Chat Completions покрывает и сторонние
     * сервисы, и все популярные локальные серверы, поэтому отдельного поля
     * «протокол» нет: достаточно [baseUrl], [model] и [apiKey].
     */
    data class Spec(
        val id: String,
        val title: String,
        val summary: String = "",
        /** Базовый URL API, например `http://192.168.1.10:11434/v1`. */
        val baseUrl: String,
        val model: String,
        val apiKey: String = "",
        /** Встроенные провайдеры нельзя удалить или перезаписать. */
        val builtIn: Boolean = false,
    )

    /** Id встроенных провайдеров: пользовательский не может их занять. */
    val RESERVED_IDS: Set<String> = setOf(
        AiAssistant.PROVIDER_ZEN,
        AiAssistant.PROVIDER_OPENROUTER,
    )

    private fun dir(context: Context): File =
        File(AiWorkspace.root(context), "providers").apply { runCatching { mkdirs() } }

    private fun fileOf(context: Context, id: String): File = File(dir(context), sanitizeId(id) + ".json")

    /**
     * Нормализация id: только безопасные символы, без учёта регистра. Тот же
     * подход, что в [AiPlugins]: имя файла не должно уметь выйти из каталога.
     */
    fun sanitizeId(id: String): String =
        id.trim().lowercase().replace(Regex("[^a-z0-9_а-яё.-]"), "_").take(40)

    /**
     * Полный URL chat-запроса из базового. Принимает и «голый» базовый URL, и
     * уже готовый endpoint — `/chat/completions` не дублируется. `null`, если
     * URL пустой или не http(s): например, `file://` или `javascript:`.
     */
    fun chatCompletionsUrl(baseUrl: String): String? {
        val trimmed = baseUrl.trim().trimEnd('/')
        if (trimmed.isEmpty()) return null
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null
        return if (trimmed.endsWith("/chat/completions")) trimmed else "$trimmed/chat/completions"
    }

    /**
     * Проверка объявления до записи на диск. Возвращает причину для UI или
     * `null`, если провайдер корректен: невалидная запись не должна молча
     * появляться в реестре и «не работать» потом.
     */
    fun validate(spec: Spec): String? = when {
        spec.id.isBlank() -> "Пустой id"
        !spec.builtIn && sanitizeId(spec.id) in RESERVED_IDS ->
            "Имя «${spec.id}» занято встроенным провайдером"
        spec.baseUrl.isBlank() -> "Не указан базовый URL"
        chatCompletionsUrl(spec.baseUrl) == null -> "URL должен начинаться с http:// или https://"
        spec.model.isBlank() -> "Не указана модель"
        else -> null
    }

    /**
     * Встроенные провайдеры как объявления того же типа. URL берутся из
     * констант [AiAssistant], чтобы список не разъезжался с маршрутизацией.
     */
    fun builtIn(): List<Spec> = listOf(
        Spec(
            id = AiAssistant.PROVIDER_ZEN,
            title = "Zen (без ключа)",
            summary = "Ротация бесплатных моделей, ключ не нужен.",
            baseUrl = AiAssistant.ZEN_BASE_URL,
            model = AiAssistant.ZEN_MODELS.first(),
            builtIn = true,
        ),
        Spec(
            id = AiAssistant.PROVIDER_OPENROUTER,
            title = "OpenRouter",
            summary = "Бесплатные модели «:free» по вашему ключу OpenRouter.",
            baseUrl = AiAssistant.OPENROUTER_BASE_URL,
            model = AiAssistant.OPENROUTER_FREE_FALLBACK.first(),
            builtIn = true,
        ),
    )

    /** Провайдеры пользователя. Битые файлы пропускаются, остальные работают. */
    fun list(context: Context): List<Spec> = runCatching {
        dir(context).listFiles { f -> f.extension == "json" }
            ?.mapNotNull { f ->
                runCatching { fromJson(JSONObject(f.readText())) }
                    .onFailure { e -> logcat(LogPriority.WARN, e) { "Skipping broken provider ${f.name}" } }
                    .getOrNull()
            }
            ?.sortedBy { it.title }
            .orEmpty()
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "AiProviders.list failed" }
        emptyList()
    }

    /**
     * Провайдер пользователя по id, либо `null`. Встроенные сюда не входят:
     * у них свои маршруты в [AiAssistant.chatFull], и подменять их нельзя.
     */
    fun userProvider(context: Context, id: String?): Spec? {
        val key = id?.trim().orEmpty()
        if (key.isEmpty()) return null
        return runCatching { list(context).firstOrNull { it.id == key } }.getOrNull()
    }

    /** Все провайдеры для показа в настройках: встроенные + пользовательские. */
    fun all(context: Context): List<Spec> = builtIn() + list(context)

    /** Сохранить или обновить. `false` — объявление невалидно либо запись не удалась. */
    fun save(context: Context, spec: Spec): Boolean {
        val normalized = spec.copy(id = sanitizeId(spec.id))
        val error = validate(normalized)
        if (error != null) {
            logcat(LogPriority.WARN) { "AiProviders.save rejected '${normalized.id}': $error" }
            return false
        }
        return runCatching {
            fileOf(context, normalized.id).writeText(toJson(normalized).toString(2))
            true
        }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "AiProviders.save failed for '${normalized.id}'" }
            false
        }
    }

    /** Удалить провайдер пользователя. Встроенные не удаляются. */
    fun delete(context: Context, id: String): Boolean {
        val key = sanitizeId(id)
        if (key in RESERVED_IDS) return false
        return runCatching { fileOf(context, key).delete() }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "AiProviders.delete failed for '$key'" }
            false
        }
    }

    private fun toJson(spec: Spec) = JSONObject()
        .put("id", sanitizeId(spec.id))
        .put("title", spec.title.ifBlank { spec.id })
        .put("summary", spec.summary)
        .put("baseUrl", spec.baseUrl.trim())
        .put("model", spec.model.trim())
        .put("apiKey", spec.apiKey)

    private fun fromJson(j: JSONObject) = Spec(
        id = sanitizeId(j.getString("id")),
        title = j.optString("title").ifBlank { j.getString("id") },
        summary = j.optString("summary"),
        baseUrl = j.getString("baseUrl"),
        model = j.getString("model"),
        apiKey = j.optString("apiKey"),
    )
}
