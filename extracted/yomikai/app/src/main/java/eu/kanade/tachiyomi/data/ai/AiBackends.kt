package eu.kanade.tachiyomi.data.ai

import android.content.Context
import eu.kanade.tachiyomi.data.ai.AiAssistant.ChatReply
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.core.common.util.system.isNetworkAvailable
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Что нужно бэкенду AI-чата для работы. Те же категории, что у OCR- и
 * голосовых плагинов (`OcrPluginAvailability`, `VoiceRequirement`), чтобы
 * три реестра говорили с пользователем на одном языке.
 */
enum class AiRequirement {
    /** Нужен интернет (онлайн-провайдеры). */
    NETWORK,

    /** Нужен ключ OpenRouter. Без него Zen всё равно ответит, поэтому это не блокирующее требование. */
    OPENROUTER_KEY,

    /** Нужен GitHub PAT для запуска сессии на ранере. */
    GITHUB_PAT,

    /** Нужно разрешение «полу-онлайн LLM» в настройках вкладки AI. */
    RUNNER_ALLOWED,

    /** Нужна скачанная локальная модель из `LocalLlm.CATALOG`. */
    MODEL_DOWNLOAD,

    /** Нужна живая сессия ранера. */
    RUNNER_SESSION,
}

/** Снимок состояния устройства — всё, что нужно для честного статуса бэкенда. */
data class AiBackendState(
    val networkAvailable: Boolean,
    val hasOpenRouterKey: Boolean,
    val hasGithubPat: Boolean,
    val runnerAllowed: Boolean,
    val localModelId: String,
    val localModelInstalled: Boolean,
    val localModelSizeMb: Int,
    val runnerSessionAlive: Boolean,
)

/** Итог проверки: готов ли бэкенд и что именно ему мешает. */
data class AiBackendStatus(
    val available: Boolean,
    val missing: List<AiRequirement>,
    /** Что сейчас выбрано внутри бэкенда: провайдер, модель, сессия. */
    val detail: String,
)

/**
 * РЕЕСТР БЭКЕНДОВ AI-ЧАТА — «плагины» AI, по образцу `OcrPlugins` и
 * `VoicePlugins`.
 *
 * Ключи совпадают со значениями настройки `pref_ai_backend`, поэтому реестр
 * не вводит собственного состояния: что выбрано во вкладке AI, то и здесь.
 *
 * Второй задачей реестр убирает дублирование маршрутизации: раньше проверка
 * «готова ли локальная модель / есть ли живая сессия ранера» была зашита
 * прямо в `AiChatTab.send()`. Теперь это `resolve()`, и ровно ту же проверку
 * может показать экран настроек, не копируя логику.
 */
object AiBackends {

    /** Значения `pref_ai_backend`. */
    const val BACKEND_ONLINE = "online"
    const val BACKEND_LOCAL = "local"
    const val BACKEND_RUNNER = "runner"

    /**
     * Подпись функции чата, которую ждёт `AiAgent.run(chatFn = …)`.
     *
     * Это именно `typealias`, а не `fun interface`: `AiAgent.run` принимает
     * обычную suspend-функцию, и SAM-преобразование suspend-типов здесь ни к
     * чему — с алиасом типы совпадают буквально.
     */
    typealias ChatFn = suspend (prompt: String, system: String) -> ChatReply?

    /**
     * Результат маршрутизации: либо готовая функция чата, либо `message` —
     * готовый текст объяснения для пользователя (почему бэкенд не ответил).
     */
    data class Resolution(
        val backendId: String,
        val chat: ChatFn?,
        val message: String? = null,
    ) {
        val ready: Boolean get() = chat != null
    }

    data class Plugin(
        /** Значение настройки `pref_ai_backend`. */
        val id: String,
        val title: String,
        val summary: String,
        /** Работает без интернета. */
        val offline: Boolean,
        /** Требования, без которых бэкенд не ответит. */
        val requirements: List<AiRequirement>,
        /** Требования-подсказки: их отсутствие не блокирует работу. */
        val optionalRequirements: List<AiRequirement> = emptyList(),
    )

