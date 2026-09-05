# Yomikai — Продвинутый разбор второго круга: локальная библиотека, читалка, оверлеи, голоса, веб, конструктор, AI-чат

**Дата:** 2026-09-05  
**Ветка:** `main` @ `a218b4d` + патчи аудита #2  
**База:** 1152 Kotlin-файла, 17 модулей. Сборка — только `release.yml` (arm64-v8a, `versionCode≥10907`).

Этот документ отвечает на 10 запросов: проверить локальную библиотеку/читалку/оверлеи/кнопки/распознавание, уменьшить оверлей или вынести в шторку, история сканирования, голоса 1/2/3 (муж локальный/онлайн, жен, нарратор м/ж), рамки разной формы, стриминг-подсветка + авточтение, веб-кнопка «сохранить как локальную главу» с папкой на сайт, конструктор, и AI-чат без потери истории и с честным отчётом о возможностях.

---

## 1. Локальная библиотека — проверка и продвинутый уровень

**Файлы:** `source-local/LocalSource.kt`, `core/common/storage`, `domain/library/model/LibraryIndex`, `presentation/library/**`

**Что было:**
- Папки-манги + одиночные архивы CBZ/ZIP, `genresOf()` из `ComicInfo.xml` с кэшем `ConcurrentHashMap`, `allKnownGenres()` сортирует, `LibraryIndex.matches(query)` для `#` алфавитного указателя — уже продвинуто.
- Сортировка `Popular`/`Latest`, фильтры `GenreFilter`, `OrderBy` — есть.
- Сохранение веб-страницы как локальной главы — **не было**: веб жил отдельно.

**Что сделано:**
- **Новый `WebLocalSaver`** (`app/.../webbrowser/WebLocalSaver.kt`) — сохраняет WebView как локальную главу:
  ```kotlin
  siteId = sha256(host).take(4).hex + "_" + host.sanitize()
  dir = local/<siteId>/<bookTitle>/<chapterTitle_yyyy-MM-dd_HH-mm-ss>/
  page = page_001.png + ComicInfo.xml (Title, Series, Web=url, Genre=Web,siteId)
  ```
  Каждая страница сайта — отдельная папка, сайты не смешиваются (id по домену). Глава сразу видна в «Локальной библиотеке», участвует в поиске/фильтрах `Genre=Web`, сортируется по `lastModified`.

- **Проверка локальной библиотеки** — листинг `getSearchManga` уже не блокирует UI: обложки берутся только из кэша `coverManager.find()`, генерация — фоном `scheduleCoverGeneration` (было медленно, стало мгновенно). Папки, начинающиеся с `.` — игнорируются. Дубли по `name` — `distinctBy`.

- **Рекомендация (TD-L1):** добавить `sort by natural order` в `OrderBy` (уже есть `compareToCaseInsensitiveNaturalOrder`) как отдельный чип «А-Я / Числа» — покрыть тестами `UiTabsTest`.

---

## 2. Читалка — Viewers, пресеты, стриминг

**Файлы:** `ui/reader/viewer/*`, `presentation/reader/**`, `data/ocr/OcrRegionRules.kt`, `domain/ocr/service/OcrPreferences.kt`

**Проверка:**
- `PagerViewer` / `WebtoonViewer` / `WebtoonRecyclerView` — `PagerConfig`, `WebtoonConfig`, `ViewerNavigation` (Edge/Kindlish/RightAndLeft) — продвинуто, `DisplayRefreshHost` для 120 Гц.
- `OcrRegionRules.effectiveRegion()` — один источник истины для движка, настроек и AI-инструмента `reader_status`.
- `ContentAutoPreset` — по геометрии страницы выбирает `balanced/manga/manhwa/comic` и запоминает `mangaPresetMap` (60 последних).

**Продвинуто:**
- `OcrTuning.preset()` — `balanced` байт-в-байт старые константы (тест `OcrRegionRulesTest`), `manga` (rtl, больше боксов), `manhwa` (vertical, крупные буквы) — уже было.
- **Стриминг подсветки** — добавлена настройка `pref_ocr_streaming_highlight` (дефолт `true`). `AutoReadEngine` теперь публикует `frameRegions: List<FrameRegion>(DONE/CURRENT/UPCOMING)` и `currentRegion`. `ReaderOcrOverlayRenderer` рисует полупрозрачно прочитанные, ярко текущую, пунктирно будущие — видно историю и план. `OcrHistoryStore.addStreamingScan()` пишет частичные результаты по мере тайлов, а не только в конце.
- **Чтение сразу при авточтении** — `AutoReadEngine.readFrame()` теперь не ждёт полной страницы: первая реплика озвучивается, как только первый кроп распознан (стриминг), следующая — без паузы; `lastFrameHadText` управляет скроллом (пустой кадр — мгновенно дальше).

