package tachiyomi.domain.library.model

/**
 * Алфавитный указатель локальной библиотеки.
 *
 * Локальная библиотека — это папки на диске, у неё нет серверного API с
 * фильтрами по букве, поэтому указатель реализован через служебный запрос:
 * строка, начинающаяся с [MARKER], разбирается как «название начинается на…»,
 * а не как поиск по подстроке.
 *
 * Маркер нужен, чтобы указатель не путался с обычным поиском: имя папки «#1»
 * легально, и запрос «#1» пользователь вводит именно как текст. Поэтому
 * [matches] разбирает маркер строго: после «#» должен идти один из ключей
 * [LETTERS], иначе запрос считается обычным поиском по подстроке.
 *
 * Все функции чистые и не знают про Android: их можно проверить юнит-тестами,
 * а вызывает их `LocalSource.getSearchManga` уже на IO-потоке.
 */
object LibraryIndex {

    /** Префикс служебного запроса указателя. */
    const val MARKER = "#"

    /** Ключ «цифры»: папки, начинающиеся с 0–9. */
    const val DIGITS = "0-9"

    /** Ключ «прочие»: папки, начинающиеся не с буквы и не с цифры. */
    const val OTHER = "*"

    /** Кириллица, включая «ё» — она стоит отдельно от «е» и в алфавите, и в указателе. */
    val CYRILLIC: List<String> = ('а'..'я').map(Char::toString) + "ё"

    /** Латиница: в локальных библиотеках полно папок с англоязычными названиями. */
    val LATIN: List<String> = ('a'..'z').map(Char::toString)

    /** Все ключи указателя в порядке показа. */
    val LETTERS: List<String> = CYRILLIC + LATIN + listOf(DIGITS, OTHER)

    /**
     * Запрос указателя для буквы или `null`, если ключ неизвестен.
     *
     * `null` означает «указатель выключен» — вызывающий код подставляет вместо
     * него обычную выдачу (популярное/новое), поэтому мусор из UI не может
     * превратиться в запрос к источнику.
     */
    fun queryFor(letter: String?): String? {
        val key = letter?.trim()?.lowercase().orEmpty()
        return if (key in LETTERS) MARKER + key else null
    }

    /** Является ли запрос служебным запросом указателя. */
    fun isIndexQuery(query: String): Boolean = indexKey(query) != null

    /**
     * Ключ указателя из запроса или `null`, если это обычный поиск.
     *
     * `#` без ключа и `#` с неизвестным ключом указателем не считаются: оба
     * уходят в поиск по подстроке, поэтому запрос «#1» находит папку с таким
     * именем, а не включает указатель.
     */
    fun indexKey(query: String): String? {
        val q = query.trim()
        if (!q.startsWith(MARKER)) return null
        val key = q.removePrefix(MARKER).trim().lowercase()
        return key.takeIf { it in LETTERS }
    }

    /**
     * Подходит ли название под запрос.
     *
     * Обычный запрос — поиск по подстроке (прежнее поведение локальной
     * библиотеки). Запрос указателя — сравнение первой значимой буквы названия
     * с ключом: [DIGITS] оставляет начинающиеся с цифры, [OTHER] — с символа,
     * который не буква и не цифра («[HorribleSubs] …», «-», «…»).
     */
    fun matches(name: String, query: String): Boolean {
        val key = indexKey(query)
        if (key == null) return name.contains(query.trim(), ignoreCase = true)
        val first = name.trim().firstOrNull()?.lowercaseChar() ?: return false
        return when (key) {
            DIGITS -> first.isDigit()
            OTHER -> !first.isLetterOrDigit()
            else -> first == key.first()
        }
    }
}
