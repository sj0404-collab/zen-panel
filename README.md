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

## OpenCode Mobile `<Client>` не коннектится — какой адрес вводить

`opencode serve` в workflow запускается с `--hostname 127.0.0.1`, поэтому **порт 4096 доступен только на самом раннере** и с телефона по LAN не открывается. Телефону нужен **gateway** (`agent/oc-gateway.js`), который слушает `0.0.0.0` и отдаёт мобильный чат на `/`, проксируя API OpenCode.

Как подключить телефон:

- **Через GitHub Actions (туннель).** Открой сессию OpenCode на вкладке «Сессии»; в панели появится адрес вида `https://…trycloudflare.com/`. Это и есть адрес gateway — вставь именно его (и `agentUrl` из `session-opencode.json`).
- **По LAN (свой сервер/ПК в домашней сети).** Запусти стек скриптом:
  ```bash
  PATH="$HOME/.local/node_modules/.bin:$PATH" tools/oc_lan_start.sh
  # он поднимет opencode serve на 127.0.0.1 и gateway на 0.0.0.0,
  # затем напечатает адрес для телефона:  http://<LAN-IP>:4100/
  ```
  Вставить именно адрес **gateway** (`http://<LAN-IP>:4100/`), **не** `…:4096`.

Остановить — `tools/oc_lan_stop.sh`. Порт `4096` (`opencode serve`) со скриншота «Сервер#1 / http://192.168.1.xxx:4096» — неверный для телефона: он слушает только localhost. Учти, что gateway на LAN работает без пароля (`OPENCODE_SERVER_PASSWORD` не задан) — держи сеть доверенной или запускай через туннель.