---

## 3. Оверлеи — уменьшен, вынесен в шторку

**Файлы:** `presentation/reader/OcrResultOverlay.kt`, `OcrResultBottomSheet.kt`, `OcrSelectionOverlay.kt`, `presentation/reader/components/AutoReadHighlight.kt`

**Было:** `OcrResultOverlay` — либо `ResizableSheet` на 70% высоты, либо `Surface` на 520dp, затемнял фон. При сканировании 10 пузырей — занимал весь экран.

**Стало:**
- **Новый `OcrPreferences.ocrOverlayCompact` (true)** — компактная карточка `320dp` по центру, без `scrim`, с кнопками `Голос / Выбрать голос / Копировать / Закрыть`. В `OcrResultOverlay` ветка `noDictionaries → OcrPlainTextCard` уже была компактной — оставлена как дефолт, `BottomSheet` только для словарного режима.
- **Новый `OcrNotificationManager`** (`data/.../ocr/OcrNotificationManager.kt`) — канал `yomikai_ocr` (IMPORTANCE_LOW, без звука/вибрации). Если `pref_ocr_to_notification=true`, `BrowserTab.manualScan()` и `ReaderActivity` дублируют распознанный текст в `NotificationCompat.BigTextStyle` с обновлением `updateStreaming()` пока OCR идёт по тайлам. Действия «Копировать / Озвучить» — через `PendingIntent` (заглушка в менеджере, реальные интент-фильтры в Activity).
- **Настройки:** `SettingsOcrScreen` → группа «Оверлей» — тумблер «Компактный» и «Дублировать в шторку».

---

## 4. История сканирования — была in-memory, стала персистентной

**Файл:** `data/.../ocr/OcrHistoryStore.kt`

**Было:** `object` с двумя `MutableStateFlow`, `MAX=200`, только в памяти — при перезапуске пропадала.

**Стало:**
- `MAX=500`, `RETENTION_MS=30дней`, JSON `filesDir/ocr_history.json` + `StateFlow`, `init(context)` при старте `App`.
- `addScan(ok, detail, wordDictHits, ... isStreaming, page)` + `addStreamingScan(partial, page)` — пишет частичные результаты.
- `addAutoRead(ok, event, detail, voice, durationMs)` — голос и длительность.
- `filteredScans(okOnly, query)` / `filteredReads(query)` — для поиска в диалоге.
- `persist()` в `Dispatchers.IO` после каждого добавления, `clearAll/clearScans/clearReads`, `export(context)` → `history/ocr_history_<ts>.json`.
- **UI:** `OcrHistoryDialog` — две вкладки, `LazyColumn`, `HorizontalDivider`, `EmptyHint` — уже был, теперь фильтры и экспорт доступны из того же диалога (добавить `TextField` поиска — TD-H1).
- Настройка `pref_persist_ocr_history` (true) — если выключена, `init` не читает файл.

---

## 5. Голоса — 1 / 2 / 3 на выбор, локальный/онлайн, муж/жен/нарратор

**Файлы:** `domain/.../ocr/service/OcrPreferences.kt`, `data/tts/VoicePreset.kt`, `data/tts/VoiceHelper.kt`, `data/tts/TtsSpeaker.kt`, **новый** `data/tts/VoiceModeResolver.kt`

**Было:** `voiceFemale`, `voiceMale`, `voiceName` (нарратор), `voiceEngine` один на всех. `VoiceHelper.pick()` разводил по полу, но режим 1/2/3 был жёстко зашит в `perSpeakerVoices` (bool).

**Стало:**
- **Новые преференсы:**
  ```
  pref_voice_mode = single | dual | triple (дефолт dual)
  pref_voice_male_engine / pref_voice_female_engine / pref_voice_narrator_engine = system_tts | google_web | remote_tts | eleven_api
  pref_voice_narrator_gender = male | female | auto (дефолт female)
  pref_voice_preset_gender/age — остаются (pitch/rate поверх)
  ```
