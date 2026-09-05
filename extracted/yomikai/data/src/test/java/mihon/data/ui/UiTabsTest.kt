package mihon.data.ui

import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test

/**
 * Реестр видимости вкладок нижней навигации.
 *
 * Проверяется декларативная часть: валидация id с конкретной причиной, защита
 * закреплённых вкладок и нормализация списка из файла пользователя. Само
 * хранилище требует Android и в юнит-тесты не входит.
 */
class UiTabsTest {

    @Test
    fun `every tab has a unique lowercase id and a title`() {
        UiTabs.IDS shouldBe UiTab.entries.map { it.id }
        UiTabs.IDS.toSet().size shouldBe UiTab.entries.size
        UiTab.entries.forEach { tab ->
            tab.id shouldBe tab.id.trim().lowercase()
            tab.title.isNotBlank() shouldBe true
        }
    }

    @Test
    fun `library and more are pinned and cannot be hidden`() {
        UiTabs.PROTECTED_IDS shouldContainExactly setOf(UiTab.LIBRARY.id, UiTab.MORE.id)
        UiTabs.validate("library") shouldContain "нельзя скрыть"
        UiTabs.validate("more") shouldContain "нельзя скрыть"
    }

    @Test
    fun `a hideable tab passes validation`() {
        UiTabs.validate("browser").shouldBeNull()
        UiTabs.validate(" Browser ") shouldBe null
    }

    @Test
    fun `an unknown id is rejected with the list of known ones`() {
        val reason = UiTabs.validate("dota")
        reason shouldContain "Неизвестная вкладка"
        reason shouldContain UiTab.BROWSER.id
    }

    @Test
    fun `a blank id is rejected`() {
        UiTabs.validate("   ") shouldContain "Пустой"
    }

    @Test
    fun `hidden tabs disappear and the rest keep their order`() {
        val visible = UiTabs.visibleTabs(UiTabs.IDS, setOf("browser", "updates"))
        visible shouldContainExactly listOf(
            "library", "local_library", "history", "browse", "ai", "more",
        )
    }

    @Test
    fun `a pinned tab stays visible even if the file asks to hide it`() {
        // Файл правится руками или сторонним плагином, поэтому защита
        // применяется и на чтении, а не только на записи.
        UiTabs.visibleTabs(UiTabs.IDS, setOf("library", "more", "browser")) shouldContainExactly
            listOf("library", "local_library", "updates", "history", "browse", "ai", "more")
        UiTabs.isHidden("library", setOf("library")) shouldBe false
        UiTabs.isHidden("browser", setOf("browser")) shouldBe true
    }

    @Test
    fun `sanitize keeps only known hideable ids, normalized`() {
        UiTabs.sanitizeHidden(listOf(" Browser ", "dota", "library", "", "ai")) shouldContainExactly
            setOf("browser", "ai")
    }

    @Test
    fun `fromId tolerates case and spaces and rejects garbage`() {
        UiTab.fromId(" LOCAL_Library ") shouldBe UiTab.LOCAL_LIBRARY
        UiTab.fromId("нет").shouldBeNull()
        UiTab.fromId(null).shouldBeNull()
    }
}
