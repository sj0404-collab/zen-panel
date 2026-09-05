package mihon.data.ocr

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Живые стадии сканирования/распознавания для индикации в читалке.
 *
 * Пользователь жаловался, что между тапом «OCR» и появлением текста нет
 * никакой индикации. Шина даёт UI честную стадию (и заметку: сколько боксов,
 * сколько символов, сколько срабатываний словарей), а позже послужит
 * источником истории сканирования.
 */
object OcrStageBus {

    enum class Stage { IDLE, DETECTING, RECOGNIZING, DONE, FAILED }

    data class Event(
        val stage: Stage,
        val note: String = "",
        val wordDictHits: Int = 0,
        val punctFixes: Int = 0,
        val splitFixes: Int = 0,
    )

    private val _event = MutableStateFlow(Event(Stage.IDLE))
    val event: StateFlow<Event> = _event

    fun post(stage: Stage, note: String = "") {
        val event = Event(
            stage = stage,
            note = note,
            wordDictHits = OcrTextCleanerStats.wordDictHits,
            punctFixes = OcrTextCleanerStats.punctFixes,
            splitFixes = OcrTextCleanerStats.splitFixes,
        )
        _event.value = event
        // Финал прохода сразу уходит в журнал сканирования (экран истории).
        if (stage == Stage.DONE || stage == Stage.FAILED) {
            OcrHistoryStore.addScan(
                ok = stage == Stage.DONE,
                detail = note,
                wordDictHits = event.wordDictHits,
                punctFixes = event.punctFixes,
                splitFixes = event.splitFixes,
            )
        }
    }
}