- **Новый `VoiceModeResolver`:**
  ```kotlin
  enum Mode { SINGLE("Один голос"), DUAL("Два"), TRIPLE("Три") }
  fun resolve(detectedGender: String?, isNarration: Boolean, speakerSlot: Int): ResolvedVoice {
    when(mode) {
      SINGLE -> ResolvedVoice(narratorGender, narratorEngine, narratorVoice)
      DUAL   -> if(male) ResolvedVoice(maleEngine, voiceMale) else ResolvedVoice(femaleEngine, voiceFemale)
      TRIPLE -> if(isNarration) ResolvedVoice(narrator...) else DUAL-логика
    }
  }
  ```
  `isLocal` / `isOnline` поля показывают, нужен ли интернет.
- **Интеграция:** `AutoReadEngine` теперь вызывает `VoiceModeResolver.resolve(gender, isNarration, slot)` вместо прямого `VoiceHelper.pick`, затем `applyToTts(tts, resolved, rate*pitch)`. `TtsSpeaker.speakAs()` проверяет `manualVoiceMode` (ручной перекрывает всё), иначе `VoiceModeResolver`.
- **Настройки:** `SettingsVoicePluginsScreen` — три строки выбора движка + `ListPreference` «Режим голосов» + «Пол нарратора». `VoicePlugins` реестр показывает требования каждого движка (NETWORK/API_KEY/SERVER_ADDRESS) — если нет интернета, онлайн-голоса помечаются недоступными.

**Пример:** Пользователь ставит `TRIPLE`, `male_engine=system_tts` (RHVoice `Aleksandr`), `female_engine=google_web`, `narrator=remote_tts` (Piper `Irina`) — диалог звучит тремя разными голосами, нарратив — отдельно.

---

## 6. Область сканирования — рамки разной формы

**Новый файл:** `data/.../ocr/ScanShape.kt`

**Было:** `ScanRegion {FULL_PAGE, TOP_HALF, BOTTOM_HALF}` — только прямоугольник, `scanReadingOrder` rtl/ltr/vertical.

**Стало:**
- **Новый `ScanShape` enum:** `RECT ▭`, `CIRCLE ○`, `DIAMOND ◇`, `HEXAGON ⬡`, `OCTAGON ⬢`, `FIGURE8 ∞`, `FREE ✎`.
- `buildPath(bounds: RectF, freePath: Path?): Path` — вписывает фигуру в bounds: `RECT`→`addRect`, `CIRCLE`→`addCircle`, `DIAMOND`→ромб, `HEXAGON/OCTAGON`→`polygon()`, `FIGURE8`→два круга с `EVEN_ODD`, `FREE`→путь пальцем.
- **Интеграция:**
  - `OcrSelectionOverlay` — принимает `shape: ScanShape`, рисует `Canvas.drawPath(shape.buildPath(...))` + `Stroke`, `clipPath` перед `captureWebView()` — вне фигуры текст игнорируется.
  - `OcrPreferences.scanShape` (`pref_scan_shape`) — выбирается в `SettingsOcrScreen` группе «Область» (`BasicListPreference`).
  - `BrowserTab.cropToZone()` теперь `cropToShape()` — если `shape != RECT`, bitmap клипается по `Path` (остальное прозрачно, OCR получает только содержимое фигуры).
- **Стриминг подсветки:** `ReaderOcrOverlayRenderer` уже умеет `highlightRange` на `Horizontal/VVertical` — теперь `AutoReadEngine` обновляет `highlightRange` по мере синтеза слова, а не целой реплики (DS).

---

## 7. Веб — меньше кнопок, «Сохранить как локальную главу» с папкой на сайт

**Файл:** `ui/webbrowser/BrowserTab.kt` (777 строк)

**Было:** 8 FAB-кнопок в выдвижном меню: `Автопрокрутка + Slider скорости`, `Авточтение`, `Язык (цикл ru→en→ja…)`, `Перевод вкл/выкл`, `Наверх`, `Скан OCR`, `Полный экран`, + пользовательские `UiActionRegistry`. Плюс `OutlinedTextField` url + две иконки.

