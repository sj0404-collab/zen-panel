# Zen Panel

Android-панель и GitHub Actions для Zen Agent, OpenCode, NPM Hub и удалённых столов Linux/Windows.

Репозиторий самодостаточный: панель, агент (`agent/zen-agent.js`), хаб и workflow живут здесь. Панель поднимает сессии через `workflow_dispatch` в этом репозитории (или в вашем форке).

## Что внутри

- Android WebView-оболочка и панель в `app/src/main/assets/panel/`
- CLI-агент и веб-хаб (`agent/`)
- NPM Hub — дашборд CLI-инструментов, терминалы и файловый менеджер (`npm-hub/`, доки: `npm-hub/README.md`)
- Десктопная оболочка для Windows/Linux в `desktop/` (Electron, те же страницы панели)
- Workflow:
  - `agent.yml` — CLI-агент на Linux/Windows, туннель, чат в оверлее
  - `opencode.yml` — OpenCode web на Linux/Windows, туннель, чат в оверлее
  - `hub.yml` — NPM Hub на Linux/Windows, установка CLI одним вызовом npm, туннель, адрес в `session-hub.json`
  - `desks.yml` — столы Linux (noVNC) и Windows (MJPEG)
  - `panel-apk.yml` — сборка APK и GitHub Release (`v1.{commits}`, versionCode растёт сам)
  - `desktop.yml` — сборка ПК-версии и GitHub Release (`desktop-v1.{commits}`: `.exe` / `.AppImage` / `.deb`)
  - `js-syntax.yml` — `node --check` всего JS (`agent/`, `desktop/`, `npm-hub/`) на каждый push/PR

## Как пользоваться

1. Добавьте GitHub-токен с правами `repo` и `workflow`.
2. На вкладке «Сессии» запустите стол, CLI-агент, OpenCode или NPM Hub (Linux/Windows на выбор).
3. После старта панель сама откроет веб-чат в оверлее. Поле «Первая команда» уходит в чат сразу (`?q=` у CLI, `opencode run --attach` у OpenCode).

Адрес сессии публикуется в ветке `session-state` — у каждого типа свой файл на ОС: `session-agent-linux.json`, `session-agent-windows.json`, `session-opencode-linux.json`, `session-opencode-windows.json`, `session-hub-linux.json`, `session-hub-windows.json`, `session-linux.json`, `session-windows.json` (плюс старые `session-agent.json`, `session-opencode.json`, `session-hub.json` и общий `session.json` для совместимости).

## Вкладки панели

- **Сессии** — запуск новых сессий и список живых: агент, OpenCode, хаб, столы Linux/Windows. После старта адрес открывается сам.
- **Actions** — живые логи workflow: вотч выбранного рана с автообновлением.
- **APK** — обновление приложения: на Android ищет релиз `v1.N` с `.apk`, на ПК — `desktop-v1.N` под вашу ОС.

Панель бережёт квоту GitHub API: опрос идёт не чаще раза в 5 секунд, а при ответе 403 (лимит/антиабот) ожидание и вотч встают на паузу и показывают время снятия бана — и не долбят API сквозь него.

## NPM Hub

Дашборд AI CLI-инструментов: автоопределение установленных пакетов, запуск любого в терминале (xterm + PTY), файловый менеджер с бэкендами local/ADB/FTP/GDrive/GitHub/HTTP/WebDAV, реестр моделей всех провайдеров с живыми каталогами, пробами и мониторингом.

Запуск с панели: вкладка «Сессии» → Hub → Linux/Windows. Ран ставит CLI одним вызовом `npm`, поднимает хаб, открывает туннель и публикует адрес в `session-hub.json` (и в summary рана).

Локально:

```bash
cd npm-hub && npm install && node src/server.js   # http://localhost:8090/ (d — десктоп, m — мобильный UI)
```

Подробности — в `npm-hub/README.md`: env-переменные, API, модель id хранилищ (`github-xxxxx`), клонирование репозитория в один клик (▶).

## OpenCode — какой адрес открывать и как выбрать веб-интерфейс

`opencode serve` в workflow запускается с `--hostname 127.0.0.1`, поэтому **порт 4096 доступен только на самом раннере** и по сети не открывается. Снаружи нужен **gateway** (`agent/oc-gateway.js`), который слушает `0.0.0.0` и отдаёт один origin (интерфейс + API), проксируя на сервер.

