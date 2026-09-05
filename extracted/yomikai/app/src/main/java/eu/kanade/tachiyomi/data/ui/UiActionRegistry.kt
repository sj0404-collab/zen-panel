package eu.kanade.tachiyomi.data.ui

import android.content.Context
import eu.kanade.tachiyomi.data.ai.AiProviders
import eu.kanade.tachiyomi.data.ai.AiReaderTools
import eu.kanade.tachiyomi.data.ai.AiWorkspace
import eu.kanade.tachiyomi.data.voice.VoiceBackend
import eu.kanade.tachiyomi.ui.reader.setting.ReaderPreferences
import eu.kanade.tachiyomi.ui.reader.setting.ReadingMode
import logcat.LogPriority
import mihon.data.ocr.OcrViewerHint
import mihon.data.ui.UiActionSpec
import mihon.data.ui.UiActions
import mihon.data.ui.UiEffect
import mihon.data.ui.UiPlacement
import mihon.domain.ocr.service.OcrPreferences
import mihon.domain.ocr.service.ScanRegion
import org.json.JSONObject
import tachiyomi.core.common.util.system.logcat
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.File

/**
 * Хранение и применение пользовательских действий UI.
 *
 * Объявления лежат JSON-файлами в `workspace/ui/`: переживают перезапуск,
 * уезжают с архивом workspace, создаются файлом или через AI-чат
 * (`ui_action_create`). Исполняемого кода в них нет — эффект выбирается из
 * замкнутого списка [UiEffect], поэтому плагин не может уронить читалку.
 *
 * Контракт надёжности тот же, что у `AiWorkspace` и `AiProviders`: ни один
 * метод не бросает исключение наружу, битый JSON пропускается, а сбой эффекта
 * возвращается текстом и показывается пользователю.
 */
object UiActionRegistry {

    private fun dir(context: Context): File =
        File(AiWorkspace.root(context), "ui").apply { runCatching { mkdirs() } }

    private fun fileOf(context: Context, id: String): File =
        File(dir(context), UiActions.sanitizeId(id) + ".json")

    /** Действия пользователя, отсортированные [UiActions.forPlacement]-ом. */
    fun list(context: Context): List<UiActionSpec> = runCatching {
        dir(context).listFiles { f -> f.extension == "json" }
            ?.mapNotNull { f ->
                runCatching { fromJson(JSONObject(f.readText())) }
                    .onFailure { e -> logcat(LogPriority.WARN, e) { "Skipping broken UI action ${f.name}" } }
                    .getOrNull()
            }
            .orEmpty()
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "UiActionRegistry.list failed" }
        emptyList()
    }

    /** Встроенные + пользовательские действия. */
    fun all(context: Context): List<UiActionSpec> = UiActions.builtIn() + list(context)

    /** Действия конкретного размещения в порядке показа. */
    fun forPlacement(context: Context, placement: UiPlacement): List<UiActionSpec> =
        UiActions.forPlacement(all(context), placement)

    fun save(context: Context, spec: UiActionSpec): Boolean {
        val normalized = spec.copy(id = UiActions.sanitizeId(spec.id))
        val error = UiActions.validate(normalized)
        if (error != null) {
            logcat(LogPriority.WARN) { "UiActionRegistry.save rejected '${normalized.id}': $error" }
            return false
        }
        return runCatching {
            fileOf(context, normalized.id).writeText(toJson(normalized).toString(2))
            true
        }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "UiActionRegistry.save failed for '${normalized.id}'" }
            false
        }
    }

    fun delete(context: Context, id: String): Boolean {
        val key = UiActions.sanitizeId(id)
        if (key in UiActions.RESERVED_IDS) return false
        return runCatching { fileOf(context, key).delete() }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "UiActionRegistry.delete failed for '$key'" }
            false
        }
    }

    /**
     * Применить эффект действия. Возвращает текст результата для тоста/агента.
     *
     * Каждый эффект — это переключение одной настройки, которое пользователь
     * мог бы сделать руками в настройках. Значения нормализуются через
     * соответствующие реестры, поэтому мусор из JSON не попадает в настройки.
     */
    fun apply(context: Context, spec: UiActionSpec): String = runCatching {
        val prefs = Injekt.get<OcrPreferences>()
        when (spec.effect) {
            UiEffect.OCR_PRESET ->
                // Тот же код, что использует агент: пресет меняет тип контента
                // и режим чтения согласованно (см. AiReaderTools.applyPreset).
                AiReaderTools.applyPreset(context, spec.value, prefs)

            UiEffect.SCAN_REGION -> {
                val region = runCatching { ScanRegion.valueOf(spec.value) }.getOrNull()
                if (region == null) {
                    "ОШИБКА: неизвестная область «${spec.value}»"
                } else {
                    prefs.scanRegion().set(region)
                    "Область сканирования: ${region.name}"
                }
            }

            UiEffect.READING_MODE -> {
                val hint = OcrViewerHint.fromId(spec.value)
                val mode = ReadingMode.fromOcrHint(hint)
                if (mode == null) {
                    "Режим чтения: ${hint.title}"
                } else {
                    Injekt.get<ReaderPreferences>().defaultReadingMode.set(mode.flagValue)
                    "Режим чтения: ${hint.title}"
                }
            }

            UiEffect.VOICE_ENGINE -> {
                // fromId нормализует значение и откатывается на системный TTS,
                // поэтому в настройки не попадёт несуществующий движок.
                val backend = VoiceBackend.fromId(spec.value)
                prefs.voiceEngine().set(backend.id)
                "Движок озвучки: ${backend.id}"
            }

            UiEffect.AI_PROVIDER -> {
                val known = AiProviders.all(context).firstOrNull { it.id == spec.value.trim() }
                if (known == null) {
                    "ОШИБКА: провайдер «${spec.value}» не найден в реестре"
                } else {
                    prefs.aiProvider().set(known.id)
                    "Провайдер AI: ${known.title}"
                }
            }
        }
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "UiActionRegistry.apply failed for '${spec.id}'" }
        "ОШИБКА действия «${spec.title}»: ${e.message?.take(120)}"
    }

    private fun toJson(spec: UiActionSpec) = JSONObject()
        .put("id", UiActions.sanitizeId(spec.id))
        .put("title", spec.title)
        .put("placement", spec.placement.id)
        .put("effect", spec.effect.id)
        .put("value", spec.value)
        .put("order", spec.order)

    private fun fromJson(j: JSONObject): UiActionSpec? {
        val placement = UiPlacement.fromId(j.optString("placement")) ?: return null
        val effect = UiEffect.fromId(j.optString("effect")) ?: return null
        return UiActionSpec(
            id = UiActions.sanitizeId(j.getString("id")),
            title = j.optString("title").ifBlank { j.getString("id") },
            placement = placement,
            effect = effect,
            value = j.optString("value"),
            order = j.optInt("order", 100),
        )
    }
}
