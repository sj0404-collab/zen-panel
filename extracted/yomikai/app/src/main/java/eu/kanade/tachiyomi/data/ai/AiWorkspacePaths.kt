package eu.kanade.tachiyomi.data.ai

/**
 * Чистые вспомогательные функции workspace — без `Context`, без файловой
 * системы, без Android. Вынесены из [AiWorkspace] именно потому, что их можно
 * проверить обычными unit-тестами на JVM: это защита от выхода за пределы
 * workspace и от `ZipException("duplicate entry")`.
 */
object AiWorkspacePaths {

    private val FORBIDDEN = Regex("[\\\\:*?\"<>|]")

    /**
     * Приводит пользовательское имя к безопасному для файловой системы виду.
     * `..` вырезается, чтобы имя не могло вывести запись за пределы workspace:
     * проверка `canonicalPath` в [AiWorkspace.resolve] остаётся основным
     * барьером, но второй слой здесь ничего не стоит.
     */
    fun sanitize(name: String): String =
        name.replace(FORBIDDEN, "_").replace("..", "_").trim()

    /**
     * Уникальное имя zip-записи.
     *
     * `ZipOutputStream.putNextEntry` бросает `ZipException("duplicate entry")`,
     * если имя уже встречалось, и весь архив не собирается. Имена могут
     * совпасть, когда файлы из разных папок дают одинаковый относительный путь
     * (например, `relPath()` не смог вычислить префикс и вернул только имя).
     * Дубликат получает числовой суффикс перед расширением: `a.txt` → `a_1.txt`.
     *
     * Метод добавляет результат в [used] и возвращает его.
     */
    fun uniqueEntryName(candidate: String, used: MutableSet<String>): String {
        val base = candidate.ifBlank { "file" }
        if (used.add(base)) return base
        val dot = base.lastIndexOf('.')
        val stem = if (dot > 0) base.substring(0, dot) else base
        val ext = if (dot > 0) base.substring(dot) else ""
        var index = 1
        while (true) {
            val next = "${stem}_$index$ext"
            if (used.add(next)) return next
            index++
        }
    }
}
