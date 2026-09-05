package eu.kanade.tachiyomi.data.tts

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class SpeechMarkupTest {

    @Test
    fun `strip removes tags so tts never reads them`() {
        SpeechMarkup.strip("{1}{ж} Навигация по маршруту завершена.") shouldBe
            "Навигация по маршруту завершена."
    }

    @Test
    fun `divider becomes a short pause not a spoken symbol`() {
        SpeechMarkup.strip("Это-о ÷ о-очень ÷ опасно же!") shouldBe
            "Это-о, о-очень, опасно же!"
    }

    @Test
    fun `gender is read from markup`() {
        SpeechMarkup.genderOf("{2}{м} Кажется, я зря волновался...") shouldBe "male"
        SpeechMarkup.genderOf("{1}{ж} Что за негодяйка!") shouldBe "female"
        SpeechMarkup.genderOf("{1} Без пола") shouldBe null
    }

    @Test
    fun `two characters of the same gender get different slots`() {
        SpeechMarkup.speakerSlot("{ж} Первая") shouldBe 0
        SpeechMarkup.speakerSlot("{ж2} Вторая") shouldBe 1
        SpeechMarkup.speakerSlot("{ж3} Третья") shouldBe 2
    }

    @Test
    fun `speaker name is parsed and not spoken`() {
        val line = "{1}{ж}{имя:Аки} Мы на месте..."
        SpeechMarkup.speakerName(line) shouldBe "Аки"
        SpeechMarkup.strip(line) shouldBe "Мы на месте..."
    }

    @Test
    fun `pause tag is detected and stripped`() {
        val line = "{пауза} Я способен убить человека без поднятия шума."
        SpeechMarkup.hasPause(line) shouldBe true
        SpeechMarkup.strip(line) shouldBe "Я способен убить человека без поднятия шума."
    }

    @Test
    fun `plain text is untouched`() {
        val plain = "У меня бока болят от смеха~"
        SpeechMarkup.strip(plain) shouldBe plain
        SpeechMarkup.genderOf(plain) shouldBe null
        SpeechMarkup.speakerSlot(plain) shouldBe 0
    }

    @Test
    fun `tags are collected for on-screen display`() {
        SpeechMarkup.tagsOf("{3}{м2} Мне даже вмешиваться не придётся.") shouldBe "{3}{м2}"
    }

    @Test
    fun `numbering is idempotent`() {
        val once = SpeechMarkup.withIndex("Что?..", 1)
        once shouldBe "{1} Что?.."
        SpeechMarkup.withIndex(once, 1) shouldBe once
    }

    @Test
    fun `stripping leaves no double spaces or stray punctuation`() {
        SpeechMarkup.strip("{1}{ж}  Я думала,  ÷ мы в кино идём...") shouldBe
            "Я думала, мы в кино идём..."
    }
}
