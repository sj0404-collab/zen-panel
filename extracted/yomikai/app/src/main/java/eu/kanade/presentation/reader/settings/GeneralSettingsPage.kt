package eu.kanade.presentation.reader.settings

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import eu.kanade.tachiyomi.ui.reader.setting.ReaderPreferences
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import eu.kanade.tachiyomi.ui.reader.setting.ReaderSettingsScreenModel
import eu.kanade.tachiyomi.ui.reader.setting.ReadingMode
import eu.kanade.tachiyomi.util.system.hasDisplayCutout
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.components.CheckboxItem
import tachiyomi.presentation.core.components.SettingsChipRow
import tachiyomi.presentation.core.components.SliderItem
import tachiyomi.presentation.core.i18n.pluralStringResource
import tachiyomi.presentation.core.i18n.stringResource
import tachiyomi.presentation.core.util.collectAsState

private val themes = listOf(
    MR.strings.black_background to 1,
    MR.strings.gray_background to 2,
    MR.strings.white_background to 0,
    MR.strings.automatic_background to 3,
)

private val flashColors = listOf(
    MR.strings.pref_flash_style_black to ReaderPreferences.FlashColor.BLACK,
    MR.strings.pref_flash_style_white to ReaderPreferences.FlashColor.WHITE,
    MR.strings.pref_flash_style_white_black to ReaderPreferences.FlashColor.WHITE_BLACK,
)

