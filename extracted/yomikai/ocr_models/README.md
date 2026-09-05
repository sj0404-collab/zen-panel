# Офлайн-модели OCR для Yomihon

APK поставляется **без локальных моделей** — из коробки работают только онлайн-движки
(Zen Free, Google Lens, Gemini, OpenRouter, OwOCR). Локальные модели опциональны
и хранятся **снаружи приложения**, не увеличивая размер APK.

## Способ 1 — из приложения (рекомендуется)

**Настройки → OCR → Управление локальными OCR-моделями** — включите нужную модель,
файлы скачаются в `Android/data/app.yomihon/files/ocr_models/`.

## Способ 2 — вручную через папку

1. Создайте папку `Yomihon/OCR` на внутренней памяти (`/sdcard/Yomihon/OCR/`).
2. Скопируйте туда файлы моделей с такими именами:

| Файл | Модель | Источник (Hugging Face) |
| --- | --- | --- |
| `encoder.tflite` | Manga OCR encoder | `bluolightning/manga-ocr-tflite` → `mocr_2025_encoder_fp32.tflite` |
| `decoder.tflite` | Manga OCR decoder | `bluolightning/manga-ocr-tflite` → `mocr_2025_decoder_float32.tflite` |
| `embeddings.bin` | Manga OCR embeddings | `bluolightning/manga-ocr-tflite` → `mocr_2025_embeddings_float32.bin` |
| `encoder_fast.tflite` | Fast OCR encoder | `bluolightning/manga-ocr-mobile` → `v1_fp16/encoder.tflite` |
| `decoder_fast.tflite` | Fast OCR decoder | `bluolightning/manga-ocr-mobile` → `v1_fp16/decoder.tflite` |
| `panel_detector.tflite` | Panel Detector | `leoxs22/manga-panel-detector-yolo26n` → `manga_panel_detector_int8.tflite` |

3. Выберите локальную модель в **Настройки → OCR**.

Если файлы моделей отсутствуют — приложение автоматически и без крашей
использует онлайн-модели.
