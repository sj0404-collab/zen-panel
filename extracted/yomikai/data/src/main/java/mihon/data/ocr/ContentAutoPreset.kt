package mihon.data.ocr

import mihon.domain.ocr.service.OcrPreferences

/**
 * Авто-пресет типа контента без ручного «применить» (запрос пользователя).
 *
 * Правила:
 *  - срабатывает ОДИН раз на главу, на первом скане;
 *  - только пока пользователь не выбрал пресет явно (contentType == balanced);
 *  - порядок чтения из читалки ([ReaderContextBus]): вебтун/непрерывно →
 *    MANHWA, пейджинг справа налево → MANGA, пейджинг слева направо →
 *    COMIC; вертикальный пейджинг и отсутствие контекста — геометрия
 *    страницы (height/width >= 1.8 → MANHWA);
 *  - память по манге: применённый (авто или вручную) пресет запоминается
 *    для mangaId и восстанавливается при входе в читалку без переклассификации;
 *  - область сканирования не трогает вообще: её выделяет пользователь;
 *  - выключатель «Авто-пресет типа контента» (on/off).
 */
object ContentAutoPreset {

    private const val WEBTOON_RATIO = 1.8f
    private const val MAX_MAP_ENTRIES = 60

    private val appliedChapters = mutableSetOf<Long>()

    /** Вход в читалку: восстанавливаем запомненный пресет этой манги. */
    @Synchronized
    fun onReaderContext(ctx: ReaderContextBus.Ctx, prefs: OcrPreferences) {
        val mangaId = ctx.mangaId ?: return
        val remembered = readMap(prefs)[mangaId] ?: return
        if (OcrContentType.entries.any { it.id == remembered } &&
            prefs.contentType().get() != remembered
        ) {
            prefs.contentType().set(remembered)
        }
    }

    /** Явный выбор пользователя (настройки/агент) запоминаем для этой манги. */
    @Synchronized
    fun rememberManual(mangaId: Long?, presetId: String, prefs: OcrPreferences) {
        if (mangaId == null) return
        if (OcrContentType.entries.none { it.id == presetId }) return
        val map = readMap(prefs).toMutableMap()
        map[mangaId] = presetId
        val tail = map.entries.toList().takeLast(MAX_MAP_ENTRIES)
        prefs.mangaPresetMap().set(tail.joinToString(",") { "${it.key}:${it.value}" })
    }

    @Synchronized
    fun maybeApply(chapterId: Long, pageWidth: Int, pageHeight: Int, prefs: OcrPreferences) {
        if (prefs.autoPreset().get() != "on") return
        if (chapterId in appliedChapters) return
        appliedChapters.add(chapterId)
        // Явный выбор пользователя священен: авто-пресет его не перебивает.
        if (prefs.contentType().get() != "balanced") return
        val ctx = ReaderContextBus.current.value
        val decided: OcrContentType? = when {
            ctx?.webtoon == true -> OcrContentType.MANHWA
            ctx?.rtl == true -> OcrContentType.MANGA
            ctx != null && !ctx.vertical -> OcrContentType.COMIC
            pageWidth > 0 && pageHeight.toFloat() / pageWidth >= WEBTOON_RATIO -> OcrContentType.MANHWA
            else -> null
        }
        if (decided != null) {
            prefs.contentType().set(decided.id)
            rememberManual(ctx?.mangaId, decided.id, prefs)
        }
    }

    private fun readMap(prefs: OcrPreferences): Map<Long, String> {
        val raw = prefs.mangaPresetMap().get()
        if (raw.isBlank()) return emptyMap()
        val out = HashMap<Long, String>()
        for (pair in raw.split(',')) {
            val idx = pair.indexOf(':')
            if (idx <= 0) continue
            val id = pair.substring(0, idx).toLongOrNull() ?: continue
            out[id] = pair.substring(idx + 1)
        }
        return out
    }

    /** Для тестов: сброс отметок применения. */
    @Synchronized
    fun resetForTests() = appliedChapters.clear()
}