@Composable
internal fun ColumnScope.GeneralPage(screenModel: ReaderSettingsScreenModel) {
    val readerTheme by screenModel.preferences.readerTheme.collectAsState()

    val flashPageState by screenModel.preferences.flashOnPageChange.collectAsState()

    val flashMillisPref = screenModel.preferences.flashDurationMillis
    val flashMillis by flashMillisPref.collectAsState()

    val flashIntervalPref = screenModel.preferences.flashPageInterval
    val flashInterval by flashIntervalPref.collectAsState()

    val flashColorPref = screenModel.preferences.flashColor
    val flashColor by flashColorPref.collectAsState()

    SettingsChipRow(MR.strings.pref_reader_theme) {
        themes.map { (labelRes, value) ->
            FilterChip(
                selected = readerTheme == value,
                onClick = { screenModel.preferences.readerTheme.set(value) },
                label = { Text(stringResource(labelRes)) },
            )
        }
    }

    CheckboxItem(
        label = stringResource(MR.strings.pref_show_page_number),
        pref = screenModel.preferences.showPageNumber,
    )

    val verticalNavigatorModes by screenModel.preferences.verticalNavigator.collectAsState()

    SettingsChipRow(MR.strings.pref_vertical_navigator) {
        ReadingMode.entries.filter { it != ReadingMode.DEFAULT }.forEach { mode ->
            FilterChip(
                selected = verticalNavigatorModes.contains(mode),
                onClick = {
                    val newModes = if (verticalNavigatorModes.contains(mode)) {
                        verticalNavigatorModes - mode
                    } else {
                        verticalNavigatorModes + mode
                    }
                    screenModel.preferences.verticalNavigator.set(newModes)
                },
                label = { Text(stringResource(mode.stringRes)) },
            )
        }
    }

    if (verticalNavigatorModes.isNotEmpty()) {
        val verticalNavigatorHeightPref = screenModel.preferences.verticalNavigatorHeight
        val verticalNavigatorHeight by verticalNavigatorHeightPref.collectAsState()

        CheckboxItem(
            label = stringResource(MR.strings.pref_webtoon_vertical_navigator_on_left),
            pref = screenModel.preferences.verticalNavigatorOnLeft,
        )

        SliderItem(
            label = stringResource(MR.strings.pref_vertical_navigator_height),
            value = verticalNavigatorHeight,
            valueRange = 65..100,
            steps = 6,
            onChange = { verticalNavigatorHeightPref.set(it) },
        )
    }

    CheckboxItem(
        label = stringResource(MR.strings.pref_fullscreen),
        pref = screenModel.preferences.fullscreen,
    )

    val isFullscreen by screenModel.preferences.fullscreen.collectAsState()
    if (LocalActivity.current?.hasDisplayCutout() == true && isFullscreen) {
        CheckboxItem(
            label = stringResource(MR.strings.pref_cutout_short),
            pref = screenModel.preferences.drawUnderCutout,
        )
    }

    CheckboxItem(
        label = stringResource(MR.strings.pref_keep_screen_on),
        pref = screenModel.preferences.keepScreenOn,
    )

    CheckboxItem(
        label = stringResource(MR.strings.pref_read_with_long_tap),
        pref = screenModel.preferences.readWithLongTap,
    )

    CheckboxItem(
        label = stringResource(MR.strings.pref_always_show_chapter_transition),
        pref = screenModel.preferences.alwaysShowChapterTransition,
    )

    CheckboxItem(
        label = stringResource(MR.strings.pref_page_transitions),
        pref = screenModel.preferences.pageTransitions,
    )

    CheckboxItem(
        label = stringResource(MR.strings.pref_flash_page),
        pref = screenModel.preferences.flashOnPageChange,
    )
    if (flashPageState) {
        SliderItem(
            value = flashMillis / ReaderPreferences.MILLI_CONVERSION,
            valueRange = 1..15,
            label = stringResource(MR.strings.pref_flash_duration),
            valueString = stringResource(MR.strings.pref_flash_duration_summary, flashMillis),
            onChange = { flashMillisPref.set(it * ReaderPreferences.MILLI_CONVERSION) },
            pillColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        )
        SliderItem(
            value = flashInterval,
            valueRange = 1..10,
            label = stringResource(MR.strings.pref_flash_page_interval),
            valueString = pluralStringResource(MR.plurals.pref_pages, flashInterval, flashInterval),
            onChange = {
                flashIntervalPref.set(it)
            },
            pillColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        )
        SettingsChipRow(MR.strings.pref_flash_with) {
            flashColors.map { (labelRes, value) ->
                FilterChip(
                    selected = flashColor == value,
                    onClick = { flashColorPref.set(value) },
                    label = { Text(stringResource(labelRes)) },
                )
            }
        }
    }

    // Паритет с основными настройками (запрос пользователя): распознавание
    // и пресеты голоса доступны прямо из читалки.
    val ocrPrefs = remember { Injekt.get<mihon.domain.ocr.service.OcrPreferences>() }
    val voiceGender by ocrPrefs.voicePresetGender().collectAsState()
    val voiceAge by ocrPrefs.voicePresetAge().collectAsState()
    val ocrContent by ocrPrefs.contentType().collectAsState()
    val ocrHighlight by ocrPrefs.highlightStyle().collectAsState()
    val ocrStress by ocrPrefs.ruStress().collectAsState()

    Text(
        text = "Распознавание и голос",
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(start = 16.dp, top = 12.dp, end = 16.dp),
    )
    PresetChipRow(
        title = "Пол голоса",
        options = mapOf("auto" to "Авто", "male" to "Мужской", "female" to "Женский", "neutral" to "Средний"),
        current = voiceGender,
        onPick = { ocrPrefs.voicePresetGender().set(it) },
    )
    PresetChipRow(
        title = "Возраст голоса",
        options = mapOf("infant" to "Младенец", "child" to "Ребёнок", "teen" to "Подросток", "adult" to "Взрослый", "elderly" to "Пожилой"),
        current = voiceAge,
        onPick = { ocrPrefs.voicePresetAge().set(it) },
    )
    PresetChipRow(
        title = "Пресет типа контента",
        options = mihon.data.ocr.OcrContentType.entries.associate { it.id to it.title },
        current = ocrContent,
        onPick = { ocrPrefs.contentType().set(it) },
    )
    PresetChipRow(
        title = "Подсветка читаемого",
        options = mapOf("box" to "Рамка", "underline" to "Подчёркивание", "both" to "Рамка+линия", "bubble" to "Мягкая"),
        current = ocrHighlight,
        onPick = { ocrPrefs.highlightStyle().set(it) },
    )
    PresetChipRow(
        title = "Ударения (RHVoice)",
        options = mapOf("on" to "Включены", "off" to "Выключены"),
        current = ocrStress,
        onPick = { ocrPrefs.ruStress().set(it) },
    )
}

/** Подпись + горизонтальная лента чипов (русские подписи, как в SAO-панели). */
@Composable
private fun ColumnScope.PresetChipRow(
    title: String,
    options: Map<String, String>,
    current: String,
    onPick: (String) -> Unit,
) {
    Text(
        text = title,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp),
    )
    Row(
        modifier = Modifier
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { (id, label) ->
            FilterChip(
                selected = current == id,
                onClick = { onPick(id) },
                label = { Text(label) },
            )
        }
    }
}
