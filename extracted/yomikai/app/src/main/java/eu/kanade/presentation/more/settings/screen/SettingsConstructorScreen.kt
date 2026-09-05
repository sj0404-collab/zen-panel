package eu.kanade.presentation.more.settings.screen

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import cafe.adriel.voyager.core.screen.Screen
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.currentOrThrow
import eu.kanade.presentation.components.AppBar
import eu.kanade.tachiyomi.data.ui.UiActionRegistry
import eu.kanade.tachiyomi.data.ui.UiConstructorStore
import eu.kanade.tachiyomi.data.ui.UiTabRegistry
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mihon.data.ui.UiActionSpec
import mihon.data.ui.UiEffect
import mihon.data.ui.UiPlacement
import mihon.data.ui.UiTab
import mihon.data.ui.UiTabs
import tachiyomi.presentation.core.components.material.Scaffold

/**
 * «Конструктор» приложения: вкладки нижней панели (скрыть/переставить),
 * модули панелей читалки и браузера (скрыть/показать), собственные кнопки
 * действий (создать/изменить/удалить) и сброс к виду по умолчанию.
 *
 * Всё хранится декларативно в `workspace/ui/` (id и значения), исполняемого
 * кода пользователь не добавляет — эффекты выбираются из замкнутого списка.
 */
object SettingsConstructorScreen : Screen {

    private val READER_MODULES = listOf(
        "r_scan" to "Читалка: строка «OCR скан»",
        "r_autoscroll" to "Читалка: автопрокрутка",
        "r_autoread" to "Читалка: прочитать страницу",
        "r_export" to "Читалка: сохранить главу в папку",
        "r_order" to "Читалка: порядок чтения",
        "r_tts" to "Читалка: озвучка (TTS)",
    )
    private val BROWSER_MODULES = listOf(
        "b_autoscroll" to "Браузер: автопрокрутка",
        "b_autoread" to "Браузер: авточтение страницы",
        "b_lang" to "Браузер: язык озвучки",
        "b_translate" to "Браузер: перевод",
        "b_top" to "Браузер: наверх",
        "b_scan" to "Браузер: скан текста (OCR)",
        "b_full" to "Браузер: полный экран",
        "b_urlscan" to "Браузер: кнопка скана в URL-баре",
        "b_urlfull" to "Браузер: кнопка фулскрина в URL-баре",
    )

    @Composable
    override fun Content() {
        val navigator = LocalNavigator.currentOrThrow
        val context = LocalContext.current
        val storeVersion by UiConstructorStore.version.collectAsState()
        val tabVersion by UiTabRegistry.version.collectAsState()

        var hiddenTabs by remember { mutableStateOf(setOf<String>()) }
        var tabIds by remember { mutableStateOf(UiTab.entries.toList()) }
        var hiddenModules by remember { mutableStateOf(setOf<String>()) }
        var actions by remember { mutableStateOf(listOf<UiActionSpec>()) }
        var editor by remember { mutableStateOf<UiActionSpec?>(null) }
        var creating by remember { mutableStateOf(false) }

        LaunchedEffect(storeVersion, tabVersion) {
            val (h, o, m, a) = withContext(Dispatchers.IO) {
                Quad(
                    UiTabRegistry.hidden(context),
                    UiConstructorStore.tabOrder(context),
                    UiConstructorStore.moduleHidden(context),
                    UiActionRegistry.list(context),
                )
            }
            hiddenTabs = h
            hiddenModules = m
            actions = a
            tabIds = if (o.isEmpty()) {
                UiTab.entries.toList()
            } else {
                UiTab.entries.sortedBy { val i = o.indexOf(it.id); if (i < 0) Int.MAX_VALUE else i }
            }
        }

        Scaffold(
            topBar = {
                AppBar(
                    title = "Конструктор",
                    navigateUp = { navigator.pop() },
                )
            },
        ) { contentPadding ->
            LazyColumn(contentPadding = contentPadding) {
                item { Header("Вкладки нижней панели") }
                items(tabIds) { tab ->
                    val index = tabIds.indexOf(tab)
                    ModuleRow(
                        title = tab.title + if (tab.pinned) " (закреплена)" else "",
                        checked = !UiTabs.isHidden(tab.id, hiddenTabs),
                        enabled = !tab.pinned,
                        onChecked = { show ->
                            if (show) UiTabRegistry.show(context, tab.id) else UiTabRegistry.hide(context, tab.id)
                        },
                        onUp = if (index > 0) {
                            {
                                val next = tabIds.toMutableList()
                                next[index] = next[index - 1]
                                next[index - 1] = tab
                                tabIds = next
                                UiConstructorStore.setTabOrder(context, next.map { it.id })
                            }
                        } else {
                            null
                        },
                        onDown = if (index < tabIds.lastIndex) {
                            {
                                val next = tabIds.toMutableList()
                                next[index] = next[index + 1]
                                next[index + 1] = tab
                                tabIds = next
                                UiConstructorStore.setTabOrder(context, next.map { it.id })
                            }
                        } else {
                            null
                        },
                    )
                }
                item { Header("Модули панели читалки") }
                items(READER_MODULES) { (id, title) ->
                    ModuleRow(
                        title = title,
                        checked = id !in hiddenModules,
                        enabled = true,
                        onChecked = { show -> UiConstructorStore.setModuleHidden(context, id, !show) },
                        onUp = null,
                        onDown = null,
                    )
                }
                item { Header("Модули панели браузера") }
                items(BROWSER_MODULES) { (id, title) ->
                    ModuleRow(
                        title = title,
                        checked = id !in hiddenModules,
                        enabled = true,
                        onChecked = { show -> UiConstructorStore.setModuleHidden(context, id, !show) },
                        onUp = null,
                        onDown = null,
                    )
                }
                item { Header("Мои кнопки действий") }
                items(actions) { spec ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = spec.title + "\n" + spec.placement.title + " · " + spec.effect.title,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(onClick = { editor = spec }) {
                            Icon(Icons.Outlined.Edit, contentDescription = "Изменить")
                        }
                        IconButton(onClick = {
                            val ok = UiActionRegistry.delete(context, spec.id)
                            context.toast(if (ok) "Кнопка удалена" else "Не удалось удалить")
                        }) {
                            Icon(Icons.Outlined.Delete, contentDescription = "Удалить")
                        }
                    }
                    HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                }
                item {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        TextButton(onClick = { creating = true }) {
                            Text("+ Создать кнопку")
                        }
                        TextButton(onClick = {
                            UiConstructorStore.reset(context)
                            context.toast("Вид панелей и порядок вкладок сброшены")
                        }) {
                            Text("Сбросить модули и порядок")
                        }
                    }
                }
                item {
                    Text(
                        text = "Скрытые модули и порядок хранятся в workspace/ui/ и переживают переустановку вместе с архивом workspace. Закреплённые вкладки («Библиотека», «Ещё») скрыть нельзя.",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }

        if (creating || editor != null) {
            ActionEditorDialog(
                initial = editor,
                onDismiss = {
                    creating = false
                    editor = null
                },
                onSave = { spec ->
                    val ok = UiActionRegistry.save(context, spec)
                    context.toast(if (ok) "Кнопка сохранена" else "Ошибка: проверьте поля")
                    if (ok) {
                        creating = false
                        editor = null
                    }
                },
            )
        }
    }

    private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)

