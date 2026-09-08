# NPM Hub

Локальный хаб для AI CLI-инструментов: дашборд установленных npx-пакетов,
терминалы (xterm + node-pty) с вкладками-сессиями, файловый менеджер с
кучей бэкендов (local/ADB/FTP/GDrive/GitHub/HTTP/WebDAV), реестр моделей
всех провайдеров с живым обновлением каталогов, пробами моделей и
мониторингом доступности.

- Desktop UI: `http://localhost:8090/d`
- Mobile UI: `http://localhost:8090/m`
- Launcher: `http://localhost:8090/`

## Запуск

```bash
npm install
node src/server.js            # локально
node src/server.js --tunnel=localtunnel   # + публичный URL
```

Windows: `launch.bat` или `NPM Hub.bat` (меню: local/network/ngrok/cloudflare/localtunnel).

Порт по умолчанию `8090` (`PORT=...` для смены; занятый порт
автоматически сдвигается вверх).

## Env

| Переменная | Назначение |
|---|---|
| `PORT` | порт сервера |
| `OPENROUTER_API_KEY` | ключ OpenRouter (или 🔑 в UI → `~/.npm-hub/keys.json`) |
| `OPENCODE_BASE_URL` | override Zen API (по умолчанию `https://opencode.ai/zen/v1`) |
| `OPENROUTER_BASE_URL` | override OpenRouter API |
| `OLLAMA_BASE_URL` | override Ollama (`http://localhost:11434/v1`) |
| `NGROK_AUTHTOKEN` | токен ngrok (или файл `~/.npm-hub-ngrok-token`) |

Никаких ключей в коде нет и быть не должно. Если ключ когда-то попал в
исходники — отзовите его у провайдера и выпустите новый.

## Что умеет

- **Инструменты** (`/api/tools`): автоопределение установленных CLI
  (`opencode`, `claude`, `gemini`, `codex`, `crush`, `copilot`, `aider`,
  `goose`, `qwen`, `koda`, `openclaude`, `ccb`, `agent`, `http-server`)
  с версиями; запуск любого в новой PTY-сессии из дашборда, сайдбара,
  файлменеджера или модалки «Новая сессия».
- **Терминал**: вкладки, zoom, fullscreen, SIGINT/Esc/вставка, рестарт;
  в PTY пробрасываются `MODEL` и ключ провайдера выбранной модели.
- **Модели**: единый реестр free+paid (OpenCode Zen/Go, OpenRouter,
  Anthropic, OpenAI, Google, DeepSeek, xAI, Mistral, Groq, Perplexity,
  Xiaomi, Zhipu, MiniMax, Moonshot, Cerebras, Together, DeepInfra,
  NVIDIA, HuggingFace, GitHub Models, Qwen, StepFun, SiliconFlow,
  Ollama). Выбор модели синхронизируется в конфиги CLI-инструментов.
- **Живые каталоги**: Zen `/models`, OpenRouter `/models` и Ollama
  `/api/tags` подтягиваются при старте и каждые 30 минут
  (`🌐 Обновить каталоги`, `POST /api/models/refresh`), кэш —
  `~/.npm-hub/live-models.json`.
- **Пробы** (`🧪`, `POST /api/models/test`): микро-запрос к модели,
  ответ `{ok, ms, error}`. Только OpenAI-совместимые API.
- **Мониторинг** (`/api/health`, stat на дашборде, опрос раз в минуту):
  доступность и задержка каждого провайдера + сам сервер
  (uptime/RAM/сессии).
- **Файлы**: browse/mkdir/delete/rename/read/write/download/upload,
  устройства (локальные диски, ADB), подключаемые хранилища.
- **Туннели**: ngrok / localtunnel / cloudflared, URL в топбаре.

## API (кратко)

```text
GET  /api/tools /api/info /api/networks /api/drives /api/devices
GET  /api/browse?backend=&path=
POST /api/fs/mkdir /api/fs/delete /api/fs/rename /api/fs/read /api/fs/write /api/fs/upload
GET  /api/fs/download?backend=&path=
GET  /api/storages        POST /api/storages/add /api/storages/remove
POST /api/adb/connect /api/adb/disconnect   GET /api/adb/info?device=
GET  /api/models[?freeOnly=true] /api/models/full /api/models/current /api/providers
POST /api/models/select /api/models/key /api/models/apikey /api/models/freeonly
POST /api/models/refresh  POST /api/models/test   GET /api/health
GET  /api/path-history    POST /api/path-history /api/last-dir
GET  /api/tunnel          GET/POST /api/ngrok-token
WS   /ws  {open,input,resize,kill,close}
```

Ключи наружу не отдаются: API возвращает только маскированные
превью (`keyMasked`) и флаги `hasKey`/`configured`.

## Безопасность

Доступа по паролю нет: сервер слушает `0.0.0.0` ради телефона в LAN,
любой в сети получает shell. Не публикуйте URL туннеля, не запускайте
в недоверенных сетях. Весь shell-стринг с пользовательским вводом
(ADB/FTP) санитизируется, но модель угроз — «доверенная локалка».
