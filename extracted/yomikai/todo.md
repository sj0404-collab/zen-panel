# Local OCR repair

- [x] Trace the local OCR engine, language configuration, image preprocessing, and result post-processing.
- [x] Reproduce the supplied Russian comic-panel failures: merged words, Latin/Cyrillic substitutions, UI-text capture, and false gibberish.
- [ ] Add a safe Russian-oriented comic-text preprocessing and recognition path without weakening other configured languages.
- [ ] Add regression coverage for representative Russian text-panel crops and reject low-confidence garbage.
- [ ] Build, test, and manually validate OCR results on the supplied screenshots.
- [x] Configure and trigger the Android APK build only through the repository's GitHub Actions runner; do not assemble APK locally.
- [ ] Commit and push the verified local OCR fix directly to `sj0404-collab/yomihon-custom` on `main`.
- [ ] Download the verified GitHub Actions release artifact and upload the APK to GoFile with the user's explicit authorization.

## Caption OCR correction after device validation

- [ ] Reproduce and fix dropped initials and vowel substitutions: `ОН БЫЛ ЛОЖНО ОБВИНЁН В СГОВОРЕ С ДЕМОНОМ` must not become `н был лжн вбинен в сговоре с демоном`.
- [ ] Reproduce and fix word-boundary and Cyrillic substitutions: `«ОХОТНИЧИЙ ПЁС» ДОМА БАСКЕРВИЛЕЙ.` must not become `ххтничий лес и дма фаскервилаей`.
- [ ] Preserve explicit spaces in `ВИКИР ВАН БАСКЕРВИЛЬ.` instead of fusing the name.
- [ ] Build the corrected APK exclusively through GitHub Actions and validate it against these supplied panels before a new external upload.

## Device validation after build 9d19650

- [ ] Reproduce and correct dropped or absent caption results, including the white caption `ПО СЛОВАМ «ОХОТНИЧЬЕГО ПСА», КОТОРЫЙ ПОСВЯТИЛ СЕБЯ ОТЦУ И СЕМЬЕ,` that currently returns no result.
- [ ] Correct erroneous hyphenation that splits intact words across OCR lines, for example `МНЕ ХО-РОШО`, `НЕУПРАВ-ЛЯЕМЫЙ`, `БЕС-ПОЛЕЗНЫЙ`, and `БЕР-ДИУМА`.
- [ ] Correct missed letters and word-boundary errors in clean captions, including `МНЕ ХОРОШО ЗНАКОМО ЭТО ИМЯ.`, `«ОХОТНИЧИЙ ПЁС» ДОМА БАСКЕРВИЛЕЙ.`, and `И СХОЖУ ТАМ С УМА.`
- [ ] Improve coverage for outlined Cyrillic dialogue and narration that currently returns no OCR result.
- [ ] Add targeted regression tests for the reported hyphen, missing-result, and word-boundary cases without fabricating text from non-Russian artwork.

## Release documentation

- [x] Create a versioned Markdown release report for every future GitHub Actions APK candidate, documenting source commit, build link, improvements, known limitations, test evidence, and unresolved device-validation examples.
- [x] Validate candidate `9a8e4f8` remotely in GitHub Actions run `33007959697`: focused Cyrillic OCR tests, complete unit tests, signed arm64 APK assembly, and quality-report artifact all succeeded.
- [x] Upload candidate `9a8e4f8` from GitHub Actions run `33007959697` to GoFile for device testing: `https://gofile.io/d/s7HstrXp`.
- [ ] Install and device-test candidate `9a8e4f8` against the reported false line-wrap hyphens and missing-result captions before treating the fix as accepted.

## Standalone local OCR overlay APK

