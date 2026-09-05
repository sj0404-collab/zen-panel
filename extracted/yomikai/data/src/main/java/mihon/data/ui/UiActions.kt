package mihon.data.ui

import mihon.data.ocr.OcrContentType
import mihon.data.ocr.OcrViewerHint
import mihon.domain.ocr.service.ScanRegion

/**
 * Куда пользовательское действие добавляется в UI читалки.
 *
 * Размещение декларативное: экраны читают список действий своего размещения и
 * дорисовывают их к встроенным кнопкам. Вкладка приложения сюда намеренно не
 * входит — у вкладки есть содержимое, а исполняемый код из плагинов мы не
 * загружаем. Видимостью вкладок управляет отдельный реестр [UiTabs]: он тоже
 * декларативный и хранит только id.
 */
enum class UiPlacement(val id: String, val title: String) {
    /** Плавающее меню читалки (SAO-кнопка). */
    FLOATING_MENU("floating_menu", "Плавающее меню читалки"),

    /** Верхняя панель читалки. */
    READER_TOP_BAR("reader_top_bar", "Верхняя панель читалки"),

    /** Карточка результата OCR. */
    OCR_CARD("ocr_card", "Карточка результата OCR"),
    ;

    companion object {
        fun fromId(id: String?): UiPlacement? =
            entries.firstOrNull { it.id == id?.trim()?.lowercase() }
    }
}

/**
 * Что действие реально делает.
 *
 * Набор ЗАМКНУТ и сводится к переключению одной настройки приложения. Это
 * осознанное ограничение: пользовательский плагин не приносит исполняемого
 * кода, поэтому он физически не может уронить читалку, прочитать чужие ключи
 * или отправить данные наружу. Всё, что ему доступно, — те же переключатели,
 * что есть в настройках.
 */
enum class UiEffect(val id: String, val title: String) {
    /** Пресет типа контента: манга / манхва / комикс / сбалансированный. */
    OCR_PRESET("ocr_preset", "Пресет типа контента"),

    /** Область сканирования страницы. */
    SCAN_REGION("scan_region", "Область сканирования"),

    /** Режим чтения (вьюер). */
    READING_MODE("reading_mode", "Режим чтения"),

    /** Движок озвучки. */
    VOICE_ENGINE("voice_engine", "Движок озвучки"),

    /** Провайдер AI-чата. */
    AI_PROVIDER("ai_provider", "Провайдер AI-чата"),
    ;

    companion object {
        fun fromId(id: String?): UiEffect? =
            entries.firstOrNull { it.id == id?.trim()?.lowercase() }
    }
}

/**
 * Объявление одного пользовательского действия в UI.
 *
 * @param order позиция в списке: меньше — выше. Встроенные действия идут до
 *   пользовательских при равном `order`.
 */
data class UiActionSpec(
    val id: String,
    val title: String,
    val placement: UiPlacement,
    val effect: UiEffect,
    /** Значение эффекта: id пресета, имя области, id режима и т. п. */
    val value: String,
    val order: Int = 100,
    val builtIn: Boolean = false,
)

/**
 * Реестр действий пользовательского UI: валидация, допустимые значения и
 * встроенные объявления.
 *
 * Чистая часть (без Android), поэтому проверяется unit-тестами на JVM — как
 * `OcrPlugins`, `VoicePlugins` и `AiBackends`. Хранение JSON и применение
 * эффектов живут в app-модули (`UiActionRegistry`).
 */
object UiActions {

    /** Id встроенных действий: пользовательское не может их занять. */
    val RESERVED_IDS: Set<String> = builtIn().map { it.id }.toSet()

    /**
     * Допустимые значения эффекта, если их можно проверить без Android.
     * `null` — значение проверяет app-модуль по своему реестру (движки озвучки
     * и провайдеры AI описаны там).
     */
    fun allowedValues(effect: UiEffect): Set<String>? = when (effect) {
        UiEffect.OCR_PRESET -> OcrContentType.entries.map { it.id }.toSet()
        UiEffect.SCAN_REGION -> ScanRegion.entries.map { it.name }.toSet()
        UiEffect.READING_MODE -> OcrViewerHint.entries.map { it.id }.toSet()
        // Реестры движков озвучки и провайдеров живут в app-модули: там же
        // значение и нормализуется (VoiceBackend.fromId / AiProviders.all).
        UiEffect.VOICE_ENGINE, UiEffect.AI_PROVIDER -> null
    }

    /** Нормализация id: безопасные символы, нижний регистр, обрезка до 40. */
    fun sanitizeId(id: String): String =
        id.trim().lowercase().replace(Regex("[^a-z0-9_а-яё.-]"), "_").take(40)

    /**
     * Проверка объявления. Возвращает причину для UI/агента либо `null`, если
     * действие корректно. Невалидное объявление не должно попадать в реестр и
     * «молча не работать» потом.
     */
    fun validate(spec: UiActionSpec): String? {
        val id = sanitizeId(spec.id)
        return when {
            id.isBlank() || id.all { it == '_' } -> "Пустой id"
            !spec.builtIn && id in RESERVED_IDS -> "Имя «${spec.id}» занято встроенным действием"
            spec.title.isBlank() -> "Пустое название кнопки"
            spec.value.isBlank() -> "Не указано значение для эффекта «${spec.effect.title}»"
            else -> {
                val allowed = allowedValues(spec.effect)
                when {
                    allowed == null -> null
                    spec.value in allowed -> null
                    else -> "Значение «${spec.value}» недопустимо для «${spec.effect.title}». " +
                        "Можно: ${allowed.sorted().joinToString(", ")}"
                }
            }
        }
    }