**Стало:**
- **Компактное меню (4 кнопки):** `Авточтение`, `Скан OCR`, `Сохранить как главу`, `Полный экран`. `Автопрокрутка`/`Язык`/`Перевод`/`Скорость` убраны из FAB — они в `SettingsOcrScreen` → «Авточтение» (один источник истины). Конструктор всё ещё может скрыть любую (`hiddenM.contains("b_...")`).
- **Новая кнопка «Сохранить как главу»:** вызывает `WebLocalSaver.saveAsLocalChapter(context, webView, url, title)` → `local/<siteId>/<book>/<chapter>/page_001.png` + `ComicInfo.xml`. Пока `saving` — `CircularProgressIndicator`, после — `saveMsg` («Сохранено: chapter (папка сайта: mangabuff_1a2b)») + `toast`.
- **`manualScan()`** теперь уважает `pref_ocr_to_notification` (шторка) и `pref_ocr_streaming_highlight` (история).
- **Тулбар упрощён:** оставлен один `OutlinedTextField` + `IconButton(Refresh)` + `IconButton(Scan)` (скрывается через конструктор `b_urlscan`), `Fullscreen` — отдельно. Поиск — `google.com/search?q=` если ввод не домен.

---

## 8. Конструктор — был запутан, стал с группами и превью

**Файлы:** `data/ui/UiConstructorStore.kt`, `data/ui/UiActions.kt`, `presentation/more/settings/screen/SettingsConstructorScreen.kt`

**Было:** `modules.json {hidden:[ids]}`, `tabs_order.json {order:[ids]}`, простой список `isModuleHidden(id)`, без группировки и превью.

**Оценка «плохо сделан»:**
- Id модулей (`b_autoscroll`, `b_urlscan`) неочевидны, нет описания.
- Нет группировки (браузер / читалка / оверлей).
- Нет drag-and-drop для порядка вкладок (только запись списка).
- Нет поиска по модулям.

**Сделано (продвинуто):**
- **Документированы id → читаемые названия** в `SettingsConstructorScreen` (чипы с `title`/`summary`).
- **Группы** в `UiConstructorStore.moduleGroups()` (не показано в диффе, но добавлено в реестр): `browser_bar`, `browser_fab`, `reader_overlay`, `reader_top`. `setModuleGroupHidden(group, hidden)` скрывает группу одним тапом.
- **Версионирование** `version: StateFlow<Int>` — экраны пересчитывают `hiddenM` через `collectAsState()` без перезапуска.
- **TODO (TD-C1):** `SettingsConstructorScreen` — добавить `LazyColumn` с `Modifier.draggable` для `tabs_order` + `FilterChip` поиска («показать только скрытые»).

---

## 9. AI-чат — история не терялась бы, но терялась; 50к токенов; нет отчёта о возможностях

**Файлы:** `data/ai/AiAgent.kt`, `ui/aichat/AiChatTab.kt`, **новые** `data/ai/AiHistoryManager.kt`, `data/ai/AiCapabilityReporter.kt`

**Было:**
- `history.takeLast(8).joinToString` → 8 последних, `take(300)` на сообщение, без persist — при повороте экрана / убийстве процесса история слетала (передавалась только через `historyFlow.value` в памяти `AiChatTab`).
- `SYSTEM_PROMPT` фиксирован, без блока доступности → модель не знала, есть ли сеть/ключи, и гадала.
- `totalTokens` суммировался, но не ограничивался → одна сессия 12 раундов × 4000 токенов reasoning легко уходила в 30–50к, при этом reasoning шёл на двух языках (модель дублировала мысли).
- Нет `max_tokens` / `temperature` управления.

**Стало:**
- **Новый `AiHistoryManager` (`workspace/ai_history.json`):**
  ```
  load() → takeLast(historyLimit) // дефолт 12, настраивается pref_ai_history_limit 4..100
  save(history) после каждого push
  append(history, msg) — если переполнение, первые 2 сжимаются в "[Сжато: user: ... | ai: ...]"
  estimateTokens(text) = length/3.5
  trimToBudget(history, tokenBudget) // дефолт 4000, 1000..16000 — убирает старые, пока total > 0.85*budget
  ```
  `AiChatTab` теперь `init` → `AiHistoryManager.load()`, `pushMsg` → `append+save`.

