package eu.kanade.presentation.more.settings.screen

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import eu.kanade.presentation.more.settings.Preference
import eu.kanade.tachiyomi.data.voice.VoiceBackend
import eu.kanade.tachiyomi.data.voice.VoicePluginDescriptor
import eu.kanade.tachiyomi.data.voice.VoicePlugins
import eu.kanade.tachiyomi.data.voice.VoiceRequirement
import mihon.domain.ocr.service.OcrPreferences
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.i18n.stringResource
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import tachiyomi.presentation.core.util.collectAsState as collectPreferenceAsState

/**
 * Реестр голосовых плагинов: системный TTS, веб-озвучка Google, ElevenLabs и
 * офлайн-голоса sherpa-onnx.
 *
 * Экран показывает состояние каждого движка на этом устройстве: что установлено,
 * чего не хватает и какие голоса реально доступны. Переключение движка и выбор
 * конкретного голоса остаются в штатных настройках озвучки, чтобы не плодить
 * два источника истины для `pref_voice_engine` и `pref_voice_name`.
 */
object SettingsVoicePluginsScreen : SearchableSettings {

    @ReadOnlyComposable
    @Composable
    override fun getTitleRes() = MR.strings.pref_category_voice

    @Composable
    override fun getPreferences(): List<Preference> {
        val context = LocalContext.current
        val prefs = remember { Injekt.get<OcrPreferences>() }
        val voiceEngine by prefs.voiceEngine().collectPreferenceAsState()

        val online = rememberNetworkState(context)
        val available = remember(online, prefs, voiceEngine) {
            VoicePlugins.available(
                networkAvailable = online,
                systemEnginePresent = true,
                hasApiKey = { plugin ->
                    plugin.backend == VoiceBackend.ELEVEN_API && prefs.elevenApiKey().get().isNotBlank()
                },
                hasServerAddress = { plugin ->
                    plugin.backend == VoiceBackend.REMOTE_TTS &&
                        prefs.remoteTtsUrl().get().isNotBlank()
                },
            ).map { it.id }.toSet()
        }

        return listOf(
            Preference.PreferenceGroup(
                title = stringResource(MR.strings.pref_voice_plugins_group),
                preferenceItems = VoicePlugins.ALL.map { plugin ->
                    Preference.PreferenceItem.TextPreference(
                        title = pluginTitle(plugin, isSelected = plugin.id == voiceEngine),
                        subtitle = pluginSubtitle(plugin, available),
                    )
                },
            ),
            Preference.PreferenceGroup(
                title = stringResource(MR.strings.pref_voice_engine),
                preferenceItems = listOf(
                    Preference.PreferenceItem.ListPreference(
                        preference = prefs.voiceEngine(),
                        entries = VoicePlugins.ALL.associate { it.id to it.title },
                        title = stringResource(MR.strings.pref_voice_engine),
                    ),
                    Preference.PreferenceItem.ListPreference(
                        preference = prefs.voiceName(),
                        entries = remember(prefs, voiceEngine) {
                            VoicePlugins.voices(
                                context = context,
                                plugin = VoicePlugins.current(prefs),
                                prefs = prefs,
                            ).associate { it.id to it.name }
                        },
                        title = stringResource(MR.strings.pref_voice_name),
                    ),
                    // Движок и голос — разные настройки: пакет движка уходит в
                    // pref_system_tts_engine, а имя голоса — в pref_voice_name.
                    // Список движков берётся из PackageManager, поэтому здесь
                    // видны любые установленные сторонние TTS-приложения.
                    Preference.PreferenceItem.ListPreference(
                        preference = prefs.systemTtsEngine(),
                        entries = remember(context, prefs) {
                            VoicePlugins.systemEngineOptions(
                                context = context,
                                prefs = prefs,
                                defaultLabel = "Как в системе (по умолчанию)",
                            ).toMap()
                        },
                        title = stringResource(MR.strings.pref_voice_system_engine),
                    ),
                ),
            ),
        )
    }

    @Composable
    private fun pluginTitle(plugin: VoicePluginDescriptor, isSelected: Boolean): String {
        val badge = when {
            isSelected -> stringResource(MR.strings.pref_ocr_plugin_selected)
            plugin.offline -> stringResource(MR.strings.pref_voice_plugin_offline)
            else -> stringResource(MR.strings.pref_ocr_plugin_online)
        }
        val gender = if (plugin.supportsGender) {
            " • " + stringResource(MR.strings.pref_voice_plugin_gender)
        } else {
            ""
        }
        return "${plugin.title} — $badge$gender"
    }

    @Composable
    private fun pluginSubtitle(
        plugin: VoicePluginDescriptor,
        available: Set<String>,
    ): String {
        val missing = if (plugin.id in available) {
            null
        } else {
            plugin.requirements.firstOrNull()
        }
        val state = if (missing == null) {
            stringResource(MR.strings.pref_voice_plugin_installed)
        } else {
            stringResource(MR.strings.pref_voice_plugin_missing) + ": " + requirementName(missing)
        }
        return "${plugin.summary}\n$state"
    }

    @Composable
    private fun requirementName(requirement: VoiceRequirement): String = when (requirement) {
        VoiceRequirement.NETWORK -> stringResource(MR.strings.pref_plugin_requires_network)
        VoiceRequirement.API_KEY -> stringResource(MR.strings.pref_plugin_requires_key)
        VoiceRequirement.SYSTEM_ENGINE -> stringResource(MR.strings.pref_voice_requires_system)
        VoiceRequirement.MODEL_DOWNLOAD -> stringResource(MR.strings.pref_plugin_requires_models)
        VoiceRequirement.NATIVE_LIBRARY -> stringResource(MR.strings.pref_voice_requires_native)
        VoiceRequirement.SERVER_ADDRESS -> "адрес TTS-сервера (Настройки озвучки)"
    }
}
