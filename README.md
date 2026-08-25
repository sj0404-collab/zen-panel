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
