package eu.kanade.presentation.more.settings.screen

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.Navigator
import cafe.adriel.voyager.navigator.currentOrThrow
import eu.kanade.presentation.more.settings.Preference
import eu.kanade.tachiyomi.data.ai.AiBackendStatus
import eu.kanade.tachiyomi.data.ai.AiBackends
import eu.kanade.tachiyomi.data.ai.AiPlugins
import eu.kanade.tachiyomi.data.ai.AiRequirement
import eu.kanade.tachiyomi.data.ai.AiWorkspace
import eu.kanade.tachiyomi.ui.main.MainActivity
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.i18n.stringResource
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import tachiyomi.presentation.core.util.collectAsState as collectPreferenceAsState

/**
 * Настройки AI-ассистента: реестр бэкендов чата с их готовностью на этом
 * устройстве, состояние рабочей области и плагинов разработчика, плюс
 * доступ к самой вкладке «AI».
 *
 * Переключатели бэкенда, моделей и ключей намеренно НЕ дублируются: они живут
 * в настройках вкладки AI (⚙), и второй источник истины мгновенно разошёлся бы
 * с первым. Задача этого экрана — показать, что выбрано, готово ли оно и где
 * это менять.
 */
object SettingsAiScreen : SearchableSettings {

    @ReadOnlyComposable
    @Composable
    override fun getTitleRes() = MR.strings.pref_category_ai

    @Composable
    override fun getPreferences(): List<Preference> {
        val context = LocalContext.current
        val navigator = LocalNavigator.currentOrThrow
        val prefs = remember { Injekt.get<OcrPreferences>() }

        val online = rememberNetworkState(context)
        val backend by prefs.aiBackend().collectPreferenceAsState()
        val provider by prefs.aiProvider().collectPreferenceAsState()

        // Снимок состояния: настройки, установленные .task-модели, сессия ранера.
        // Сеть берём из общего наблюдателя, чтобы статус пересчитывался при её
        // пропаже без перечитывания всех настроек.
        val state = remember(online, prefs, context) {
            AiBackends.state(context, prefs).copy(networkAvailable = online)
        }
        val statuses = remember(state, provider) {
            AiBackends.ALL.associate { it.id to AiBackends.statusOf(it, state, provider) }
        }

        // Рабочая область и плагины разработчика — это файлы на диске, поэтому
        // считаем их один раз на вход в экран, а не на каждую рекомпозицию.
        val workspace = remember(context) {
            runCatching {
                AiPlugins.list(context).size to AiWorkspace.listAll(context).size
            }.getOrDefault(0 to 0)
        }

        return listOf(
            getBackendsGroup(statuses = statuses, selected = backend),
            getWorkspaceGroup(plugins = workspace.first, files = workspace.second),
            getAccessGroup(prefs = prefs, context = context, navigator = navigator),
        )
    }

    @Composable
    private fun getBackendsGroup(
        statuses: Map<String, AiBackendStatus>,
        selected: String,
    ): Preference.PreferenceGroup {
        val current = AiBackends.byId(selected)
        return Preference.PreferenceGroup(
            title = stringResource(MR.strings.pref_ai_backends_group),
            preferenceItems = AiBackends.ALL.map { plugin ->
                Preference.PreferenceItem.TextPreference(
                    title = backendTitle(
                        plugin = plugin,
                        isSelected = plugin.id == selected,
                        status = statuses[plugin.id],
                    ),
                    subtitle = backendSubtitle(plugin = plugin, status = statuses[plugin.id]),
                )
            } + listOf(
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ai_backend_current).format(current.title),
                ),
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ai_backend_switch_hint),
                ),
            ),
        )
    }

    @Composable
    private fun getWorkspaceGroup(plugins: Int, files: Int): Preference.PreferenceGroup =
        Preference.PreferenceGroup(
            title = stringResource(MR.strings.pref_ai_workspace_group),
            preferenceItems = listOf(
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ai_workspace_files).format(files),
                ),
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ai_workspace_plugins).format(plugins),
                ),
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ai_workspace_hint),
                ),
            ),
        )

    @Composable
    private fun getAccessGroup(
        prefs: OcrPreferences,
        context: Context,
        navigator: Navigator,
    ): Preference.PreferenceGroup =
        Preference.PreferenceGroup(
            title = stringResource(MR.strings.pref_ai_access_group),
            preferenceItems = listOf(
                Preference.PreferenceItem.TextPreference(
                    title = stringResource(MR.strings.pref_ai_open_chat),
                    subtitle = stringResource(MR.strings.pref_ai_open_chat_summary),
                    onClick = {
                        // Тот же приём, что у кнопки «настройки OCR» в читалке:
                        // вкладка AI живёт в нижней навигации, поэтому открываем
                        // её интентом с extra, а не навигатором настроек.
                        context.startActivity(
                            Intent(context, MainActivity::class.java)
                                .putExtra(MainActivity.EXTRA_OPEN_AI_CHAT, true),
                        )
                        navigator.pop()
                    },
                ),
                Preference.PreferenceItem.SwitchPreference(
                    preference = prefs.aiTabVisible(),
                    title = stringResource(MR.strings.pref_ai_tab_visible),
                    subtitle = stringResource(MR.strings.pref_ai_tab_visible_summary),
                ),
                Preference.PreferenceItem.SwitchPreference(
                    preference = prefs.aiHttpServer(),
                    title = stringResource(MR.strings.pref_ai_http_server),
                    subtitle = stringResource(MR.strings.pref_ai_http_server_summary),
                ),
            ),
        )

    @Composable
    private fun backendTitle(
        plugin: AiBackends.Plugin,
        isSelected: Boolean,
        status: AiBackendStatus?,
    ): String = buildString {
        append(plugin.title)
        append(" • ")
        append(
            when {
                isSelected -> stringResource(MR.strings.pref_ai_backend_selected)
                status?.available == true -> stringResource(MR.strings.pref_ai_backend_ready)
                else -> stringResource(MR.strings.pref_ai_backend_not_ready)
            },
        )
        if (plugin.offline) {
            append(" • ")
            append(stringResource(MR.strings.pref_ai_backend_offline))
        }
    }

    @Composable
    private fun backendSubtitle(
        plugin: AiBackends.Plugin,
        status: AiBackendStatus?,
    ): String = buildString {
        append(plugin.summary)
        if (status == null) return@buildString
        append('\n')
        append(status.detail)
        if (status.missing.isNotEmpty()) {
            // Подписи требований готовим до joinToString: внутри его лямбды
            // @Composable вызывать нельзя.
            val labels = status.missing.associateWith { requirementLabel(it) }
            append('\n')
            append(stringResource(MR.strings.pref_ai_requires))
            append(": ")
            append(status.missing.joinToString(", ") { labels.getValue(it) })
        }
    }

    @Composable
    private fun requirementLabel(requirement: AiRequirement): String =
        stringResource(
            when (requirement) {
                AiRequirement.NETWORK -> MR.strings.pref_ai_requires_network
                AiRequirement.OPENROUTER_KEY -> MR.strings.pref_ai_requires_openrouter_key
                AiRequirement.GITHUB_PAT -> MR.strings.pref_ai_requires_github_pat
                AiRequirement.RUNNER_ALLOWED -> MR.strings.pref_ai_requires_runner_allowed
                AiRequirement.MODEL_DOWNLOAD -> MR.strings.pref_ai_requires_model
                AiRequirement.RUNNER_SESSION -> MR.strings.pref_ai_requires_runner_session
            },
        )
}
