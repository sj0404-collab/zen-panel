package mihon.domain.ocr.service

import mihon.domain.ocr.model.OcrModel
import tachiyomi.core.common.preference.PreferenceStore
import tachiyomi.core.common.preference.getEnum

enum class ScanRegion {
    FULL_PAGE,   // Сканировать всю страницу (100%)
    TOP_HALF,    // Сканировать верхнюю часть (Top 50%)
    BOTTOM_HALF, // Сканировать нижнюю часть (Bottom 50%)
}

class OcrPreferences(
    private val preferenceStore: PreferenceStore,
) {

    fun ocrModel() = preferenceStore.getEnum("pref_ocr_model", OcrModel.CYRILLIC)

    fun scanRegion() = preferenceStore.getEnum("pref_scan_region", ScanRegion.FULL_PAGE)

    // ---- Пресеты областей и типа контента ----
    // Тип контента (манга / манхва / комикс / сбалансированный) задаёт пресет
    // параметров детектора и порядок чтения. См. mihon.data.ocr.OcrTuning.
    fun contentType() = preferenceStore.getString("pref_ocr_content_type", "balanced")

    /** Авто-пресет типа контента по геометрии страницы: on/off. */
    fun autoPreset() = preferenceStore.getString("pref_ocr_auto_preset", "on")

    /** Разметка ударений («+» после ударного гласного) для RHVoice. */
    fun ruStress() = preferenceStore.getString("pref_ru_stress", "on")

    /** Память авто-пресета: «mangaId:presetId,…» (последние 60). */
    fun mangaPresetMap() = preferenceStore.getString("pref_manga_preset_map", "")

    /** Пресет голоса: пол (auto/male/female/neutral). */
    fun voicePresetGender() = preferenceStore.getString("pref_voice_preset_gender", "auto")

    /** Пресет голоса: возраст (infant/child/teen/adult/elderly). */
    fun voicePresetAge() = preferenceStore.getString("pref_voice_preset_age", "adult")

    // Область, которую пресет применяет по умолчанию. Хранится отдельно от
    // scanRegion(): пользователь может переопределить область, не теряя пресет.
    fun presetScanRegion() = preferenceStore.getString("pref_ocr_preset_region", "full")

    // Точные переопределения пресета. Пустая строка = «как в пресете».
    fun detectorThresholdOverride() = preferenceStore.getString("pref_ocr_detector_threshold", "")
    fun minComponentAreaOverride() = preferenceStore.getString("pref_ocr_min_area", "")
    fun maxTextBoxesOverride() = preferenceStore.getString("pref_ocr_max_boxes", "")
    fun wordGapFactorOverride() = preferenceStore.getString("pref_ocr_word_gap", "")
    fun minAcceptConfidenceOverride() = preferenceStore.getString("pref_ocr_min_confidence", "")
    fun shortTextConfidenceOverride() = preferenceStore.getString("pref_ocr_short_confidence", "")
    fun minCoverageOverride() = preferenceStore.getString("pref_ocr_min_coverage", "")
    fun rescueMaxLinesOverride() = preferenceStore.getString("pref_ocr_rescue_lines", "")

    fun autoOcrOnDownload() = preferenceStore.getBoolean("auto_ocr_on_download", false)

    fun owocrAddress() = preferenceStore.getString("pref_owocr_address", "ws://10.0.2.2:7331")

    fun useFallbackModels() = preferenceStore.getBoolean("pref_use_fallback_models", true)

    // Пресет цепочки фолбэков:
    //  auto      — умный порядок: онлайн при сети, локальные без сети
    //  online    — только онлайн-движки (GLENS -> ZEN_FREE -> GOOGLE)
    //  offline   — только локальные (TESSERACT -> FAST -> LEGACY)
    //  single    — без фолбэков, только выбранный движок
    fun fallbackPreset() = preferenceStore.getString("pref_fallback_preset", "auto")

    // OpenRouter Settings
    fun openrouterApiKey() = preferenceStore.getString("pref_openrouter_api_key", "")
    fun openrouterModel() = preferenceStore.getString("pref_openrouter_model", "google/gemini-2.5-flash")

    // Google AI / Gemini Settings
    fun googleApiKey() = preferenceStore.getString("pref_google_api_key", "")
    fun googleModel() = preferenceStore.getString("pref_google_model", "gemini-2.5-flash")

    // Zen Free Mode Settings (Works without API key)
    fun zenFreeEnabled() = preferenceStore.getBoolean("pref_zen_free_enabled", true)

    // Token Tracker & Usage Counter
    fun tokenUsageCount() = preferenceStore.getLong("pref_token_usage_count", 0L)
    fun incrementTokens(tokens: Long) {
        val current = tokenUsageCount().get()
        tokenUsageCount().set(current + tokens)
    }

    // Voice & Text-to-Speech Settings
    // Движки: system_tts (системные/локальные голоса), google_web (веб без
    // API-ключа, с сайта Google Translate), eleven_api (ElevenLabs по ключу)
    fun voiceEngine() = preferenceStore.getString("pref_voice_engine", "system_tts")
    fun voiceName() = preferenceStore.getString("pref_voice_name", "ru-ru-x-dfa-network")
    fun speechRate() = preferenceStore.getFloat("pref_speech_rate", 1.0f)
    fun speechPitch() = preferenceStore.getFloat("pref_speech_pitch", 1.0f)
    fun ttsWebLanguage() = preferenceStore.getString("pref_tts_web_lang", "ru")
    fun elevenApiKey() = preferenceStore.getString("pref_eleven_api_key", "")
    fun elevenVoiceId() = preferenceStore.getString("pref_eleven_voice_id", "")

    // Пресеты голосов: отдельно женский и мужской системные голоса.
    // При автоозвучке реплики могут чередоваться по полу говорящего.
    fun voiceFemale() = preferenceStore.getString("pref_voice_female", "")
    fun voiceMale() = preferenceStore.getString("pref_voice_male", "")

    // Авто-OCR видимой страницы + мгновенная озвучка результата
    fun autoScanAndSpeak() = preferenceStore.getBoolean("pref_auto_scan_speak", false)

    // Пресет направления сканирования/чтения страницы:
    // rtl (манга), ltr (комиксы), vertical (вебтуны)
    fun scanReadingOrder() = preferenceStore.getString("pref_scan_reading_order", "rtl")

    // ---- Авточтение (браузер и читалка) ----
    // Язык, который читаем; всё остальное на кадре игнорируется:
    // ru / en / ja / ko / zh / any
    fun autoReadLanguage() = preferenceStore.getString("pref_autoread_language", "ru")

    // Переводить ли реплики на русский перед озвучкой (для en/ja/…)
    fun autoReadTranslate() = preferenceStore.getBoolean("pref_autoread_translate", true)

    // Автолистание после дочитывания кадра (в браузере — автоскролл на кадр)
    fun autoReadAutoAdvance() = preferenceStore.getBoolean("pref_autoread_advance", true)

    // AI-определение пола говорящего (Gemini Vision по лицам и баллонам):
    // женские реплики читает женский голос-пресет, мужские — мужской.
    // Требует Google AI ключ; выключено по умолчанию (онлайн, медленнее).
    fun aiGenderVoices() = preferenceStore.getBoolean("pref_ai_gender_voices", false)

    // Целевой язык перевода перед озвучкой. Раньше был жёстко "ru" в коде
    // AutoReadEngine, из-за чего англоязычный пользователь получал русскую
    // озвучку независимо от настроек.
    fun translateTarget() = preferenceStore.getString("pref_translate_target", "ru")

    // ---- Офлайн-распознавание (Tesseract, модели в APK) ----
    // Языки распознавания: eng+rus | rus | eng (оба .traineddata лежат в APK)
    fun tessLangs() = preferenceStore.getString("pref_tess_langs", "eng+rus")

    // Режим сегментации страницы Tesseract:
    // single_block (баллон целиком, дефолт) | auto | sparse | single_line
    fun tessPsm() = preferenceStore.getString("pref_tess_psm", "single_block")

    // Апскейл мелких кропов: минимальная короткая сторона в px (0 = выкл).
    // Tesseract резко лучше читает текст, когда буквы >= ~20px.
    fun tessUpscaleMinSide() = preferenceStore.getInt("pref_tess_upscale", 320)

    // Предобработка перед распознаванием: ч/б + усиление контраста
    fun tessPreprocess() = preferenceStore.getBoolean("pref_tess_preprocess", true)

    // Держать офлайн-модели распакованными между сессиями:
    // быстрее старт движка, но ~8МБ постоянно на диске (иначе — только
    // tar.xz внутри APK, извлечение при каждом первом использовании).
    fun keepOfflinePacks() = preferenceStore.getBoolean("pref_keep_offline_packs", false)

    // ---- Онлайн AI-ассистент (пол говорящих, помощь читалке) ----
    // Провайдер: zen (без ключа) | openrouter (нужен ключ)
    fun aiProvider() = preferenceStore.getString("pref_ai_provider", "zen")

    // Вкладка «AI» в нижней навигации: показать/скрыть. Агент при скрытой
    // вкладке остаётся доступен из внешнего браузера (порт 8765), если
    // включён встроенный сервер.
    fun aiTabVisible() = preferenceStore.getBoolean("pref_ai_tab_visible", true)

    // Встроенный HTTP-сервер агента (http://127.0.0.1:8765 и по Wi-Fi)
    fun aiHttpServer() = preferenceStore.getBoolean("pref_ai_http_server", false)

    /** Секрет доступа к встроенному HTTP-серверу AI (генерируется лениво при старте). */
    fun aiHttpToken() = preferenceStore.getString("pref_ai_http_token", "")

    // GitHub PAT для полу-онлайн LLM-сессий (llm-runner.yml): нужен scope
    // actions:write на репозиторий. Хранится только на устройстве.
    fun githubPat() = preferenceStore.getString("pref_github_pat", "")

    // Бэкенд AI-чата: online (Zen/OpenRouter) | local (LLM на телефоне) |
    // runner (полу-онлайн, GitHub-ранер)
    fun aiBackend() = preferenceStore.getString("pref_ai_backend", "online")

    // Выбранная локальная модель (id из LocalLlm.CATALOG)
    fun localLlmModel() = preferenceStore.getString("pref_local_llm_model", "")

    // ONNX-голос по умолчанию (id из OnnxTts.CATALOG)
    /** Адрес локального TTS-сервера (tools/remote_tts_server.py на ПК/ранере). */
    fun remoteTtsUrl() = preferenceStore.getString("pref_remote_tts_url", "")

    // Пакет системного TTS-движка: "" = движок по умолчанию системы.
    // Примеры: com.google.android.tts, com.github.olga_yakovleva.rhvoice.android,
    // com.acapelagroup.android.tts — любой установленный на устройстве.
    fun systemTtsEngine() = preferenceStore.getString("pref_system_tts_engine", "")

    // Разрешение агенту (любой модели) пользоваться ранером: запускать
    // сессии и говорить с моделью на нём. Выключено по умолчанию —
    // включается в настройках вкладки AI (⚙), как просил пользователь
    // («с уточнением с настроек»).
    fun aiAllowRunner() = preferenceStore.getBoolean("pref_ai_allow_runner", false)

    // Разрешение агенту обращаться к GitHub API привязанным PAT-токеном
    // (список воркфлоу, статусы, диспатч). Тоже opt-in.
    fun aiAllowGithub() = preferenceStore.getBoolean("pref_ai_allow_github", false)

    // Модель Zen (opencode.ai/zen, бесплатные *-free, работают без ключа)
    fun zenModel() = preferenceStore.getString("pref_zen_model", "mimo-v2.5-free")

    // Автосмена моделей: при лимите/ошибке выбранной модели запрос уходит
    // следующей из списка. Выключено — только выбранная модель.
    fun aiAutoRotate() = preferenceStore.getBoolean("pref_ai_auto_rotate", true)

    // Показывать «размышления» reasoning-моделей в AI-чате (блок 🤔 под ответом)
    fun aiShowReasoning() = preferenceStore.getBoolean("pref_ai_show_reasoning", false)

    // Бесплатная модель OpenRouter (суффикс :free)
    fun openrouterFreeModel() = preferenceStore.getString("pref_openrouter_free_model", "")

    // ---- Вид подсветки реплики ----
    // Цвет рамки/подчёркивания текущей реплики (ARGB). По умолчанию — бирюзовый,
    // как на скриншотах пользователя.
    fun highlightColor() = preferenceStore.getLong("pref_highlight_color", 0xFF00E5FFL)

    // Стиль: bubble (мягкое пятно, по умолчанию) | box (рамка) |
    // underline (подчёркивание) | both
    // По умолчанию — видимая рамка: «bubble» (еле заметные круги) пользователь
    // воспринял как отсутствие подсветки вообще.
    fun highlightStyle() = preferenceStore.getString("pref_highlight_style", "box")

    // Толщина рамки/линии в dp
    fun highlightWidth() = preferenceStore.getFloat("pref_highlight_width", 3f)

    // Показывать номера реплик на странице (порядок чтения). Номера видны
    // глазами, но TTS их не произносит — см. SpeechMarkup.
    fun showSpeechNumbers() = preferenceStore.getBoolean("pref_show_speech_numbers", true)

    // Разные голоса разным персонажам одного пола в сцене
    fun perSpeakerVoices() = preferenceStore.getBoolean("pref_per_speaker_voices", true)

    // ---- Выбор голоса в читалке ----
    // false — пол реплики определяется автоматически (морфология → словарь →
    // AI Vision). true — читатель сам выбрал голос кнопкой в читалке, и он
    // применяется ко всем репликам.
    fun manualVoiceMode() = preferenceStore.getBoolean("pref_manual_voice_mode", false)

    // Какой голос использовать в ручном режиме: "female" | "male"
    fun manualVoiceGender() = preferenceStore.getString("pref_manual_voice_gender", "female")

    // ---- Продвинутые настройки голоса (запрос: 1/2/3 голоса, муж/жен/нарратор) ----
    /** Режим озвучки: single (один голос нарратора) | dual (муж+жен) | triple (муж+жен+нарратор) */
    fun voiceMode() = preferenceStore.getString("pref_voice_mode", "dual")

    /** Пол нарратора в режиме single/triple: male | female | auto */
    fun narratorGender() = preferenceStore.getString("pref_voice_narrator_gender", "female")

    /** Движок для мужского голоса: system_tts | google_web | remote_tts | eleven_api */
    fun voiceMaleEngine() = preferenceStore.getString("pref_voice_male_engine", "system_tts")

    /** Движок для женского голоса */
    fun voiceFemaleEngine() = preferenceStore.getString("pref_voice_female_engine", "system_tts")

    /** Движок для голоса нарратора */
    fun voiceNarratorEngine() = preferenceStore.getString("pref_voice_narrator_engine", "system_tts")

    // ---- Оверлей и уведомления ----
    /** Компактный оверлей (уменьшенный) вместо полноэкранного затемнения */
    fun ocrOverlayCompact() = preferenceStore.getBoolean("pref_ocr_overlay_compact", true)

    /** Дублировать распознанный текст в шторку уведомлений */
    fun ocrToNotification() = preferenceStore.getBoolean("pref_ocr_to_notification", false)

    /** Стриминг подсветки: подсвечивать слово сразу по мере распознавания */
    fun ocrStreamingHighlight() = preferenceStore.getBoolean("pref_ocr_streaming_highlight", true)

    // ---- Формы области сканирования ----
    /** Форма рамки сканирования: rect | circle | diamond | hexagon | octagon | figure8 | free */
    fun scanShape() = preferenceStore.getString("pref_scan_shape", "rect")

    // ---- Веб: сохранение как локальная глава ----
    /** Сохранять веб-страницы как локальные главы с изоляцией по сайту */
    fun webSavePerSiteFolder() = preferenceStore.getBoolean("pref_web_per_site_folder", true)

    // ---- История сканирования (персистент) ----
    /** Хранить историю сканирования между перезапусками */
    fun persistOcrHistory() = preferenceStore.getBoolean("pref_persist_ocr_history", true)

    // ---- AI-чат продвинутый ----
    /** Лимит истории чата (сообщений) — чтобы не тратить 50к токенов */
    fun aiHistoryLimit() = preferenceStore.getInt("pref_ai_history_limit", 12)

    /** Лимит токенов на один ответ (reasoning + content) */
    fun aiTokenBudget() = preferenceStore.getInt("pref_ai_token_budget", 4000)

    /** Показывать что доступно/невозможно (availability report) */
    fun aiShowAvailability() = preferenceStore.getBoolean("pref_ai_show_availability", true)

    // Local Model Management (модели НЕ входят в APK — по умолчанию не установлены,
    // из коробки работают только онлайн-движки)
    fun isMangaOcrDownloaded() = preferenceStore.getBoolean("pref_model_manga_ocr_downloaded", false)
    fun isFastOcrDownloaded() = preferenceStore.getBoolean("pref_model_fast_ocr_downloaded", false)
    fun isPanelDetectorDownloaded() = preferenceStore.getBoolean("pref_model_panel_detector_downloaded", false)
}
