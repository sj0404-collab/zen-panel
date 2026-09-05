package eu.kanade.tachiyomi.data.ai

import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Реестр бэкендов AI-чата.
 *
 * Проверяется декларативная часть и чистая функция статуса: реальные запросы
 * к Zen/OpenRouter, скачивание .task-моделей и сессии ранера требуют Android
 * и сеть, поэтому в юнит-тесты не входят.
 */
class AiBackendsTest {

    private val readyState = AiBackendState(
        networkAvailable = true,
        hasOpenRouterKey = true,
        hasGithubPat = true,
        runnerAllowed = true,
        localModelId = "qwen25_05b",
        localModelInstalled = true,
        localModelSizeMb = 521,
        runnerSessionAlive = true,
    )

    @Test
    fun `registry ids match the values stored in pref_ai_backend`() {
        AiBackends.ALL.map { it.id } shouldContainExactly listOf("online", "local", "runner")
        AiBackends.ALL.map { it.id }.distinct().size shouldBe AiBackends.ALL.size

        AiBackends.byId("online") shouldBe AiBackends.ONLINE
        AiBackends.byId("local") shouldBe AiBackends.LOCAL
        AiBackends.byId("runner") shouldBe AiBackends.RUNNER
        // Пустое или неизвестное значение читается как «онлайн» — ровно так же,
        // как это делала маршрутизация вкладки AI до появления реестра.
        AiBackends.byId("") shouldBe AiBackends.ONLINE
        AiBackends.byId(null) shouldBe AiBackends.ONLINE
        AiBackends.byId("что-то-новое") shouldBe AiBackends.ONLINE
    }

    @Test
    fun `only the local backend works offline`() {
        AiBackends.ALL.filter { it.offline }.map { it.id } shouldContainExactly listOf("local")
        AiBackends.ONLINE.requirements shouldContainExactly listOf(AiRequirement.NETWORK)
        // Ключ OpenRouter — подсказка, а не блокирующее требование: без него
        // AiAssistant сам уходит на Zen.
        AiBackends.ONLINE.optionalRequirements shouldContainExactly listOf(AiRequirement.OPENROUTER_KEY)
        AiBackends.RUNNER.requirements shouldContainExactly listOf(
            AiRequirement.NETWORK,
            AiRequirement.GITHUB_PAT,
            AiRequirement.RUNNER_ALLOWED,
            AiRequirement.RUNNER_SESSION,
        )
        AiBackends.LOCAL.requirements shouldContainExactly listOf(AiRequirement.MODEL_DOWNLOAD)
    }

    @Test
    fun `every backend is available on a fully prepared device`() {
        AiBackends.ALL.forEach { plugin ->
            val status = AiBackends.statusOf(plugin, readyState)
            status.available shouldBe true
            status.missing shouldBe emptyList<AiRequirement>()
            status.detail.isNotBlank() shouldBe true
        }
    }

    @Test
    fun `online reports the missing network and the effective provider`() {
        AiBackends.statusOf(AiBackends.ONLINE, readyState.copy(networkAvailable = false))
            .missing shouldContainExactly listOf(AiRequirement.NETWORK)

        val zen = AiBackends.statusOf(AiBackends.ONLINE, readyState, provider = AiAssistant.PROVIDER_ZEN)
        zen.available shouldBe true
        zen.detail shouldBe "Провайдер: Zen (без ключа)"

        // OpenRouter без ключа не готов: chatFull уйдёт на Zen, но в настройках
        // это должно быть видно как проблема выбранного провайдера.
        val noKey = AiBackends.statusOf(
            AiBackends.ONLINE,
            readyState.copy(hasOpenRouterKey = false),
            provider = AiAssistant.PROVIDER_OPENROUTER,
        )
        noKey.available shouldBe false
        noKey.missing shouldContainExactly listOf(AiRequirement.OPENROUTER_KEY)

        // Ключ есть, но сети нет → только сеть: ключ никуда не делся.
        AiBackends.statusOf(
            AiBackends.ONLINE,
            readyState.copy(networkAvailable = false),
            provider = AiAssistant.PROVIDER_OPENROUTER,
        ).missing shouldContainExactly listOf(AiRequirement.NETWORK)

        // Нет ни сети, ни ключа → оба требования, сеть первой.
        val offline = AiBackends.statusOf(
            AiBackends.ONLINE,
            readyState.copy(networkAvailable = false, hasOpenRouterKey = false),
            provider = AiAssistant.PROVIDER_OPENROUTER,
        )
        offline.available shouldBe false
        offline.missing shouldContainExactly listOf(AiRequirement.NETWORK, AiRequirement.OPENROUTER_KEY)
    }