Gateway умеет **два режима** (переменная `OC_UI`):

- `OC_UI=web` (**по умолчанию**) — **оригинальный веб OpenCode**. Сам `opencode serve` уже отдаёт настоящий веб-SPA на `/`, поэтому gateway просто обрабатывает `/` как обычно. Это полный веб-интерфейс, как в браузере.
- `OC_UI=mobile` — **лёгкий мобильный чат** (`agent/oc-mobile.html`, «Это лёгкий чат, не веб OpenCode»). Раньше был по умолчанию; оставлен как опция для слабых телефонов.

Как открыть:

- **Через GitHub Actions (туннель).** На вкладке «Сессии» для OpenCode задай `UI: web` (по умолчанию `web`) или `mobile` — выбор есть в `workflow_dispatch`. После старта в панели появится адрес вида `https://…trycloudflare.com/`. Это адрес gateway — открой его в браузере (web) или вставь в OpenCode Mobile `<Client>` (mobile). `agentUrl` из `session-opencode.json` — тот же адрес.
- **По LAN (свой сервер/ПК в домашней сети).** Запусти стек скриптом:
  ```bash
  PATH="$HOME/.local/node_modules/.bin:$PATH" tools/oc_lan_start.sh          # оригинальный веб
  PATH="$HOME/.local/node_modules/.bin:$PATH" OC_UI=mobile tools/oc_lan_start.sh   # мобильный чат
  # поднимет opencode serve на 127.0.0.1 и gateway на 0.0.0.0,
  # затем напечатает адрес:  http://<LAN-IP>:4100/
  ```
  Открой `http://<LAN-IP>:4100/` в браузере (web) или вставь в OpenCode Mobile `<Client>` (mobile). **НЕ** порт `4096` — он только localhost.

Остановить — `tools/oc_lan_stop.sh`. Gateway на LAN работает без пароля (`OPENCODE_SERVER_PASSWORD` не задан) — держи сеть доверенной или запускай через туннель.

## OpenCode и GitHub через токен (доступ к репозиторию)

Чтобы OpenCode-агент **сам подключался к GitHub по токену** и работал с твоим репозиторием (клон, чтение, запись, push):

- **Модели GitHub** появляются автоматически, как только в окружении `opencode serve` есть `GITHUB_TOKEN`/`GH_TOKEN` (провайдер `github-copilot`, ~30 моделей). Ручной логин не нужен.
- **Доступ к репозиторию** — агент должен работать внутри клона репо, а git должен авторизоваться токеном.

**По LAN / локально** — запусти стек так, чтобы он поднял агента в твоём репо и дал ему git-авторизацию:
```bash
export ZEN_GH_TOKEN=ghp_xxxx           # твой GitHub-токен (repo + workflow)
OC_REPO="sj0404-collab/zen-panel" \
  PATH="$HOME/.local/node_modules/.bin:$PATH" tools/oc_lan_start.sh
# скрипт: поднимет opencode serve в .zen-open/<repo> (склонирует его),
# настроит git через http.extraheader (token не хранится и не печатается),
# и агент сможет clone/push — без ручного входа в GitHub.
```

**В GitHub Actions** это уже работает из коробки: `opencode.yml` запускает `opencode serve` из клона репо (`fork`) и передаёт `GH_TOKEN`, а `actions/checkout` настраивает git-авторизацию. Агент сразу видит и пишет в репозиторий.

Проверка, что git-авторизация токеном работает (без вставки токена в URL):
```bash
git ls-remote https://github.com/<owner>/<repo>.git main   # должен вернуть SHA, не просить логин
```

`tools/oc_gh_auth.sh` — переиспользуемый хелпер: экспортирует `GITHUB_TOKEN`/`GH_TOKEN`, настраивает `http.https://github.com/.extraheader`, и опционально клонирует `OC_REPO` в заданную папку. Токен в конфиг не пишется (только base64 basic) и не выводится в лог.

## Панель для ПК (Windows / Linux)

Десктопный аналог Android-приложения — в `desktop/` (Electron). Показывает те же страницы из `app/src/main/assets/panel/`, дубликата интерфейса нет.

```bash
cd desktop && npm install && npm start
```

Сборка установщиков — `npm run dist:win` / `npm run dist:linux`, либо workflow `desktop.yml` (релизы `desktop-v1.N`). Панель сама предлагает нужный файл: на ПК вкладка обновлений ищет релиз `desktop-*` вместо APK.
