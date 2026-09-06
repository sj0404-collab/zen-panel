# Zen Panel

Android-панель и GitHub Actions для Zen Agent, OpenCode и удалённых столов Linux/Windows.

Репозиторий самодостаточный: панель, агент (`agent/zen-agent.js`), хаб и workflow живут здесь. Панель поднимает сессии через `workflow_dispatch` в этом репозитории (или в вашем форке).

## Что внутри

- Android WebView-оболочка и панель в `app/src/main/assets/panel/`
- CLI-агент и веб-хаб (`agent/`)
- Workflow:
  - `agent.yml` — CLI-агент на Linux/Windows, туннель, чат в оверлее
  - `opencode.yml` — OpenCode web на Linux/Windows, туннель, чат в оверлее
  - `desks.yml` — столы Linux (noVNC) и Windows (MJPEG)
  - `panel-apk.yml` — сборка APK и GitHub Release (`v1.{commits}`, versionCode растёт сам)

## Как пользоваться

1. Добавьте GitHub-токен с правами `repo` и `workflow`.
2. На вкладке «Сессии» запустите стол, CLI-агент или OpenCode.
3. После старта панель сама откроет веб-чат в оверлее. Поле «Первая команда» уходит в чат сразу (`?q=` у CLI, `opencode run --attach` у OpenCode).

Адрес сессии публикуется в ветке `session-state` (`session-agent.json`, `session-opencode.json`, `session-linux.json`, `session-windows.json`).

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