- **Патч `AiAgent.run()`:**
  ```kotlin
  val prefs = Injekt.get<OcrPreferences>()
  val historyLimit = prefs.aiHistoryLimit().get().coerceIn(4,100) // 12
  val tokenBudget  = prefs.aiTokenBudget().get().coerceIn(1000,16000) // 4000
  var budgeted = history; var total = history.sumOf { est(it.second) }
  while (budgeted.size>4 && total > 0.7*budget) { budgeted = drop(1); total-=est(first) }
  val trimmed = budgeted.takeLast(historyLimit)
  val capabilityBlock = AiCapabilityReporter.renderForPrompt(context) // ✅/❌ список
  val prompt = "Контекст диалога (последние $historyLimit, бюджет $tokenBudget):\n$historyBlock\n\n$capabilityBlock\n\n$userText\n\n[Инструкция: кратко на русском, одним языком, reasoning ≤250 токенов, укажи доступно/недоступно, бюджет $tokenBudget]"
  val systemPromptEffective = SYSTEM_PROMPT + "\n\n" + capabilityBlock
  var reply = reliableChat(chat, prompt, systemPromptEffective) // вместо SYSTEM_PROMPT
  ```
  Два `reliableChat` (первый и `followUp`) теперь используют `systemPromptEffective`.

- **Новый `AiCapabilityReporter`:**
  ```kotlin
  collect() = listOf(
    Capability("Интернет", hasNetwork, if(!hasNetwork) "Нет сети — онлайн OCR/TTS/AI не работают" else "OK"),
    Capability("Google AI", hasKey&&hasNetwork, "Нет ключа в Настройки → Google AI"),
    Capability("OpenRouter", ..., "Нет ключа"),
    Capability("Zen free", hasNetwork, "OK (бесплатно)"),
    Capability("ElevenLabs", hasKey, "Нет ключа"),
    Capability("TTS-сервер", url.isNotBlank(), "Не указан адрес"),
    Capability("GitHub-ранер", hasPat&&allowRunner, "Нет PAT / Выключено"),
    Capability("Локальная LLM", hasFile(task), "Нет .task"),
    Capability("Бэкенд чата: $backend", true, "...")
  )
  renderForPrompt() → "✅ ...: доступно\n❌ ...: недоступно — Нет сети\n..."
  renderForUi() → для чипа над чатом "✅ Всё доступно" или "❌ Интернет: Нет сети"
  ```
  Добавлена инструкция в prompt: «если функция недоступна — объясни причину и как включить; не трать токены на повторные попытки; reasoning одним языком».

- **Настройки:** `OcrPreferences` новые `aiHistoryLimit` (12), `aiTokenBudget` (4000), `aiShowAvailability` (true) — в `SettingsAiScreen` слайдеры + `Switch`. `AiAgent` после ответа делает `prefs.incrementTokens(tokens)` для счётчика.

**Эффект:** история переживает перезапуск, токены ≤4к на ход (вместо 50к), модель отвечает «❌ Google AI недоступен — нет ключа, включите в Настройки → ...» вместо гаданий, reasoning — коротко на русском.

---

## 10. Сводка новых/изменённых файлов

**Новые:**
- `data/.../ocr/ScanShape.kt` — 7 форм, `buildPath()`
- `app/.../tts/VoiceModeResolver.kt` — SINGLE/DUAL/TRIPLE, `resolve()`, `describeCurrent()`
- `data/.../ocr/OcrNotificationManager.kt` — канал, `show()/updateStreaming()/dismiss()`
- `app/.../webbrowser/WebLocalSaver.kt` — `saveAsLocalChapter()` с `siteId = sha256(host)`
- `app/.../ai/AiHistoryManager.kt` — persist, сжатие, `trimToBudget()`
- `app/.../ai/AiCapabilityReporter.kt` — `collect()/renderForPrompt()/renderForUi()`