    /**
     * Встроенные действия — декларативное описание кнопок, которые уже есть в
     * плавающем меню. Они показываются в общем списке (агент и пользователь
     * видят, что доступно) и служат шаблоном для своих действий.
     */
    fun builtIn(): List<UiActionSpec> = listOf(
        UiActionSpec(
            id = "region_full",
            title = "Область: вся страница",
            placement = UiPlacement.FLOATING_MENU,
            effect = UiEffect.SCAN_REGION,
            value = ScanRegion.FULL_PAGE.name,
            order = 10,
            builtIn = true,
        ),
        UiActionSpec(
            id = "region_top",
            title = "Область: верхние 50%",
            placement = UiPlacement.FLOATING_MENU,
            effect = UiEffect.SCAN_REGION,
            value = ScanRegion.TOP_HALF.name,
            order = 11,
            builtIn = true,
        ),
        UiActionSpec(
            id = "region_bottom",
            title = "Область: нижние 50%",
            placement = UiPlacement.FLOATING_MENU,
            effect = UiEffect.SCAN_REGION,
            value = ScanRegion.BOTTOM_HALF.name,
            order = 12,
            builtIn = true,
        ),
        UiActionSpec(
            id = "preset_manga",
            title = "Пресет: манга",
            placement = UiPlacement.FLOATING_MENU,
            effect = UiEffect.OCR_PRESET,
            value = OcrContentType.MANGA.id,
            order = 20,
            builtIn = true,
        ),
        UiActionSpec(
            id = "preset_manhwa",
            title = "Пресет: манхва (вертикально)",
            placement = UiPlacement.FLOATING_MENU,
            effect = UiEffect.OCR_PRESET,
            value = OcrContentType.MANHWA.id,
            order = 21,
            builtIn = true,
        ),
        UiActionSpec(
            id = "preset_comic",
            title = "Пресет: комикс",
            placement = UiPlacement.FLOATING_MENU,
            effect = UiEffect.OCR_PRESET,
            value = OcrContentType.COMIC.id,
            order = 22,
            builtIn = true,
        ),
        UiActionSpec(
            id = "preset_balanced",
            title = "Пресет: сбалансированный",
            placement = UiPlacement.FLOATING_MENU,
            effect = UiEffect.OCR_PRESET,
            value = OcrContentType.BALANCED.id,
            order = 23,
            builtIn = true,
        ),
    )

    /** Действия одного размещения в порядке показа. */
    fun forPlacement(actions: List<UiActionSpec>, placement: UiPlacement): List<UiActionSpec> =
        actions.filter { it.placement == placement }.sortedWith(compareBy({ it.order }, { it.title }))

}

/**
 * Вкладки нижней навигации приложения.
 *
 * Id стабильные и живут в файлах пользователя, поэтому их нельзя брать из имени
 * класса: в release-сборке R8 переименовывает классы. Порядок объявлений —
 * порядок вкладок в навигации.
 *
 * @param pinned вкладку нельзя скрыть: без неё приложение останется либо без
 *   контента ([LIBRARY]), либо без входа в настройки ([MORE]), и вернуть её
 *   будет нечем.
 */
enum class UiTab(val id: String, val title: String, val pinned: Boolean = false) {
    LIBRARY("library", "Библиотека", pinned = true),
    LOCAL_LIBRARY("local_library", "Локальная библиотека"),
    UPDATES("updates", "Обновления"),
    HISTORY("history", "История"),
    BROWSE("browse", "Каталоги"),
    BROWSER("browser", "Браузер"),
    AI("ai", "AI-чат"),
    MORE("more", "Ещё", pinned = true),
    ;

    companion object {
        fun fromId(id: String?): UiTab? =
            entries.firstOrNull { it.id == id?.trim()?.lowercase() }
    }
}

/**
 * Правила видимости вкладок: чистые функции без Android, чтобы их можно было
 * проверить юнит-тестами.
 */
object UiTabs {

    /** Все id в порядке показа. */
    val IDS: List<String> = UiTab.entries.map { it.id }

    /** Id, которые нельзя скрыть ни через чат, ни правкой файла. */
    val PROTECTED_IDS: Set<String> = UiTab.entries.filter { it.pinned }.map { it.id }.toSet()

    /**
     * Причина, по которой id не годится, или `null`, если годится.
     *
     * Текст причины показывается пользователю и агенту, поэтому он всегда
     * содержит список допустимых значений.
     */
    fun validate(id: String): String? {
        val key = id.trim().lowercase()
        return when {
            key.isEmpty() -> "Пустой id вкладки"
            key !in IDS -> "Неизвестная вкладка «$key». Доступны: ${IDS.joinToString()}"
            key in PROTECTED_IDS ->
                "Вкладку «$key» нельзя скрыть: без неё не останется библиотеки или входа в настройки"
            else -> null
        }
    }

    /** Скрыта ли вкладка. Закреплённые не скрываются никогда. */
    fun isHidden(id: String, hidden: Set<String>): Boolean {
        val key = id.trim().lowercase()
        return key in hidden && key !in PROTECTED_IDS
    }

    /**
     * Оставить только видимые вкладки, сохранив порядок [ids].
     *
     * Защита применяется и здесь: файл `workspace/ui/tabs.json` пользователь
     * может править руками или залить из архива чужого workspace.
     */
    fun visibleTabs(ids: List<String>, hidden: Set<String>): List<String> =
        ids.filterNot { isHidden(it, hidden) }

    /** Выкинуть неизвестные, закреплённые и пустые id, привести к нижнему регистру. */
    fun sanitizeHidden(ids: Collection<String>): Set<String> =
        ids.map { it.trim().lowercase() }
            .filter { it in IDS && it !in PROTECTED_IDS }
            .toSet()
}
