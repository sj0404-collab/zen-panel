package eu.kanade.tachiyomi.data.ai

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test

/**
 * Чистая часть реестра провайдеров: нормализация id, построение endpoint и
 * валидация объявления. Чтение/запись JSON требуют Android и в юнит-тесты не
 * входят — по образцу остальных реестров (`OcrPlugins`, `VoicePlugins`).
 */
class AiProvidersTest {

    private val valid = AiProviders.Spec(
        id = "ollama",
        title = "Ollama дома",
        baseUrl = "http://192.168.1.10:11434/v1",
        model = "qwen2.5:7b",
    )

    @Test
    fun `built-in providers cannot be shadowed by a user provider`() {
        AiProviders.RESERVED_IDS shouldBe setOf(
            AiAssistant.PROVIDER_ZEN,
            AiAssistant.PROVIDER_OPENROUTER,
        )
        AiProviders.validate(valid.copy(id = "zen")) shouldContain "занято встроенным"
        AiProviders.validate(valid.copy(id = "OpenRouter")) shouldContain "занято встроенным"
        // Встроенное объявление с тем же id — это оно и есть, валидация пропускает.
        AiProviders.validate(valid.copy(id = "zen", builtIn = true)).shouldBeNull()
    }

    @Test
    fun `sanitizeId normalizes case and unsafe characters`() {
        AiProviders.sanitizeId("  My Provider ") shouldBe "my_provider"
        AiProviders.sanitizeId("../../etc") shouldBe ".._.._etc"
        AiProviders.sanitizeId("../../etc").contains("..") shouldBe true // путь режется в validate/resolve
        AiProviders.sanitizeId("провайдер-1") shouldBe "провайдер-1"
        AiProviders.sanitizeId("a".repeat(80)).length shouldBe 40
    }

    @Test
    fun `chat completions url accepts base urls and ready endpoints`() {
        AiProviders.chatCompletionsUrl("http://192.168.1.10:11434/v1") shouldBe
            "http://192.168.1.10:11434/v1/chat/completions"
        AiProviders.chatCompletionsUrl("https://api.example.com/v1/") shouldBe
            "https://api.example.com/v1/chat/completions"
        // Уже готовый endpoint не удваивается.
        AiProviders.chatCompletionsUrl("https://api.example.com/v1/chat/completions") shouldBe
            "https://api.example.com/v1/chat/completions"
    }

    @Test
    fun `chat completions url rejects non-http schemes and blanks`() {
        AiProviders.chatCompletionsUrl("").shouldBeNull()
        AiProviders.chatCompletionsUrl("   ").shouldBeNull()
        AiProviders.chatCompletionsUrl("file:///sdcard/secret").shouldBeNull()
        AiProviders.chatCompletionsUrl("javascript:alert(1)").shouldBeNull()
        AiProviders.chatCompletionsUrl("content://com.android.providers/x").shouldBeNull()
    }

    @Test
    fun `validate reports a reason for every broken declaration`() {
        AiProviders.validate(valid).shouldBeNull()
        AiProviders.validate(valid.copy(id = "")) shouldBe "Пустой id"
        AiProviders.validate(valid.copy(baseUrl = "")) shouldBe "Не указан базовый URL"
        AiProviders.validate(valid.copy(model = " ")) shouldContain "Не указана модель"
        AiProviders.validate(valid.copy(baseUrl = "ftp://host/v1")) shouldContain "http"
    }

    @Test
    fun `built-in specs point at the urls the router really uses`() {
        // Если список в настройках разойдётся с реальной маршрутизацией,
        // пользователь увидит провайдера, который работает не туда.
        val builtIn = AiProviders.builtIn().associateBy { it.id }
        builtIn[AiAssistant.PROVIDER_ZEN]!!.baseUrl shouldBe AiAssistant.ZEN_BASE_URL
        builtIn[AiAssistant.PROVIDER_OPENROUTER]!!.baseUrl shouldBe AiAssistant.OPENROUTER_BASE_URL
        builtIn.values.forEach { spec -> AiProviders.validate(spec).shouldBeNull() }
    }

    @Test
    fun `ui action tool names are reserved from developer plugins`() {
        // Иначе самодельный плагин с именем ui_action_create перехватил бы
        // вызов, и кнопка в читалке не появилась.
        listOf("ui_action_create", "ui_action_edit", "ui_action_delete", "ui_action_list")
            .forEach { name -> (name in AiPlugins.RESERVED_TOOL_NAMES) shouldBe true }
    }

    @Test
    fun `provider tool names are reserved from developer plugins`() {
        // Иначе самодельный плагин с именем provider_create перехватил бы вызов.
        listOf("provider_create", "provider_edit", "provider_delete", "provider_list")
            .forEach { name -> (name in AiPlugins.RESERVED_TOOL_NAMES) shouldBe true }
    }
}
