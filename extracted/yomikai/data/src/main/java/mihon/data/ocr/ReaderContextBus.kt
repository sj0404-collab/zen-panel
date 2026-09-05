package mihon.data.ocr

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Мост читалка → data-слой без прямой зависимости: ReaderActivity сообщает,
 * какую мангу и в каком порядке чтения сейчас смотрят, а ContentAutoPreset
 * использует это для авто-пресета (манга/манхва/комикс) и памяти пресетов
 * по манге.
 */
object ReaderContextBus {

    data class Ctx(
        val mangaId: Long?,
        val rtl: Boolean,
        val webtoon: Boolean,
        val vertical: Boolean,
    )

    private val _current = MutableStateFlow<Ctx?>(null)
    val current: StateFlow<Ctx?> = _current

    fun set(mangaId: Long?, rtl: Boolean, webtoon: Boolean, vertical: Boolean) {
        val ctx = Ctx(mangaId, rtl, webtoon, vertical)
        _current.value = ctx
        runCatching { ContentAutoPreset.onReaderContext(ctx, Injekt.get()) }
    }
}