    @Test
    fun `local reports a missing or unselected model`() {
        AiBackends.statusOf(AiBackends.LOCAL, readyState.copy(localModelInstalled = false))
            .missing shouldContainExactly listOf(AiRequirement.MODEL_DOWNLOAD)
        AiBackends.statusOf(AiBackends.LOCAL, readyState.copy(localModelId = "")).detail shouldBe
            "Модель не выбрана"
        AiBackends.statusOf(AiBackends.LOCAL, readyState).detail shouldBe "qwen25_05b • 521 МБ • установлена"
    }

    @Test
    fun `runner lists every unmet requirement in declaration order`() {
        val bare = AiBackends.statusOf(
            AiBackends.RUNNER,
            readyState.copy(
                networkAvailable = false,
                hasGithubPat = false,
                runnerAllowed = false,
                runnerSessionAlive = false,
            ),
        )
        bare.available shouldBe false
        bare.missing shouldContainExactly listOf(
            AiRequirement.NETWORK,
            AiRequirement.GITHUB_PAT,
            AiRequirement.RUNNER_ALLOWED,
            AiRequirement.RUNNER_SESSION,
        )
        bare.detail shouldBe "Разрешение ранера выключено"

        AiBackends.statusOf(AiBackends.RUNNER, readyState.copy(runnerAllowed = false)).detail shouldBe
            "Разрешение ранера выключено"
        AiBackends.statusOf(AiBackends.RUNNER, readyState.copy(runnerSessionAlive = false)).detail shouldBe
            "Нет живой сессии ранера"
        AiBackends.statusOf(AiBackends.RUNNER, readyState).detail shouldBe "Сессия ранера активна"
    }

    @Test
    fun `unknown backend routes to online and never fails`() {
        // Онлайн-бэкенд готов всегда: сеть и ключи проверяет сам AiAssistant,
        // а при сбое возвращает null, который чат превращает в понятный ответ.
        listOf(null, "", "online", "local-ne-sushchestvuet").forEach { key ->
            val route = AiBackends.route(key, readyState)
            route.backendId shouldBe AiBackends.ONLINE.id
            route.ready shouldBe true
            route.message shouldBe null
        }
    }

    @Test
    fun `unready backends explain themselves instead of returning a dead chat function`() {
        val local = AiBackends.route("local", readyState.copy(localModelInstalled = false))
        local.ready shouldBe false
        local.message shouldBe
            "Локальная модель не готова: скачайте её в ⚙ → Локальные LLM и прогоните «Тест»"

        val noModel = AiBackends.route("local", readyState.copy(localModelId = ""))
        noModel.ready shouldBe false
        noModel.message shouldBe local.message

        val runner = AiBackends.route("runner", readyState.copy(runnerSessionAlive = false))
        runner.ready shouldBe false
        runner.message shouldBe "Нет живой ранер-сессии: запустите её в ⚙ → Полу-онлайн LLM"

        // Готовый бэкенд сообщений не выдаёт.
        AiBackends.route("local", readyState).message shouldBe null
        AiBackends.route("runner", readyState).message shouldBe null
    }
}