    @Composable
    private fun Header(text: String) {
        Text(
            text = text,
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 6.dp),
        )
    }

    @Composable
    private fun ModuleRow(
        title: String,
        checked: Boolean,
        enabled: Boolean,
        onChecked: (Boolean) -> Unit,
        onUp: (() -> Unit)?,
        onDown: (() -> Unit)?,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.weight(1f),
            )
            if (onUp != null) {
                IconButton(onClick = onUp) {
                    Icon(Icons.Outlined.KeyboardArrowUp, contentDescription = "Выше")
                }
            }
            if (onDown != null) {
                IconButton(onClick = onDown) {
                    Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = "Ниже")
                }
            }
            Switch(checked = checked, onCheckedChange = onChecked, enabled = enabled)
        }
        HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
    }

    @Composable
    private fun ActionEditorDialog(
        initial: UiActionSpec?,
        onDismiss: () -> Unit,
        onSave: (UiActionSpec) -> Unit,
    ) {
        var title by remember { mutableStateOf(initial?.title ?: "") }
        var value by remember { mutableStateOf(initial?.value ?: "") }
        var id by remember { mutableStateOf(initial?.id ?: "") }
        var placement by remember { mutableStateOf(initial?.placement ?: UiPlacement.FLOATING_MENU) }
        var effect by remember { mutableStateOf(initial?.effect ?: UiEffect.OCR_PRESET) }
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(if (initial == null) "Новая кнопка" else "Кнопка «${initial.title}»") },
            text = {
                androidx.compose.foundation.layout.Column(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Название") })
                    TextButton(onClick = {
                        val next = UiPlacement.entries[(placement.ordinal + 1) % UiPlacement.entries.size]
                        placement = next
                    }) {
                        Text("Куда: ${placement.title}")
                    }
                    TextButton(onClick = {
                        val next = UiEffect.entries[(effect.ordinal + 1) % UiEffect.entries.size]
                        effect = next
                    }) {
                        Text("Действие: ${effect.title}")
                    }
                    OutlinedTextField(value = value, onValueChange = { value = it }, label = { Text("Значение") })
                    if (initial == null) {
                        OutlinedTextField(value = id, onValueChange = { id = it }, label = { Text("id (пусто = авто)") })
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    onSave(
                        UiActionSpec(
                            id = id.ifBlank { "act_" + (System.currentTimeMillis() % 1_000_000L) },
                            title = title.ifBlank { "Кнопка" },
                            placement = placement,
                            effect = effect,
                            value = value,
                        ),
                    )
                }) {
                    Text("Сохранить")
                }
            },
            dismissButton = {
                TextButton(onClick = onDismiss) {
                    Text("Отмена")
                }
            },
        )
    }
}
