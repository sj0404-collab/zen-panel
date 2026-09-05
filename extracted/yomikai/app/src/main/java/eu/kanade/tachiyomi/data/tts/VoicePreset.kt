package eu.kanade.tachiyomi.data.tts

/**
 * Пресеты голосов по полу и возрасту (запрос пользователя: пресеты для
 * каждой интонации: м/ж/средний род и возраст от младенца до пожилого).
 *
 * Реализовано модификаторами pitch/rate поверх выбранного голоса: движки
 * TTS не предоставляют возрастных голосов, но высота и темп передают
 * возраст убедительно и работают на любом локальном движке.
 * Пол «авто» = прежняя логика (пол реплики/пресет пользователя).
 */
object VoicePreset {

    enum class Age(val id: String, val title: String, val pitch: Float, val rate: Float) {
        INFANT("infant", "Младенец", 1.85f, 0.92f),
        CHILD("child", "Ребёнок", 1.5f, 1.02f),
        TEEN("teen", "Подросток", 1.22f, 1.04f),
        ADULT("adult", "Взрослый", 1.0f, 1.0f),
        ELDERLY("elderly", "Пожилой", 0.82f, 0.86f),
        ;

        companion object {
            fun fromId(id: String?): Age = entries.firstOrNull { it.id == id } ?: ADULT
        }
    }

    enum class Gender3(val id: String, val title: String, val pitch: Float) {
        AUTO("auto", "Авто (по реплике)", 1.0f),
        MALE("male", "Мужской", 0.8f),
        FEMALE("female", "Женский", 1.16f),
        NEUTRAL("neutral", "Средний род", 1.0f),
        ;

        companion object {
            fun fromId(id: String?): Gender3 = entries.firstOrNull { it.id == id } ?: AUTO
        }
    }
}
