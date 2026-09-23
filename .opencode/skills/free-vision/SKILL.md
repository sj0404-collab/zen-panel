---
name: free-vision
description: Use when the user asks to describe/analyze/read an image, screenshot, photo, or a picture in code without providing an API key. Covers free no-key vision models (OpenCode Zen mimo-v2-omni-free, Kilo 200 req/h, OVH 2 req/min, plus fallbacks). Use when asked "what's on the image", OCR of screens, UI mockups, diagram reading.
---

# Free vision models (no API key)

Бесплатные вижн-модели **без ключа и регистрации**. Проверено 22.09.2026 (живой запрос с изображением). Источник: `free-multimodal-models.txt` в корне репозитория.

## Правила
- Эндпоинты Kilo/OVH анонимные: **НЕ добавляй заголовок `Authorization`** (иначе 401).
- Изображение передаётся как data URL: `data:image/png;base64,....` (jpg → `data:image/jpeg;base64,...`).
- Парс ответа: `choices[0].message.content`. У Kilo может прийти `reasoning` — бери итоговый `content`.

## 0. OpenCode Zen (основной, внутри opencode)
Модель: `opencode/mimo-v2-omni-free` (текст + изображения + аудио).
- Бесплатно, без ключа, **только внутри opencode** (мы внутри — работает нативно).
- Базовый URL: `https://opencode.ai/zen/v1` (OpenAI-compatible).
- Используй нативно: `model: opencode/mimo-v2-omni-free`.

## 1. Kilo Code Gateway (внешний фоллбэк, 200 req/ч)
`POST https://api.kilo.ai/api/gateway/v1/chat/completions`

```bash
DATA_URL="data:image/jpeg;base64,...."
curl -s https://api.kilo.ai/api/gateway/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"stepfun/step-3.7-flash:free\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Опиши фото подробно\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"$DATA_URL\"}}]}],\"max_tokens\":3000}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['choices'][0]['message']['content'])"
```

Вижн-модели Kilo (`:free`):
- `stepfun/step-3.7-flash:free` — текст + изображения (основная)
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — + аудио
- `dots-studio/dots-3-note-preview:free`
- `inclusionai/ling-3.0-flash-vl:free` — бывает 429, повторить
- `nex-agi/nex-n2.5-pro:free`
- `inclusionai/ling-3.0-flash-sante:free`

## 2. OVHcloud AI (резерв, 2 req/мин)
`POST https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions`
- Модель: `Qwen2.5-VL-72B-Instruct` (текст + изображения, отвечает по-русски).
- Жёсткий rate-limit 2/мин: при 429 ждать 60+ сек.

```bash
curl -s https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"Qwen2.5-VL-72B-Instruct\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Опиши фото подробно\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"$DATA_URL\"}}]}],\"max_tokens\":1500}"
```

## 3. Резерв
- **VisionSter** (сторонняя обёртка, модель не раскрыта): `POST https://ahm7xmakki.com/api/imgchat` с JSON `{"userPrompt":"...","image":"data:image/jpeg;base64,...","messages":[...]}`. Агрессивный rate-limit.

## Не путать — текстовые (без вижн) в этих провайдерах
- Kilo текст: `nemotron-3-super-120b-a12b:free`, `nemotron-3-ultra-550b-a55b:free`, `z-ai/glm-5.2:free` (на картинку 404), `qwen/qwen3.8-27b:free`, `thinkingmachines/inkling-small:free`, etc.
- OpenCode Zen free текст: `deepseek-v4-flash-free`, `mimo-v2.5-free`, `kimi-k2.5-free`, `nemotron-3-ultra-free` — строго текст (вижн только `mimo-v2-omni-free`).