package mihon.data.ocr

import android.content.Context

/**
 * Публичная проверка доступности OCR-плагинов для UI.
 *
 * Экраны настроек живут в модуле `app`, а `OcrModelFiles` и
 * `CyrillicOcrEngine` — `internal` в модуле `data`. Чтобы UI не тянул внутренности
 * движка и не дублировал список файлов пакета моделей, проверка собирается
 * здесь и отдаётся уже готовым множеством id.
 */
object OcrPluginAvailability {

    /**
     * Id плагинов, которые можно использовать прямо сейчас.
     *
     * @param networkAvailable есть ли интернет;
     * @param hasApiKey есть ли ключ у плагина (OpenRouter / Google AI);
     * @param hasServerAddress задан ли адрес своего сервера (OwOCR).
     */
    fun availableIds(
        context: Context,
        networkAvailable: Boolean,
        hasApiKey: (OcrPluginDescriptor) -> Boolean = { false },
        hasServerAddress: (OcrPluginDescriptor) -> Boolean = { false },
    ): Set<String> {
        val litertAvailable = runCatching {
            com.google.ai.edge.litert.Environment.create().close()
        }.isSuccess
        val modelsInstalled = OcrModelFiles.allInstalled(
            context,
            listOf(
                CyrillicOcrEngine.DETECTOR_PATH,
                CyrillicOcrEngine.PRIMARY_PATH,
                CyrillicOcrEngine.PRIMARY_DICT_PATH,
            ),
        )
        return OcrPlugins.available(
            networkAvailable = networkAvailable,
            modelsInstalled = modelsInstalled,
            litertAvailable = litertAvailable,
            hasApiKey = hasApiKey,
            hasServerAddress = hasServerAddress,
        ).map { it.id }.toSet()
    }

    /** Причина недоступности одним текстом — для подзаголовка в настройках. */
    fun missingRequirement(
        plugin: OcrPluginDescriptor,
        availableIds: Set<String>,
    ): OcrPluginRequirement? {
        if (plugin.id in availableIds) return null
        return plugin.requirements.firstOrNull()
    }
}
