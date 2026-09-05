package eu.kanade.presentation.more.settings.screen

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.Navigator
import cafe.adriel.voyager.navigator.currentOrThrow
import eu.kanade.presentation.more.settings.Preference
import eu.kanade.tachiyomi.ui.reader.setting.ReaderPreferences
import eu.kanade.tachiyomi.ui.reader.setting.ReadingMode
import mihon.data.ocr.OcrContentType
import mihon.data.ocr.OcrPluginAvailability
import mihon.data.ocr.OcrPlugins
import mihon.domain.ocr.model.OcrModel
import mihon.domain.ocr.service.OcrPreferences
import mihon.domain.ocr.service.ScanRegion
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.i18n.stringResource
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import tachiyomi.presentation.core.util.collectAsState as collectPreferenceAsState

/**
 * Настройки распознавания: пресет типа контента, область страницы, точная
 * подстройка детектора и переход к реестру OCR-плагинов.
 *
 * Экран построен на штатных [Preference.PreferenceGroup], поэтому попадает в
 * поиск по настройкам и выглядит как остальные разделы. Названия и подсказки
 * пресетов берутся из [OcrContentType], а список движков — из [OcrPlugins],
 * так что настройки не могут разойтись с тем, что реально поддерживает движок.
 */
object SettingsOcrScreen : SearchableSettings {

    @ReadOnlyComposable
    @Composable
    override fun getTitleRes() = MR.strings.pref_category_ocr

