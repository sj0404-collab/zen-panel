# Zen Panel для ПК (Windows / Linux)

Десктопный аналог Android-приложения: окно на Electron, которое показывает **ту же самую панель** (`app/src/main/assets/panel/`), что и APK. Дубликата интерфейса нет — обе оболочки служат одни и те же файлы, поэтому Android и ПК всегда выглядят и работают одинаково.

## Что умеет

| Android (MainActivity) | ПК (это приложение) |
|---|---|
| WebView на `panel.symbiosis.local` | Окно Electron на `zen-panel://panel.symbiosis.local` |
| Страницы из APK | Страницы из `app/src/main/assets/panel/` (dev) или из ресурсов сборки |
| Внешние ссылки — в браузер | Внешние ссылки — в браузер (`shell.openExternal`) |
| Туннели (cloudflare/ngrok) — внутри | Туннели — внутри (новая вкладка-окно для `target=_blank`) |
| `ZenBridge.notifyReady` → уведомление «Открыть чат» | Тот же `ZenBridge` → системное уведомление, клик открывает чат |
| `version.json` + `ZEN_PANEL_BUILD` | Тот же `version.json` + `ZEN_PANEL_BUILD` |
| Скачивание APK через DownloadManager | Скачивание в `~/Downloads` с уведомлением |
| Обновление: релиз `v1.N` + `.apk` | Обновление: релиз `desktop-v1.N` + `.exe` / `.AppImage` / `.deb` |

## Запуск из исходников

```bash
cd desktop
npm install
npm start
```

Требуется Node 20+. Папка `../app/src/main/assets/panel/` должна быть на месте (это обычный checkout репозитория).

Проверка без Electron:

```bash
npm run check   # node --check + self-test panel-store.js
```

## Сборка установщиков

```bash
npm run dist:win    # Windows: NSIS-установщик + portable .exe (запускать на Windows)
npm run dist:linux  # Linux: .AppImage + .deb (запускать на Linux)
```

Готовые файлы падают в `desktop/dist/`. Перед сборкой CI записывает `desktop/build-info.json` (versionCode/versionName из git) — руками его создавать не нужно; в dev-режиме версия показывается как `dev`.

Версии идут от числа коммитов, как у APK: тег `desktop-v1.N`, где N = `git rev-list --count HEAD`. Установка поверх старой работает.

Открыть конкретную сессию сразу при старте:

```bash
npm start -- --slot agent --url https://…trycloudflare.com/
```

## Как панелю понять, где она запущена

Preload-мост выставляет два объекта:

- `window.ZenBridge` — тот же API, что в Android (`notifyReady`, `requestNotifications`), страницы вызывают его как раньше;
- `window.ZEN_DESKTOP = { platform, arch }` — по нему вкладка «APK» ищет релиз с тегом `desktop-*` и предлагает файл под вашу ОС вместо APK.

## Файлы

- `main.js` — окно, протокол `zen-panel:`, навигация, уведомления, скачивания, меню;
- `preload.js` — мост `ZenBridge` + флаг `ZEN_DESKTOP`;
- `panel-store.js` — чистая логика без Electron (allow-list, MIME, хосты, `version.json`), покрыта `test-panel-store.js`;
- `build/icon.png`, `build/icon.ico` — иконка из `app/src/main/assets/panel/icon.svg`;
- `../.github/workflows/desktop.yml` — CI: сборка Windows+Linux и публикация GitHub Release.
