package mihon.data.ocr

/**
 * Частотный словарь русских словоформ для разбиения слипшегося OCR-текста
 * на слова (только вставка пробелов, без замены символов — словарная
 * «коррекция» запрещена правилами проекта).
 *
 * Собран из открытых текстов (русские классические рассказы/пьесы,
 * wikisource) плюс диалоговые сиды под речь манги. Частотный порог >=2
 * вхождений в корпусе; ручные сиды добавлены безусловно.
 */
object RuWordList {

    private val parts: Array<Array<String>> = arrayOf(
        ruWordListPart000(),
        ruWordListPart001(),
        ruWordListPart002(),
    )

    /** Словоформы ВЕРХНИМ регистром: прогоны OCR приходят капсом. */
    val upper: Set<String> by lazy {
        val set = HashSet<String>(parts.sumOf { it.size } * 2)
        for (part in parts) for (w in part) set.add(w.uppercase())
        set
    }

    val lower: Set<String> by lazy {
        val set = HashSet<String>(parts.sumOf { it.size } * 2)
        for (part in parts) for (w in part) set.add(w)
        set
    }
}