    @Composable
    override fun getPreferences(): List<Preference> {
        val navigator = LocalNavigator.currentOrThrow
        val prefs = remember { Injekt.get<OcrPreferences>() }
        val context = LocalContext.current

        val contentType by prefs.contentType().collectPreferenceAsState()
        val presetRegion by prefs.presetScanRegion().collectPreferenceAsState()

        // Экран истории (две вкладки: авточтение и сканирование) открывается
        // полноэкранным диалогом прямо из настроек.
        var showHistory by remember { mutableStateOf(false) }
        if (showHistory) {
            OcrHistoryDialog(onDismiss = { showHistory = false })
        }

        // Доступность плагинов пересчитывается при смене состояния сети:
        // список должен честно показывать, что можно выбрать прямо сейчас.
        val online = rememberNetworkState(context)
        val availableIds = remember(online, prefs) {
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

        return listOf(
            getContentTypeGroup(prefs = prefs, contentType = contentType),
            getRegionGroup(prefs = prefs, presetRegion = presetRegion),
            getTuningGroup(prefs = prefs),
            getEnginesGroup(prefs = prefs, navigator = navigator, availableIds = availableIds),
            getHistoryGroup(onOpenHistory = { showHistory = true }),
        )
    }

    @Composable
    private fun getHistoryGroup(onOpenHistory: () -> Unit): Preference.PreferenceGroup {
        return Preference.PreferenceGroup(
            title = "История",
            preferenceItems = listOf(
                Preference.PreferenceItem.TextPreference(
                    title = "История авточтения и сканирования",
                    subtitle = "Журналы: успех/неудача по страницам, словари, сбои TTS",
                    onClick = onOpenHistory,
                ),
            ),
        )
    }

    @Composable
    private fun getContentTypeGroup(
        prefs: OcrPreferences,
        contentType: String,
    ): Preference.PreferenceGroup {
        val current = OcrContentType.fromId(contentType)
        val readerPrefs = remember { Injekt.get<ReaderPreferences>() }
        return Preference.PreferenceGroup(
            title = stringResource(MR.strings.pref_ocr_content_type_group),
            preferenceItems = listOf(
                Preference.PreferenceItem.ListPreference(
                    preference = prefs.contentType(),
                    entries = OcrContentType.entries.associate { it.id to it.title },
                    title = stringResource(MR.strings.pref_ocr_content_type),
                    subtitleProvider = { _, _ -> current.hint },
                    onValueChanged = { value ->
                        // Пресет типа контента задаёт и режим чтения: порядок
                        // распознавания и направление листания обязаны совпадать.
                        // BALANCED (KEEP) выбор пользователя не трогает.
                        val mode = ReadingMode.fromOcrHint(OcrContentType.fromId(value).viewer)
                        if (mode != null) readerPrefs.defaultReadingMode.set(mode.flagValue)
                        // Ручной выбор запоминаем для текущей манги: авто-пресет
                        // восстановит его при следующем входе без переклассификации.
                        mihon.data.ocr.ContentAutoPreset.rememberManual(
                            mihon.data.ocr.ReaderContextBus.current.value?.mangaId,
                            value,
                            prefs,
                        )
                        true
                    },
                ),
                Preference.PreferenceItem.ListPreference(
                    preference = prefs.autoPreset(),
                    entries = mapOf(
                        "on" to "Включён: манхва/вебтун определяются по странице",
                        "off" to "Выключен: только ручной выбор",
                    ),
                    title = "Авто-пресет типа контента",
                ),
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ocr_content_type_info),
                ),
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ocr_content_type_reading_mode)
                        .format(current.viewer.title),
                ),
            ),
        )
    }

    @Composable
    private fun getRegionGroup(
        prefs: OcrPreferences,
        presetRegion: String,
    ): Preference.PreferenceGroup {
        val regionNames = mapOf(
            "full" to stringResource(MR.strings.pref_ocr_region_full),
            "top" to stringResource(MR.strings.pref_ocr_region_top),
            "bottom" to stringResource(MR.strings.pref_ocr_region_bottom),
        )
        return Preference.PreferenceGroup(
            title = stringResource(MR.strings.pref_ocr_region_group),
            preferenceItems = listOf(
                Preference.PreferenceItem.BasicListPreference(
                    value = presetRegion,
                    entries = regionNames,
                    title = stringResource(MR.strings.pref_ocr_region),
                    onValueChanged = { prefs.presetScanRegion().set(it) },
                ),
                Preference.PreferenceItem.ListPreference(
                    preference = prefs.scanReadingOrder(),
                    entries = mapOf(
                        "rtl" to stringResource(MR.strings.pref_ocr_order_rtl),
                        "ltr" to stringResource(MR.strings.pref_ocr_order_ltr),
                        "vertical" to stringResource(MR.strings.pref_ocr_order_vertical),
                    ),
                    title = stringResource(MR.strings.pref_ocr_reading_order),
                ),
                Preference.PreferenceItem.ListPreference(
                    preference = prefs.scanRegion(),
                    entries = mapOf(
                        ScanRegion.FULL_PAGE to regionNames.getValue("full"),
                        ScanRegion.TOP_HALF to regionNames.getValue("top"),
                        ScanRegion.BOTTOM_HALF to regionNames.getValue("bottom"),
                    ),
                    title = stringResource(MR.strings.pref_ocr_region_override),
                ),
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ocr_region_info),
                ),
            ),
        )
    }

    @Composable
    private fun getTuningGroup(prefs: OcrPreferences): Preference.PreferenceGroup {
        return Preference.PreferenceGroup(
            title = stringResource(MR.strings.pref_ocr_tuning_group),
            preferenceItems = listOf(
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ocr_tuning_info),
                ),
                Preference.PreferenceItem.EditTextPreference(
                    preference = prefs.detectorThresholdOverride(),
                    title = stringResource(MR.strings.pref_ocr_tuning_detector_threshold),
                ),
                Preference.PreferenceItem.EditTextPreference(
                    preference = prefs.minComponentAreaOverride(),
                    title = stringResource(MR.strings.pref_ocr_tuning_min_area),
                ),
                Preference.PreferenceItem.EditTextPreference(
                    preference = prefs.maxTextBoxesOverride(),
                    title = stringResource(MR.strings.pref_ocr_tuning_max_boxes),
                ),
                Preference.PreferenceItem.EditTextPreference(
                    preference = prefs.wordGapFactorOverride(),
                    title = stringResource(MR.strings.pref_ocr_tuning_word_gap),
                ),
                Preference.PreferenceItem.EditTextPreference(
                    preference = prefs.minAcceptConfidenceOverride(),
                    title = stringResource(MR.strings.pref_ocr_tuning_min_confidence),
                ),
                Preference.PreferenceItem.EditTextPreference(
                    preference = prefs.shortTextConfidenceOverride(),
                    title = stringResource(MR.strings.pref_ocr_tuning_short_confidence),
                ),
                Preference.PreferenceItem.EditTextPreference(
                    preference = prefs.minCoverageOverride(),
                    title = stringResource(MR.strings.pref_ocr_tuning_min_coverage),
                ),
                Preference.PreferenceItem.EditTextPreference(
                    preference = prefs.rescueMaxLinesOverride(),
                    title = stringResource(MR.strings.pref_ocr_tuning_rescue_lines),
                ),
            ),
        )
    }

    @Composable
    private fun getEnginesGroup(
        prefs: OcrPreferences,
        navigator: Navigator,
        availableIds: Set<String>,
    ): Preference.PreferenceGroup {
        return Preference.PreferenceGroup(
            title = stringResource(MR.strings.pref_ocr_plugins_group),
            preferenceItems = listOf(
                Preference.PreferenceItem.TextPreference(
                    title = stringResource(MR.strings.pref_ocr_plugins),
                    subtitle = stringResource(MR.strings.pref_ocr_plugins_summary),
                    onClick = { navigator.push(SettingsOcrPluginsScreen) },
                ),
                Preference.PreferenceItem.ListPreference(
                    preference = prefs.ocrModel(),
                    entries = OcrModel.entries
                        .filter { model ->
                            // LEGACY/FAST/TESSERACT — алиасы кириллического
                            // плагина, отдельными пунктами их показывать нельзя.
                            model == OcrModel.CYRILLIC || OcrPlugins.byModel(model) != OcrPlugins.CYRILLIC
                        }
                        .associateWith { OcrPlugins.byModel(it).title },
                    title = stringResource(MR.strings.pref_ocr_model),
                ),
                Preference.PreferenceItem.ListPreference(
                    preference = prefs.fallbackPreset(),
                    entries = mapOf(
                        "auto" to stringResource(MR.strings.pref_ocr_fallback_auto),
                        "online" to stringResource(MR.strings.pref_ocr_fallback_online),
                        "offline" to stringResource(MR.strings.pref_ocr_fallback_offline),
                        "single" to stringResource(MR.strings.pref_ocr_fallback_single),
                    ),
                    title = stringResource(MR.strings.pref_ocr_fallback),
                ),
                Preference.PreferenceItem.InfoPreference(
                    title = stringResource(MR.strings.pref_ocr_available_count)
                        .format(availableIds.size),
                ),
            ),
        )
    }
}
