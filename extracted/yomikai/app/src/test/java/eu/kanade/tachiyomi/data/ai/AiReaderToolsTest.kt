package eu.kanade.tachiyomi.data.ai

import eu.kanade.tachiyomi.data.tts.TtsSpeaker
import eu.kanade.tachiyomi.data.voice.VoiceBackend
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import mihon.data.ocr.OcrContentType
import org.junit.jupiter.api.Test

/**
 * Инструменты агента для читалки.
 *
 * Проверяется контракт, который видит модель: имена инструментов, их
 * документация в системном промпте и защита имён от самодельных плагинов.
 * Сами отчёты читают настройки, файлы моделей и состояние сети, поэтому
 * требуют Android и в юнит-тесты не входят.
 */
class AiReaderToolsTest {

    @Test
    fun `tool names are unique`() {
        AiReaderTools.TOOL_NAMES shouldContainExactly listOf(
            "reader_status",
            "ocr_preset",
            "plugins_list",
            "tts_status",
        )
        AiReaderTools.TOOL_NAMES.distinct().size shouldBe AiReaderTools.TOOL_NAMES.size
    }

    @Test
    fun `reader tools cannot be shadowed by a developer plugin`() {
        // AiPlugins.save() отвергает имя из этого набора, поэтому плагин
        // разработчика не может перехватить вызов инструмента читалки.
        AiReaderTools.TOOL_NAMES.forEach { (it in AiPlugins.RESERVED_TOOL_NAMES) shouldBe true }
    }

    @Test
    fun `every tool is documented in the system prompt exactly once`() {
        AiReaderTools.SYSTEM_PROMPT_LINES.size shouldBe AiReaderTools.TOOL_NAMES.size
        AiReaderTools.TOOL_NAMES.forEach { name ->
            AiReaderTools.SYSTEM_PROMPT_LINES.count { "@tool $name " in it } shouldBe 1
        }
    }

    @Test
    fun `preset ids offered to the model are the real OcrContentType ids`() {
        val documented = AiReaderTools.SYSTEM_PROMPT_LINES.first { "ocr_preset" in it }
        OcrContentType.entries.forEach { type ->
            // Модель должна видеть ровно те id, которые принимает инструмент.
            documented.contains(type.id) shouldBe true
        }
    }

    @Test
    fun `report sources still match the registries`() {
        // Отчёты строятся из реестров; если реестр изменится, эти проверки
        // укажут на рассинхрон между инструментами агента и настройками.
        // id бэкендов обязаны совпадать со значениями, на которых маршрутизируется
        // TtsSpeaker: иначе выбор движка в настройках молча не применялся бы.
        VoiceBackend.entries.map { it.id } shouldContainExactly
            listOf(
                TtsSpeaker.ENGINE_SYSTEM,
                TtsSpeaker.ENGINE_GOOGLE_WEB,
                TtsSpeaker.ENGINE_ELEVENLABS,
                TtsSpeaker.ENGINE_REMOTE,
            )
        AiBackends.ALL.map { it.id } shouldContainExactly listOf("online", "local", "runner")
    }
}
