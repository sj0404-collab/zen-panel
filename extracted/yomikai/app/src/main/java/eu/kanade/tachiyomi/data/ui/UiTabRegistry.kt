package eu.kanade.tachiyomi.data.ui

import android.content.Context
import eu.kanade.tachiyomi.data.ai.AiWorkspace
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import logcat.LogPriority
import mihon.data.ui.UiTab
import mihon.data.ui.UiTabs
import org.json.JSONArray
import org.json.JSONObject
import tachiyomi.core.common.util.system.logcat
import java.io.File

/**
 * Хранение скрытых вкладок нижней навигации.
 *
 * Один JSON-файл `workspace/ui/tabs.json` со списком id: переживает перезапуск,
 * уезжает с архивом workspace, создаётся файлом или через AI-чат
 * (`ui_tab_hide` / `ui_tab_show`). Исполняемого кода в нём нет — только id из
 * замкнутого списка [UiTab], поэтому плагин не может уронить приложение.
 *
 * Контракт надёжности тот же, что у [UiActionRegistry] и `AiProviders`: ни один
 * метод не бросает исключение наружу, битый JSON даёт пустой список, а запись
 * возвращает результат булевым значением.
 *
 * [version] растёт после каждой успешной записи, чтобы открытый `HomeScreen`
 * перечитал список сразу, без перезапуска приложения.
 */
object UiTabRegistry {

    private val versionState = MutableStateFlow(0)

    /** Счётчик записей: `HomeScreen` подписан на него и перечитывает файл. */
    val version: StateFlow<Int> = versionState.asStateFlow()

    private fun file(context: Context): File =
        File(File(AiWorkspace.root(context), "ui").apply { runCatching { mkdirs() } }, "tabs.json")

    /** Скрытые вкладки, нормализованные [UiTabs.sanitizeHidden]. */
    fun hidden(context: Context): Set<String> = UiTabs.sanitizeHidden(readHidden(context))

    private fun readHidden(context: Context): Set<String> = runCatching {
        val f = file(context)
        if (!f.isFile) return@runCatching emptySet()
        val array = JSONObject(f.readText()).optJSONArray("hidden") ?: JSONArray()
        buildSet {
            for (i in 0 until array.length()) {
                array.optString(i)?.trim()?.takeIf { it.isNotEmpty() }?.let { add(it) }
            }
        }
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "UiTabRegistry.hidden failed" }
        emptySet()
    }

    /** Скрыть вкладку. `false` — неизвестный id, закреплённая вкладка или сбой записи. */
    fun hide(context: Context, id: String): Boolean {
        val tab = UiTab.fromId(id)
        val error = UiTabs.validate(id)
        if (tab == null || error != null) {
            logcat(LogPriority.WARN) { "UiTabRegistry.hide rejected '$id': ${error ?: "unknown id"}" }
            return false
        }
        return write(context, hidden(context) + tab.id)
    }

    /** Вернуть вкладку. `false` — неизвестный id или сбой записи. */
    fun show(context: Context, id: String): Boolean {
        val tab = UiTab.fromId(id)
        if (tab == null) {
            logcat(LogPriority.WARN) { "UiTabRegistry.show rejected unknown id '$id'" }
            return false
        }
        return write(context, hidden(context) - tab.id)
    }

    /**
     * Записать список. Порядок в файле всегда канонический ([UiTabs.IDS]),
     * поэтому содержимое не «прыгает» от порядка добавления.
     */
    private fun write(context: Context, hidden: Set<String>): Boolean {
        val normalized = UiTabs.sanitizeHidden(hidden)
        return runCatching {
            val array = JSONArray()
            UiTabs.IDS.filter { it in normalized }.forEach { array.put(it) }
            file(context).writeText(JSONObject().put("hidden", array).toString(2))
            versionState.value++
            true
        }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "UiTabRegistry.write failed" }
            false
        }
    }
}