    val ONLINE = Plugin(
        id = BACKEND_ONLINE,
        title = "Онлайн (Zen / OpenRouter)",
        summary = "Бесплатные модели Zen без ключа; при указанном ключе OpenRouter — его модель " +
            "и автосмена на Zen при лимите. Инструменты агента исполняет приложение.",
        offline = false,
        requirements = listOf(AiRequirement.NETWORK),
        optionalRequirements = listOf(AiRequirement.OPENROUTER_KEY),
    )

    val LOCAL = Plugin(
        id = BACKEND_LOCAL,
        title = "Локальная LLM",
        summary = "Модель на устройстве (LiteRT/.task из LocalLlm.CATALOG). Полностью офлайн, " +
            "инструменты агента доступны так же, как и онлайн.",
        offline = true,
        requirements = listOf(AiRequirement.MODEL_DOWNLOAD),
    )

    val RUNNER = Plugin(
        id = BACKEND_RUNNER,
        title = "Полу-онлайн (GitHub Runner)",
        summary = "Модель запускается на GitHub-ранере через llm-runner.yml и отвечает по HTTP. " +
            "Нужны PAT и живая сессия.",
        offline = false,
        requirements = listOf(
            AiRequirement.NETWORK,
            AiRequirement.GITHUB_PAT,
            AiRequirement.RUNNER_ALLOWED,
            AiRequirement.RUNNER_SESSION,
        ),
    )

    val ALL = listOf(ONLINE, LOCAL, RUNNER)

    fun byId(id: String?): Plugin = ALL.firstOrNull { it.id == id } ?: ONLINE

    /**
     * Статус бэкенда по снимку состояния. Чистая функция — её можно
     * проверять тестами без Android.
     *
     * @param provider значение `pref_ai_provider` (zen | openrouter) — нужно,
     *   чтобы показать фактический онлайн-провайдер в `detail`.
     */
    fun statusOf(
        plugin: Plugin,
        state: AiBackendState,
        provider: String = AiAssistant.PROVIDER_ZEN,
    ): AiBackendStatus {
        val missing = mutableListOf<AiRequirement>()
        val detail: String
        when (plugin.id) {
            BACKEND_ONLINE -> {
                if (!state.networkAvailable) missing += AiRequirement.NETWORK
                val openRouter = provider == AiAssistant.PROVIDER_OPENROUTER
                if (openRouter && !state.hasOpenRouterKey) missing += AiRequirement.OPENROUTER_KEY
                detail = if (openRouter && state.hasOpenRouterKey) {
                    "Провайдер: OpenRouter, автосмена на Zen при лимите"
                } else {
                    "Провайдер: Zen (без ключа)"
                }
            }

            BACKEND_LOCAL -> {
                if (!state.localModelInstalled) missing += AiRequirement.MODEL_DOWNLOAD
                detail = when {
                    state.localModelId.isBlank() -> "Модель не выбрана"
                    state.localModelSizeMb > 0 ->
                        "${state.localModelId} • ${state.localModelSizeMb} МБ" +
                            if (state.localModelInstalled) " • установлена" else " • не скачана"
                    else -> state.localModelId
                }
            }

            else -> {
                if (!state.networkAvailable) missing += AiRequirement.NETWORK
                if (!state.hasGithubPat) missing += AiRequirement.GITHUB_PAT
                if (!state.runnerAllowed) missing += AiRequirement.RUNNER_ALLOWED
                if (!state.runnerSessionAlive) missing += AiRequirement.RUNNER_SESSION
                detail = when {
                    !state.runnerAllowed -> "Разрешение ранера выключено"
                    state.runnerSessionAlive -> "Сессия ранера активна"
                    else -> "Нет живой сессии ранера"
                }
            }
        }
        return AiBackendStatus(
            available = missing.isEmpty(),
            missing = missing.toList(),
            detail = detail,
        )
    }