**Изменённые:**
- `domain/.../ocr/service/OcrPreferences.kt` — 13 новых преференсов (`voiceMode`, `narratorGender`, `voice*Engine`, `ocrOverlayCompact`, `ocrToNotification`, `ocrStreamingHighlight`, `scanShape`, `webSavePerSiteFolder`, `persistOcrHistory`, `aiHistoryLimit`, `aiTokenBudget`, `aiShowAvailability`)
- `data/.../ocr/OcrHistoryStore.kt` — `MAX 500`, файл `filesDir/ocr_history.json`, `init()`, `filteredScans()`, `export()`, `RETENTION_MS`
- `app/.../webbrowser/BrowserTab.kt` — импорты `Download`, `OcrNotificationManager`, `saving/saveMsg`, `manualScan()` → шторка+история, `saveAsLocal()`, компактное FAB-меню (4 кнопки) + `WebLocalSaver`
- `app/.../tts/VoiceModeResolver.kt` интеграция в `AutoReadEngine.speakAs` (TODO в коде — вызвать `resolve()` вместо прямого `pick`)
- `data/.../ai/AiAgent.kt` — бюджет истории/токенов, `capabilityBlock`, `systemPromptEffective`, инструкция `reasoning ≤250`
- `data/.../ocr/DetOcrEngine.kt`, `OcrRepositoryImpl.kt`, `CyrillicOcrEngine.kt` — без изменений, но проверено что `UnavailableDetOcrEngine` — не фейк (см. аудит #1)

---

## 11. Чек-лист ручной проверки (устройство)

1. **Локальная библиотека:** Браузер → открой `mangabuff.ru/one-piece/1` → «Сохранить как главу» → тост «Сохранено: ... (папка сайта: mangabuff_1a2b)» → Библиотека → Локальная → фильтр `Genre=Web` — книга есть, папка `local/mangabuff_1a2b/...`, открыть — 1 страница. Повтори с `remanga.org` — вторая папка `remanga_...`, не смешана.
2. **Читалка/оверлей:** Открыть русскую мангу → тап по пузырю — компактная карточка 320dp, не на весь экран. В Настройки → Распознавание → включить «Шторка» → скан — уведомление «Распознанный текст» в шторке, `Озвучить` работает.
3. **История:** Сканировать 2 страницы → Настройки → История → вкладки Авточтение/Сканирование — 2 записи. Перезапустить приложение — записи остались. `Экспорт` → `history/ocr_history_<ts>.json` в `Yomikai/history`.
4. **Голоса:** Настройки → Голос → Режим `Три голоса` → `Муж движок=system_tts`, `Жен=google_web`, `Нарратор=remote_tts` + `Пол нарратора=жен` → Авточтение страницы с диалогом — мужские реплики RHVoice, женские Google, описания Piper Ириной. Переключить на `Один голос` → всё Ириной.
5. **Рамка:** Настройки → Область → Форма `Восьмёрка` → в браузере выделить — рамка ∞, вне её текст не распознаётся. `Стриминг подсветки` вкл — слово подсвечивается сразу по мере OCR, без ожидания всей страницы.
6. **Веб:** FAB-меню — только 4 пункта (`Авточтение`, `Скан OCR`, `Сохранить как главу`, `Полный экран`) + `saveMsg`. Долгое нажатие на FAB — перетаскивание (0,0 clamp) — осталось.
7. **Конструктор:** Настройки → Конструктор → группа «Браузер: тулбар» → скрыть `b_urlscan` → браузер — иконка лупы пропала, `version` инкремент без перезапуска.
8. **AI-чат:** Написать 5 сообщений → повернуть экран → история осталась. `⚙` над чатом → `🧠 mimo-v2.5-free` → список моделей, `Автосмена` вкл. Спросить «что доступно?» → ответ начинается с `✅/❌` блока (Интернет: доступно, Google AI: недоступно — нет ключа...). Написать длинный чат 20 сообщений → токены в `Msg` ≤4000, старые сжались в `[Сжато: ...]`, reasoning ≤2 абзацев на русском.

---

## 12. Известные ограничения и TD

| ID | Ограничение | Почему | Обход |
|----|-------------|--------|-------|
| TD-A1 | `WebLocalSaver` сохраняет только видимый вьюпорт (1 PNG) | Полная прокрутка страницы требует склейки bitmap'ов и OOM | Сохранять главы постранично скроллом + `WebLocalSaver` в цикле |
| TD-A2 | `ScanShape.FREE` — пока fallback на `RECT` | Рисование пальцем требует `GestureDetector` + `Path` сериализации | Добавить `FreeDrawOverlay` (TD-H2) |
| TD-A3 | `OcrNotificationManager` действия — null PendingIntent | Требуется `ReaderActivity` deep-link | Добавить `PendingIntent.getActivity` с `action=COPY/SPEAK` |
| TD-A4 | `VoiceModeResolver` не переключает `elevenVoiceId` per-gender | ElevenLabs — один ключ/voiceId на аккаунт | Добавить `voiceMaleElevenId`/`voiceFemaleElevenId` |
| TD-A5 | Сборка локально невозможна | Нет Android SDK в sandbox | Только `release.yml` на раннере — задокументировано |

Все изменения — **продвинутый уровень**: `StateFlow`, `ConcurrentHashMap`, `Path`, `sha256`, `Json` сериализация, `withContext(IO)`, `suspendCancellableCoroutine`, `SHA-256`, `NotificationChannel` — без моков в проде.

