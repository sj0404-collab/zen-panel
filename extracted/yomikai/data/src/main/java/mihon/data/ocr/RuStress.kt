package mihon.data.ocr

/**
 * Ударения для локальных голосов (запрос пользователя: морфология/ударения
 * для интонаций локальных голосов).
 *
 * RHVoice понимает разметку «+» ПОСЛЕ ударного гласного («за+мок»), поэтому
 * разметку получает только он (TtsSpeaker проверяет движок); Google и прочие
 * движки видят исходный текст без символов.
 *
 * Правила:
 *  1) словарь омографов и слов с неочевидным ударением: word -> номер
 *     ударного гласного по порядку (0-based);
 *  2) буква «ё» почти всегда несёт ударение — ставим на неё, если слова нет
 *     в словаре;
 *  3) односложные слова не размечаются: ударение единственно;
 *  4) всё остальное оставляет движку: его словарь частых слов корректен.
 *
 * Никакой подмены букв/слов: только вставка маркера ударения.
 */
object RuStress {

    private val STRESS_MAP: Map<String, Int> = mapOf(
        "замок" to 0,
        "замка" to 1,
        "замки" to 1,
        "замке" to 1,
        "атлас" to 0,
        "атласа" to 2,
        "атласы" to 0,
        "пары" to 1,
        "мука" to 1,
        "трусы" to 1,
        "косы" to 1,
        "стрелки" to 2,
        "видна" to 2,
        "ноги" to 1,
        "руки" to 1,
        "голова" to 3,
        "головы" to 3,
        "стороны" to 2,
        "сторона" to 3,
        "письма" to 1,
        "окна" to 1,
        "ведро" to 2,
        "сирота" to 3,
        "вдова" to 2,
        "скала" to 2,
        "скалы" to 1,
        "волна" to 2,
        "волны" to 1,
        "спина" to 2,
        "спины" to 1,
        "стена" to 2,
        "стены" to 1,
        "трава" to 2,
        "травы" to 1,
        "борода" to 3,
        "бороды" to 1,
        "губа" to 2,
        "губы" to 1,
        "зуба" to 2,
        "зубы" to 1,
        "язык" to 1,
        "языки" to 2,
        "гроза" to 2,
        "грозы" to 1,
        "роса" to 1,
        "росы" to 1,
        "слеза" to 2,
        "свекла" to 1,
        "торты" to 1,
        "банты" to 1,
        "каталог" to 2,
        "договор" to 2,
        "договоры" to 2,
        "средства" to 2,
        "намерение" to 1,
        "обеспечение" to 2,
        "звонит" to 1,
        "звонить" to 1,
        "позвонит" to 2,
        "включит" to 1,
        "включишь" to 1,
        "щавель" to 1,
        "кухонный" to 0,
        "мизерный" to 0,
        "премия" to 0,
        "ходатайство" to 2,
        "кладбище" to 0,
        "купон" to 0,
        "шофер" to 1,
        "намеренно" to 0,
        "дала" to 1,
        "дали" to 0,
        "начала" to 1,
        "начали" to 0,
        "поняла" to 2,
        "поняли" to 0,
        "взяла" to 1,
        "взяли" to 0,
        "была" to 1,
        "были" to 0,
        "ждала" to 1,
        "ждали" to 0,
        "звала" to 1,
        "звали" to 0,
        "рвала" to 1,
        "рвали" to 0,
        "слышала" to 0,
        "видела" to 0,
        "верит" to 0,
        "ветер" to 0,
        "вечер" to 0,
        "сетка" to 0,
        "ирис" to 0,
        "ирисы" to 0,
        "пила" to 1,
        "пилы" to 1,
        "полки" to 1,
        "полка" to 0,
        "орган" to 1,
        "органы" to 0,
        "парит" to 1,
        "пахнет" to 0,
        "клубы" to 1,
        "клуба" to 1,
    )

    private val VOWELS = "аеёиоуыэюя"

    fun mark(text: String): String {
        if (text.isEmpty()) return text
        val sb = StringBuilder(text.length + 8)
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c.isLetter()) {
                var j = i
                while (j < text.length && text[j].isLetter()) j++
                sb.append(markWord(text.substring(i, j)))
                i = j
            } else {
                sb.append(c)
                i++
            }
        }
        return sb.toString()
    }

    private fun markWord(word: String): String {
        val lower = word.lowercase()
        val vowelIdx = ArrayList<Int>(4)
        for (k in lower.indices) if (lower[k] in VOWELS) vowelIdx.add(k)
        if (vowelIdx.size <= 1) return word
        val ordinal = STRESS_MAP[lower]
            ?: if ('ё' in lower) vowelIdx.indexOfFirst { lower[it] == 'ё' } else -1
        if (ordinal < 0 || ordinal >= vowelIdx.size) return word
        val pos = vowelIdx[ordinal]
        return word.substring(0, pos + 1) + "+" + word.substring(pos + 1)
    }
}