    /** Читает состояние устройства: настройки + файлы моделей + сессии ранера. */
    fun state(context: Context, prefs: OcrPreferences = Injekt.get()): AiBackendState {
        val modelId = prefs.localLlmModel().get()
        val model = LocalLlm.CATALOG.firstOrNull { it.id == modelId }
        val session = runCatching { RunnerLlm.listSessions(context).firstOrNull() }.getOrNull()
        return AiBackendState(
            // Сеть нужна только для статуса: сам resolve() её не требует,
            // потому что онлайн-провайдеры и так отвечают null при сбое.
            networkAvailable = isNetworkAvailable(context),
            hasOpenRouterKey = prefs.openrouterApiKey().get().isNotBlank(),
            hasGithubPat = prefs.githubPat().get().isNotBlank(),
            runnerAllowed = prefs.aiAllowRunner().get(),
            localModelId = modelId,
            localModelInstalled = model != null && runCatching {
                LocalLlm.isInstalled(context, model)
            }.getOrDefault(false),
            localModelSizeMb = model?.sizeMb ?: 0,
            runnerSessionAlive = session?.url != null,
        )
    }

    /**
     * Готов ли бэкенд отвечать и что сказать пользователю, если нет.
     *
     * Чистая функция (без `Context`), поэтому маршрутизация проверяется
     * юнит-тестами, а `resolve()` ниже лишь навешивает на неё реальную
     * функцию чата.
     */
    fun route(backendId: String?, state: AiBackendState): Route {
        val plugin = byId(backendId)
        return when (plugin.id) {
            BACKEND_LOCAL ->
                if (state.localModelId.isNotBlank() && state.localModelInstalled) {
                    Route(plugin.id, ready = true)
                } else {
                    Route(
                        plugin.id,
                        ready = false,
                        message = "Локальная модель не готова: скачайте её в ⚙ → Локальные LLM и прогоните «Тест»",
                    )
                }

            BACKEND_RUNNER ->
                if (state.runnerSessionAlive) {
                    Route(plugin.id, ready = true)
                } else {
                    Route(
                        plugin.id,
                        ready = false,
                        message = "Нет живой ранер-сессии: запустите её в ⚙ → Полу-онлайн LLM",
                    )
                }

            // Онлайн-бэкенд готов всегда: сеть и ключи проверяет сам
            // AiAssistant, а при сбое возвращает null — чат показывает это
            // пользователю вместо падения.
            else -> Route(plugin.id, ready = true)
        }
    }

    /** Вердикт `route()`: какой бэкенд выбран, готов ли он, что сказать. */
    data class Route(val backendId: String, val ready: Boolean, val message: String? = null)

    /**
     * Выбор бэкенда для запроса. Поведение совпадает с прежней маршрутизацией
     * вкладки AI: неизвестное или пустое значение читается как «онлайн»,
     * локальная модель и ранер проверяются на готовность, а при неготовности
     * возвращается текст объяснения вместо тихого падения.
     */
    fun resolve(
        context: Context,
        backendId: String?,
        state: AiBackendState = state(context),
        maxTokens: Int = DEFAULT_MAX_TOKENS,
    ): Resolution {
        val plugin = byId(backendId)
        val route = route(plugin.id, state)
        if (!route.ready) {
            return Resolution(plugin.id, chat = null, message = route.message)
        }
        return when (plugin.id) {
            BACKEND_LOCAL -> {
                val model = LocalLlm.CATALOG.firstOrNull { it.id == state.localModelId }
                if (model != null && state.localModelInstalled) {
                    Resolution(
                        backendId = plugin.id,
                        chat = { prompt, system ->
                            LocalLlm.chat(context, model, "$system\n\n$prompt")
                                ?.let { ChatReply(it, null, model.name) }
                        },
                    )
                } else {
                    Resolution(plugin.id, chat = null, message = route.message)
                }
            }

            BACKEND_RUNNER -> {
                val session = runCatching { RunnerLlm.listSessions(context).firstOrNull() }.getOrNull()
                if (session?.url != null) {
                    Resolution(
                        backendId = plugin.id,
                        chat = { prompt, system ->
                            RunnerLlm.chat(context, session, "$system\n\n$prompt")
                                ?.let { ChatReply(it, null, session.model) }
                        },
                    )
                } else {
                    Resolution(plugin.id, chat = null, message = route.message)
                }
            }

            else -> Resolution(
                backendId = plugin.id,
                chat = { prompt, system -> AiAssistant.chatFull(prompt, system, maxTokens) },
            )
        }
    }

    /** Столько токенов просил чат вкладки AI до появления реестра. */
    const val DEFAULT_MAX_TOKENS = 1800
}