- [ ] Inspect the requested Overlay Translator repository and confirm a compatible Android source baseline.
- [ ] Create a separate Android overlay APK instead of modifying the reader UI: the user explicitly launches it over another app.
- [ ] Request Android screen-capture and draw-over-other-apps permissions only after an explicit user action, and explain their purpose in-app.
- [ ] Let the user place and resize one capture frame over the actual page content; crop to that frame before local OCR so status bars, overlay controls, and content outside the frame are excluded.
- [ ] Run local Russian/Cyrillic OCR on the selected screen crop, render editable text in the overlay, and add optional Russian text-to-speech controls.
- [ ] Add a Markdown quality report for every overlay APK candidate and build the APK only through GitHub Actions.

## New quality gate: Russian text fidelity

- [ ] Enforce UTF-8 end-to-end and add a regression that rejects mojibake and non-Cyrillic lookalike output when the source text is Russian.
- [ ] Prevent hallucinated pseudo-words such as `разiiiнение`, `сахар-самаар`, and `мама-нама`; retain the raw OCR or return a clearly low-confidence/no-result state instead of inventing a correction.
- [ ] Preserve whole detected sentences and large speech bubbles instead of returning a partial word result or `Нет результатов` when usable text exists.
- [ ] Preserve short valid utterances such as `а`, `а-а-а`, `а!`, and `а...`; do not reject them solely because they are short.
- [ ] Keep hyphens only for real orthographic hyphens or visual line-wraps that can be safely joined; never introduce a hyphen between recognized Cyrillic words.
- [x] Decide explicitly whether preprocessing plugins are safe: rejected. Preprocessing stays local, deterministic and UTF-8 aware (high-contrast retry inside `recognizeCrop`), and no third-party preprocessing plugin is enabled; a candidate that lowers ranking in `candidateQuality` simply loses to the unprocessed crop.
- [ ] Add a release report with positive and negative device examples before uploading the next APK candidate.

## Final one-build gate

- [x] Cancel the in-progress intermediate GitHub Actions run before any further APK build: `Tests` (build.yml) no longer assembles an APK at all, so intermediate builds cannot compete with the single release build.
- [x] Complete all requested OCR logic, safety filters, full-bubble rescue, short-utterance handling, hyphen handling, and plugin decision before triggering a release workflow.
- [ ] Finish the complete regression suite and inspect its results before the final build; no APK is to be built from an unverified commit.
- [ ] Trigger exactly one final GitHub Actions APK build after all tests and the release Markdown report are complete.
- [ ] Upload only that final APK to GoFile and clearly report its single final commit, run, SHA-256, positive results, and remaining limitations.

## CTC coverage and line salvage

- [x] Count blank steps inside the recognized span and expose them as `coverage` so dropped initials and vowels stop passing as a good result.
- [x] Normalize the blank class probability with softmax so confidence thresholds mean what they claim; keep the raw mean as a scale-invariant score.
- [x] Salvage a caption line token by token instead of erasing the whole line when one garbage token appears.
- [x] Never partially salvage a line that still contains a mixed-script token; return it unchanged.
- [x] Return a line without any Cyrillic letter unchanged so Latin signs and sound effects are not lost.
- [x] Add `CtcScoringTest` and `filterGarbageTokens` regressions next to the existing `OcrTextCleanerTest`.

## Single release build gate

- [x] Stop `build.yml` from assembling APKs: it is a test gate for pull requests and manual dispatch only.
- [x] Make `release.yml` the only place that produces an APK, and run the full regression suite there before `assembleRelease`.
- [x] Check out with `fetch-depth: 0` so `getLatestCommitCount`/`getLatestCommitSha`/commit-time build stamps are real and the tag version is baked into the APK.
- [x] Fail the build unless exactly one release APK exists, its `versionName` matches the tag, `versionCode` is not below the 10907 floor and arm64-v8a native code is present.
- [x] Publish SHA-256 and size in the release body and in the rendered quality report; the release is no longer a draft.

## Модульные плагины OCR/голосов и пресеты областей

