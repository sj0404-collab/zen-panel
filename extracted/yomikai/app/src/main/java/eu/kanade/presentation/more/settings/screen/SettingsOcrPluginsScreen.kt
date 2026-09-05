package eu.kanade.presentation.more.settings.screen

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import eu.kanade.presentation.more.settings.Preference
import mihon.data.ocr.OcrPluginAvailability
import mihon.data.ocr.OcrPluginDescriptor
import mihon.data.ocr.OcrPluginRequirement
import mihon.data.ocr.OcrPlugins
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.core.common.util.system.isNetworkAvailable
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.i18n.stringResource
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Реестр OCR-плагинов: что умеет приложение, что из этого доступно на этом
 * устройстве и почему недоступно остальное.
 *
 * Экран ничего не переключает — выбор движка делается в разделе «Распознавание
 * текста». Здесь видна полная картина: требования (сеть, пакет моделей, LiteRT,
 * API-ключ, адрес сервера), порядок во fallback-цепочке и поддержка областей.
 */
object SettingsOcrPluginsScreen : SearchableSettings {

    @ReadOnlyComposable
    @Composable
    override fun getTitleRes() = MR.strings.pref_ocr_plugins

    @Composable
    override fun getPreferences(): List<Preference> {
        val context = LocalContext.current
        val prefs = remember { Injekt.get<OcrPreferences>() }

        val online = rememberNetworkState(context)
        val availableIds = remember(online, prefs, context) {
            OcrPluginAvailability.availableIds(
                context = context,
                networkAvailable = online,
                hasApiKey = { plugin ->
                    when (plugin.id) {
                        "openrouter" -> prefs.openrouterApiKey().get().isNotBlank()
                        "google_ai" -> prefs.googleApiKey().get().isNotBlank()
                        else -> false
                    }
                },
                hasServerAddress = { prefs.owocrAddress().get().isNotBlank() },
            )
        }

        val selected = prefs.ocrModel().get()
        val chain = OcrPlugins.fallbackChain(
            primary = OcrPlugins.byModel(selected),
            preset = prefs.fallbackPreset().get(),
            networkAvailable = online,
        )

        return listOf(
            Preference.PreferenceGroup(
                title = stringResource(MR.strings.pref_ocr_plugins_group),
                preferenceItems = OcrPlugins.ALL.map { plugin ->
                    Preference.PreferenceItem.TextPreference(
                        title = pluginTitle(plugin, isSelected = plugin.model == selected),
                        subtitle = pluginSubtitle(plugin, availableIds),
                    )
                },
            ),
            Preference.PreferenceGroup(
                title = stringResource(MR.strings.pref_ocr_fallback),
                preferenceItems = listOf(
                    Preference.PreferenceItem.InfoPreference(
                        title = if (chain.isEmpty()) {
                            stringResource(MR.strings.pref_ocr_fallback_empty)
                        } else {
                            chain.joinToString(" → ") { it.title }
                        },
                    ),
                ),
            ),
        )
    }

    @Composable
    private fun pluginTitle(plugin: OcrPluginDescriptor, isSelected: Boolean): String {
        val badge = when {
            isSelected -> stringResource(MR.strings.pref_ocr_plugin_selected)
            plugin.online -> stringResource(MR.strings.pref_ocr_plugin_online)
            else -> stringResource(MR.strings.pref_ocr_plugin_offline)
        }
        val regions = if (plugin.supportsRegions) {
            " • " + stringResource(MR.strings.pref_ocr_plugin_regions)
        } else {
            ""
        }
        return "${plugin.title} — $badge$regions"
    }

    @Composable
    private fun pluginSubtitle(
        plugin: OcrPluginDescriptor,
        availableIds: Set<String>,
    ): String {
        val missing = OcrPluginAvailability.missingRequirement(plugin, availableIds)
        val state = if (missing == null) {
            stringResource(MR.strings.pref_ocr_plugin_available)
        } else {
            stringResource(MR.strings.pref_ocr_plugin_unavailable) + ": " + requirementName(missing)
        }
        return "${plugin.summary}\n$state"
    }

    @Composable
    private fun requirementName(requirement: OcrPluginRequirement): String = when (requirement) {
        OcrPluginRequirement.NETWORK -> stringResource(MR.strings.pref_plugin_requires_network)
        OcrPluginRequirement.MODEL_PACK -> stringResource(MR.strings.pref_plugin_requires_models)
        OcrPluginRequirement.LITERT -> stringResource(MR.strings.pref_plugin_requires_litert)
        OcrPluginRequirement.API_KEY -> stringResource(MR.strings.pref_plugin_requires_key)
        OcrPluginRequirement.SERVER_ADDRESS -> stringResource(MR.strings.pref_plugin_requires_server)
    }
}

@Composable
internal fun rememberNetworkState(context: Context): Boolean =
    remember(context) { isNetworkAvailable(context) }
