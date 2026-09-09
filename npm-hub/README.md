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

## Запуск в GitHub Actions

Workflow `hub.yml` (вкладка «Сессии» в панели → Hub → Linux/Windows):

1. Ставит все CLI одним вызовом `npm` (параллельные скачивания; при
   ошибке — поштучный fallback, чтобы один переименованный пакет не
   отменял остальные; недостающее всё равно стартует через `npx -y`).
2. Поднимает хаб (`npm ci` + `node src/server.js`), открывает туннель.
3. Публикует адрес в `session-hub.json` ветки `session-state`
   (и в summary рана) — панель подхватывает его автоматически.

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
  `goose`, `qwen`, `koda`, `openclaude`, `openrouter`, `ccb`, `agent`,
  `http-server`) с версиями; запуск любого в новой PTY-сессии из
  дашборда, сайдбара, файлменеджера или модалки «Новая сессия».
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
  У каждого хранилища свой id вида `тип-xxxxx` (например,
  `github-mtt2yqt7`); старые id вида `тип:репо` продолжают открываться.
  Неизвестный id — громкая ошибка `unknown backend`, а не молчаливый
  корень локального диска.
- **GitHub в один клик**: авторизация по токену (`🔑`, `POST
  /api/git/auth`), просмотр репозитория как хранилища без клона,
  кнопка ▶ — склонировать (`~/repos/<name>`) и сразу открыть как
  локальное хранилище (`POST /api/storages/clone`).
- **Туннели**: ngrok / localtunnel / cloudflared, URL в топбаре.

## API (кратко)

```text
GET  /api/tools /api/info /api/networks /api/drives /api/devices
GET  /api/browse?backend=<id хранилища>&path=
POST /api/fs/mkdir /api/fs/delete /api/fs/rename /api/fs/read /api/fs/write /api/fs/upload
GET  /api/fs/download?backend=&path=
GET  /api/storages        POST /api/storages/add /api/storages/remove /api/storages/clone
POST /api/adb/connect /api/adb/disconnect   GET /api/adb/info?device=
POST /api/git/auth        POST /api/git/clone
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