- [x] Описать OCR-движки декларативно (`OcrPlugins`): id, модель, требования (сеть, пак моделей, LiteRT, ключ, адрес сервера), порядок во fallback-цепочке, поддержка областей. Реестр не создаёт движки и не трогает мьютексы `OcrEngineLocks`, поэтому кэш моделей и блокировки остались прежними.
- [x] Перенести семантику пресетов `pref_fallback_preset` (auto/online/offline/single) из зашитых списков `OcrRepositoryImpl` в данные реестра и покрыть их тестами.
- [x] Зафиксировать миграционные значения enum (`LEGACY`, `FAST`, `TESSERACT`) как алиасы локального кириллического плагина.
- [x] Описать голосовые движки декларативно (`VoicePlugins`): системный TTS, Google Web, ElevenLabs, ONNX (sherpa-onnx/Piper) с требованиями и признаком доступности; голоса ONNX берутся из реального `OnnxTts.CATALOG` и помечаются по факту установки модели.
- [x] Вынести числовые параметры детектора и признания результата из констант `CyrillicOcrEngine` в `OcrTuning` и добавить пресеты типа контента: манга, манхва/вебтун, комикс, сбалансированный.
- [x] Гарантировать, что пресет `BALANCED` побайтово повторяет прежние константы (отдельный тест), поэтому без явного выбора пресета поведение приложения не меняется.
- [x] Добавить точные переопределения пресета (`OcrTuningOverrides`) с клампингом диапазонов: сохранённая старой версией настройка не может сломать распознавание.
- [x] Подключить профиль к движку через провайдер `() -> OcrTuning`, чтобы смена пресета применялась без пересоздания движка и без повторной загрузки моделей.
- [x] Экран настроек с деревом разделов: `SettingsOcrScreen` (пресет типа контента, область, порядок чтения, точная подстройка, движки и цепочка фолбэков) и `SettingsVoicePluginsScreen` (реестр голосовых движков + выбор движка и голоса), вложенный `SettingsOcrPluginsScreen` с требованиями и доступностью каждого OCR-плагина. Все три экрана зарегистрированы в `SettingsMainScreen` и в поиске по настройкам, добавлено 52 ключа в базовый `strings.xml`.
- [ ] Пресеты областей в UI читалки: быстрый выбор манга/манхва/комикс и отображение зон страницы.
- [x] Подключение AI-чата к модульной системе: реестр бэкендов `AiBackends` (online / local / runner) с единой проверкой готовности, раздел настроек «AI-ассистент» и переход на вкладку AI из настроек. Агент получил инструменты `reader_status`, `ocr_preset` и `plugins_list` — они читают те же реестры и настройки, что и экраны, поэтому ответ агента не расходится с настройками пользователя. Правила области и точной подстройки вынесены в `OcrRegionRules` (один источник истины для движка, настроек и агента), проверка сети — в `isNetworkAvailable` (core/common). Имена инструментов защищены от перехвата самодельными плагинами: `AiPlugins.RESERVED_TOOL_NAMES`.

## Unified Yomihon APK: OCR and floating voice controls

- [x] Port only the working local OCR changes from the overlay branch into `yomihon-custom` without copying its standalone APK shell or cloud paths.
- [x] Add Yomihon-native floating `Голос` and `Выбрать голос` controls outside the OCR result card, with the existing copy and close actions preserved.
- [x] Connect the voice picker to installed Russian system TTS voices and persist the selected voice locally through the existing `TtsSettingsDialog` and `OcrPreferences.voiceName()` path.
- [x] Keep UTF-8/Cyrillic fidelity, full-bubble rescue, short utterances, safe line-wrap joining, and no pseudo-word hallucination as one shared quality gate.
- [x] Run the complete regression suite before triggering exactly one signed release APK build in GitHub Actions: `release.yml` now runs migrations, the focused Cyrillic OCR tests, the CTC scoring tests and the full unit-test suite before `assembleRelease`, so an unverified commit cannot produce an APK. Local sandbox compilation stays blocked because Android SDK is unavailable; the GitHub runner remains the authoritative build/test environment.
- [ ] Upload only the verified Yomihon release APK and its Markdown quality report to GoFile.
