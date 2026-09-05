package eu.kanade.presentation.reader.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogWindowProvider
import eu.kanade.tachiyomi.data.ui.UiActionRegistry
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mihon.data.ui.UiActionSpec
import eu.kanade.presentation.components.TabbedDialog
import eu.kanade.presentation.components.TabbedDialogPaddings
import eu.kanade.tachiyomi.ui.reader.setting.ReaderSettingsScreenModel
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.i18n.stringResource

@Composable
fun ReaderSettingsDialog(
    onDismissRequest: () -> Unit,
    onShowMenus: () -> Unit,
    onHideMenus: () -> Unit,
    screenModel: ReaderSettingsScreenModel,
) {
    val tabTitles = listOf(
        stringResource(MR.strings.pref_category_reading_mode),
        stringResource(MR.strings.pref_category_general),
        stringResource(MR.strings.custom_filter),
        // Вкладка построена из реестра UiActions: пользователь видит все свои
        // действия (и встроенные) и может применить любое одним тапом.
        stringResource(MR.strings.pref_reader_actions_tab),
    )
    val pagerState = rememberPagerState { tabTitles.size }

    BoxWithConstraints {
        TabbedDialog(
            modifier = Modifier.heightIn(max = maxHeight * 0.75f),
            onDismissRequest = {
                onDismissRequest()
                onShowMenus()
            },
            tabTitles = tabTitles,
            pagerState = pagerState,
        ) { page ->
            val window = (LocalView.current.parent as? DialogWindowProvider)?.window

            LaunchedEffect(pagerState.currentPage) {
                if (pagerState.currentPage == 2) {
                    window?.setDimAmount(0f)
                    onHideMenus()
                } else {
                    window?.setDimAmount(0.5f)
                    onShowMenus()
                }
            }

            Column(
                modifier = Modifier
                    .padding(vertical = TabbedDialogPaddings.Vertical)
                    .verticalScroll(rememberScrollState()),
            ) {
                when (page) {
                    0 -> ReadingModePage(screenModel)
                    1 -> GeneralPage(screenModel)
                    2 -> ColorFilterPage(screenModel)
                    3 -> ReaderActionsPage()
                }
            }
        }
    }
}

/**
 * Список действий реестра [UiActionRegistry]: встроенные и добавленные
 * пользователем. Тап применяет эффект и показывает результат тостом.
 *
 * Список читается на `Dispatchers.IO` и никогда не падает: при недоступном
 * хранилище реестр возвращает пустой список.
 */
@Composable
private fun ReaderActionsPage() {
    val context = LocalContext.current
    var actions by remember { mutableStateOf<List<UiActionSpec>>(emptyList()) }
    var refresh by remember { mutableStateOf(0) }

    LaunchedEffect(refresh) {
        actions = withContext(Dispatchers.IO) {
            UiActionRegistry.all(context).sortedWith(compareBy({ it.order }, { it.title }))
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            stringResource(MR.strings.pref_reader_actions_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (actions.isEmpty()) {
            Text(
                stringResource(MR.strings.pref_reader_actions_empty),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        // stringResource — @Composable, внутри buildString его вызывать нельзя.
        val builtinLabel = stringResource(MR.strings.pref_reader_actions_builtin)
        actions.forEach { action ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable {
                        context.toast(UiActionRegistry.apply(context, action))
                        refresh++
                    }
                    .padding(vertical = 8.dp, horizontal = 4.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(action.title, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        buildString {
                            append(action.placement.title)
                            append(" • ")
                            append(action.effect.title)
                            append(": ")
                            append(action.value)
                            if (action.builtIn) append(" • ").append(builtinLabel)
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
