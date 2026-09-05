package mihon.data.ocr

/**
 * Лёгкая офлайн-морфология: пол говорящего по окончаниям словоформ.
 *
 * Нужна для интонаций локальных голосов: когда словарные маркеры
 * («сестра», «господин») в реплике отсутствуют, AutoReadEngine выбирает
 * голос по перевесу родовых окончаний. Никакой подмены текста: только
 * классификация. Лемматизация и части речи — отдельный воркстрим.
 */
object RuMorph {

    /** Слова женского рода с «мужскими» признаками и наоборот. */
    private val MASC_EXCEPTIONS = setOf(
        "папа", "дядя", "мужчина", "юноша", "староста", "судья",
        "старшина", "воевода", "юнга", "молодца", "сирота", "коллега",
    )

    private val FEM_EXCEPTIONS = setOf(
        "моль", "соль", "боль", "роль", "фасоль", "метель", "постель",
        "неделя", "свадьба", "смерть", "дверь", "тень", "осень", "лошадь",
    )

    private val CONSONANTS = "бвгджзклмнпрстфхцчшщ"

    /**
     * «female» / «male» / null: перевес родовых окончаний >= 2 слов,
     * иначе нейтрально (лучше никакой пол, чем ошибочный).
     */
    fun guessGender(text: String): String? {
        var fem = 0
        var masc = 0
        for (m in Regex("[а-яёА-ЯЁ]{4,}").findAll(text)) {
            val w = m.value.lowercase()
            when {
                w in MASC_EXCEPTIONS -> masc++
                w in FEM_EXCEPTIONS -> fem++
                w.endsWith("ость") || w.endsWith("ия") || w.endsWith("ия") -> fem++
                w.endsWith("а") || w.endsWith("я") -> fem++
                w.endsWith("й") || w.endsWith("ец") || w.last() in CONSONANTS -> masc++
            }
        }
        return when {
            fem - masc >= 2 -> "female"
            masc - fem >= 2 -> "male"
            else -> null
        }
    }

    /** Часть речи грубо по окончанию: для будущей лемматизации/отладки. */
    fun guessPos(word: String): String {
        val w = word.lowercase()
        return when {
            w.endsWith("ть") || w.endsWith("л") || w.endsWith("ла") ||
                w.endsWith("ли") || w.endsWith("ю") || w.endsWith("ет") ||
                w.endsWith("ут") || w.endsWith("ат") || w.endsWith("ят") -> "verb"
            w.endsWith("ый") || w.endsWith("ий") || w.endsWith("ой") ||
                w.endsWith("ая") || w.endsWith("яя") || w.endsWith("ое") ||
                w.endsWith("ее") -> "adj"
            else -> "noun"
        }
    }
}
