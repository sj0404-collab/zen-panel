package eu.kanade.tachiyomi.data.ui

import android.content.Context
import eu.kanade.tachiyomi.data.ai.AiWorkspace
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import logcat.LogPriority
import mihon.data.ui.UiTabs
import org.json.JSONArray
import org.json.JSONObject
import tachiyomi.core.common.util.system.logcat
import java.io.File

/**
 * Хранилище «Конструктора»: какие модули панелей скрыты и в каком порядке
 * стоят вкладки нижней навигации.
 *
 * Файлы лежат рядом с пользовательскими действиями (`workspace/ui/`), поэтому
 * уезжают вместе с архивом workspace и переживают переустановку. Формат
 * нарочно простой: списки id, битые файлы читаются как пустые.
 *
 * Контракт надёжности как у [UiTabRegistry]: ни один метод не бросает
 * исключение наружу.
 */
object UiConstructorStore {

    private val versionState = MutableStateFlow(0)

    /** Счётчик изменений: экраны пересчитывают видимость без перезапуска. */
    val version: StateFlow<Int> = versionState.asStateFlow()

    private fun dir(context: Context): File =
        File(AiWorkspace.root(context), "ui").apply { runCatching { mkdirs() } }

    private fun modulesFile(context: Context) = File(dir(context), "modules.json")
    private fun orderFile(context: Context) = File(dir(context), "tabs_order.json")

    // ---------- модули панелей ----------

    /** Id скрытых модулей (строки панелей читалки/браузера, кнопки URL-бара). */
    fun moduleHidden(context: Context): Set<String> = runCatching {
        val f = modulesFile(context)
        if (!f.exists()) return@runCatching emptySet<String>()
        val array = JSONObject(f.readText()).optJSONArray("hidden") ?: JSONArray()
        (0 until array.length()).mapNotNull { array.optString(it)?.takeIf { s -> s.isNotBlank() } }.toSet()
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "UiConstructorStore.moduleHidden failed" }
        emptySet()
    }

    fun isModuleHidden(context: Context, id: String): Boolean = id in moduleHidden(context)

    fun setModuleHidden(context: Context, id: String, hidden: Boolean): Boolean = runCatching {
        val current = moduleHidden(context).toMutableSet()
        if (hidden) current += id else current -= id
        modulesFile(context).writeText(JSONObject().put("hidden", JSONArray(current.toList())).toString(2))
        versionState.value++
        true
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "UiConstructorStore.setModuleHidden failed" }
        false
    }

    // ---------- порядок вкладок ----------

    /** Пользовательский порядок вкладок; пустой список = порядок по умолчанию. */
    fun tabOrder(context: Context): List<String> = runCatching {
        val f = orderFile(context)
        if (!f.exists()) return@runCatching emptyList<String>()
        val array = JSONObject(f.readText()).optJSONArray("order") ?: JSONArray()
        (0 until array.length()).mapNotNull { array.optString(it)?.takeIf { s -> s.isNotBlank() } }
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "UiConstructorStore.tabOrder failed" }
        emptyList()
    }

    fun setTabOrder(context: Context, ids: List<String>): Boolean = runCatching {
        val clean = ids.map { it.trim().lowercase() }.filter { it in UiTabs.IDS }.distinct()
        orderFile(context).writeText(JSONObject().put("order", JSONArray(clean)).toString(2))
        versionState.value++
        true
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "UiConstructorStore.setTabOrder failed" }
        false
    }

    /** Вернуть вид панелей и порядок вкладок к исходному. */
    fun reset(context: Context): Boolean = runCatching {
        runCatching { modulesFile(context).delete() }
        runCatching { orderFile(context).delete() }
        versionState.value++
        true
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "UiConstructorStore.reset failed" }
        false
    }
}
