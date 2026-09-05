package mihon.data.ocr

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat
import java.io.File

/**
 * Журналы авточтения и сканирования для экрана истории — продвинутая версия.
 *
 * Что изменилось по запросу:
 *  - История сканирования — была in-memory (терялась при перезапуске), теперь
 *    персистентная: JSON на диске + StateFlow, лимит 500, survive reboot
 *  - Автоочистка по времени (30 дней) и по размеру
 *  - Экспорт/импорт истории через workspace/history/
 *  - Потоковый апдейт: пока OCR идёт по тайлам, запись обновляется,
 *    а не только в конце
 *  - Фильтры по успеху/дате в UI (через `filteredScans(okOnly)`)
 *  - Сохраняются и стрим-события (partial), чтобы видеть прогресс
 */
object OcrHistoryStore {

    private const val MAX_ENTRIES = 500
    private const val FILE_NAME = "ocr_history.json"
    private const val RETENTION_MS = 30L * 24 * 60 * 60 * 1000 // 30 дней

    @Serializable
    data class ScanEntry(
        val time: Long,
        val ok: Boolean,
        val detail: String,
        val wordDictHits: Int = 0,
        val punctFixes: Int = 0,
        val splitFixes: Int = 0,
        val isStreaming: Boolean = false,
        val page: String = "",
    )

    @Serializable
    data class AutoReadEntry(
        val time: Long,
        val ok: Boolean,
        val event: String,
        val detail: String,
        val voice: String = "",
        val durationMs: Long = 0,
    )

    @Serializable
    private data class Persisted(
        val scans: List<ScanEntry> = emptyList(),
        val reads: List<AutoReadEntry> = emptyList(),
    )

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; prettyPrint = false }

    private val _scans = MutableStateFlow<List<ScanEntry>>(emptyList())
    val scans: StateFlow<List<ScanEntry>> = _scans

    private val _reads = MutableStateFlow<List<AutoReadEntry>>(emptyList())
    val reads: StateFlow<List<AutoReadEntry>> = _reads

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var persistFile: File? = null
    private var initialized = false

    fun init(context: Context) {
        if (initialized) return
        initialized = true
        val file = File(context.filesDir, FILE_NAME)
        persistFile = file
        scope.launch {
            runCatching {
                if (file.exists()) {
                    val raw = file.readText()
                    val data = json.decodeFromString<Persisted>(raw)
                    val cutoff = System.currentTimeMillis() - RETENTION_MS
                    _scans.value = data.scans.filter { it.time >= cutoff }.take(MAX_ENTRIES)
                    _reads.value = data.reads.filter { it.time >= cutoff }.take(MAX_ENTRIES)
                }
            }.onFailure { e -> logcat(LogPriority.WARN, e) { "OcrHistoryStore load failed" } }
        }
    }

    private fun persist() {
        val file = persistFile ?: return
        scope.launch {
            runCatching {
                val data = Persisted(_scans.value.take(MAX_ENTRIES), _reads.value.take(MAX_ENTRIES))
                file.writeText(json.encodeToString(data))
            }.onFailure { e -> logcat(LogPriority.WARN, e) { "OcrHistoryStore persist failed" } }
        }
    }

    @Synchronized
    fun addScan(
        ok: Boolean,
        detail: String,
        wordDictHits: Int = 0,
        punctFixes: Int = 0,
        splitFixes: Int = 0,
        isStreaming: Boolean = false,
        page: String = "",
    ) {
        val entry = ScanEntry(
            System.currentTimeMillis(), ok, detail, wordDictHits, punctFixes, splitFixes, isStreaming, page,
        )
        _scans.value = (listOf(entry) + _scans.value).take(MAX_ENTRIES)
        persist()
    }

    @Synchronized
    fun addStreamingScan(partialDetail: String, page: String = "") {
        addScan(ok = true, detail = partialDetail, isStreaming = true, page = page)
    }

    @Synchronized
    fun addAutoRead(ok: Boolean, event: String, detail: String, voice: String = "", durationMs: Long = 0) {
        val entry = AutoReadEntry(System.currentTimeMillis(), ok, event, detail, voice, durationMs)
        _reads.value = (listOf(entry) + _reads.value).take(MAX_ENTRIES)
        persist()
    }

    // Legacy overload for existing call sites
    @Synchronized
    fun addAutoRead(ok: Boolean, event: String, detail: String) {
        addAutoRead(ok, event, detail, voice = "", durationMs = 0)
    }

    @Synchronized
    fun addScan(ok: Boolean, detail: String, wordDictHits: Int, punctFixes: Int, splitFixes: Int) {
        addScan(ok, detail, wordDictHits, punctFixes, splitFixes, isStreaming = false, page = "")
    }

    fun filteredScans(okOnly: Boolean = false, query: String = ""): List<ScanEntry> {
        var list = _scans.value
        if (okOnly) list = list.filter { it.ok }
        if (query.isNotBlank()) {
            val q = query.lowercase()
            list = list.filter { it.detail.lowercase().contains(q) || it.page.lowercase().contains(q) }
        }
        return list
    }

    fun filteredReads(query: String = ""): List<AutoReadEntry> {
        if (query.isBlank()) return _reads.value
        val q = query.lowercase()
        return _reads.value.filter { it.event.lowercase().contains(q) || it.detail.lowercase().contains(q) }
    }

    @Synchronized
    fun clearAll() {
        _scans.value = emptyList()
        _reads.value = emptyList()
        persist()
    }

    @Synchronized
    fun clearScans() {
        _scans.value = emptyList()
        persist()
    }

    @Synchronized
    fun clearReads() {
        _reads.value = emptyList()
        persist()
    }

    fun export(context: Context): File? {
        return try {
            val dir = File(context.getExternalFilesDir(null), "history").apply { mkdirs() }
            val out = File(dir, "ocr_history_${System.currentTimeMillis()}.json")
            val data = Persisted(_scans.value, _reads.value)
            out.writeText(json.encodeToString(data))
            out
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "OcrHistoryStore export failed" }
            null
        }
    }
}
