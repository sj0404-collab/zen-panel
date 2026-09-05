package eu.kanade.tachiyomi.data.tts

/**
 * Разметка реплик для озвучки.
 *
 * На экране у каждой реплики есть служебные пометки — номер по порядку
 * чтения, кто говорит, пауза. Их должно быть ВИДНО, но TTS не должен их
 * произносить. Поэтому текст для показа и текст для синтеза расходятся:
 * [strip] снимает разметку перед отправкой в движок.
 *
 * Поддерживаемые пометки:
 *
 * | Запись        | Значение                                   | Читается |
 * |---------------|--------------------------------------------|----------|
 * | `{1}`         | номер реплики в порядке чтения             | нет      |
 * | `{ж}` `{м}`   | пол говорящего (женский / мужской)         | нет      |
 * | `{ж2}`        | вторая женщина в сцене (свой голос)        | нет      |
 * | `{имя:Аки}`   | имя говорящего                             | нет      |
 * | `{пауза}`     | дополнительная пауза перед репликой        | нет      |
 * | `{...}`       | любая другая служебная пометка             | нет      |
 * | `÷`           | разделитель частей реплики (короткая пауза)| нет      |
 *
 * Всё, что не в фигурных скобках, читается как обычно.
 */
object SpeechMarkup {

    // ВАЖНО: закрывающая } обязана быть экранирована. На JVM/ART без экрана
    // работает, но ICU-движок регулярок (Itel, Infinix и др. Android 13+)
    // бросает PatternSyntaxException прямо в <clinit>, из-за чего ЛЮБОЕ
    // обращение к TTS роняло приложение (ExceptionInInitializerError).
    private val TAG = Regex("""\{[^{}]{0,40}\}""")
    private val DIVIDER = '÷'

    /** Пол, объявленный разметкой: "female" | "male" | null. */
    fun genderOf(text: String): String? {
        val m = TAG.findAll(text).map { it.value.trim('{', '}').lowercase() }
        m.forEach {
            when {
                it.startsWith("ж") || it.startsWith("f") -> return "female"
                it.startsWith("м") || it.startsWith("m") -> return "male"
            }
        }
        return null
    }

    /**
     * Номер говорящего в сцене: `{ж2}` -> 1 (второй женский слот),
     * `{ж}`/`{м}` -> 0. Нужен, чтобы два персонажа одного пола звучали
     * разными голосами.
     */
    fun speakerSlot(text: String): Int {
        TAG.findAll(text).forEach { match ->
            val body = match.value.trim('{', '}').lowercase()
            if (body.startsWith("ж") || body.startsWith("м") ||
                body.startsWith("f") || body.startsWith("m")
            ) {
                val digits = body.dropWhile { !it.isDigit() }.takeWhile { it.isDigit() }
                if (digits.isNotEmpty()) return (digits.toIntOrNull() ?: 1).minus(1).coerceAtLeast(0)
                return 0
            }
        }
        return 0
    }

    /** Есть ли запрос на дополнительную паузу перед репликой. */
    fun hasPause(text: String): Boolean =
        TAG.findAll(text).any { it.value.trim('{', '}').lowercase().startsWith("пауза") }

    /** Имя говорящего из `{имя:Аки}`, если задано. */
    fun speakerName(text: String): String? {
        TAG.findAll(text).forEach { match ->
            val body = match.value.trim('{', '}')
            val lower = body.lowercase()
            if (lower.startsWith("имя:") || lower.startsWith("name:")) {
                return body.substringAfter(':').trim().ifBlank { null }
            }
        }
        return null
    }

    /**
     * Текст для синтеза: разметка убрана, `÷` заменён на запятую (короткая
     * пауза), лишние пробелы схлопнуты.
     */
    fun strip(text: String): String {
        var out = TAG.replace(text, " ")
        out = out.replace(DIVIDER, ',')
        out = out.replace(Regex("""\s+"""), " ")
        out = out.replace(Regex("""\s+([,.!?;:])"""), "$1")
        out = out.replace(Regex(""",{2,}"""), ",")
        return out.trim().trim(',').trim()
    }

    /** Добавляет номер реплики в начало, если его там ещё нет. */
    fun withIndex(text: String, index: Int): String =
        if (TAG.containsMatchIn(text) && text.trimStart().startsWith("{$index}")) {
            text
        } else {
            "{$index} $text"
        }

    /** Собирает пометки для показа: `{3}{ж2}` перед текстом. */
    fun tagsOf(text: String): String =
        TAG.findAll(text).joinToString("") { it.value }
}
